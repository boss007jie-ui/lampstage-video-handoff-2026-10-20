import { effectiveSixReferences, readySixSegments } from "./six-reference-plan";
import { candidateReviewToken } from "./candidate-review";
import { assessCandidateTiming } from "./candidate-quality";
import { Prisma, type VideoAsset, type VideoJob } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isVideoPreparation, segmentCoinQuote, videoData, type VideoJobData, type VideoJobView, type VideoStatus } from "./types";
import { generationMode, preparedReferencesReady } from "./reference-inputs";
import { reviewToken } from "./review-token";

export const LEASE_MS = 90_000;
type RepositoryDb = Pick<typeof prisma, "videoJob">;
export class LeaseLostError extends Error { constructor() { super("任务租约已失效"); } }

export function jobView(job: VideoJob & { source_asset?: VideoAsset }): VideoJobView {
  const data = videoData(job.data);
  const media = (kind: string, segment?: number) => `/api/videos/projects/${encodeURIComponent(job.id)}/media?kind=${kind}${segment === undefined ? "" : `&segment=${segment}`}`;
  const quote = segmentCoinQuote(generationMode(data));
  return {
    id: job.id, title: job.title, status: job.status as VideoStatus, stage: job.stage,
    instructions: job.instructions, preserve_audio: job.preserve_audio,
    generation_mode: generationMode(data),
    references_ready: generationMode(data) !== "legacy_frames" ? preparedReferencesReady(data) : data.segments.length > 0 && data.segments.every(s => Boolean(s.openingKey && s.endingKey && s.clipKey)),
    reference_assets: (data.referenceImages ?? []).map((ref, i) => ({ picture: i + 1, asset_id: ref.assetId, role: ref.role, label: ref.label,
      url: ref.key ? media("reference", i) : null, sha256: ref.sha256 ?? null })),
    source_url: media("source"), product_url: generationMode(data) !== "legacy_frames" && data.referenceImages?.[0]?.key ? media("reference", 0) : media("product"), source_duration: data.sourceDuration ?? null,
    error: job.error, created_at: job.created_at.toISOString(), updated_at: job.updated_at.toISOString(),
    // 业务进展与数据库 updated_at 分开：后者会被 20 秒一次的租约心跳刷新，不能当业务推进的证据。
    progress_updated_at: data.progress?.lastProgressAt ?? null,
    stage_code: data.progress?.stageCode ?? null,
    // 审阅标识只在"可提交审阅"时签发；展示后的任何状态变化都会改变它。
    review_token: job.status === "review" ? reviewToken({ jobId: job.id, data, quote }) : null,
    candidate_review_token: ["review", "attention"].includes(job.status) ? candidateReviewToken(job.id, data) : null,
    ready_segment_indices: ["completed", "failed", "cancelled"].includes(job.status) ? [] : generationMode(data) === "six_references" ? readySixSegments(data).map(s => s.index) : data.segments.filter(s => !s.candidateKey).map(s => s.index),
    pricing_basis: quote === null ? "unpriced_technical_cap" as const : "configured_quote" as const,
    segments: data.segments.map(s => ({ index: s.index, start: s.start, duration: s.duration,
      opening_url: s.openingKey ? media("opening", s.index) : null,
      ending_url: s.endingKey ? media("ending", s.index) : null,
      candidate_url: s.candidateKey ? media("candidate", s.index) : null,
      source_duration: s.sourceWindowDuration, instructions: s.instructions, before_state: s.beforeState, after_state: s.afterState, start_from_segment: s.startFromSegment,
      candidate_sha256: s.candidateSha256, candidate_media: s.candidateMedia, tail_url: s.tailKey ? media("tail", s.index) : null, tail_sha256: s.tailSha256, accepted: Boolean(s.accepted), attempt: s.attempt ?? 0,
      ...(generationMode(data) === "six_references" && s.candidateKey ? { candidate_timing: assessCandidateTiming(data.segments, s.index) } : {}),
      reference_assets: (s.startFromSegment !== undefined && data.segments[s.startFromSegment]?.accepted
        ? effectiveSixReferences(data, s) : s.referenceImages ?? []).map((r, i) => ({ picture: i + 1, asset_id: r.assetId, role: r.role, label: r.label, sha256: r.sha256 ?? null, url: r.key ? `${media("segment_reference", s.index)}&picture=${i}` : null })) })),
    output_url: data.outputKey ? media("output") : null,
    download_url: data.outputKey ? `${media("output")}&download=1` : null,
    estimate: { segments: data.segments.length, image_calls: data.imageCalls, video_coins: quote === null ? null : quote * (generationMode(data) === "six_references" ? readySixSegments(data).length : data.segments.filter(s => !s.candidateKey).length) },
  };
}

