export const VIDEO_DRAFT_LIMIT = 10;
export const VIDEO_ACTIVE_LIMIT = 10;
export const VIDEO_DRAFT_TTL_SECONDS = 86400;
export const VIDEO_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;
export const VIDEO_ACTIVE_STATUSES = ["queued", "preparing", "review", "generating", "assembling", "attention"] as const;
export type CancellationReason = "user_cancelled" | "draft_expired" | "user_closed";
export type VideoJobUsage = {
  observed_at: string;
  active: { count: number; limit: number; remaining: number; counted_statuses: string[]; includes_unknown_statuses: true };
  drafts: { count: number; limit: number; remaining: number; ttl_seconds: number };
  terminal_statuses: string[];
};
export type VideoJobSummary = {
  kind?: "single_call";
  id: string; title: string; status: string; stage: string; revision: number;
  created_at: string; updated_at: string; progress_updated_at: string | null;
  counts_toward_limit: boolean; quota_bucket: "draft" | "active" | null;
  can_cancel: boolean; cancel_blocked_reason: string | null; draft_expires_at: string | null;
  can_close: boolean; close_blocked_reason: string | null;
  cancelled_at: string | null; cancellation_reason: CancellationReason | null;
};
export type VideoJobList = { jobs: VideoJobSummary[]; next_cursor: string | null; usage: VideoJobUsage };
export type VideoJobCancelResponse = { id: string; status: "cancelled"; revision: number; job: VideoJobSummary; usage: VideoJobUsage };
type GuardJob = { status: string; phase: string; revision: number; lease_owner: string | null; lease_until: Date | null; error: string | null; data: unknown };
type SummaryJob = GuardJob & { id: string; title: string; stage: string; created_at: Date; updated_at: Date };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const label = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const roles = ["product", "character", "scene", "product_detail", "start_state", "end_state"];
function initialReferences(value: unknown, max = 6): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(ref => record(ref) &&
    only(ref, ["assetId", "role", "label"]) && identifier(ref.assetId) && typeof ref.role === "string" && roles.includes(ref.role) && label(ref.label, 80)) &&
    new Set(value.map(ref => ref.assetId)).size === value.length;
}
/** Whitelist the raw initial schema. A new field needs an explicit safety decision here. */
function initialData(value: unknown): boolean {
  if (!record(value) || !only(value, ["version", "generationMode", "referenceImages", "workflowProfile", "segments", "imageCalls"]) ||
    value.version !== 1 || value.imageCalls !== 0 || !Array.isArray(value.segments)) return false;
  if (value.generationMode === undefined || value.generationMode === "legacy_frames")
    return value.segments.length === 0 && !("referenceImages" in value) && !("workflowProfile" in value);
  if (value.generationMode === "direct_references") return value.segments.length === 0 && !("workflowProfile" in value) &&
    initialReferences(value.referenceImages, 3) && value.referenceImages.length === 3 && value.referenceImages[0].role === "product" &&
    value.referenceImages.slice(1).every(ref => typeof ref.role === "string" && ["character", "scene", "product_detail"].includes(ref.role));
  if (value.generationMode !== "six_references" || value.workflowProfile !== "sixref-v1" ||
    !initialReferences(value.referenceImages) || value.segments.length < 1 || value.segments.length > 8) return false;
  let end = 0;
  return value.segments.every((s, index) => {
    if (!record(s) || !only(s, ["index", "start", "duration", "trimStart", "sourceWindowDuration", "attempt", "instructions", "beforeState", "afterState", "referenceImages", "startFromSegment"]) ||
      s.index !== index || typeof s.start !== "number" || !Number.isFinite(s.start) || s.start < 0 || Math.abs(s.start - end) > 0.001 ||
      typeof s.duration !== "number" || ![4, 5, 6, 8].includes(s.duration) || s.trimStart !== 0 || s.attempt !== 0 ||
      typeof s.sourceWindowDuration !== "number" || !Number.isFinite(s.sourceWindowDuration) || s.sourceWindowDuration <= 0 ||
      s.start + s.sourceWindowDuration > 30.12 || s.sourceWindowDuration / s.duration < 1 / 1.15 || s.sourceWindowDuration / s.duration > 1.15 ||
      !label(s.instructions, 1600) || !label(s.beforeState, 400) || !label(s.afterState, 400) || !initialReferences(s.referenceImages)) return false;
    if ("startFromSegment" in s && (typeof s.startFromSegment !== "number" || !Number.isInteger(s.startFromSegment) ||
      s.startFromSegment < 0 || s.startFromSegment >= index || s.referenceImages.filter(ref => ref.role === "start_state").length !== 1)) return false;
    end = s.start + s.sourceWindowDuration;
    return true;
  });
}
export function draftCancellationBlock(job: GuardJob, hasPermit: boolean): string | null {
  if (record(job.data) && "singleCall" in job.data) return "single_call_api_required";
  if (job.status !== "draft") return "not_draft";
  if (job.phase !== "prepare" || job.revision !== 0 || job.error !== null) return "state_changed";
  if (job.lease_owner !== null || job.lease_until !== null) return "lease_present";
  if (hasPermit) return "permit_history";
  return initialData(job.data) ? null : "invalid_draft_data";
}
export type ClosePermit = { attempt_id: string; status: string };
/** A paused local state is not proof that an upstream request has finished. */
export function videoJobClosureBlock(job: GuardJob & { id: string }, permits: ClosePermit[]): string | null {
  if (record(job.data) && "singleCall" in job.data) return "single_call_api_required";
  if (!["review", "attention"].includes(job.status)) return "not_closable_state";
  if (job.lease_owner !== null || job.lease_until !== null) return "lease_present";
  if (permits.some(permit => permit.status !== "released")) return "unreleased_permit";
  const data = job.data;
  if (!record(data) || data.version !== 1 || !Array.isArray(data.segments) ||
    !Number.isSafeInteger(data.imageCalls) || (data.imageCalls as number) < 0 ||
    ![undefined, "legacy_frames", "direct_references", "six_references"].includes(data.generationMode as string | undefined) ||
    !["prepare", "prepare_references", "prepare_sixref", "render", "reconcile", "assemble"].includes(job.phase)) return "invalid_job_data";
  const released = new Set(permits.map(permit => permit.attempt_id));
  let savedImages = 0;
  const indices = new Set<number>();
  const receipt = (value: unknown) => typeof value === "string" && value.length > 0;
  for (const segment of data.segments) {
    if (!record(segment) || !Number.isSafeInteger(segment.index) || (segment.index as number) < 0 || indices.has(segment.index as number) ||
      (segment.attempt !== undefined && (!Number.isSafeInteger(segment.attempt) || (segment.attempt as number) < 0)) ||
      (segment.history !== undefined && !Array.isArray(segment.history))) return "invalid_job_data";
    indices.add(segment.index as number);
    savedImages += Number(receipt(segment.openingKey)) + Number(receipt(segment.endingKey));
    const finished = (attempt: Record<string, unknown>, number: number) =>
      receipt(attempt.candidateKey) || attempt.terminalFailure === true || released.has(`${job.id}:${segment.index}:${number}`);
    const attempted = (attempt: Record<string, unknown>) => ["submissionIntentAt", "buildId", "providerTaskId"].some(key => key in attempt && attempt[key] != null);
    if (attempted(segment) && !finished(segment, (segment.attempt as number | undefined) ?? 0)) return "unresolved_submission";
    for (const history of (segment.history ?? []) as unknown[]) {
      if (!record(history) || !Number.isSafeInteger(history.attempt) || (history.attempt as number) < 0) return "invalid_job_data";
      if (attempted(history) && !finished(history, history.attempt as number)) return "unresolved_submission";
    }
  }
  if ((data.generationMode === undefined || data.generationMode === "legacy_frames")
    ? (data.imageCalls as number) > savedImages : data.imageCalls !== 0) return "unresolved_image_submission";
  return null;
}
export function videoQuotaBucket(status: string): "draft" | "active" | null {
  return status === "draft" ? "draft" : (VIDEO_TERMINAL_STATUSES as readonly string[]).includes(status) ? null : "active";
}
export function draftExpiry(job: { created_at: Date }): Date { return new Date(job.created_at.getTime() + VIDEO_DRAFT_TTL_SECONDS * 1000); }
function iso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
export function summarizeVideoJob(job: SummaryJob, hasPermit = false, permits?: ClosePermit[]): VideoJobSummary {
  const blocked = draftCancellationBlock(job, hasPermit);
  const closeBlocked = permits ? videoJobClosureBlock(job, permits) : "permit_status_unavailable";
  const data = record(job.data) ? job.data : {};
  const audit = record(data.cancellation) ? data.cancellation : {};
  const reason = job.status === "cancelled" && typeof audit.reason === "string" && ["user_cancelled", "draft_expired", "user_closed"].includes(audit.reason) ? audit.reason as CancellationReason : null;
  const bucket = videoQuotaBucket(job.status);
  return { id: job.id, title: job.title, status: job.status, stage: job.stage, revision: job.revision,
    ...(record(job.data) && "singleCall" in job.data ? { kind: "single_call" as const } : {}),
    created_at: job.created_at.toISOString(), updated_at: job.updated_at.toISOString(),
    progress_updated_at: record(data.progress) ? iso(data.progress.lastProgressAt) : null,
    counts_toward_limit: bucket === "active", quota_bucket: bucket, can_cancel: blocked === null, cancel_blocked_reason: blocked,
    can_close: closeBlocked === null, close_blocked_reason: closeBlocked,
    draft_expires_at: blocked === null ? draftExpiry(job).toISOString() : null,
    cancelled_at: reason ? iso(audit.at) : null, cancellation_reason: reason };
}
