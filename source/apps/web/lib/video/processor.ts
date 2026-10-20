import { acquireVideoPermit, adoptExistingVideoPermit, assertVideoPermitMaySubmit, markVideoPermitUnknown, releaseVideoPermit } from "./permits";
import { processSixRefVideoJob } from "./sixref-processor";
import { isSingleCallJob } from "../video-calls/contract";
import { processSingleCall } from "../video-calls/processor";
import type { VideoJob } from "@prisma/client";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { getObjectBytes } from "@/lib/storage";
import { generateReference, videoDirection } from "./image-reference";
import { collectH3, inspectH3, recoverH3Submission, resumeH3Worker, runnerReadiness, submitH3 } from "./hypit-runner";
import { assembleVideo, inspectSource, prepareMotionSegment, prepareSegment, segmentTimeline, VideoPipelineError } from "./media";
import { assertVideoPaidGenerationEnabled, paidBoundaryProblem } from "./control";
import { heartbeatLease, LeaseLostError, patchJob, releaseJob } from "./repository";
import { privateDownloadTo, privateUploadFile, privateWrite } from "./storage";
import { VIDEO_MAX_BYTES, isVideoPreparation, segmentCoinQuote, videoData, type VideoJobData, type VideoSegment } from "./types";
import { generationMode, referenceDigest, referenceImagesFor, referenceVideoDirection, snapshotReferenceImages, VideoReferenceInputError } from "./reference-inputs";

/** 免费网络操作总超时：产品图 30 秒（源片/视频对象走 storage 层的 120 秒默认值）。 */
const PRODUCT_IMAGE_TIMEOUT_MS = 30_000;

/** A persisted intent without a receipt is ambiguous, even if the network call threw. */
export function segmentAction(segment: VideoSegment, reconcile: boolean): "reuse" | "inspect" | "submit" {
  if (segment.candidateKey) return "reuse";
  if (segment.buildId) return "inspect";
  if (segment.submissionIntentAt || reconcile) throw new VideoPipelineError("缺少生成回执，请人工核对；系统不会重复提交。");
  return "submit";
}

/** Reconciliation salvages existing work even when later segments have never been submitted. */
export function reconciliationPlan(segments: VideoSegment[]) {
  return { recoverable: segments.filter(s => s.buildId || s.candidateKey), missing: segments.filter(s => !s.buildId && !s.candidateKey) };
}

export function verifyRenderConsent(data: VideoJobData, currentQuote: number | null, submittingIndex?: number): void {
  const consent = data.renderConsent;
  if (generationMode(data) === "direct_references" && (!consent?.referenceDigest || consent.referenceDigest !== referenceDigest(data))) {
    throw new VideoPipelineError("参考图或角色说明与费用确认时不一致，请重新核对素材与预算。");
  }
  const indices = consent?.segmentIndices;
  const baseInvalid = !consent || !Number.isFinite(Date.parse(consent.at)) || !Number.isInteger(consent.maxCoins) || consent.maxCoins <= 0 ||
      !data.segments.length || !Array.isArray(indices) || !indices.length || new Set(indices).size !== indices.length ||
      indices.some(i => !Number.isInteger(i) || !data.segments.some(s => s.index === i)) ||
      data.segments.some(s => !s.candidateKey && !s.buildId && !s.submissionIntentAt && !indices.includes(s.index)) ||
      (submittingIndex !== undefined && !indices.includes(submittingIndex));
  /**
   * 未定价模式（explicit）：确认时没有单段报价 ⇒ 确认时与提交时都必须仍是"未定价"。
   * 一旦中途配置了报价，旧确认立即作废 —— 这正是"展示后涨价"要拦的情形。
   * 已定价模式：确认价必须为正整数，当前价不得高于确认价，且不得超出已确认预算。
   */
  const unpriced = consent?.perSegmentCoins === null;
  const pricingInvalid = !consent ? true : unpriced
    ? currentQuote !== null || consent.estimatedCoins !== null
    : !Number.isInteger(consent.perSegmentCoins) || (consent.perSegmentCoins as number) <= 0 || currentQuote === null ||
      !Number.isInteger(currentQuote) || currentQuote <= 0 || currentQuote > (consent.perSegmentCoins as number) ||
      consent.estimatedCoins !== (consent.perSegmentCoins as number) * indices!.length ||
      (consent.estimatedCoins as number) > consent.maxCoins || currentQuote * indices!.length > consent.maxCoins;
  if (baseInvalid || pricingInvalid) {
    throw new VideoPipelineError("缺少有效的费用确认，或当前上限超出已确认预算。请重新核对费用。");
  }
}

