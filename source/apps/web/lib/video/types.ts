import type { CandidateTiming } from "./candidate-quality";
import type { SingleCall } from "../video-calls/contract";

/** Public contracts contain media URLs only; storage keys and provider receipts stay server-side. */
export type VideoStatus = "draft" | "queued" | "preparing" | "review" | "generating" | "assembling" | "completed" | "failed" | "attention" | "cancelled";
export type VideoPhase = "prepare" | "prepare_references" | "prepare_sixref" | "render" | "reconcile" | "assemble";
/** Older workers reject this new phase instead of treating direct preparation as paid image work. */
export const isVideoPreparation = (phase: string): boolean => phase === "prepare" || phase === "prepare_references" || phase === "prepare_sixref";
export type VideoGenerationMode = "legacy_frames" | "direct_references" | "six_references";
export type VideoReferenceRole = "product" | "character" | "scene" | "product_detail" | "start_state" | "end_state";
export interface VideoReferenceImage {
  assetId: string;
  role: VideoReferenceRole;
  label: string;
  /** Frozen normalized bytes used for rendering, never a mutable source URL. */
  key?: string;
  sha256?: string;
}

export interface VideoSegment {
  index: number;
  start: number;
  duration: 4 | 5 | 6 | 8;
  trimStart: number;
  /** Six-reference semantic window, independent of the upstream requested duration. */
  sourceWindowDuration?: number;
  instructions?: string;
  beforeState?: string;
  afterState?: string;
  referenceImages?: VideoReferenceImage[];
  startFromSegment?: number;
  attempt?: number;
  candidateSha256?: string;
  candidateMedia?: { duration: number; width: number; height: number; fps?: number; frameCount?: number };
  /** Explicitly reviewed leading repetition to remove; never applied automatically. */
  candidateTrimStart?: number;
  tailKey?: string;
  tailSha256?: string;
  accepted?: boolean;
  terminalFailure?: boolean;
  history?: { attempt: number; buildId?: string; providerTaskId?: string; candidateKey?: string; candidateSha256?: string; reason: string }[];
  clipKey?: string;
  openingKey?: string;
  endingKey?: string;
  candidateKey?: string;
  submissionIntentAt?: string;
  buildId?: string;
  providerTaskId?: string;
  error?: string;
}

export interface VideoJobData {
  version: 1;
  singleCall?: SingleCall;
  /** Soft cancellation retains inputs and records its original timestamp. */
  cancellation?: { at: string; reason: "user_cancelled" | "draft_expired" | "user_closed"; previous_status?: string; previous_revision?: number };
  /** Missing on existing jobs means legacy_frames; never reinterpret old consent. */
  generationMode?: VideoGenerationMode;
  referenceImages?: VideoReferenceImage[];
  /** Versioned immutable provider selection; existing jobs retain their original route. */
  workflowProfile?: "sixref-v1";
  sourceDuration?: number;
  sourceHasAudio?: boolean;
  segments: VideoSegment[];
  outputKey?: string;
  outputSha256?: string;
  outputMedia?: { duration: number; width: number; height: number; fps?: number; frameCount?: number };
  imageCalls: number;
  /**
   * 未定价模式（explicit）：单段报价未配置时 estimatedCoins/perSegmentCoins 为 null，
   * 只保留调用方给出的整数上限 maxCoins，并用 pricingBasis 标明"这不是已定价报价"。
   */
  renderConsent?: { at: string; maxCoins: number; estimatedCoins: number | null; perSegmentCoins: number | null;
    pricingBasis?: "configured_quote" | "unpriced_technical_cap"; segmentIndices: number[]; referenceDigest?: string };
  /**
   * 业务进展。刻意放进 JSON 而不是加数据库列：这次改动不值得一次 schema 迁移，
   * 且旧读取器忽略未知字段即可兼容。
   */
  progress?: { stageCode: string; stageStartedAt: string; lastProgressAt: string };
}

