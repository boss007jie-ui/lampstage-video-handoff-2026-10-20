import type { VideoJob } from "@prisma/client";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getObjectBytes } from "@/lib/storage";
import { loadJobCharacterImageHashes } from "../characters/bindings";
import { verifyOriginalImage, MAX_IMAGE_BYTES } from "../assets/image-content";
import { assertVideoPaidGenerationEnabled, paidBoundaryProblem } from "./control";
import { sixRefRunner, SubmissionUnknownError } from "./hypit-runner";
import { inspectSource, VideoPipelineError } from "./media";
import { heartbeatLease, LeaseLostError, patchJob, releaseJob } from "./repository";
import { privateDownloadTo, privateUploadFile, privateWrite } from "./storage";
import { isVideoPreparation, segmentCoinQuote, videoData, type VideoJobData, type VideoSegment } from "./types";
import { snapshotReferenceImages } from "./reference-inputs";
import { assertSixStartStatePlan, effectiveSixReferences, readySixSegments, sixPlanDigest, sixSegmentDirection, validateSemanticWindows, SixReferencePlanError } from "./six-reference-plan";
import { acquireVideoPermit, adoptExistingVideoPermit, assertVideoPermitMaySubmit, markVideoPermitUnknown, releaseVideoPermit } from "./permits";
import { prepareSixMotionSegment, extractSixCandidateTail, assembleSixVideo } from "./sixref-media";

export const VIDEO_PROVIDER_ACCOUNT = "runninghub.account01";
export function sixAttemptId(jobId: string, segment: VideoSegment) { return `${jobId}:${segment.index}:${segment.attempt ?? 0}`; }
export function verifySixConsent(data: VideoJobData, quote: number | null, index?: number): void {
  const c = data.renderConsent;
  if (!c || !Number.isFinite(Date.parse(c.at)) || !Number.isSafeInteger(c.maxCoins) || c.maxCoins <= 0 || c.maxCoins > 1_000_000 ||
    !c.segmentIndices.length || new Set(c.segmentIndices).size !== c.segmentIndices.length ||
    c.segmentIndices.some(i => !Number.isInteger(i) || !data.segments.some(s => s.index === i)) ||
    (index !== undefined && !c.segmentIndices.includes(index)) || c.referenceDigest !== sixPlanDigest(data)) throw new VideoPipelineError("动作计划、参考图或本轮费用确认已变化，请重新审阅。");
  assertSixStartStatePlan(data, c.segmentIndices);
  if (c.perSegmentCoins === null ? quote !== null || c.estimatedCoins !== null :
    !Number.isSafeInteger(c.perSegmentCoins) || c.perSegmentCoins <= 0 || quote === null || quote <= 0 || quote > c.perSegmentCoins ||
    c.estimatedCoins !== c.perSegmentCoins * c.segmentIndices.length || c.estimatedCoins > c.maxCoins)
    throw new VideoPipelineError("当前报价与已确认的本轮预算不一致。");
}

/** Independent in-flight work is always collected, even if another operation fails. */
export async function runVideoWave<T>(items: T[], run: (item: T) => Promise<void>, concurrency = 3): Promise<void> {
  let next = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(3, Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length && failure === undefined) {
      const item = items[next++];
      try { await run(item); } catch (error) { failure ??= error; }
    }
  });
  await Promise.allSettled(workers);
  if (failure !== undefined) throw failure;
}

