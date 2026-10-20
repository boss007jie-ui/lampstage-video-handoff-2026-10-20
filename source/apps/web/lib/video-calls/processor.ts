import type { Prisma, VideoJob } from "@prisma/client";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { refundVideoCallCredits } from "../credits";
import { assertVideoPaidGenerationEnabled, paidBoundaryProblem } from "../video/control";
import { sixRefRunner } from "../video/hypit-runner";
import { probeMedia } from "../video/media";
import { acquireVideoPermit, adoptExistingVideoPermit, assertVideoPermitMaySubmit, markVideoPermitUnknown, releaseVideoPermit } from "../video/permits";
import { heartbeatLease, LeaseLostError, patchJob, releaseInterruptedJob } from "../video/repository";
import { privateDownloadTo, privateUploadFile } from "../video/storage";
import { videoData } from "../video/types";
import { callBillingAuthorized, isSingleCallJob, sha256, VideoCallError } from "./contract";
import { runSingleCall } from "./engine";

export async function processSingleCall(initial: VideoJob, workerId: string, options: { signal?: AbortSignal } = {}): Promise<"safe" | "needs_review"> {
  if (!isSingleCallJob(initial.data)) throw new VideoCallError("not_single_call");
  let job = initial;
  const data = structuredClone(videoData(job.data));
  const call = data.singleCall!;
  if (call.version !== 1 || call.kind !== "single_call" || !/^vc_[a-f0-9]{64}$/.test(job.id) || !["render", "reconcile"].includes(job.phase)) throw new VideoCallError("invalid_single_call");
  const workspace = path.resolve(process.env.VIDEO_WORK_ROOT || path.join(process.cwd(), ".video-work"), job.id, "single-call");
  const permitId = `${job.id}:0:0`;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const deadline = Date.now() + 45 * 60_000;
  let heartbeatBusy = false;
  const timer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void heartbeatLease(job.id, workerId).catch(() => controller.abort()).finally(() => { heartbeatBusy = false; });
  }, 20_000);
  const save = async (fields: { status?: string; stage?: string; error?: string | null } = {}) => {
    if (controller.signal.aborted) throw new LeaseLostError();
    job = await patchJob(job.id, workerId, { ...fields, expectedRevision: job.revision }, data);
  };
  const paths: string[] = [];
  const sourcePath = path.join(workspace, "motion.mp4");
  try {
    await mkdir(workspace, { recursive: true });
    if (!call.terminal_failure && (call.submission_intent_at || call.build_id)) {
      await adoptExistingVideoPermit({ accountId: "runninghub.account01", attemptId: permitId, jobId: job.id, segmentIndex: 0, reservedCoins: null, maxCoins: 0 });
      if (!call.build_id) {
        const receipt = await sixRefRunner.recoverH3Submission(workspace);
        if (receipt) { call.build_id = receipt.buildId; await save(); }
      }
    }
    return await runSingleCall(call, {
      stopped: () => signal.aborted || Date.now() > deadline,
      prepare: async () => {
        if (job.phase === "reconcile") throw new VideoCallError("no_submission_to_reconcile");
        for (const [index, asset] of [call.motion, ...call.references].entries()) {
          const file = index === 0 ? sourcePath : path.join(workspace, `reference-${index - 1}.${asset.mime === "image/jpeg" ? "jpg" : asset.mime === "image/webp" ? "webp" : "png"}`);
          await privateDownloadTo(asset.key, file, { expectedBytes: asset.size_bytes, signal });
          if (sha256(await readFile(file)) !== asset.sha256) throw new VideoCallError("frozen_asset_changed", 409);
          if (index) paths.push(file);
        }
      },
      reserve: async () => {
        // VideoPermit 是供应商并发占槽；平台积分不可伪装为供应商 coins。
        const permit = await acquireVideoPermit({ accountId: "runninghub.account01", attemptId: permitId, jobId: job.id, segmentIndex: 0, reservedCoins: null, maxCoins: 0 });
        if (!permit.acquired) throw new VideoCallError("provider_permit_unavailable", 503);
        if (permit.alreadyAcquired) {
          call.submission_intent_at ??= new Date().toISOString();
          throw new VideoCallError("submission_unknown", 409);
        }
      },
      authorize: async () => {
        assertVideoPaidGenerationEnabled();
        if (signal.aborted) throw new LeaseLostError();
        const current = await prisma.videoJob.findFirst({ where: { id: job.id } });
        if (paidBoundaryProblem(current ? { leaseOwner: current.lease_owner, leaseUntil: current.lease_until, revision: current.revision } : null, { workerId, revision: job.revision })) throw new LeaseLostError();
        const stored = videoData(current!.data).singleCall;
        const user = await prisma.user.findUnique({ where: { id: job.user_id }, select: { credits_unlimited: true } });
        if (!stored || stored.input_digest !== call.input_digest || JSON.stringify(stored) !== JSON.stringify(call) || !user || !callBillingAuthorized(call, user.credits_unlimited)) throw new VideoCallError("authorization_changed", 409);
        await assertVideoPermitMaySubmit(permitId);
      },
      save: () => save(),
      submit: async (beforeSubmit, onBuildId) => (await sixRefRunner.submitH3({ workspace, sourcePath, referencePaths: paths,
        prompt: call.input.prompt, duration: call.input.duration, beforeSubmit, onBuildId })).buildId,
      inspect: () => sixRefRunner.inspectH3({ workspace, buildId: call.build_id! }),
      resume: async () => {
        if (signal.aborted) throw new LeaseLostError();
        await heartbeatLease(job.id, workerId);
        return sixRefRunner.resumeH3Worker({ workspace, buildId: call.build_id! });
      },
      collect: async () => {
        const file = path.join(workspace, "output.mp4");
        await sixRefRunner.collectH3({ workspace, buildId: call.build_id!, to: file });
        const media = await probeMedia(file, signal);
        const bytes = await readFile(file);
        const key = `videos/${job.id}/single-call/output.mp4`;
        await privateUploadFile(key, file, "video/mp4", { signal });
        call.output = { asset_id: job.id, key, sha256: sha256(bytes), size_bytes: bytes.length, mime: "video/mp4", duration: media.duration, width: media.width, height: media.height };
        data.outputKey = key; data.outputSha256 = call.output.sha256;
      },
      release: async () => { await releaseVideoPermit(permitId); },
      unknown: async () => { await markVideoPermitUnknown(permitId); },
      refund: async () => {
        // 退款与 JSON 账本同事务提交；失败回滚，不出现已退账但任务仍展示扣款的状态。
        job = await prisma.$transaction(async tx => {
          const refund = await refundVideoCallCredits(tx, job.user_id, job.id, call.quote_credits);
          const next = structuredClone(data);
          next.singleCall!.billing.refunded_credits = refund.refundedCredits;
          if (refund.transactionId) next.singleCall!.billing.refund_id = refund.transactionId;
          const updated = await tx.videoJob.updateMany({ where: { id: job.id, lease_owner: workerId, lease_until: { gt: new Date() }, revision: job.revision },
            data: { data: next as unknown as Prisma.InputJsonValue, revision: { increment: 1 } } });
          if (updated.count !== 1) throw new LeaseLostError();
          const refreshed = await tx.videoJob.findUniqueOrThrow({ where: { id: job.id } });
          call.billing = next.singleCall!.billing;
          return refreshed;
        });
      },
      finish: status => save({ status, stage: status === "completed" ? "单次生成完成，等待本地审阅" : status === "failed" ? "生成未完成，实际扣款已退款" : "提交或收取状态待核对，不会自动重投",
        error: status === "attention" ? "single_call_needs_reconciliation" : status === "failed" ? "single_call_failed" : null }),
      wait: () => new Promise(resolve => { const t = setTimeout(done, 10_000); function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done(); }),
    });
  } catch {
    console.warn("Single video call requires reconciliation", { jobId: job.id });
    if (call.submission_intent_at || call.build_id) await markVideoPermitUnknown(permitId).catch(() => undefined);
    await save({ status: "attention", stage: "单次调用待核对", error: "single_call_needs_reconciliation" }).catch(() => undefined);
    return "needs_review";
  } finally {
    clearInterval(timer);
    await releaseInterruptedJob(job.id, workerId).catch(() => undefined);
  }
}
