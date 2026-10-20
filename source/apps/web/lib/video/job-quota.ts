import { isSingleCallJob } from "../video-calls/contract";
import { validateDraftCharacterBindings, CharacterBindingError, type CharacterSlotSelection, type CharacterSlotPin } from "../characters/bindings";
import { Prisma, type PrismaClient, type VideoJob } from "@prisma/client";
import { prisma } from "../db";
import type { VideoJobData } from "./types";
import { cleanTemplateRecipe, templateStructureSignature } from "./template-recipe";
import { VIDEO_ACTIVE_LIMIT, VIDEO_ACTIVE_STATUSES, VIDEO_DRAFT_LIMIT, VIDEO_DRAFT_TTL_SECONDS, VIDEO_TERMINAL_STATUSES,
  draftCancellationBlock, draftExpiry, summarizeVideoJob, videoQuotaBucket, videoJobClosureBlock,
  type CancellationReason, type VideoJobCancelResponse, type VideoJobList, type VideoJobUsage } from "./job-lifecycle";

export type LifecycleResult<T> = { ok: true; value: T } | { ok: false; status: number; body: Record<string, unknown> };
type Options = { db?: PrismaClient; now?: Date; admissionError?: string };
type Tx = Prisma.TransactionClient;
export type CreateVideoDraftInput = { source_asset_id: string; product_asset_id: string; title: string; instructions: string;
  preserve_audio: boolean; stage: string; data: VideoJobData; template_version_id?: string; character_bindings?: CharacterSlotSelection[] };
