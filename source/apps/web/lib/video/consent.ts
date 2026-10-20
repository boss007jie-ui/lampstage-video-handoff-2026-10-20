import { assertSixStartStatePlan, readySixSegments, SixReferencePlanError } from "./six-reference-plan";
import type { VideoJobData } from "./types";
import { generationMode, preparedReferencesReady, referenceDigest } from "./reference-inputs";

export type PricingBasis = "configured_quote" | "unpriced_technical_cap";

/** Called before claiming a queued render and again immediately before each paid submission. */
export function validateRenderConsent(data: VideoJobData, maxCoins: unknown, quote: number | null) {
  const direct = generationMode(data) !== "legacy_frames";
  if (!data.segments.length || data.segments.some(s => !s.clipKey || (!direct && (!s.openingKey || !s.endingKey))) ||
    (direct && !preparedReferencesReady(data))) return { ok: false as const, reason: "关键参考图尚未就绪。" };
  const six = generationMode(data) === "six_references";
  if (six && data.segments.some(s => !s.candidateKey && (s.buildId || s.submissionIntentAt))) return { ok: false as const, reason: "已有未核清回执，请先核对原任务。" };
  const remaining = six ? readySixSegments(data) : data.segments.filter(s => !s.candidateKey);
  if (!remaining.length) return { ok: false as const, reason: "所有视频片段均已生成，请核查并合成原任务。" };
  if (six) {
    try { assertSixStartStatePlan(data, remaining.map(segment => segment.index)); }
    catch (error) {
      if (error instanceof SixReferencePlanError) return { ok: false as const, code: "invalid_video_references" as const, reason: error.message };
      throw error;
    }
  }
  /**
   * 未定价模式（explicit）：单段报价未配置时**不再硬拒**——否则 render 根本无法进行。
   * 但绝不放弃边界：此时仍要求调用方给出一个明确的整数上限，并把它标记为
   * `unpriced_technical_cap`，让后续核算知道"这不是已定价的报价"。
   * ⚠️ 该上限只是平台侧预算门（max_coins 不传给上游），不是上游账单硬封顶。
   */
  const estimate = quote === null ? null : remaining.length * quote;
  const badCoins = typeof maxCoins !== "number" || !Number.isSafeInteger(maxCoins) || maxCoins <= 0 || maxCoins > 1000000;
  if (badCoins || (estimate !== null && maxCoins < estimate)) {
    return { ok: false as const, reason: estimate === null
      ? "当前未配置单段报价，请给出 1–1000000 之间的整数 RH 币预算上限。"
      : `本次预算需至少为 ${estimate} RH 币。` };
  }
  if (remaining.some(s => s.submissionIntentAt || s.buildId)) return { ok: false as const, reason: "项目已有提交记录，请核查原任务，不能重复生成。" };
  return { ok: true as const, estimate, maxCoins, quote, pricingBasis: (quote === null ? "unpriced_technical_cap" : "configured_quote") as PricingBasis,
    segmentIndices: remaining.map(s => s.index),
    ...(direct ? { referenceDigest: referenceDigest(data) } : {}) };
}

export type ReviewTokenCheck = { ok: true } | { ok: false; status: 400 | 409; reason: string };

/**
 * 校验回传的审阅标识与**当前**状态是否一致。
 *   缺失/格式不对 → 400（要求重新获取任务再确认）
 *   与当前状态不符 → 409 `review_changed`（展示后涨价、参考或片段变化都落在这里）
 */
export function checkReviewToken(provided: unknown, expected: string | null): ReviewTokenCheck {
  if (!expected) return { ok: false, status: 409, reason: "review_state_unavailable" };
  if (typeof provided !== "string" || !/^[a-f0-9]{64}$/.test(provided)) return { ok: false, status: 400, reason: "review_token_required" };
  if (provided !== expected) return { ok: false, status: 409, reason: "review_changed" };
  return { ok: true };
}
