import type { VideoSegment } from "./types";

export const SIX_DELIVERY_FPS = 30;
export const MAX_CANDIDATE_RETIME_RATIO = 1.15;
const RATIO_EPSILON = 1e-6;

export interface CandidateTiming {
  status: "compatible" | "incompatible" | "unknown";
  reason: "compatible" | "actual_duration_unknown" | "invalid_source_window" | "invalid_trim" | "duration_out_of_range";
  source_duration: number | null;
  requested_duration: number | null;
  actual_duration: number | null;
  trim_start: number | null;
  kept_duration: number | null;
  delivery_duration: number | null;
  retime_ratio: number | null;
  max_retime_ratio: typeof MAX_CANDIDATE_RETIME_RATIO;
  allowed_kept_duration: { min: number; max: number } | null;
  visual_review_required: true;
}

const seconds = (value: unknown, zero = false): number | null =>
  typeof value === "number" && Number.isFinite(value) && value <= 86400 && (zero ? value >= 0 : value > 0) ? value : null;

/** 按完整时间线累计量化，和实际合成共用，避免独立四舍五入丢帧。 */
export function sixDeliveryWindow(segments: readonly VideoSegment[], index: number): { frames: number; duration: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= segments.length) return null;
  let cursor = 0;
  let startFrame = 0;
  for (let i = 0; i <= index; i++) {
    const segment = segments[i];
    const window = seconds(segment.sourceWindowDuration);
    if (segment.index !== i || window === null || !Number.isFinite(segment.start) ||
      segment.start < 0 || Math.abs(segment.start - cursor) > 0.02 || cursor + window > 30.12) return null;
    startFrame = Math.round(cursor * SIX_DELIVERY_FPS);
    cursor += window;
  }
  const frames = Math.round(cursor * SIX_DELIVERY_FPS) - startFrame;
  return frames > 0 ? { frames, duration: frames / SIX_DELIVERY_FPS } : null;
}

/** 只读取已有媒体测量，不解码、不联网、不建议或应用任何自动剪辑。 */
export function assessCandidateTiming(segments: readonly VideoSegment[], index: number,
  overrides: { actualDuration?: number; trimStart?: number } = {}): CandidateTiming {
  const segment = segments[index];
  const source = seconds(segment?.sourceWindowDuration);
  const actual = seconds(overrides.actualDuration ?? segment?.candidateMedia?.duration);
  const trim = seconds(overrides.trimStart ?? segment?.candidateTrimStart ?? 0, true);
  const delivery = sixDeliveryWindow(segments, index)?.duration ?? null;
  const kept = actual !== null && trim !== null ? actual - trim : null;
  const timing: CandidateTiming = {
    status: "unknown", reason: "invalid_source_window", source_duration: source,
    requested_duration: seconds(segment?.duration), actual_duration: actual, trim_start: trim,
    kept_duration: kept, delivery_duration: delivery, retime_ratio: null,
    max_retime_ratio: MAX_CANDIDATE_RETIME_RATIO,
    allowed_kept_duration: source !== null && delivery !== null ? {
      min: Math.max(source, delivery) / MAX_CANDIDATE_RETIME_RATIO,
      max: Math.min(source, delivery) * MAX_CANDIDATE_RETIME_RATIO,
    } : null,
    visual_review_required: true,
  };
  if (source === null || delivery === null) return timing;
  if (actual === null) return { ...timing, reason: "actual_duration_unknown" };
  if (trim === null || kept === null || kept <= 0) return { ...timing, status: "incompatible", reason: "invalid_trim" };
  const ratio = Math.max(kept / source, source / kept, kept / delivery, delivery / kept);
  const compatible = ratio <= MAX_CANDIDATE_RETIME_RATIO + RATIO_EPSILON;
  return { ...timing, retime_ratio: ratio, status: compatible ? "compatible" : "incompatible",
    reason: compatible ? "compatible" : "duration_out_of_range" };
}