const terminal = [...VIDEO_TERMINAL_STATUSES];
const activeWhere = { status: { notIn: ["draft", ...terminal] } };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LifecycleResult<never> => ({ ok: false, status, body: { error, ...extra } });
const success = <T>(value: T): LifecycleResult<T> => ({ ok: true, value });
const transactionOptions = { maxWait: 15_000, timeout: 15_000 };
async function lockUser(tx: Tx, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  return rows.length === 1;
}
async function currentTime(tx: Tx, options: Options) {
  if (options.now) return options.now;
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}
async function permitIds(tx: Tx, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await tx.videoPermit.findMany({ where: { job_id: { in: ids } }, select: { job_id: true }, distinct: ["job_id"] });
  return new Set(rows.map(row => row.job_id));
}
async function usage(tx: Tx, userId: string, now: Date): Promise<VideoJobUsage> {
  const groups = await tx.videoJob.groupBy({ by: ["status"], where: { user_id: userId }, _count: { _all: true } });
  let drafts = 0; let active = 0;
  for (const row of groups) {
    if (videoQuotaBucket(row.status) === "draft") drafts += row._count._all;
    else if (videoQuotaBucket(row.status) === "active") active += row._count._all;
  }
  return { observed_at: now.toISOString(),
    active: { count: active, limit: VIDEO_ACTIVE_LIMIT, remaining: Math.max(0, VIDEO_ACTIVE_LIMIT - active),
      counted_statuses: [...VIDEO_ACTIVE_STATUSES], includes_unknown_statuses: true },
    drafts: { count: drafts, limit: VIDEO_DRAFT_LIMIT, remaining: Math.max(0, VIDEO_DRAFT_LIMIT - drafts), ttl_seconds: VIDEO_DRAFT_TTL_SECONDS },
    terminal_statuses: terminal };
}
function quotaDenied(bucket: "draft" | "active", counts: VideoJobUsage): LifecycleResult<never> {
  const count = bucket === "draft" ? counts.drafts : counts.active;
  return fail(429, bucket === "draft" ? "video_draft_limit_reached" : "video_job_limit_reached", {
    scope: "account", quota_bucket: bucket, limit: count.limit, count: count.count, remaining: count.remaining, retryable: false,
    message: bucket === "draft" ? "草稿已达上限。请查看现有任务，并取消不再需要且允许取消的草稿。" : "同时进行的任务已达上限。请继续现有任务，或关闭不再需要且允许关闭的已停止任务。",
    usage: counts, actions: bucket === "draft" ? ["list_video_jobs", "cancel_video_job"] : ["list_video_jobs", "continue_existing_job", "close_video_job"],
  });
}
/** Caller holds the User lock. Retain the raw data and append only cancellation audit. */
async function cancelEligible(tx: Tx, job: VideoJob, reason: CancellationReason, now: Date, hasPermit: boolean): Promise<VideoJob | null> {
  if (draftCancellationBlock(job, hasPermit) !== null || (reason === "draft_expired" && draftExpiry(job) > now)) return null;
  const cutoff = new Date(now.getTime() - VIDEO_DRAFT_TTL_SECONDS * 1000);
  const changed = await tx.videoJob.updateMany({ where: { id: job.id, user_id: job.user_id, status: "draft", revision: job.revision,
    lease_owner: null, lease_until: null, ...(reason === "draft_expired" ? { created_at: { lte: cutoff } } : {}) },
    data: { status: "cancelled", stage: reason === "draft_expired" ? "草稿已过期" : "草稿已取消", revision: { increment: 1 },
      data: { ...(job.data as Prisma.JsonObject), cancellation: { at: now.toISOString(), reason } } } });
  return changed.count === 1 ? tx.videoJob.findFirst({ where: { id: job.id, user_id: job.user_id } }) : null;
}
/** Bounded fallback when the periodic worker is unavailable; never runs from GET. */
async function expireUserDrafts(tx: Tx, userId: string, now: Date) {
  const rows = await tx.videoJob.findMany({ where: { user_id: userId, status: "draft", created_at: { lte: new Date(now.getTime() - VIDEO_DRAFT_TTL_SECONDS * 1000) } },
    orderBy: [{ created_at: "asc" }, { id: "asc" }], take: 100 });
  const permits = await permitIds(tx, rows.map(row => row.id));
  for (const job of rows) await cancelEligible(tx, job, "draft_expired", now, permits.has(job.id));
}
export async function createVideoDraft(userId: string, input: CreateVideoDraftInput, options: Options = {}): Promise<LifecycleResult<VideoJob>> {
  return (options.db ?? prisma).$transaction(async tx => {
    if (!await lockUser(tx, userId)) return fail(404, "not_found");
    const now = await currentTime(tx, options);
    await expireUserDrafts(tx, userId, now);
    const counts = await usage(tx, userId, now);
    if (counts.drafts.count >= VIDEO_DRAFT_LIMIT) return quotaDenied("draft", counts);
    let templatePins: CharacterSlotPin[] = [];
    if (input.template_version_id) {
      const version = await tx.videoTemplateVersion.findFirst({ where: { id: input.template_version_id,
        template: { user_id: userId, archived: false },
        source_asset: { user_id: userId, sha256: { not: null } } }, include: { template: true, source_asset: true, character_bindings: true } });
      const source = await tx.videoAsset.findFirst({ where: { id: input.source_asset_id, user_id: userId } });
      if (!version || !source || source.sha256 !== version.source_sha256) return fail(409, "template_source_mismatch");
      if (![1, 2].includes(version.recipe_schema_version)) return fail(409, "template_schema_unsupported");
      templatePins = version.character_bindings;
      try {
        const recipe = cleanTemplateRecipe(input);
        if (templateStructureSignature(recipe, source.sha256) !== version.structure_signature ||
          version.structure_signature !== version.template.structure_signature) return fail(409, "template_structure_mismatch");
      } catch { return fail(409, "template_structure_mismatch"); }
    }
    const { character_bindings, ...fields } = input;
    let pins: CharacterSlotPin[];
    try { pins = await validateDraftCharacterBindings(tx, userId, input.data, character_bindings ?? [], templatePins); }
    catch (e) { if (e instanceof CharacterBindingError) return fail(e.status, e.code); throw e; }
    const job = await tx.videoJob.create({ data: { user_id: userId, ...fields, data: input.data as object, created_at: now } });
    if (pins.length) await tx.videoJobCharacterBinding.createMany({ data: pins.map(pin => ({ job_id: job.id, ...pin })) });
    return success(job);
  }, transactionOptions);
}
export async function prepareVideoDraft(userId: string, jobId: string, options: Options = {}): Promise<LifecycleResult<{ job: VideoJob; queued: boolean }>> {
  return (options.db ?? prisma).$transaction(async tx => {
    if (!await lockUser(tx, userId)) return fail(404, "not_found");
    const now = await currentTime(tx, options);
    let job = await tx.videoJob.findFirst({ where: { id: jobId, user_id: userId } });
    if (!job) return fail(404, "not_found");
    if (isSingleCallJob(job.data)) return fail(409, "single_call_api_required");
    await expireUserDrafts(tx, userId, now);
    // Check the target separately, including when an over-limit historical account exceeds the fallback batch.
    job = await tx.videoJob.findFirst({ where: { id: jobId, user_id: userId } });
    if (!job) return fail(404, "not_found");
    if (isSingleCallJob(job.data)) return fail(409, "single_call_api_required");
    const permits = await permitIds(tx, [job.id]);
    const expired = await cancelEligible(tx, job, "draft_expired", now, permits.has(job.id));
    if (expired) job = expired;
    if (job.status === "cancelled") return fail(409, "video_job_cancelled", { message: "该任务已取消或关闭，请查看历史记录。", job: summarizeVideoJob(job, permits.has(job.id)) });
    if (job.status !== "draft") return success({ job, queued: false });
    if (options.admissionError) return fail(503, "video_worker_unavailable", { message: options.admissionError });
    if (job.lease_owner !== null || job.lease_until !== null) return fail(409, "job_state_changed");
    const counts = await usage(tx, userId, now);
    if (counts.active.count >= VIDEO_ACTIVE_LIMIT) return quotaDenied("active", counts);
    const raw = job.data as Record<string, unknown> | null;
    const mode = raw?.generationMode;
    if (mode !== undefined && (typeof mode !== "string" || !["legacy_frames", "direct_references", "six_references"].includes(mode))) return fail(409, "job_state_changed");
    const direct = mode === "direct_references" || mode === "six_references";
    const changed = await tx.videoJob.updateMany({ where: { id: job.id, user_id: userId, status: "draft", revision: job.revision, lease_owner: null, lease_until: null },
      data: { status: "queued", phase: mode === "six_references" ? "prepare_sixref" : direct ? "prepare_references" : "prepare",
        stage: direct ? "等待校验参考图并切分原视频" : "等待拆解参考视频并生成参考帧", error: null, revision: { increment: 1 } } });
    if (changed.count !== 1) return fail(409, "job_state_changed");
    const queued = await tx.videoJob.findFirst({ where: { id: jobId, user_id: userId } });
    return queued ? success({ job: queued, queued: true }) : fail(409, "job_state_changed");
  }, transactionOptions);
}
export async function cancelVideoDraft(userId: string, jobId: string, options: Options = {}): Promise<LifecycleResult<VideoJobCancelResponse>> {
  return (options.db ?? prisma).$transaction(async tx => {
    if (!await lockUser(tx, userId)) return fail(404, "not_found");
    const now = await currentTime(tx, options);
    let job = await tx.videoJob.findFirst({ where: { id: jobId, user_id: userId } });
    if (!job) return fail(404, "not_found");
    if (isSingleCallJob(job.data)) return fail(409, "single_call_api_required");
    const permits = await permitIds(tx, [job.id]);
    if (job.status !== "cancelled") {
      const reason = draftCancellationBlock(job, permits.has(job.id));
      if (reason) return fail(409, "video_job_not_cancellable", { reason, message: "该任务当前不能作为未启动草稿取消，请查看最新状态。", job: summarizeVideoJob(job, permits.has(job.id)) });
      const cancelled = await cancelEligible(tx, job, "user_cancelled", now, permits.has(job.id));
      if (!cancelled) {
        const current = await tx.videoJob.findFirst({ where: { id: jobId, user_id: userId } });
        return current ? fail(409, "video_job_not_cancellable", { reason: "state_changed", message: "任务状态已更新，请重新查看。", job: summarizeVideoJob(current, permits.has(job.id)) }) : fail(404, "not_found");
      }
      job = cancelled;
    }
    return success({ id: job.id, status: "cancelled", revision: job.revision, job: summarizeVideoJob(job, permits.has(job.id)), usage: await usage(tx, userId, now) });
  }, transactionOptions);
}
export async function getVideoJobUsage(userId: string, options: Options = {}): Promise<VideoJobUsage> {
  return usage(options.db ?? prisma, userId, options.now ?? new Date());
}
/** User -> Job lock. Permit insertion also locks Job, preventing a late paid request after closure. */
export async function closeVideoJob(userId: string, jobId: string, expectedRevision: number, options: Options = {}): Promise<LifecycleResult<VideoJobCancelResponse>> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail(400, "invalid_expected_revision");
  return (options.db ?? prisma).$transaction(async tx => {
    if (!await lockUser(tx, userId)) return fail(404, "not_found");
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoJob" WHERE id = ${jobId} AND user_id = ${userId} FOR UPDATE`;
    if (locked.length !== 1) return fail(404, "not_found");
    let job = await tx.videoJob.findFirst({ where: { id: jobId, user_id: userId } });
    if (!job) return fail(404, "not_found");
    if (isSingleCallJob(job.data)) return fail(409, "single_call_api_required");
    const now = await currentTime(tx, options);
    const permits = await tx.videoPermit.findMany({ where: { job_id: jobId }, select: { attempt_id: true, status: true } });
    const audit = (job.data as unknown as VideoJobData)?.cancellation;
    const replay = job.status === "cancelled" && audit?.reason === "user_closed" && audit.previous_revision === expectedRevision;
    if (!replay) {
      if (job.revision !== expectedRevision) return fail(409, "job_state_changed", { message: "任务状态已更新，请重新查看后再关闭。" });
      const reason = videoJobClosureBlock(job, permits);
      if (reason) return fail(409, "video_job_not_closable", { reason, message: "该任务仍在运行或有未确认的生成请求，暂时不能关闭。", job: summarizeVideoJob(job, permits.length > 0, permits) });
      const changed = await tx.videoJob.updateMany({ where: { id: jobId, user_id: userId, status: job.status, revision: expectedRevision, lease_owner: null, lease_until: null },
        data: { status: "cancelled", stage: "任务已关闭", revision: { increment: 1 },
          data: { ...(job.data as Prisma.JsonObject), cancellation: { at: now.toISOString(), reason: "user_closed", previous_status: job.status, previous_revision: job.revision } } } });
      if (changed.count !== 1) return fail(409, "job_state_changed");
      job = await tx.videoJob.findFirst({ where: { id: jobId, user_id: userId } });
      if (!job) return fail(404, "not_found");
    if (isSingleCallJob(job.data)) return fail(409, "single_call_api_required");
    }
    return success({ id: job.id, status: "cancelled", revision: job.revision, job: summarizeVideoJob(job, permits.length > 0, permits), usage: await usage(tx, userId, now) });
  }, transactionOptions);
}
type ListOptions = { status?: string; limit?: string | number; cursor?: string };
type PageCursor = { v: 1; created_at: string; id: string };
function decodeCursor(value: string): PageCursor | null {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as PageCursor;
    if (!raw || raw.v !== 1 || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id) || typeof raw.created_at !== "string" ||
      !Number.isFinite(Date.parse(raw.created_at)) || new Date(raw.created_at).toISOString() !== raw.created_at) return null;
    return raw;
  } catch { return null; }
}
export async function listVideoJobs(userId: string, query: ListOptions = {}, options: Options = {}): Promise<LifecycleResult<VideoJobList>> {
  const filter = query.status ?? "all";
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!["all", "draft", "active", "history"].includes(filter) || !Number.isInteger(limit) || limit < 1 || limit > 50 ||
    (typeof query.limit === "string" && !/^\d+$/.test(query.limit))) return fail(400, "invalid_video_job_query");
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && !cursor) return fail(400, "invalid_video_job_cursor");
  return (options.db ?? prisma).$transaction(async tx => {
    const where: Prisma.VideoJobWhereInput = { user_id: userId,
      ...(filter === "draft" ? { status: "draft" } : filter === "active" ? activeWhere : filter === "history" ? { status: { in: terminal } } : {}),
      ...(cursor ? { OR: [{ created_at: { lt: new Date(cursor.created_at) } }, { created_at: new Date(cursor.created_at), id: { lt: cursor.id } }] } : {}) };
    const rows = await tx.videoJob.findMany({ where, orderBy: [{ created_at: "desc" }, { id: "desc" }], take: limit + 1 });
    const page = rows.slice(0, limit);
    const permits = await tx.videoPermit.findMany({ where: { job_id: { in: page.map(row => row.id) } }, select: { job_id: true, attempt_id: true, status: true } });
    const last = page[page.length - 1];
    return success({ jobs: page.map(job => { const own = permits.filter(permit => permit.job_id === job.id); return summarizeVideoJob(job, own.length > 0, own); }),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, created_at: last.created_at.toISOString(), id: last.id })).toString("base64url") : null,
      usage: await usage(tx, userId, options.now ?? new Date()) });
  }, { ...transactionOptions, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export type DraftSweepCursor = { createdAt: string; id: string };
export async function sweepExpiredDrafts(input: { cursor?: DraftSweepCursor | null; limit?: number; cutoff?: Date } = {}, options: Options = {}) {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const cutoff = input.cutoff ?? new Date(now.getTime() - VIDEO_DRAFT_TTL_SECONDS * 1000);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
  const cursor = input.cursor;
  const candidates = await db.videoJob.findMany({ where: { status: "draft", created_at: { lte: cutoff },
    ...(cursor ? { OR: [{ created_at: { gt: new Date(cursor.createdAt) } }, { created_at: new Date(cursor.createdAt), id: { gt: cursor.id } }] } : {}) },
    orderBy: [{ created_at: "asc" }, { id: "asc" }], take: limit + 1, select: { id: true, user_id: true, created_at: true } });
  const batch = candidates.slice(0, limit);
  let cancelled = 0;
  for (const candidate of batch) {
    const didCancel = await db.$transaction(async tx => {
      if (!await lockUser(tx, candidate.user_id)) return false;
      const job = await tx.videoJob.findFirst({ where: { id: candidate.id, user_id: candidate.user_id, status: "draft", created_at: { lte: cutoff } } });
      if (!job) return false;
      const permits = await permitIds(tx, [job.id]);
      return Boolean(await cancelEligible(tx, job, "draft_expired", await currentTime(tx, options), permits.has(job.id)));
    }, transactionOptions);
    if (didCancel) cancelled++;
  }
  const done = candidates.length <= limit;
  const last = batch[batch.length - 1];
  return { cursor: !done && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null,
    scanned: batch.length, cancelled, blocked: batch.length - cancelled, done };
}