/** An expired claim is never placed back on the paid queue automatically. */
export async function claimJob(workerId: string, db: RepositoryDb = prisma, options: { recoveryOnly?: boolean } = {}): Promise<VideoJob | null> {
  const now = new Date();
  await db.videoJob.updateMany({
    where: { status: { in: ["preparing", "generating", "assembling"] }, lease_until: { lt: now } },
    data: { status: "attention", stage: "处理已中断，请核对已提交的任务", error: "工作进程租约过期；不会自动重复生成。", lease_owner: null, lease_until: null, revision: { increment: 1 } },
  });
  const candidates = await db.videoJob.findMany({ where: { status: "queued", lease_owner: null, ...(options.recoveryOnly ? { phase: { in: ["reconcile", "assemble"] } } : {}) }, orderBy: { created_at: "asc" }, take: 10 });
  for (const candidate of candidates) {
    const claimed = await db.videoJob.updateMany({
      where: { id: candidate.id, status: "queued", revision: candidate.revision, lease_owner: null },
      data: { status: isVideoPreparation(candidate.phase) ? "preparing" : candidate.phase === "assemble" ? "assembling" : "generating", lease_owner: workerId,
        lease_until: new Date(Date.now() + LEASE_MS), revision: { increment: 1 }, error: null },
    });
    if (claimed.count === 1) return db.videoJob.findFirst({ where: { id: candidate.id, lease_owner: workerId } });
  }
  return null;
}

type JobPatch = { expectedRevision: number; status?: string; phase?: string; stage?: string; error?: string | null };
export async function patchJob(jobId: string, owner: string, patch: JobPatch, data?: VideoJobData, db: RepositoryDb = prisma): Promise<VideoJob> {
  const { expectedRevision, ...fields } = patch;
  const result = await db.videoJob.updateMany({
    where: { id: jobId, lease_owner: owner, lease_until: { gt: new Date() }, revision: expectedRevision },
    data: { ...fields, ...(data ? { data: data as unknown as Prisma.InputJsonValue } : {}), revision: { increment: 1 } },
  });
  if (result.count !== 1) throw new LeaseLostError();
  const refreshed = await db.videoJob.findFirst({ where: { id: jobId, lease_owner: owner, revision: expectedRevision + 1 } });
  if (!refreshed) throw new LeaseLostError();
  return refreshed;
}

export async function heartbeatLease(jobId: string, owner: string, db: RepositoryDb = prisma): Promise<void> {
  const result = await db.videoJob.updateMany({
    where: { id: jobId, lease_owner: owner, lease_until: { gt: new Date() } },
    data: { lease_until: new Date(Date.now() + LEASE_MS) },
  });
  if (result.count !== 1) throw new LeaseLostError();
}

export async function releaseJob(jobId: string, owner: string): Promise<void> {
  await prisma.videoJob.updateMany({ where: { id: jobId, lease_owner: owner }, data: { lease_owner: null, lease_until: null } });
}

/** Single-call cleanup; legacy processors retain their existing release behavior. */
export async function releaseInterruptedJob(jobId: string, owner: string, db: RepositoryDb = prisma): Promise<void> {
  // A heartbeat/terminal-save failure must not leave a running status with a NULL
  // lease: neither the expiry sweep nor explicit reconciliation could recover it.
  // Do not write the caller's potentially stale JSON or require a still-live lease.
  const running = ["preparing", "generating", "assembling"];
  const interrupted = await db.videoJob.updateMany({
    where: { id: jobId, lease_owner: owner, status: { in: running } },
    data: { status: "attention", stage: "处理已中断，请核对已提交的任务", error: "工作进程未能保存终态；不会自动重复生成。",
      lease_owner: null, lease_until: null, revision: { increment: 1 } },
  });
  if (interrupted.count) return;
  await db.videoJob.updateMany({ where: { id: jobId, lease_owner: owner, status: { notIn: running } }, data: { lease_owner: null, lease_until: null } });
}
