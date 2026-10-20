import { digest } from "../../agent/policy";
import { preparedReferencesReady } from "../reference-inputs";
import { segmentTimeline } from "../media";
import { assertSixStartStatePlan, validateSemanticWindows } from "../six-reference-plan";
import type { VideoJobData } from "../types";
import { record, type VideoPreparation } from "./binding";

export interface PreparedJobView {
  id: string; user_id: string; source_asset_id: string; product_asset_id: string; instructions: string; preserve_audio: boolean;
  status: string; phase: string; data: unknown; lease_owner: string | null; lease_until: Date | null;
}
const segmentFields = ["index", "start", "duration", "trimStart", "sourceWindowDuration", "instructions", "beforeState", "afterState",
  "referenceImages", "startFromSegment", "clipKey", "openingKey", "endingKey"];
function pick(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}
/** 固定旧业务真实准备结果；排除运行时 attempt/lease，但保留素材窗口、快照、说明和音频选择。 */
export function preparedJobDigest(job: Pick<PreparedJobView, "source_asset_id" | "product_asset_id" | "instructions" | "preserve_audio" | "data">): string {
  const d = record(job.data);
  return digest({ sourceAssetId: job.source_asset_id, productAssetId: job.product_asset_id, instructions: job.instructions, preserveAudio: job.preserve_audio,
    prepared: { ...pick(d, ["version", "generationMode", "workflowProfile", "sourceDuration", "sourceHasAudio", "imageCalls", "referenceImages"]),
      segments: Array.isArray(d.segments) ? d.segments.map(s => pick(record(s), segmentFields)) : null } });
}
/** 准备器要求合法完成阶段；gate 再核对同一内容摘要，当前阶段已变成 render。 */
export function validatePreparedJob(job: PreparedJobView, p: VideoPreparation, requireReady: boolean): boolean {
  try {
  const d = record(job.data), mode = d.generationMode ?? "legacy_frames";
  const expectedPhase = { legacy_frames: "prepare", direct_references: "prepare_references", six_references: "prepare_sixref" }[p.mode];
  if (job.id !== p.jobId || job.user_id !== p.userId || mode !== p.mode || d.version !== 1
    || preparedJobDigest(job) !== p.preparedJobDigest || !Number.isFinite(d.sourceDuration) || Number(d.sourceDuration) <= 0
    || !Array.isArray(d.segments) || !d.segments.length) return false;
  if (requireReady && (job.status !== "review" || job.phase !== expectedPhase || job.lease_owner || job.lease_until)) return false;
  const segments = d.segments.map(record), seen = new Set<number>();
  const ownKey = (v: unknown) => typeof v === "string" && v.startsWith(`videos/${job.id}/`) && !/[?%\\]/.test(v)
    && v.split("/").every(part => part && part !== "." && part !== "..");
  for (const s of segments) {
    if (!Number.isSafeInteger(s.index) || Number(s.index) < 0 || seen.has(Number(s.index)) || ![4, 5, 6, 8].includes(Number(s.duration))
      || !Number.isFinite(s.start) || Number(s.start) < 0 || !Number.isFinite(s.trimStart) || Number(s.trimStart) < 0 || !ownKey(s.clipKey)) return false;
    seen.add(Number(s.index));
    if (p.mode === "legacy_frames" && (!ownKey(s.openingKey) || !ownKey(s.endingKey))) return false;
  }
  if (p.mode === "six_references") {
    validateSemanticWindows(segments as unknown as VideoJobData["segments"], Number(d.sourceDuration));
    assertSixStartStatePlan(d as unknown as VideoJobData);
  } else {
    const expected = segmentTimeline(Number(d.sourceDuration));
    if (expected.length !== segments.length || expected.some((s, i) =>
      s.index !== segments[i].index || s.duration !== segments[i].duration || s.start !== segments[i].start || s.trimStart !== segments[i].trimStart)) return false;
  }
  if (p.mode !== "legacy_frames" && !preparedReferencesReady(d as unknown as VideoJobData)) return false;
  // 六图允许逐段覆盖默认参考；未使用的顶层默认参考可能没有快照，仍保留在审阅摘要中。
  const refs = p.mode === "six_references" ? segments.flatMap(s => Array.isArray(s.referenceImages) ? s.referenceImages : [])
    : (Array.isArray(d.referenceImages) ? d.referenceImages : []);
  for (const ref of refs) {
    const r = record(ref);
    if (!ownKey(r.key) || !p.materials.some(m => m.kind === "uploaded_asset" && m.assetId === r.assetId)) return false;
  }
  for (const s of p.segments) {
    const old = segments.find(v => v.index === s.index);
    // 本批只绑定从未提交的独立片段；依赖前段已审阅末帧的动作尚未接入，不猜测其起态。
    if (!old || old.startFromSegment !== undefined || old.duration !== s.duration || old.start !== s.window.start
      || s.window.end !== s.window.start + Number(old.sourceWindowDuration ?? old.duration) || s.window.end > Number(d.sourceDuration)) return false;
  }
  return true;
  } catch { return false; }
}