export async function processSixRefVideoJob(initial: VideoJob, workerId: string, options: { signal?: AbortSignal } = {}): Promise<"safe" | "needs_review"> {
  let job = initial;
  const data = structuredClone(videoData(job.data));
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let leaseLost = false, terminalSaved = false, unknown = false, stopPaid = false, heartbeatBusy = false;
  let writes: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = writes.then(fn);
    writes = result.catch(() => undefined);
    return result;
  };
  const save = (mutate: () => void = () => undefined, fields: { status?: string; stage?: string; error?: string | null } = {}) => serial(async () => {
    if (leaseLost || signal.aborted) throw new LeaseLostError();
    mutate();
    const now = new Date().toISOString();
    if (fields.stage) data.progress = { stageCode: job.phase, stageStartedAt: data.progress?.stageStartedAt ?? now, lastProgressAt: now };
    job = await patchJob(job.id, workerId, { ...fields, expectedRevision: job.revision }, data);
    if (fields.status && ["review", "completed", "attention", "failed"].includes(fields.status)) terminalSaved = true;
  });
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void heartbeatLease(job.id, workerId).catch(() => { leaseLost = true; controller.abort(); }).finally(() => { heartbeatBusy = false; });
  }, 20_000);
  const paidBoundary = (segment: VideoSegment, permitId: string) => serial(async () => {
    if (stopPaid || signal.aborted || leaseLost) throw new VideoPipelineError("本轮已停止新提交，正在收取已有任务。");
    assertVideoPaidGenerationEnabled();
    const current = await prisma.videoJob.findFirst({ where: { id: job.id }, select: { lease_owner: true, lease_until: true, revision: true, data: true, instructions: true } });
    if (paidBoundaryProblem(current ? { leaseOwner: current.lease_owner, leaseUntil: current.lease_until, revision: current.revision } : null,
      { workerId, revision: job.revision })) throw new LeaseLostError();
    const currentData = videoData(current!.data);
    verifySixConsent(currentData, segmentCoinQuote("six_references"), segment.index);
    if (sixPlanDigest(currentData) !== sixPlanDigest(data) || current!.instructions !== job.instructions ||
      JSON.stringify(currentData.renderConsent) !== JSON.stringify(data.renderConsent)) throw new VideoPipelineError("已确认的输入发生变化。");
    await assertVideoPermitMaySubmit(permitId);
    // Revision-checked durable intent immediately precedes the runner's own exclusive intent/build.
    segment.submissionIntentAt = new Date().toISOString();
    job = await patchJob(job.id, workerId, { expectedRevision: job.revision, stage: `正在提交第 ${segment.index + 1} 段` }, data);
  });
  try {
    if (data.generationMode !== "six_references" || data.workflowProfile !== "sixref-v1" || !/^[\w-]+$/.test(job.id)) throw new VideoPipelineError("六图任务或工作流版本无效。");
    const workspace = path.resolve(process.env.VIDEO_WORK_ROOT || path.join(process.cwd(), ".video-work"), job.id);
    await mkdir(workspace, { recursive: true });
    const sourcePath = path.join(workspace, "source.mp4");
    const downloadSource = async () => {
      const source = await prisma.videoAsset.findFirst({ where: { id: job.source_asset_id, user_id: job.user_id, status: "ready" } });
      if (!source) throw new VideoPipelineError("原视频不存在或不可用。");
      await privateDownloadTo(source.storage_key, sourcePath, { expectedBytes: source.size_bytes, signal });
    };
    if (isVideoPreparation(job.phase)) {
      if (data.imageCalls !== 0 || data.segments.some(s => s.submissionIntentAt || s.buildId)) throw new VideoPipelineError("已有生成记录，不能重新准备。");
      assertSixStartStatePlan(data);
      await save(undefined, { stage: "正在校验完整原片和动作分段" });
      await downloadSource();
      const info = await inspectSource(sourcePath, signal);
      validateSemanticWindows(data.segments, info.duration);
      data.sourceDuration = info.duration; data.sourceHasAudio = info.hasAudio;
      const characterHashes = await loadJobCharacterImageHashes(prisma, job.user_id, job.id, data);
      for (const s of data.segments) {
        const refs = await snapshotReferenceImages(s.referenceImages!, job.id, {
          read: async assetId => {
            const asset = await prisma.uploadedAsset.findFirst({ where: { id: assetId, user_id: job.user_id } });
            if (!asset) throw new VideoPipelineError("参考图片不存在或无权访问。");
            const expected = characterHashes.get(assetId);
            const bytes = (await getObjectBytes(asset.image_url, { signal, timeoutMs: 30_000,
              maxBytes: expected ? MAX_IMAGE_BYTES : 30 * 1024 * 1024 })).bytes;
            if (expected) {
              try { verifyOriginalImage(bytes, expected); }
              catch { throw new VideoPipelineError("人物原图与已选版本不一致，请重新核对人物参考。"); }
            }
            return bytes;
          }, write: (key, bytes) => privateWrite(key, bytes, "image/png", { signal }),
        }, s.index);
        const clip = await prepareSixMotionSegment(sourcePath, s, workspace, signal);
        const key = `videos/${job.id}/segments/${s.index}/source.mp4`;
        await privateUploadFile(key, clip, "video/mp4", { signal });
        await save(() => { s.referenceImages = refs; s.clipKey = key; }, { stage: `第 ${s.index + 1} 段参考用途与动作引导已准备` });
      }
      data.referenceImages = (data.referenceImages ?? []).map(ref => data.segments.flatMap(s => s.referenceImages ?? []).find(r => r.assetId === ref.assetId) ?? ref);
      await save(undefined, { status: "review", stage: "请核对逐段动作、参考用途和本轮费用", error: null });
      return "safe";
    }
    validateSemanticWindows(data.segments, data.sourceDuration);
    if (job.phase === "assemble") {
      if (!data.segments.every(s => s.accepted && s.candidateKey && s.candidateSha256)) throw new VideoPipelineError("所有片段均需审阅通过后才能合成。");
      await save(undefined, { status: "assembling", stage: "正在合成已审阅片段并校验完整音画" });
      await downloadSource();
      const candidates: string[] = [];
      for (const s of data.segments) {
        const file = path.join(workspace, `assemble-${s.index}-${s.attempt ?? 0}.mp4`);
        await privateDownloadTo(s.candidateKey!, file, { signal });
        if (createHash("sha256").update(await readFile(file)).digest("hex") !== s.candidateSha256) throw new VideoPipelineError("待合成片段与已审阅文件不一致。");
        candidates.push(file);
      }
      const output = await assembleSixVideo({ candidates, segments: data.segments, source: sourcePath, duration: data.sourceDuration!, preserveAudio: job.preserve_audio && Boolean(data.sourceHasAudio), workspace, signal });
      const finalInfo = await extractSixCandidateTail(output, path.join(workspace, "output-tail.png"), signal);
      if (finalInfo.fps !== 30) throw new VideoPipelineError("成片实际帧率未通过 30fps 校验。");
      const key = `videos/${job.id}/output.mp4`;
      await privateUploadFile(key, output, "video/mp4", { signal });
      const outputHash = createHash("sha256").update(await readFile(output)).digest("hex");
      await save(() => { data.outputKey = key; data.outputSha256 = outputHash;
        data.outputMedia = { duration: finalInfo.media.duration, width: finalInfo.media.width, height: finalInfo.media.height, fps: finalInfo.fps, frameCount: finalInfo.frameCount };
      }, { status: "completed", stage: "已审阅片段已合成，请完整播放验收成片", error: null });
      return "safe";
    }
    const reconcile = job.phase === "reconcile";
    if (!reconcile && job.phase !== "render") throw new VideoPipelineError("任务阶段无效。");
    if (!reconcile) verifySixConsent(data, segmentCoinQuote("six_references"));
    if (!(await sixRefRunner.runnerReadiness()).ready) throw new VideoPipelineError("六图 account01 工作环境尚未就绪。");
    const segmentWorkspace = (s: VideoSegment) => path.join(workspace, `segment-${s.index}`, `attempt-${s.attempt ?? 0}`);
    if (reconcile) {
      for (const s of data.segments) if (!s.candidateKey && !s.terminalFailure && (s.buildId || s.submissionIntentAt)) {
        await adoptExistingVideoPermit({ accountId: VIDEO_PROVIDER_ACCOUNT, attemptId: sixAttemptId(job.id, s), jobId: job.id,
          segmentIndex: s.index, reservedCoins: null,
          maxCoins: Number.isSafeInteger(data.renderConsent?.maxCoins) && data.renderConsent!.maxCoins >= 0 ? data.renderConsent!.maxCoins : 0 });
      }
      for (const s of data.segments) if (!s.candidateKey && s.submissionIntentAt && !s.buildId) {
        const receipt = await sixRefRunner.recoverH3Submission(segmentWorkspace(s));
        if (receipt) await save(() => { s.buildId = receipt.buildId; }, { stage: "已恢复原提交回执" });
      }
    }
    const pending = reconcile ? data.segments.filter(s => s.buildId && !s.candidateKey && !s.terminalFailure) :
      readySixSegments(data).filter(s => data.renderConsent!.segmentIndices.includes(s.index));
    if (!reconcile && !pending.length) throw new VideoPipelineError("没有已确认且可独立执行的片段。");
    const failures: unknown[] = [];
    // Use a bounded batch; each DB mutation is serialized above, while remote work overlaps.
    await runVideoWave(pending, async segment => {
      const dir = segmentWorkspace(segment), permitId = sixAttemptId(job.id, segment);
      let acquired = false;
      let knownTerminal = false;
      await mkdir(dir, { recursive: true });
      try {
        if (!reconcile) {
          if (stopPaid) return;
          const permitRequest = { accountId: VIDEO_PROVIDER_ACCOUNT, attemptId: permitId, jobId: job.id,
            segmentIndex: segment.index, reservedCoins: data.renderConsent!.perSegmentCoins, maxCoins: data.renderConsent!.maxCoins };
          let permit = await acquireVideoPermit(permitRequest);
          const slotDeadline = Date.now() + 45 * 60_000;
          while (!permit.acquired && permit.reason === "busy" && !stopPaid && !signal.aborted && Date.now() < slotDeadline) {
            await new Promise(resolve => setTimeout(resolve, 5_000));
            permit = await acquireVideoPermit(permitRequest);
          }
          if (stopPaid || signal.aborted) {
            if (permit.acquired && !permit.alreadyAcquired) await releaseVideoPermit(permitId);
            return;
          }
          if (!permit.acquired) throw new VideoPipelineError(permit.reason === "busy" ? "账户三路任务名额已占用，请等待已有任务完成后继续。" : "账户存在未核清任务，已停止新提交。");
          acquired = true;
          if (permit.alreadyAcquired) throw new SubmissionUnknownError();
          const refs = effectiveSixReferences(data, segment);
          const referencePaths: string[] = [];
          for (const [i, ref] of refs.entries()) {
            const file = path.join(dir, `reference-${i}.png`);
            await privateDownloadTo(ref.key!, file, { signal, maxBytes: 30 * 1024 * 1024 });
            if (createHash("sha256").update(await readFile(file)).digest("hex") !== ref.sha256) throw new VideoPipelineError("实际参考图与审阅快照不一致。");
            referencePaths.push(file);
          }
          const clip = path.join(dir, "source.mp4");
          await privateDownloadTo(segment.clipKey!, clip, { signal });
          const receipt = await sixRefRunner.submitH3({ workspace: dir, sourcePath: clip, referencePaths, duration: segment.duration,
            prompt: sixSegmentDirection(refs, segment, job.instructions), beforeSubmit: () => paidBoundary(segment, permitId),
            onBuildId: id => save(() => { segment.buildId = id; }, { stage: `第 ${segment.index + 1} 段已提交，等待生成` }),
          });
          if (!segment.buildId) await save(() => { segment.buildId = receipt.buildId; });
        } else {
          // Terminal results need collection, never a worker restart. A failed build may
          // have stopped naturally and must remain a known failure rather than "unknown".
          const existing = await sixRefRunner.inspectH3({ workspace: dir, buildId: segment.buildId! });
          if (existing.state === "unknown") throw new SubmissionUnknownError(segment.buildId);
          if (existing.state === "working") {
            const resumed = await sixRefRunner.resumeH3Worker({ workspace: dir, buildId: segment.buildId! });
            if (!resumed.ready) throw new SubmissionUnknownError(segment.buildId);
            if (resumed.taskId) await save(() => { segment.providerTaskId = resumed.taskId; });
          }
        }
        const deadline = Date.now() + 45 * 60_000;
        while (true) {
          if (signal.aborted || leaseLost) throw new SubmissionUnknownError(segment.buildId);
          const state = await sixRefRunner.inspectH3({ workspace: dir, buildId: segment.buildId! });
          if (state.taskId && state.taskId !== segment.providerTaskId) await save(() => { segment.providerTaskId = state.taskId; });
          if (state.state === "unknown") throw new SubmissionUnknownError(segment.buildId);
          if (state.state === "failed") {
            knownTerminal = true;
            await releaseVideoPermit(permitId);
            await save(() => { segment.terminalFailure = true; segment.error = "上游返回明确失败，请审阅原因后决定是否授权重试。"; });
            return;
          }
          if (state.state === "completed") {
            knownTerminal = true;
            await releaseVideoPermit(permitId);
            const file = path.join(dir, "candidate.mp4");
            await sixRefRunner.collectH3({ workspace: dir, buildId: segment.buildId!, to: file });
            const hash = createHash("sha256").update(await readFile(file)).digest("hex");
            const tail = path.join(dir, "tail.png");
            const tailInfo = await extractSixCandidateTail(file, tail, signal);
            const tailHash = createHash("sha256").update(await readFile(tail)).digest("hex");
            const key = `videos/${job.id}/segments/${segment.index}/attempt-${segment.attempt ?? 0}/candidate.mp4`;
            const tailKey = `videos/${job.id}/segments/${segment.index}/attempt-${segment.attempt ?? 0}/tail.png`;
            await privateUploadFile(key, file, "video/mp4", { signal });
            await privateUploadFile(tailKey, tail, "image/png", { signal });
            await save(() => { segment.candidateKey = key; segment.candidateSha256 = hash; segment.tailKey = tailKey; segment.tailSha256 = tailHash; segment.candidateMedia = { duration: tailInfo.media.duration, width: tailInfo.media.width, height: tailInfo.media.height, fps: tailInfo.fps, frameCount: tailInfo.frameCount }; },
              { stage: `第 ${segment.index + 1} 段结果及实际末帧已保存，等待审阅` });
            return;
          }
          if (Date.now() > deadline) throw new SubmissionUnknownError(segment.buildId);
          await new Promise(resolve => setTimeout(resolve, 10_000));
        }
      } catch (error) {
        stopPaid = true;
        const ambiguous = !knownTerminal && (Boolean(segment.submissionIntentAt || segment.buildId) || error instanceof SubmissionUnknownError);
        if (ambiguous) {
          unknown = true;
          await markVideoPermitUnknown(permitId).catch(() => undefined);
        } else if (acquired && !knownTerminal) {
          await releaseVideoPermit(permitId).catch(() => undefined);
          await save(() => { segment.terminalFailure = true; segment.error = "付费提交前已停止，请核对本段输入后再授权新的尝试。"; }).catch(() => undefined);
        }
        failures.push(error);
        // Do not reject here: other already-submitted operations must keep collecting.
      }
    });
    if (reconcile && data.segments.some(s => s.submissionIntentAt && !s.buildId && !s.candidateKey)) unknown = true;
    if (failures.length || unknown) throw failures[0] ?? new SubmissionUnknownError();
    await save(undefined, { status: "review", stage: "请播放审阅已生成片段；依赖片段在前段通过后开放", error: null });
    return "safe";
  } catch (error) {
    const message = error instanceof VideoPipelineError || error instanceof SixReferencePlanError ? error.message :
      "处理未完成，已保留原回执。请核对现有任务，系统不会重复付费提交。";
    if (!leaseLost && !signal.aborted) {
      try { await save(undefined, { status: unknown || data.segments.some(s => !s.candidateKey && !s.terminalFailure && (s.buildId || s.submissionIntentAt)) ? "attention" : isVideoPreparation(job.phase) ? "failed" : "review", stage: "任务暂停，已有结果已保留", error: message }); }
      catch { leaseLost = true; }
    }
    return unknown || leaseLost || !terminalSaved ? "needs_review" : "safe";
  } finally {
    clearInterval(heartbeat);
    await writes;
    if (terminalSaved) await releaseJob(job.id, workerId).catch(() => undefined);
  }
}
