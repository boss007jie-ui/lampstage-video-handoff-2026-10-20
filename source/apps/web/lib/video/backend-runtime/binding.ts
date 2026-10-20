import { digest, validatePrivateJson } from "../../agent/policy";
import type { ActorContext, AgentStep, Approval, ToolOutcome } from "../../agent/contracts";
import type { VideoBackendMode, VideoPreparedInput, VideoSubmissionIntent } from "../backends/contracts";
import { candidateIdentityDigest, candidateKey, MAX_CANDIDATE_DURATION_DRIFT_SECONDS, type CandidateReceipt, type CollectorIdentity } from "./collector";

export class VideoRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "VideoRuntimeError"; }
}
export function fail(code: string): never { throw new VideoRuntimeError(code); }
export type Material =
  | { kind: "video_asset"; role: "source"; assetId: string; sha256: string; storageKey: string }
  | { kind: "uploaded_asset"; role: "product" | "reference"; assetId: string; sha256: string;
      imageContentId: string; assetLocation: string; contentLocation: string };
export interface PreparedSegment {
  index: number; duration: number; width: number; height: number;
  window: { start: number; end: number }; maxCoins: number;
  input: VideoPreparedInput;
}
/** 只能由可信准备服务写入，不能从模型参数解码生成。 */
export interface VideoPreparation {
  version: 1; userId: string; jobId: string; backendId: string; accountId: string;
  configurationDigest: string; preparedJobDigest: string; mode: VideoBackendMode; pricingBasis: string; quoteVersion: string;
  materials: Material[]; segments: PreparedSegment[];
}
export interface VideoConsent { version: 1; userId: string; reviewDigest: string; acceptedAt: number; revokedAt: number | null }
export type SegmentState = "prepared" | "submitting" | "accepted" | "unknown" | "provider_completed" | "failed" | "not_submitted" | "collected";
export interface RuntimeSegment extends PreparedSegment {
  attempt: number; slotAttemptId: string; permitAttemptId: string; intentId: string; inputDigest: string;
  state: SegmentState; providerTaskId: string | null; receipt: CandidateReceipt | null;
}
export interface RuntimeBinding {
  version: 1; userId: string; jobId: string; runId: string; stepKey: string; coreAttemptId: string;
  approvalId: string; approvalRevision: number; planDigest: string; coreInputDigest: string;
  backendId: string; accountId: string; configurationDigest: string; reviewDigest: string;
  preparation: VideoPreparation; fence: number; lease: { owner: string; expiresAt: number } | null;
  segments: RuntimeSegment[];
}
export interface VideoLease { jobId: string; userId: string; owner: string; fence: number }
const hash = /^[a-f0-9]{64}$/;
const safeId = /^[a-zA-Z0-9_.-]{1,160}$/;
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_binding");
  return value as Record<string, unknown>;
}
export function reviewDigest(preparation: VideoPreparation): string { return digest({ purpose: "video-runtime-consent-v1", preparation }); }
export function parsePreparation(data: unknown): { preparation: VideoPreparation; consent: VideoConsent } {
  const root = record(data), p = record(root.videoPreparation) as unknown as VideoPreparation;
  const c = record(root.videoConsent) as unknown as VideoConsent;
  if (p.version !== 1 || ![p.userId, p.jobId, p.backendId, p.accountId].every(v => typeof v === "string" && safeId.test(v))
    || !hash.test(p.configurationDigest) || !hash.test(p.preparedJobDigest) || !["legacy_frames", "direct_references", "six_references"].includes(p.mode)
    || !p.pricingBasis || !p.quoteVersion || !Array.isArray(p.materials) || !p.materials.length
    || !Array.isArray(p.segments) || !p.segments.length || p.segments.length > 100) fail("invalid_preparation");
  const indices = new Set<number>();
  const assets = new Set<string>();
  for (const m of p.materials) {
    if (!safeId.test(m.assetId) || !hash.test(m.sha256) || assets.has(`${m.kind}:${m.assetId}`)) fail("invalid_material");
    assets.add(`${m.kind}:${m.assetId}`);
    if (m.kind === "video_asset") {
      if (m.role !== "source" || typeof m.storageKey !== "string" || !m.storageKey) fail("invalid_material");
    } else if (m.kind === "uploaded_asset") {
      if (!["product", "reference"].includes(m.role) || !safeId.test(m.imageContentId)
        || typeof m.assetLocation !== "string" || !m.assetLocation || typeof m.contentLocation !== "string" || !m.contentLocation) fail("invalid_material");
    } else fail("invalid_material");
  }
  if (p.materials.filter(m => m.kind === "video_asset").length !== 1 || p.materials.filter(m => m.role === "product").length !== 1) fail("invalid_material");
  for (const s of p.segments) {
    if (!Number.isSafeInteger(s.index) || s.index < 0 || indices.has(s.index) || !Number.isSafeInteger(s.duration) || s.duration <= 0
      || !Number.isSafeInteger(s.maxCoins) || s.maxCoins < 0 || !Number.isSafeInteger(s.width) || s.width <= 0
      || !Number.isSafeInteger(s.height) || s.height <= 0 || !s.window || !Number.isFinite(s.window.start)
      || !Number.isFinite(s.window.end) || s.window.start < 0 || s.window.end <= s.window.start
      || s.input?.configurationDigest !== p.configurationDigest || !s.input.applicationId || !s.input.mappingVersion) fail("invalid_preparation");
    indices.add(s.index);
    validatePrivateJson(s.input.values);
    if (Object.values(s.input.values).some(v => typeof v !== "string")) fail("invalid_preparation");
  }
  if (c.version !== 1 || c.userId !== p.userId || c.reviewDigest !== reviewDigest(p)
    || !Number.isSafeInteger(c.acceptedAt) || c.acceptedAt <= 0 || c.revokedAt !== null) fail("invalid_consent");
  return { preparation: structuredClone(p), consent: structuredClone(c) };
}
export function rejectLegacy(data: unknown, ownSegments: readonly Pick<RuntimeSegment, "index" | "attempt">[] = []): void {
  const d = record(data);
  const evidenceKeys = ["buildId", "providerTaskId", "submissionIntent", "submissionIntentAt", "candidateKey", "candidateSha256", "candidateMedia",
    "candidateTrimStart", "tailKey", "tailSha256", "accepted", "terminalFailure", "outputKey", "outputSha256", "outputMedia", "cancellation"];
  const legacy = (s: Record<string, unknown>): boolean => {
    if (evidenceKeys.some(k => s[k] !== undefined && s[k] !== null)) return true;
    if (s.attempt !== undefined && s.attempt !== 0 && !ownSegments.some(own => own.index === s.index && own.attempt === s.attempt)) return true;
    // 历史项本身就是旧尝试证据，不能仅看它是否仍保留供应商 ID。
    if (s.history !== undefined && (!Array.isArray(s.history) || s.history.length > 0)) return true;
    return false;
  };
  if (legacy(d) || (Array.isArray(d.segments) && d.segments.some(s => legacy(record(s))))) fail("legacy_job");
}
export function createBinding(actor: ActorContext, step: AgentStep, approval: Approval, data: unknown): RuntimeBinding {
  rejectLegacy(data);
  const { preparation: p, consent } = parsePreparation(data);
  if (Object.keys(step.input).sort().join(",") !== "jobId,reviewDigest" || step.input.jobId !== p.jobId || step.input.reviewDigest !== consent.reviewDigest
    || actor.userId !== p.userId || step.userId !== p.userId || step.toolName !== "video.generate"
    || step.approvalId !== approval.id || step.approvalRevision !== approval.revision || !step.requiresApproval
    || step.quote.video_second !== p.segments.reduce((n, s) => n + s.duration, 0) || Object.keys(step.quote).some(k => k !== "video_second")) fail("preparation_mismatch");
  return { version: 1, userId: p.userId, jobId: p.jobId, runId: step.runId, stepKey: step.stepKey, coreAttemptId: step.attemptId,
    approvalId: approval.id, approvalRevision: approval.revision, planDigest: step.planDigest, coreInputDigest: step.inputDigest,
    backendId: p.backendId, accountId: p.accountId, configurationDigest: p.configurationDigest, reviewDigest: consent.reviewDigest,
    preparation: p, fence: 0, lease: null, segments: p.segments.map(s => {
      const id = digest({ jobId: p.jobId, coreAttemptId: step.attemptId, index: s.index, attempt: 1 });
      return { ...s, attempt: 1, slotAttemptId: `video.${id}`, permitAttemptId: `${p.jobId}:${s.index}:1`, intentId: `vi.${id}`,
        inputDigest: digest({ reviewDigest: consent.reviewDigest, segment: s }), state: "prepared", providerTaskId: null, receipt: null };
    }) };
}
export function parseBinding(data: unknown): RuntimeBinding {
  const b = record(record(data).videoRuntime) as unknown as RuntimeBinding;
  if (b.version !== 1 || ![b.userId, b.jobId, b.runId, b.stepKey, b.coreAttemptId, b.approvalId].every(v => typeof v === "string" && v.length > 0)
    || !Number.isSafeInteger(b.fence) || b.fence < 0 || !Number.isSafeInteger(b.approvalRevision) || !Array.isArray(b.segments)
    || b.reviewDigest !== reviewDigest(b.preparation) || b.backendId !== b.preparation.backendId
    || b.accountId !== b.preparation.accountId || b.configurationDigest !== b.preparation.configurationDigest
    || b.userId !== b.preparation.userId || b.jobId !== b.preparation.jobId || b.segments.length !== b.preparation.segments.length) fail("invalid_binding");
  if (b.lease && (typeof b.lease.owner !== "string" || !b.lease.owner || !Number.isFinite(b.lease.expiresAt))) fail("invalid_binding");
  b.segments.forEach((s, i) => {
    const p = b.preparation.segments[i], id = digest({ jobId: b.jobId, coreAttemptId: b.coreAttemptId, index: p.index, attempt: 1 });
    if (s.attempt !== 1 || s.index !== p.index || s.slotAttemptId !== `video.${id}` || s.intentId !== `vi.${id}`
      || s.permitAttemptId !== `${b.jobId}:${p.index}:1` || s.inputDigest !== digest({ reviewDigest: b.reviewDigest, segment: p })
      || digest({ index: s.index, duration: s.duration, width: s.width, height: s.height, window: s.window, maxCoins: s.maxCoins, input: s.input }) !== digest(p)
      || !["prepared", "submitting", "accepted", "unknown", "provider_completed", "failed", "not_submitted", "collected"].includes(s.state)
      || (s.providerTaskId !== null && !validTaskId(s.providerTaskId))) fail("invalid_binding");
    if ((["accepted", "provider_completed", "collected", "failed"].includes(s.state) && !s.providerTaskId)
      || (["prepared", "not_submitted"].includes(s.state) && s.providerTaskId) || (s.state !== "collected" && s.receipt !== null)) fail("invalid_binding");
    if (s.state === "collected") validateReceipt(b, s, s.receipt);
  });
  return structuredClone(b);
}
export function collectorIdentity(b: RuntimeBinding, s: RuntimeSegment): CollectorIdentity {
  return { userId: b.userId, jobId: b.jobId, segmentIndex: s.index, attempt: s.attempt, inputDigest: s.inputDigest,
    requestedDuration: s.duration, width: s.width, height: s.height };
}
export function validateReceipt(b: RuntimeBinding, s: RuntimeSegment, receipt: CandidateReceipt | null): void {
  const identity = collectorIdentity(b, s);
  if (!receipt || receipt.key !== candidateKey(identity) || receipt.identityDigest !== candidateIdentityDigest(identity)
    || !hash.test(receipt.sha256) || !Number.isSafeInteger(receipt.sizeBytes) || receipt.sizeBytes <= 0
    || !Number.isFinite(receipt.duration) || receipt.duration <= 0 || Math.abs(receipt.duration - s.duration) > MAX_CANDIDATE_DURATION_DRIFT_SECONDS
    || receipt.width !== s.width || receipt.height !== s.height) fail("receipt_mismatch");
}
export function validTaskId(id: unknown): id is string { return typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(id); }
export function intentFor(b: RuntimeBinding, s: RuntimeSegment): VideoSubmissionIntent {
  return { intentId: s.intentId, fencingToken: b.fence, attempt: { backendId: b.backendId, userId: b.userId, runId: b.runId,
    jobId: b.jobId, stepKey: b.stepKey, inputDigest: s.inputDigest, attemptId: s.slotAttemptId } };
}
export function parentOutcome(b: RuntimeBinding, now: number): ToolOutcome {
  if (b.segments.some(s => !["collected", "failed", "not_submitted"].includes(s.state))) return { kind: "pending", jobId: b.jobId, nextCheckAt: now + 5000 };
  const usage = { video_second: b.segments.filter(s => s.state !== "not_submitted").reduce((n, s) => n + s.duration, 0) };
  if (b.segments.some(s => s.state !== "collected")) return { kind: "failed", code: "video_segments_failed", disposition: "charged", usage, jobId: b.jobId };
  return { kind: "succeeded", jobId: b.jobId, usage, output: { candidateCount: b.segments.length } };
}