function verifySegments(data: VideoJobData): void {
  const expected = segmentTimeline(data.sourceDuration ?? NaN);
  if (expected.length !== data.segments.length || expected.some((s, i) => {
    const actual = data.segments[i];
    return s.index !== actual.index || s.duration !== actual.duration || Math.abs(s.start - actual.start) > 0.000001 || Math.abs(s.trimStart - actual.trimStart) > 0.000001;
  })) throw new VideoPipelineError("分段记录不完整，请人工核对。");
}

/** Serial processing. Every paid request is preceded by a lease/revision-checked durable intent. */
export type VideoJobOutcome = "safe" | "needs_review";

export async function processVideoJob(initial: VideoJob, workerId: string, options: { signal?: AbortSignal } = {}): Promise<VideoJobOutcome> {
  if (isSingleCallJob(initial.data)) return processSingleCall(initial, workerId, options);
  if (generationMode(videoData(initial.data)) === "six_references") return processSixRefVideoJob(initial, workerId, options);
  const externalSignal = options.signal;
  // 租约丢失必须能**取消**正在进行的付费 I/O，而不是等下一次 await 才发现：
  // 心跳一旦失败就 abort 这个 job 级 controller，信号会穿透到 HTTP 请求与结果下载。
  const leaseController = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, leaseController.signal]) : leaseController.signal;
  let job = initial;
  let data = structuredClone(videoData(job.data));
  let leaseLost = false;
  let terminalSaved = false;
  let terminalStatus: string | null = null;
  let heartbeatBusy = false;
  const activePermits = new Map<string, VideoSegment>();
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void heartbeatLease(job.id, workerId).catch(() => { leaseLost = true; leaseController.abort(); }).finally(() => { heartbeatBusy = false; });
  }, 20_000);
  const save = async (fields: { status?: string; phase?: string; stage?: string; error?: string | null } = {}) => {
    if (leaseLost) throw new LeaseLostError();
    job = await patchJob(job.id, workerId, { ...fields, expectedRevision: job.revision }, data);
    if (fields.status && ["review", "completed", "failed", "attention"].includes(fields.status)) { terminalSaved = true; terminalStatus = fields.status; }
  };
  const checkLease = async () => { if (leaseLost) throw new LeaseLostError(); await heartbeatLease(job.id, workerId); };
  /**
   * 付费边界复核。读**当前数据库状态**（不是内存里的旧值）核对 owner / lease_until / revision，
   * 并在 render 阶段顺带核对已保存的 renderConsent；同时确认付费开关处于开启状态。
   *
   * 这是防"准备输入花了很久、之后继续用旧授权去花钱"的那道闸门，在每次真实付费调用前执行。
   */
  const verifyPaidBoundary = async (): Promise<void> => {
    assertVideoPaidGenerationEnabled();
    if (signal?.aborted) throw new VideoPipelineError("任务已取消。");
    const current = await prisma.videoJob.findFirst({
      where: { id: job.id },
      select: { lease_owner: true, lease_until: true, revision: true, data: true },
    });
    const problem = paidBoundaryProblem(
      current ? { leaseOwner: current.lease_owner, leaseUntil: current.lease_until, revision: current.revision } : null,
      { workerId, revision: job.revision },
    );
    if (problem) throw new LeaseLostError();
    if (job.phase === "render") {
      const currentData = videoData(current!.data);
      verifyRenderConsent(currentData, segmentCoinQuote());
      if (generationMode(currentData) !== generationMode(data) ||
        (generationMode(data) === "direct_references" && referenceDigest(currentData) !== referenceDigest(data))) {
        throw new VideoPipelineError("当前素材与已准备的提交输入不一致，请重新核对。");
      }
    }
  };
  /**
   * 记录业务阶段。与租约心跳严格分开：心跳每 20 秒刷 updated_at，但那只说明进程活着；
   * 只有这里写的 progress.lastProgressAt 才代表**业务真的在推进**。
   * 换阶段才更新 stageStartedAt；同一阶段有实质产出才更新 lastProgressAt。
   */
  const setStage = async (stageCode: string, stageText: string, extra: { status?: string; progressed?: boolean } = {}) => {
    const nowIso = new Date().toISOString();
    const previous = data.progress;
    data.progress = {
      stageCode,
      stageStartedAt: previous && previous.stageCode === stageCode ? previous.stageStartedAt : nowIso,
      lastProgressAt: extra.progressed === false && previous ? previous.lastProgressAt : nowIso,
    };
    await save({ ...(extra.status ? { status: extra.status } : {}), stage: stageText });
  };
  try {
    const direct = generationMode(data) === "direct_references";
    if (!/^[a-zA-Z0-9_-]+$/.test(job.id)) throw new VideoPipelineError("任务标识无效。");
    const workspace = path.resolve(process.env.VIDEO_WORK_ROOT || path.join(process.cwd(), ".video-work"), job.id);
    await mkdir(workspace, { recursive: true });
    // 阶段在**下载之前**就落库：否则"卡在下载"这段最需要被看见的时间恰好没有进展记录。
    await setStage("source_download", "正在获取原视频素材", { progressed: false });
    const sourceAsset = await prisma.videoAsset.findFirst({ where: { id: job.source_asset_id, user_id: job.user_id, status: "ready" } });
    if (!sourceAsset) throw new VideoPipelineError("原视频不存在或不可用。");
    const source = path.join(workspace, "source.mp4");
    // 不只信上游的 Content-Length：用数据库记录的真实字节数核对落盘长度，不符即失败。
    await privateDownloadTo(sourceAsset.storage_key, source, { expectedBytes: sourceAsset.size_bytes, signal });

    if (isVideoPreparation(job.phase)) {
      // Resuming an interrupted image attempt could duplicate a charged request; never infer its failure.
      if (data.imageCalls > 0) throw new VideoPipelineError("已有参考图调用记录，请人工核对；不会自动重试生成。");
      if (!direct && !process.env.OPENLUX_API_KEY?.trim()) throw new VideoPipelineError("图像生成服务尚未配置。");
      // 素材合法性必须在任何付费意图之前确定：时长/比例不对就快速拒绝，不进参考帧生成。
      await setStage("source_validate", "正在校验原视频时长与画面比例");
      const info = await inspectSource(source, signal);
      let productData: Awaited<ReturnType<typeof getObjectBytes>> | undefined;
      if (direct) {
        const refs = referenceImagesFor(data);
        if (refs[0].assetId !== job.product_asset_id) throw new VideoPipelineError("产品图与参考记录不一致。");
        await setStage("reference_snapshot", "正在校验并保存产品、人物与场景参考图");
        // Look up every asset with the current owner again; upload alone never implies permission.
        data.referenceImages = await snapshotReferenceImages(refs, job.id, {
          read: async assetId => {
            await checkLease();
            const asset = await prisma.uploadedAsset.findFirst({ where: { id: assetId, user_id: job.user_id } });
            if (!asset) throw new VideoPipelineError("参考图片不存在或无权访问。");
            return (await getObjectBytes(asset.image_url, { signal, timeoutMs: PRODUCT_IMAGE_TIMEOUT_MS, maxBytes: 30 * 1024 * 1024 })).bytes;
          },
          write: async (key, bytes) => { await checkLease(); await privateWrite(key, bytes, "image/png", { signal }); },
        });
        await save();
      } else {
        const product = await prisma.uploadedAsset.findFirst({ where: { id: job.product_asset_id, user_id: job.user_id } });
        if (!product) throw new VideoPipelineError("产品图片不存在或无权访问。");
        await setStage("product_download", "正在读取产品图");
        productData = await getObjectBytes(product.image_url, { signal, timeoutMs: PRODUCT_IMAGE_TIMEOUT_MS });
      }
      data = { ...data, sourceDuration: info.duration, sourceHasAudio: info.hasAudio, segments: segmentTimeline(info.duration) };
      await setStage("segment_extract", direct ? "正在提取原视频动作片段" : "正在提取分段和首尾画面");
      for (const segment of data.segments) {
        await checkLease();
        if (direct) {
          const clip = await prepareMotionSegment(source, segment, workspace, signal);
          segment.clipKey = `videos/${job.id}/segments/${segment.index}/source.mp4`;
          await privateUploadFile(segment.clipKey, clip, "video/mp4", { signal });
          await setStage("segment_extract", `第 ${segment.index + 1} 段动作片段已保存`);
          continue;
        }
        const files = await prepareSegment(source, segment, workspace, signal);
        segment.clipKey = `videos/${job.id}/segments/${segment.index}/source.mp4`;
        await privateUploadFile(segment.clipKey, files.clip, "video/mp4", { signal });
        await save();
        for (const endpoint of ["opening", "ending"] as const) {
          // 先读帧（免费），再在"付费意图落库"之前复核开关与租约——
          // 否则读输入花了很久之后，会拿旧授权继续花钱。
          const frame = await readFile(files[endpoint]);
          await verifyPaidBoundary();
          data.imageCalls += 1;
          await setStage("reference_generate", `正在生成第 ${segment.index + 1} 段${endpoint === "opening" ? "首" : "尾"}帧参考图`);
          const result = await generateReference({ product: productData!, frame, endpoint, instructions: job.instructions, jobId: job.id,
            signal, beforeSubmit: verifyPaidBoundary });
          const key = `videos/${job.id}/segments/${segment.index}/${endpoint}.png`;
          await privateWrite(key, result.bytes, result.mime, { signal });
          segment[endpoint === "opening" ? "openingKey" : "endingKey"] = key;
          await save();
        }
      }
      await save({ status: "review", stage: direct ? "参考图与动作片段已就绪，请确认图片角色和费用" : "参考图已就绪，请逐段检查首尾画面" });
      return "safe";
    }

    const reconcile = job.phase === "reconcile";
    if (!reconcile && job.phase !== "render") throw new VideoPipelineError("任务阶段无效。");
    verifySegments(data);
    if (!reconcile) verifyRenderConsent(data, segmentCoinQuote());
    if (reconcile) {
      for (const segment of data.segments) {
        if (!segment.candidateKey && (segment.buildId || segment.submissionIntentAt)) {
          await adoptExistingVideoPermit({ accountId: "runninghub.account01", attemptId: `${job.id}:${segment.index}:${segment.attempt ?? 0}`,
            jobId: job.id, segmentIndex: segment.index, reservedCoins: null,
            maxCoins: Number.isSafeInteger(data.renderConsent?.maxCoins) && data.renderConsent!.maxCoins >= 0 ? data.renderConsent!.maxCoins : 0 });
        }
        if (!segment.buildId && segment.submissionIntentAt) {
          const receipt = await recoverH3Submission(path.join(workspace, `segment-${segment.index}`));
          if (receipt) { segment.buildId = receipt.buildId; await save({ stage: "已恢复本地回执，正在核对原任务" }); }
        }
      }
    }
    // Reconcile only existing receipts; incomplete later segments cannot block recovery of earlier paid work.
    const plan = reconcile ? reconciliationPlan(data.segments) : { recoverable: data.segments, missing: [] };
    if (!reconcile) for (const segment of data.segments) segmentAction(segment, false);
    const needsRunner = plan.recoverable.some(s => !s.candidateKey);
    if (needsRunner && !(await runnerReadiness()).ready) throw new VideoPipelineError("Minimax H3 account01 工作环境尚未就绪。");
    let productPath = "";
    const directPaths: string[] = [];
    if (!reconcile && data.segments.some(s => segmentAction(s, false) === "submit")) {
      if (direct) {
        for (const [index, ref] of referenceImagesFor(data).entries()) {
          const file = path.join(workspace, `reference-${index}.png`);
          await privateDownloadTo(ref.key!, file, { signal, maxBytes: 30 * 1024 * 1024 });
          if (createHash("sha256").update(await readFile(file)).digest("hex") !== ref.sha256) {
            throw new VideoPipelineError("参考图快照校验失败，请重新核对；没有提交生成。");
          }
          directPaths.push(file);
        }
      } else {
        const product = await prisma.uploadedAsset.findFirst({ where: { id: job.product_asset_id, user_id: job.user_id } });
        if (!product) throw new VideoPipelineError("产品图片不存在或无权访问。");
        const productData = await getObjectBytes(product.image_url, { signal, timeoutMs: PRODUCT_IMAGE_TIMEOUT_MS, maxBytes: VIDEO_MAX_BYTES });
        productPath = path.join(workspace, "product-image.png");
        await writeFile(productPath, await sharp(productData.bytes).rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png().toBuffer());
      }
    }
    for (const segment of plan.recoverable) {
      const action = segmentAction(segment, reconcile);
      if (action === "reuse") continue;
      await checkLease();
      const segmentWorkspace = path.join(workspace, `segment-${segment.index}`);
      await mkdir(segmentWorkspace, { recursive: true });
      if (action === "submit") {
        verifyRenderConsent(data, segmentCoinQuote(), segment.index);
        if (!segment.clipKey || (!direct && (!segment.openingKey || !segment.endingKey))) throw new VideoPipelineError("分段参考素材缺失，请先核对参考图。");
        const sourcePath = path.join(segmentWorkspace, "source.mp4");
        const openingPath = path.join(segmentWorkspace, "opening.png");
        const endingPath = path.join(segmentWorkspace, "ending.png");
        const segmentProductPath = path.join(segmentWorkspace, "product.png");
        await privateDownloadTo(segment.clipKey, sourcePath, { signal });
        let referencePaths: [string, string, string] | undefined;
        if (direct) {
          if (directPaths.length !== 3) throw new VideoPipelineError("三张参考图快照尚未就绪。");
          referencePaths = [0, 1, 2].map(i => path.join(segmentWorkspace, `reference-${i}.png`)) as [string, string, string];
          for (let i = 0; i < 3; i++) await copyFile(directPaths[i], referencePaths[i]);
        } else {
          await copyFile(productPath, segmentProductPath);
          await privateDownloadTo(segment.openingKey!, openingPath, { signal });
          await privateDownloadTo(segment.endingKey!, endingPath, { signal });
        }
        const permitId = `${job.id}:${segment.index}:${segment.attempt ?? 0}`;
        const permitRequest = { accountId: "runninghub.account01", attemptId: permitId, jobId: job.id, segmentIndex: segment.index,
          reservedCoins: data.renderConsent!.perSegmentCoins, maxCoins: data.renderConsent!.maxCoins };
        let permit = await acquireVideoPermit(permitRequest);
        const slotDeadline = Date.now() + 45 * 60_000;
        while (!permit.acquired && permit.reason === "busy" && !signal.aborted && Date.now() < slotDeadline) {
          await checkLease();
          await new Promise(resolve => setTimeout(resolve, 5000));
          permit = await acquireVideoPermit(permitRequest);
        }
        if (!permit.acquired) throw new VideoPipelineError("账户视频名额已占用或存在未核清任务，请稍后核对原任务。");
        activePermits.set(permitId, segment);
        if (permit.alreadyAcquired) throw new VideoPipelineError("已有生成名额和尝试记录，请核对原任务，不能再次提交。");
        segment.submissionIntentAt = new Date().toISOString();
        await setStage("video_submit", `正在提交第 ${segment.index + 1} 段视频`);
        const receipt = await submitH3({ workspace: segmentWorkspace, sourcePath,
          ...(referencePaths ? { referencePaths } : { productPath: segmentProductPath, openingPath, endingPath }),
          duration: segment.duration, prompt: direct ? referenceVideoDirection(referenceImagesFor(data), job.instructions) : videoDirection(job.instructions),
          beforeSubmit: async () => { await verifyPaidBoundary(); await assertVideoPermitMaySubmit(permitId); },
          onBuildId: async buildId => { segment.buildId = buildId; await setStage("video_wait", `第 ${segment.index + 1} 段已提交，等待生成`); },
        });
        if (!segment.buildId && receipt.buildId) { segment.buildId = receipt.buildId; await save(); }
        if (!segment.buildId) throw new VideoPipelineError("提交结果不明确，请人工核对；不会重复提交。");
      }
      if (reconcile) {
        const resumed = await resumeH3Worker({ workspace: segmentWorkspace, buildId: segment.buildId! });
        if (!resumed.ready) throw new VideoPipelineError("原任务尚无法安全恢复，请由管理员核对；不会重复提交。");
        if (resumed.taskId && resumed.taskId !== segment.providerTaskId) { segment.providerTaskId = resumed.taskId; await save(); }
      }
      const deadline = Date.now() + 45 * 60_000;
      while (true) {
        await checkLease();
        const state = await inspectH3({ workspace: segmentWorkspace, buildId: segment.buildId! });
        if (state.taskId && state.taskId !== segment.providerTaskId) { segment.providerTaskId = state.taskId; await save(); }
        if (state.state === "failed") {
          await releaseVideoPermit(`${job.id}:${segment.index}:${segment.attempt ?? 0}`);
          activePermits.delete(`${job.id}:${segment.index}:${segment.attempt ?? 0}`);
          throw new VideoPipelineError("上游生成任务未成功；已保留回执，请人工核对。");
        }
        if (state.state === "unknown") throw new VideoPipelineError("暂时无法确认上游任务状态；已保留回执，可稍后核对。");
        if (state.state === "completed") {
          await releaseVideoPermit(`${job.id}:${segment.index}:${segment.attempt ?? 0}`);
          activePermits.delete(`${job.id}:${segment.index}:${segment.attempt ?? 0}`);
          // Unique export path also permits recovery after a previous collect succeeded but DB persistence failed.
          const target = path.join(segmentWorkspace, `candidate-${job.revision}.mp4`);
          await collectH3({ workspace: segmentWorkspace, buildId: segment.buildId!, to: target });
          const candidateKey = `videos/${job.id}/segments/${segment.index}/candidate.mp4`;
          await privateUploadFile(candidateKey, target, "video/mp4", { signal });
          segment.candidateKey = candidateKey;
          await setStage("video_wait", `第 ${segment.index + 1} 段视频已保存`);
          break;
        }
        if (Date.now() > deadline) throw new VideoPipelineError("等待生成超时；已保留回执，可稍后核对，不会重复提交。");
        await new Promise(resolve => setTimeout(resolve, 10_000));
      }
    }
    if (plan.missing.length) {
      if (plan.missing.some(s => s.submissionIntentAt)) throw new VideoPipelineError("原任务已核查，仍有提交缺少回执，请人工核对；系统未发起新生成。");
      await save({ status: "review", stage: "已恢复已生成片段，请确认剩余片段费用", error: null });
      return "safe";
    }
    await setStage("assemble", "正在合成并检查完整视频", { status: "assembling" });
    const candidates: string[] = [];
    for (const segment of data.segments) {
      if (!segment.candidateKey) throw new VideoPipelineError("视频片段缺失。");
      const file = path.join(workspace, `candidate-${segment.index}.mp4`);
      await privateDownloadTo(segment.candidateKey, file, { signal });
      candidates.push(file);
    }
    const output = await assembleVideo({ candidates, segments: data.segments, source, duration: data.sourceDuration!, preserveAudio: Boolean(job.preserve_audio && data.sourceHasAudio), workspace, signal });
    await checkLease();
    data.outputKey = `videos/${job.id}/output.mp4`;
    await privateUploadFile(data.outputKey, output, "video/mp4", { signal });
    await save({ status: "completed", stage: "完整视频已生成，可预览并下载", error: null });
  } catch (error) {
    for (const [id, segment] of activePermits) {
      await (segment.submissionIntentAt || segment.buildId ? markVideoPermitUnknown(id) : releaseVideoPermit(id)).catch(() => undefined);
    }
    if (!(error instanceof LeaseLostError) && !leaseLost) {
      const message = error instanceof VideoPipelineError || error instanceof VideoReferenceInputError ? error.message : "视频处理暂未完成；已保留处理记录，请人工核对后继续。";
      try { await save({ status: data.imageCalls > 0 || data.segments.some(s => s.submissionIntentAt || s.buildId) ? "attention" : "failed", stage: "处理暂停，请核对任务", error: message }); } catch { /* A newer lease/revision owns the record. */ }
    }
  } finally {
    clearInterval(heartbeat);
    // If saving the terminal state failed, leave the lease to expire into attention.
    if (terminalSaved) await releaseJob(job.id, workerId).catch(() => undefined);
  }
  // 能否安全地继续领取下一个任务？
  //   - 终态没落库（含"保存终态时自己又失败"）⇒ 结果不明 ⇒ 必须停下人工核对
  //   - 终态是 attention（付费结果/意图不明）⇒ 停下
  //   - 租约丢失 ⇒ 停下
  //   - review / completed / failed ⇒ 明确终态，可以继续
  if (!terminalSaved) return "needs_review";
  if (terminalStatus === "attention") return "needs_review";
  return leaseLost ? "needs_review" : "safe";
}
