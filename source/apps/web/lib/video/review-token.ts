import { readySixSegments } from "./six-reference-plan";
/**
 * 审阅标识（review_token）：把"用户在展示时看到的那些东西"压成一个确定性摘要。
 *
 * 为什么要它：`renderConsent` 绑定的是**提交那一刻**的参考摘要；展示与提交之间如果涨价
 * （只要不超过 max_coins）或参考/片段发生变化，旧流程不会拒。这个 token 把展示时的状态
 * 一起绑上，render 时必须回传同一个值，否则停止（409 review_changed）。
 *
 * 绑定内容：任务 id、生成模式、参考图快照摘要、动作窗口、**待生成片段**、展示报价。
 * 任何一项变化 ⇒ 摘要变化 ⇒ 提交被拒 —— 这是"状态变更即失效"的实现方式。
 *
 * 纯函数、不落库、无过期时间：render 时按**当前**数据库状态重算并与回传值比对，
 * 因此不存在"过期的 token 仍被接受"这种漏洞。
 */
import { createHash } from "node:crypto";
import { generationMode, preparedReferencesReady, referenceDigest } from "./reference-inputs";
import type { VideoJobData } from "./types";

export type ReviewTokenInput = {
  jobId: string;
  data: VideoJobData;
  /** 展示时的单段报价；未定价模式下为 null。 */
  quote: number | null;
};

/** 返回 null 表示"当前没有可审阅可提交的状态"，此时不允许渲染。 */
export function reviewToken(input: ReviewTokenInput): string | null {
  const { jobId, data, quote } = input;
  const mode = generationMode(data);
  if (!data.segments.length) return null;
  if (mode === "six_references" && data.segments.some(s => !s.candidateKey && (s.buildId || s.submissionIntentAt))) return null;
  const remaining = mode === "six_references" ? readySixSegments(data) : data.segments.filter(segment => !segment.candidateKey);
  if (!remaining.length) return null;
  // direct 模式下参考快照必须先就绪，否则没有可绑定的"实际参考内容"。
  if (mode !== "legacy_frames" && !preparedReferencesReady(data)) return null;
  // 已有付费意图/回执的片段不得再提交，token 也不签发（避免诱导重复提交）。
  if (remaining.some(segment => segment.submissionIntentAt || segment.buildId)) return null;
  const canonical = {
    version: 1,
    jobId,
    mode,
    quote,
    references: mode !== "legacy_frames" ? referenceDigest(data) : null,
    // 待生成片段的动作窗口：任一段被生成/变化，这里就变。
    windows: remaining.map(segment => ({
      index: segment.index,
      start: segment.start,
      duration: segment.duration,
      trimStart: segment.trimStart,
    })),
    segmentTotal: data.segments.length,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
