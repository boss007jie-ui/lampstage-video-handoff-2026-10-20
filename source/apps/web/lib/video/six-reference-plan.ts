import { validateReferenceBinding, CharacterBindingError } from "../characters/bindings";
import { createHash } from "node:crypto";
import type { VideoJobData, VideoReferenceImage, VideoReferenceRole, VideoSegment } from "./types";

// 通用指令变更必须使旧的付费确认失效；不改写已有 build/候选的历史输入。
export const SIX_REFERENCE_DIRECTION_VERSION = "target-appearance-v2";

export const SIX_REFERENCE_CAPABILITY = {
  reference_image_min: 1, reference_image_max: 6, semantic_segment_plan_required: true,
  segment_durations: [4, 5, 6, 8], generated_endpoint_frames: false,
  reference_roles: ["product", "character", "scene", "product_detail", "start_state", "end_state"],
  start_state: { required: true, picture: 1, unique: true, meaning: "complete_scene_at_action_start", dependency: "accepted_previous_tail_replaces_slot_1" },
  candidate_timing_check: "actual_media_and_30fps_delivery",
  account_concurrency: 3, candidate_review_required: true, profile: "sixref-v1",
  output: { width: 720, height: 1280, fps: 30 },
} as const;
export class SixReferencePlanError extends Error {}
const fail = (message: string): never => { throw new SixReferencePlanError(message); };
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
function label(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return fail(`${name}缺失或无效。`);
  return value.trim();
}
export function parseSixReferences(value: unknown): VideoReferenceImage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return fail("每段需要 1–6 张按用途排序的参考图，不会自动舍弃或补图。");
  const refs = value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.asset_id !== "string" || !identifier.test(raw.asset_id) ||
      !(SIX_REFERENCE_CAPABILITY.reference_roles as readonly unknown[]).includes(raw.role)) return fail("参考图的 asset_id 或 role 无效。");
    try { validateReferenceBinding(raw, "six_references"); } catch (e) { if (e instanceof CharacterBindingError) return fail(e.code); throw e; }
    return { assetId: raw.asset_id, role: raw.role as VideoReferenceRole, label: label(raw.label, "参考用途", 80) };
  });
  if (new Set(refs.map(r => r.assetId)).size !== refs.length) return fail("同一段不能重复提交相同参考图。");
  return refs;
}
const startStateMessage = "每段第一张参考必须是唯一的 start_state 完整起态图；请核对起始人物、衣物、场景和姿态。";
export function assertSixStartStateReferences(refs: readonly VideoReferenceImage[] | undefined): void {
  if (!Array.isArray(refs) || refs[0]?.role !== "start_state" || refs.filter(ref => ref?.role === "start_state").length !== 1)
    fail(startStateMessage);
}
export function assertSixStartStatePlan(data: VideoJobData, indices?: readonly number[]): void {
  const segments = indices === undefined ? data.segments : indices.map(index => data.segments[index]);
  for (const segment of segments) assertSixStartStateReferences(segment?.referenceImages);
}
export function parseSixReferencePlan(body: Record<string, unknown>): VideoJobData {
  const refs = parseSixReferences(body.reference_assets);
  if (!Array.isArray(body.segment_plan) || body.segment_plan.length < 1 || body.segment_plan.length > 8) return fail("请先按完整动作提供 1–8 段 segment_plan。");
  const segments = body.segment_plan.map((raw, index): VideoSegment => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("动作分段格式无效。");
    const { start, source_duration: sourceDuration, duration, start_from_segment: dependency } = raw;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || typeof sourceDuration !== "number" || !Number.isFinite(sourceDuration) ||
      sourceDuration <= 0 || start + sourceDuration > 30.12 || !(SIX_REFERENCE_CAPABILITY.segment_durations as readonly unknown[]).includes(duration) ||
      sourceDuration / duration < 1 / 1.15 || sourceDuration / duration > 1.15) return fail("分段需提供有效起点、完整原片动作时长和 4/5/6/8 秒生成时长；变速不得超过 15%。");
    const selected = raw.reference_assets === undefined ? structuredClone(refs) : parseSixReferences(raw.reference_assets);
    assertSixStartStateReferences(selected);
    if (dependency !== undefined && (!Number.isInteger(dependency) || dependency < 0 || dependency >= index))
      return fail("接续只能依赖前段，且本段需有一张 start_state 参考供已审阅的实际末帧替换。");
    return { index, start, duration, trimStart: 0, sourceWindowDuration: sourceDuration, attempt: 0,
      instructions: label(raw.instructions, "本段动作指令", 1600), beforeState: label(raw.before_state, "动作前状态", 400),
      afterState: label(raw.after_state, "动作后状态", 400), referenceImages: selected,
      ...(dependency === undefined ? {} : { startFromSegment: dependency }) };
  });
  validateSemanticWindows(segments);
  return { version: 1, generationMode: "six_references", workflowProfile: "sixref-v1", referenceImages: refs, segments, imageCalls: 0 };
}
export function validateSemanticWindows(segments: VideoSegment[], sourceDuration?: number) {
  let end = 0;
  for (const s of segments) {
    if (!s.instructions || !s.beforeState || !s.afterState || !s.sourceWindowDuration || Math.abs(s.start - end) > 0.001) return fail("动作窗口必须从原片开头连续覆盖，不能静默丢帧、重叠或漏掉操作。");
    end = s.start + s.sourceWindowDuration;
  }
  if (sourceDuration !== undefined && Math.abs(end - sourceDuration) > 0.02) return fail("动作分段未覆盖完整原视频，请根据实际时长修正计划。");
}
export function allReferenceImages(data: VideoJobData): VideoReferenceImage[] {
  return [...(data.referenceImages ?? []), ...data.segments.flatMap(s => s.referenceImages ?? [])];
}
export function sixReferencesReady(data: VideoJobData): boolean {
  return data.workflowProfile === "sixref-v1" && data.imageCalls === 0 && data.segments.length > 0 && data.segments.every(s =>
    s.clipKey && s.referenceImages && s.referenceImages.length >= 1 && s.referenceImages.length <= 6 && s.referenceImages.every(r =>
      typeof r.key === "string" && /^videos\/[\w-]+\/(?:segments\/\d+\/)?references\/[0-5]\.png$/.test(r.key) && /^[a-f0-9]{64}$/.test(r.sha256 ?? "")));
}
/** Only approved predecessor results can become a start-state reference. */
export function readySixSegments(data: VideoJobData): VideoSegment[] {
  return data.segments.filter(s => !s.terminalFailure && !s.candidateKey && !s.submissionIntentAt && !s.buildId && (s.startFromSegment === undefined ||
    Boolean(data.segments[s.startFromSegment]?.accepted && data.segments[s.startFromSegment]?.tailKey && data.segments[s.startFromSegment]?.tailSha256)));
}
export function sixPlanDigest(data: VideoJobData): string {
  if (!sixReferencesReady(data)) return fail("六图动作计划尚未准备完成。");
  return createHash("sha256").update(JSON.stringify({ profile: data.workflowProfile, directionVersion: SIX_REFERENCE_DIRECTION_VERSION,
    segments: data.segments.map(s => ({ index: s.index, start: s.start, sourceDuration: s.sourceWindowDuration, duration: s.duration,
      instructions: s.instructions, before: s.beforeState, after: s.afterState, refs: s.referenceImages,
      dependency: s.startFromSegment, dependencyTail: s.startFromSegment === undefined || !data.segments[s.startFromSegment]?.accepted ? null : {
        key: data.segments[s.startFromSegment]?.tailKey, sha256: data.segments[s.startFromSegment]?.tailSha256, accepted: data.segments[s.startFromSegment]?.accepted },
      attempt: s.attempt ?? 0 })) })).digest("hex");
}
export function effectiveSixReferences(data: VideoJobData, segment: VideoSegment): VideoReferenceImage[] {
  const refs = structuredClone(segment.referenceImages!);
  if (segment.startFromSegment !== undefined) {
    const previous = data.segments[segment.startFromSegment];
    if (!previous?.accepted || !previous.tailKey || !previous.tailSha256) return fail("前段实际末帧尚未审阅，不能提交依赖片段。");
    const i = refs.findIndex(r => r.role === "start_state");
    if (i < 0) return fail("接续起态参考缺失。");
    refs[i] = { assetId: `segment-${previous.index}`, role: "start_state", label: "已审阅前段实际末帧", key: previous.tailKey, sha256: previous.tailSha256 };
  }
  return refs;
}
export function sixSegmentDirection(refs: VideoReferenceImage[], segment: VideoSegment, constraints: string): string {
  const roles = refs.map((r, i) => `Picture ${i + 1}: ${r.role}; ${r.label}.`).join("\n");
  return `${roles}\nPicture 1 defines this segment's complete action-start scene: the people, clothing state, setting and pose before motion begins. Animate that target scene through the action below. Each picture has only its stated purpose; identity and product pictures must not override the starting clothing state shown in Picture 1. Character references define identity only; do not copy their unrelated clothes, pose or background. Product and detail references define the target product's appearance and construction. Replace the source video's corresponding appearance with the target appearance defined by the pictures and the explicit requirements below. Preserve unspecified appearance from Picture 1. Do not inherit the source video's different faces, garments or setting. An end-state picture describes the state after the action, not an opening pose.\nVideo 1 supplies motion, contact and timing for THIS segment; follow its operation order. Explicit requirements below override source camera movement and shot changes; otherwise follow the source camera. Do not restart the whole story, replay earlier actions, skip contact, or reverse actions. Preserve intentional pauses and final holds in the source motion and the explicit segment plan; do not replace required motion with a held still image.\nAppearance and preservation constraints:\n${constraints}\nTHIS SEGMENT ONLY:\nBefore: ${segment.beforeState}\nAction: ${segment.instructions}\nAfter: ${segment.afterState}\nKeep hands, fabric contact and transitions natural. No added text/logos. Generated audio is discarded at assembly.`;
}