export interface VideoJobView {
  id: string;
  title: string;
  status: VideoStatus;
  stage: string;
  instructions: string;
  preserve_audio: boolean;
  generation_mode: VideoGenerationMode;
  references_ready: boolean;
  reference_assets: { picture: number; asset_id: string; role: VideoReferenceRole; label: string; url: string | null; sha256: string | null }[];
  source_url: string;
  product_url: string;
  source_duration: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  /**
   * 业务进展时间（来自 data.progress，不是数据库 updated_at）。
   * 租约心跳每 20 秒就会刷新 updated_at，所以它**不能**代表业务在推进 —— 这两者必须分开看。
   * 旧数据没有 progress 时返回 null，不编造时间。
   */
  progress_updated_at: string | null;
  stage_code: string | null;
  segments: { index: number; start: number; duration: number; opening_url: string | null; ending_url: string | null; candidate_url: string | null;
    source_duration?: number; instructions?: string; before_state?: string; after_state?: string; start_from_segment?: number;
    candidate_sha256?: string; tail_url?: string | null; tail_sha256?: string; accepted?: boolean; attempt?: number;
    candidate_media?: VideoSegment["candidateMedia"]; candidate_timing?: CandidateTiming; reference_assets?: { picture: number; asset_id: string; role: VideoReferenceRole; label: string; url: string | null; sha256: string | null }[] }[];
  candidate_review_token?: string | null;
  ready_segment_indices?: number[];
  output_url: string | null;
  download_url: string | null;
  estimate: { segments: number; image_calls: number; video_coins: number | null };
  /**
   * 审阅标识：render 必须回传同一个值。绑定任务/模式/参考快照/动作窗口/待生成片段/展示报价，
   * 任何一项变化即失效（409 review_changed）。仅在可提交审阅时非空。
   */
  review_token: string | null;
  pricing_basis: "configured_quote" | "unpriced_technical_cap";
}

export interface VideoCapabilities {
  beta: true;
  signed_in: boolean;
  eligible: boolean;
  database_ready: boolean;
  storage_ready: boolean;
  worker_ready: boolean;
  image_ready: boolean;
  video_ready: boolean;
  ready: boolean;
  reason: string | null;
  /** 运维暂停或付费开关关闭。此时不接受新的 prepare/render —— 与 ready 分开表达。 */
  paused: boolean;
  maintenance: string | null;
  limits: { min_seconds: typeof VIDEO_MIN_SECONDS; max_seconds: typeof VIDEO_MAX_SECONDS; max_bytes: number; aspect_ratio: "9:16"; resolution: "768P" };
  pricing: { per_segment_coins: number | null; pricing_basis: "configured_quote" | "unpriced_technical_cap"; image_billing: "internal_beta" };
}

/**
 * 平台参考片总时长的**单一来源**：媒体校验、分段、能力接口、文案都必须引用这里。
 * 注意：上游 H3 每段仍固定 4 或 5 秒——30 秒是平台侧成片目标，不是让上游一次生成 30 秒。
 */
export const VIDEO_MIN_SECONDS = 4;
export const VIDEO_MAX_SECONDS = 30;
export const VIDEO_MAX_BYTES = 150 * 1024 * 1024;
export const VIDEO_JOB_LIMIT = 10;
export function emptyVideoData(): VideoJobData { return { version: 1, segments: [], imageCalls: 0 }; }
export function videoData(value: unknown): VideoJobData {
  if (!value || typeof value !== "object" || !Array.isArray((value as VideoJobData).segments)) return emptyVideoData();
  return value as VideoJobData;
}

/** Configured conservative quote, not an upstream spending cap. Never invent an exchange rate. */
export function segmentCoinQuote(mode?: VideoGenerationMode): number | null {
  const value = Number(mode === "six_references" ? process.env.VIDEO_SIXREF_SEGMENT_QUOTE_COINS : process.env.VIDEO_H3_SEGMENT_QUOTE_COINS);
  return Number.isInteger(value) && value > 0 && value <= 100000 ? value : null;
}
