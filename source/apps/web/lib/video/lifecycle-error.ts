type SafeObject = Record<string, unknown>;
const object = (value: unknown): value is SafeObject => !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max = 500): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const shortString = (value: unknown, max = 200): value is string => typeof value === "string" && value.length <= max;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const iso = (value: unknown): value is string => bounded(value, 40) && !Number.isNaN(Date.parse(value));
const strings = (value: unknown, max = 30): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => bounded(item, 80));

function safeUsage(value: unknown): SafeObject | null {
  if (!object(value) || !iso(value.observed_at) || !object(value.active) || !object(value.drafts) || !strings(value.terminal_statuses)) return null;
  const { active, drafts } = value;
  if (![active.count, active.limit, active.remaining, drafts.count, drafts.limit, drafts.remaining, drafts.ttl_seconds].every(integer) ||
      !strings(active.counted_statuses) || active.includes_unknown_statuses !== true) return null;
  return {
    observed_at: value.observed_at,
    active: { count: active.count, limit: active.limit, remaining: active.remaining, counted_statuses: active.counted_statuses, includes_unknown_statuses: true },
    drafts: { count: drafts.count, limit: drafts.limit, remaining: drafts.remaining, ttl_seconds: drafts.ttl_seconds },
    terminal_statuses: value.terminal_statuses,
  };
}

function safeSummary(value: unknown): SafeObject | null {
  if (!object(value) || !bounded(value.id, 200) || !shortString(value.title) || !bounded(value.status, 80) || !shortString(value.stage, 80) ||
      !integer(value.revision) || !iso(value.created_at) || !iso(value.updated_at) ||
      (value.progress_updated_at !== null && !iso(value.progress_updated_at)) || typeof value.counts_toward_limit !== "boolean" ||
      !["draft", "active", null].includes(value.quota_bucket as string | null) || typeof value.can_cancel !== "boolean" ||
      (value.cancel_blocked_reason !== null && !bounded(value.cancel_blocked_reason, 120)) ||
      (value.draft_expires_at !== null && !iso(value.draft_expires_at)) ||
      (value.cancelled_at !== null && !iso(value.cancelled_at)) ||
      !["user_cancelled", "user_closed", "draft_expired", null].includes(value.cancellation_reason as string | null) ||
      (value.can_close !== undefined && typeof value.can_close !== "boolean") ||
      (value.close_blocked_reason !== undefined && value.close_blocked_reason !== null && !bounded(value.close_blocked_reason, 120))) return null;
  const keys = ["id", "title", "status", "stage", "revision", "created_at", "updated_at", "progress_updated_at", "counts_toward_limit", "quota_bucket", "can_cancel", "cancel_blocked_reason", "draft_expires_at", "cancelled_at", "cancellation_reason"];
  const optionalKeys = ["can_close", "close_blocked_reason"].filter(key => Object.prototype.hasOwnProperty.call(value, key));
  return Object.fromEntries([...keys, ...optionalKeys].map(key => [key, value[key]]));
}

/** Return only the frozen public lifecycle fields; never pass arbitrary upstream diagnostics into MCP. */
export function safeLifecycleErrorContent(status: number, value: unknown): SafeObject | null {
  if (!object(value)) return null;
  if (status === 429 && typeof value.error === "string" && ["video_draft_limit_reached", "video_job_limit_reached"].includes(value.error)) {
    const usage = safeUsage(value.usage);
    const bucket = value.error === "video_draft_limit_reached" ? "draft" : "active";
    const allowed = ["list_video_jobs", "cancel_video_job", "continue_existing_job", "close_video_job"];
    if (!usage || value.scope !== "account" || value.quota_bucket !== bucket ||
        ![value.limit, value.count, value.remaining].every(integer) || value.retryable !== false || !bounded(value.message) ||
        !Array.isArray(value.actions) || value.actions.length > 3 || !value.actions.every(item => allowed.includes(item)) ||
        (bucket === "active" && value.actions.includes("cancel_video_job")) ||
        (bucket === "draft" && value.actions.includes("close_video_job"))) return null;
    return { error: value.error, scope: "account", quota_bucket: bucket, limit: value.limit, count: value.count, remaining: value.remaining,
      retryable: false, message: value.message, usage, actions: value.actions };
  }
  if (status === 409 && typeof value.error === "string" && ["video_job_not_cancellable", "video_job_not_closable"].includes(value.error)) {
    const summary = safeSummary(value.job);
    if (!bounded(value.reason, 120) || !bounded(value.message) || !summary) return null;
    return { error: value.error, reason: value.reason, message: value.message, job: summary };
  }
  if (status === 409 && value.error === "job_state_changed") {
    const summary = value.job === undefined ? null : safeSummary(value.job);
    if (value.job !== undefined && !summary) return null;
    return bounded(value.message) ? { error: value.error, message: value.message, ...(summary ? { job: summary } : {}) } : { error: value.error, ...(summary ? { job: summary } : {}) };
  }
  if (status === 409 && value.error === "video_job_cancelled") {
    return bounded(value.message) ? { error: value.error, message: value.message } : { error: value.error };
  }
  return null;
}
