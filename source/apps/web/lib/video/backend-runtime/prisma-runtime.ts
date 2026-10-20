import type { PrismaClient, VideoJob } from "@prisma/client";
import type { ActorContext } from "../../agent/contracts";
import type { AgentTransaction } from "../../agent/business-preparer";
import { databaseNow, json, lockRun, readState } from "../../agent/prisma-state";
import { settleAgentReservationInTransaction } from "../../agent/prisma-settlement";
import { digest } from "../../agent/policy";
import { originalImageKey, type ImageStorageConfig } from "../../jobs/image-storage-port";
import { fail, parseBinding, record, rejectLegacy, VideoRuntimeError, type RuntimeBinding } from "./binding";
import type { JobLeaseView, Permit, RuntimeTransaction } from "./transitions";
import { validatePreparedJob } from "./preparation";

export interface RuntimeStore {
  atomic<T>(actor: ActorContext, jobId: string, operation: (tx: RuntimeTransaction) => T): Promise<T>;
}
export type RuntimeFaultPoint = "after_permits" | "after_binding" | "after_slots";
export async function lockPermitAccount(tx: AgentTransaction, accountId: string): Promise<void> {
  await tx.videoPermitAccount.upsert({ where: { id: accountId }, create: { id: accountId }, update: { lock_version: { increment: 1 } } });
  await tx.videoPermitAccount.update({ where: { id: accountId }, data: { lock_version: { increment: 1 } } });
}
export async function lockVideoJob(tx: AgentTransaction, userId: string, jobId: string): Promise<VideoJob> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoJob" WHERE id = ${jobId} AND user_id = ${userId} FOR UPDATE`;
  if (!rows.length) return fail("job_missing");
  return (await tx.videoJob.findUnique({ where: { id: jobId } }))!;
}
export async function validateMaterials(tx: AgentTransaction, job: VideoJob, b: RuntimeBinding, storageConfig: ImageStorageConfig = {}): Promise<boolean> {
  try { rejectLegacy(job.data, record(job.data).videoRuntime ? b.segments : []); } catch { return false; }
  const materials = b.preparation.materials, videos = materials.filter(m => m.kind === "video_asset"), images = materials.filter(m => m.kind === "uploaded_asset");
  if (!validatePreparedJob(job, b.preparation, false) || videos.length !== 1 || videos[0].assetId !== job.source_asset_id
    || !images.some(m => m.role === "product" && m.assetId === job.product_asset_id)) return false;
  const source = await tx.videoAsset.findFirst({ where: { id: videos[0].assetId, user_id: b.userId, status: "ready" } });
  if (!source || source.sha256 !== videos[0].sha256 || source.storage_key !== videos[0].storageKey || !source.mime.startsWith("video/") || source.size_bytes <= 0) return false;
  const rows = await tx.uploadedAsset.findMany({ where: { id: { in: images.map(m => m.assetId) }, user_id: b.userId }, include: { image_content: true } });
  return images.every(m => {
    const asset = rows.find(r => r.id === m.assetId), content = asset?.image_content;
    if (!asset || !content || content.user_id !== b.userId || content.id !== m.imageContentId || content.sha256 !== m.sha256
      || asset.image_url !== m.assetLocation || content.storage_url !== m.contentLocation || content.size_bytes < 1 || content.size_bytes > 5 * 1024 * 1024
      || !["image/png", "image/jpeg", "image/webp"].includes(content.mime) || content.width <= 0 || content.height <= 0) return false;
    try {
      // 去重后的资产与 canonical content 路径可以不同，两条路径分别核对归属并固定。
      originalImageKey(b.userId, asset.image_url, storageConfig); originalImageKey(b.userId, content.storage_url, storageConfig);
      return true;
    } catch { return false; }
  });
}
function jobView(j: VideoJob): JobLeaseView {
  const d = record(j.data);
  const segments = Array.isArray(d.segments) ? d.segments.flatMap(s => {
    if (!s || typeof s !== "object") return [];
    const x = s as Record<string, unknown>;
    return typeof x.index === "number" ? [{ index: x.index, ...(typeof x.attempt === "number" ? { attempt: x.attempt } : {}) }] : [];
  }) : [];
  return { id: j.id, status: j.status, phase: j.phase, owner: j.lease_owner, until: j.lease_until?.getTime() ?? null, segments };
}
/** 保留旧准备字段和未选片段，同时同步旧 permit 孤儿判定读取的 attempt。 */
export function runtimeJobData(data: unknown, b: RuntimeBinding) {
  const d = record(data), previous = Array.isArray(d.segments) ? d.segments : [];
  return { ...d, videoRuntime: b, segments: previous.map(p => {
    const old = record(p), s = b.segments.find(s => s.index === old.index);
    return s ? { ...old, attempt: s.attempt } : old;
  }) };
}
/** 仅使用注入的 client；不读生产单例、环境密钥或共享队列。 */
export class PrismaVideoRuntimeStore implements RuntimeStore {
  constructor(private readonly client: PrismaClient, private readonly fault?: (point: RuntimeFaultPoint) => void, private readonly storageConfig: ImageStorageConfig = {}) {}
  async atomic<T>(actor: ActorContext, jobId: string, operation: (tx: RuntimeTransaction) => T): Promise<T> {
    try {
      if (!actor.permissions.includes("video.generate")) fail("tool_forbidden");
      return await this.client.$transaction(async tx => {
        // 不持视频锁读取路由提示，取得统一锁序后再次核验，避免反向进入 core 锁。
        const hintJob = await tx.videoJob.findFirst({ where: { id: jobId, user_id: actor.userId } });
        if (!hintJob) return fail("job_missing");
        const hint = parseBinding(hintJob.data);
        await lockRun(tx, actor, hint.runId);
        await lockPermitAccount(tx, hint.accountId);
        const job = await lockVideoJob(tx, actor.userId, jobId), binding = parseBinding(job.data);
        if (binding.userId !== actor.userId || binding.jobId !== jobId || binding.runId !== hint.runId || binding.accountId !== hint.accountId) fail("binding_changed");
        await tx.$queryRaw`SELECT attempt_id FROM "VideoPermit" WHERE account_id = ${binding.accountId} ORDER BY attempt_id FOR UPDATE`;
        const core = (await readState(tx, actor, binding.runId)).snapshot;
        const coreStep = core.steps.find(s => s.attemptId === binding.coreAttemptId);
        if (!coreStep || coreStep.userId !== binding.userId || coreStep.jobId !== jobId || coreStep.stepKey !== binding.stepKey || !coreStep.businessManaged) fail("binding_changed");
        const rows = await tx.videoPermit.findMany({ where: { account_id: binding.accountId } });
        const permits: Permit[] = rows.map(p => ({ attemptId: p.attempt_id, accountId: p.account_id, jobId: p.job_id,
          segmentIndex: p.segment_index, maxCoins: p.max_coins, status: p.status as Permit["status"] }));
        if (permits.some(p => !["active", "unknown", "released"].includes(p.status))) fail("invalid_permit");
        const related = await tx.videoJob.findMany({ where: { id: { in: [...new Set(permits.map(p => p.jobId))] } } });
        const state: RuntimeTransaction = { now: await databaseNow(tx), actor, binding, currentData: job.data, core,
          materialsValid: await validateMaterials(tx, job, binding, this.storageConfig), permits, jobs: related.map(jobView), effects: [] };
        const result = operation(state);
        for (const p of permits) {
          const old = rows.find(r => r.attempt_id === p.attemptId);
          if (old && old.status === p.status) continue;
          const data = { status: p.status, ...(p.status === "unknown" ? { unknown_at: new Date(state.now) } : {}),
            ...(p.status === "released" ? { released_at: new Date(state.now) } : {}) };
          if (old) await tx.videoPermit.update({ where: { attempt_id: p.attemptId }, data });
          else await tx.videoPermit.create({ data: { attempt_id: p.attemptId, account_id: p.accountId, job_id: p.jobId,
            segment_index: p.segmentIndex, max_coins: p.maxCoins, reserved_coins: null, ...data } });
        }
        this.fault?.("after_permits");
        if (digest(binding) !== digest(parseBinding(job.data))) {
          const finished = binding.segments.every(s => ["collected", "failed", "not_submitted"].includes(s.state));
          await tx.videoJob.update({ where: { id: jobId }, data: { data: json(runtimeJobData(job.data, binding)),
            // 候选收取完成进入待审，不宣称已完成视频拼接交付。
            status: finished ? (binding.segments.every(s => s.state === "collected") ? "review" : "attention") : "generating",
            phase: "render", lease_owner: binding.lease?.owner ?? null,
            lease_until: binding.lease ? new Date(binding.lease.expiresAt) : null, revision: { increment: 1 } } });
        }
        this.fault?.("after_binding");
        for (const evidence of state.effects) await settleAgentReservationInTransaction(tx, actor,
          { runId: binding.runId, attemptId: binding.coreAttemptId, unit: "video_second" }, evidence);
        this.fault?.("after_slots");
        return result;
      }, { maxWait: 10000, timeout: 20000 });
    } catch (error) {
      if (error instanceof VideoRuntimeError) throw error;
      throw new VideoRuntimeError("persistence_failed");
    }
  }
}
