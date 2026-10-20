import { SixReferencePlanError } from "./six-reference-plan";
import type { CandidateTiming } from "./candidate-quality";

export const CANDIDATE_REVIEW_MESSAGES = {
  invalid_decisions: "请提供需要审阅的片段。",
  invalid_segment: "审阅片段编号缺失或重复。",
  candidate_changed: "片段已变化或还没有明确结果，请重新获取任务并审阅。",
  candidate_incomplete: "没有可接受的完整片段及实际末帧。",
  invalid_trim: "需要有效的实际视频时长和经审阅的开头重复秒数。",
  actual_duration_unknown: "缺少实际候选时长，不能确认片段可合成。",
  duration_incompatible: "候选实际时长无法在 15% 变速内合成，请核对完整动作；不要重复相同审阅或自动裁剪。",
  invalid_source_window: "动作窗口或交付帧数无效，请重新核对计划。",
  retry_trim_conflict: "重试决定不能同时修改剪辑。",
  retry_reason_required: "重试前需要记录具体不合格原因。",
  dependent_result_exists: "后段已使用这段结果，请另建经确认的接续计划；不能静默替换它的起态。",
  invalid_action: "审阅操作必须为 accept 或 retry。",
} as const;
export type CandidateReviewReason = keyof typeof CANDIDATE_REVIEW_MESSAGES;

export class CandidateReviewError extends SixReferencePlanError {
  constructor(readonly reason: CandidateReviewReason, readonly segmentIndex?: number, readonly timing?: CandidateTiming) {
    super(CANDIDATE_REVIEW_MESSAGES[reason]);
  }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const timingKeys = ["source_duration", "requested_duration", "actual_duration", "trim_start", "kept_duration", "delivery_duration", "retime_ratio"] as const;

/** MCP 只允许固定枚举和有界数值；忽略服务端正文中的任意描述与私有字段。 */
export function safeCandidateReviewErrorContent(status: number, value: unknown): Record<string, unknown> | null {
  if (status !== 400 || !object(value) || value.error !== "invalid_candidate_review" ||
    typeof value.reason !== "string" || !Object.prototype.hasOwnProperty.call(CANDIDATE_REVIEW_MESSAGES, value.reason)) return null;
  const reason = value.reason as CandidateReviewReason;
  const result: Record<string, unknown> = { error: "invalid_candidate_review", reason, message: CANDIDATE_REVIEW_MESSAGES[reason] };
  if (Number.isInteger(value.segment_index) && Number(value.segment_index) >= 0 && Number(value.segment_index) <= 7) result.segment_index = value.segment_index;
  const timing = value.timing;
  if (!object(timing) || typeof timing.status !== "string" || !["compatible", "incompatible", "unknown"].includes(timing.status) ||
    typeof timing.reason !== "string" || !["compatible", "actual_duration_unknown", "invalid_source_window", "invalid_trim", "duration_out_of_range"].includes(timing.reason) ||
    timing.max_retime_ratio !== 1.15 || timing.visual_review_required !== true) return result;
  const safe: Record<string, unknown> = { status: timing.status, reason: timing.reason, max_retime_ratio: 1.15, visual_review_required: true };
  for (const key of timingKeys) {
    const number = timing[key];
    if (number !== null && (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 86400)) return result;
    safe[key] = number;
  }
  const range = timing.allowed_kept_duration;
  if (range === null) safe.allowed_kept_duration = null;
  else if (object(range) && typeof range.min === "number" && typeof range.max === "number" &&
    Number.isFinite(range.min) && Number.isFinite(range.max) && range.min > 0 && range.min <= range.max && range.max <= 86400) {
    safe.allowed_kept_duration = { min: range.min, max: range.max };
  } else return result;
  result.timing = safe;
  return result;
}

export function candidateReviewErrorBody(error: CandidateReviewError) {
  return { error: "invalid_candidate_review", reason: error.reason, message: error.message,
    ...(Number.isInteger(error.segmentIndex) && error.segmentIndex! >= 0 && error.segmentIndex! <= 7 ? { segment_index: error.segmentIndex } : {}),
    ...(error.timing ? { timing: error.timing } : {}) };
}
