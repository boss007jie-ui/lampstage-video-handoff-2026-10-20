import type { ActorContext, RunSnapshot, SlotEvidence } from "../../agent/contracts";
import { assertApproval, assertStepPolicy, digest } from "../../agent/policy";
import type { VideoPreparedInput, VideoSubmissionIntent, VideoSubmissionResult } from "../backends/contracts";
import { fail, intentFor, parsePreparation, validTaskId, validateReceipt, type RuntimeBinding, type RuntimeSegment, type VideoLease } from "./binding";
import type { CandidateReceipt } from "./collector";

export interface Permit { attemptId: string; accountId: string; jobId: string; segmentIndex: number; maxCoins: number; status: "active" | "unknown" | "released" }
export interface JobLeaseView { id: string; status: string; phase: string; owner: string | null; until: number | null; segments: { index: number; attempt?: number }[] }
/** 事务内状态副本；真实数据库与 fake 存储都必须原子提交此副本。 */
export interface RuntimeTransaction {
  now: number; actor: ActorContext; binding: RuntimeBinding; currentData: unknown; core: RunSnapshot;
  materialsValid: boolean; permits: Permit[]; jobs: JobLeaseView[]; effects: SlotEvidence[];
}
export function checkLease(t: RuntimeTransaction, token: VideoLease): void {
  const b = t.binding;
  if (token.userId !== b.userId || token.jobId !== b.jobId || token.owner !== b.lease?.owner || token.fence !== b.fence
    || !b.lease || b.lease.expiresAt <= t.now) fail("lease_lost");
}
export function segment(t: RuntimeTransaction, index: number): RuntimeSegment { return t.binding.segments.find(s => s.index === index) ?? fail("segment_missing"); }
function evidence(t: RuntimeTransaction, s: RuntimeSegment, kind: "unknown" | "consumed" | "released") {
  t.effects.push(kind === "unknown" ? { kind, slotAttemptId: s.slotAttemptId, reference: `${s.intentId}.unknown` }
    : { kind: "final", slotAttemptId: s.slotAttemptId, reference: `${s.intentId}.${kind}`,
      settledAmount: kind === "consumed" ? s.duration : 0, releasedAmount: kind === "released" ? s.duration : 0 });
}
const terminal = (s: RuntimeSegment) => ["provider_completed", "collected", "failed", "not_submitted"].includes(s.state);
function unknown(t: RuntimeTransaction, s: RuntimeSegment) {
  if (terminal(s)) return;
  s.state = "unknown";
  const p = t.permits.find(p => p.attemptId === s.permitAttemptId);
  if (p && p.status !== "released") p.status = "unknown";
  evidence(t, s, "unknown");
}
/** 跨 job 扫描只隔离 permit，不锁定或结算另一个 core run。 */
export function quarantineOrphans(t: RuntimeTransaction): void {
  for (const p of t.permits.filter(p => p.status === "active")) {
    const j = t.jobs.find(j => j.id === p.jobId), s = j?.segments.find(s => s.index === p.segmentIndex);
    if (!j || j.status !== "generating" || j.phase !== "render" || !j.owner || !j.until || j.until <= t.now
      || !s || p.attemptId !== `${j.id}:${s.index}:${s.attempt ?? 0}`) {
      p.status = "unknown";
      const own = t.binding.segments.find(s => s.permitAttemptId === p.attemptId);
      if (own) unknown(t, own);
    }
  }
}
export function claimLease(t: RuntimeTransaction, owner: string, ttlMs: number): VideoLease | null {
  if (!owner || owner.length > 160 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) fail("invalid_lease");
  if (t.binding.lease && t.binding.lease.expiresAt > t.now) return null;
  quarantineOrphans(t);
  t.binding.fence += 1;
  t.binding.lease = { owner, expiresAt: t.now + ttlMs };
  return { jobId: t.binding.jobId, userId: t.binding.userId, owner, fence: t.binding.fence };
}
export function heartbeat(t: RuntimeTransaction, token: VideoLease, ttlMs: number): void {
  checkLease(t, token);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) fail("invalid_lease");
  t.binding.lease!.expiresAt = t.now + ttlMs;
}
export function release(t: RuntimeTransaction, token: VideoLease): void {
  checkLease(t, token);
  for (const s of t.binding.segments) if (!terminal(s) && s.state !== "prepared") unknown(t, s);
  t.binding.lease = null;
}
export function authorized(t: RuntimeTransaction): boolean {
  const b = t.binding, run = t.core.run, step = t.core.steps.find(s => s.attemptId === b.coreAttemptId);
  const approval = t.core.approvals.find(a => a.id === b.approvalId);
  try {
    if (!step || !approval || step.jobId !== b.jobId || step.stepKey !== b.stepKey || !step.businessManaged
      || step.runId !== b.runId || step.userId !== b.userId || ["succeeded", "failed", "planned"].includes(step.status)
      || run.id !== b.runId || run.userId !== b.userId || step.inputDigest !== b.coreInputDigest
      || step.planDigest !== b.planDigest || step.approvalId !== b.approvalId || step.approvalRevision !== b.approvalRevision
      || approval.revision !== b.approvalRevision || ["cancel_requested", "cancelled", "failed", "completed"].includes(run.status)
      || !t.materialsValid) return false;
    const current = parsePreparation(t.currentData);
    if (current.consent.acceptedAt > t.now || digest(current.preparation) !== digest(b.preparation)) return false;
    assertStepPolicy(t.actor, run, step, step.quote, b.preparation.quoteVersion);
    assertApproval(approval, run, step, t.now);
    return true;
  } catch { return false; }
}
export function gate(t: RuntimeTransaction, token: VideoLease, intent: VideoSubmissionIntent, input: VideoPreparedInput): "claimed" | "not_authorized" | "already_claimed" {
  checkLease(t, token);
  const s = t.binding.segments.find(s => s.intentId === intent.intentId) ?? fail("intent_mismatch");
  if (digest(intent) !== digest(intentFor(t.binding, s)) || digest(input) !== digest(s.input)) fail("intent_mismatch");
  // 已提交的意图先于后来发生的审批失效或取消判断。
  if (s.state !== "prepared") return "already_claimed";
  if (!authorized(t)) return "not_authorized";
  quarantineOrphans(t);
  if (t.permits.some(p => p.status === "unknown") || t.permits.filter(p => p.status === "active").length >= 3) return "not_authorized";
  if (t.permits.some(p => p.attemptId === s.permitAttemptId)) fail("permit_conflict");
  t.permits.push({ attemptId: s.permitAttemptId, accountId: t.binding.accountId, jobId: t.binding.jobId,
    segmentIndex: s.index, maxCoins: s.maxCoins, status: "active" });
  s.state = "submitting";
  return "claimed";
}
export function observeSubmission(t: RuntimeTransaction, token: VideoLease, index: number, result: VideoSubmissionResult): void {
  checkLease(t, token);
  const s = segment(t, index);
  if (terminal(s)) return;
  if (s.state === "prepared") fail("intent_missing");
  if (result.kind !== "definite_not_submitted" && result.taskId !== undefined) {
    if (!validTaskId(result.taskId) || (s.providerTaskId && s.providerTaskId !== result.taskId)) return unknown(t, s);
    s.providerTaskId = result.taskId;
  }
  if (result.kind === "accepted") { s.state = "accepted"; return; }
  if (result.kind === "submission_unknown") return unknown(t, s);
  // 迟到拒绝不能推翻已受理或可能已发送的证据。
  if (s.state !== "submitting" || s.providerTaskId) return unknown(t, s);
  settleFinal(t, s, "not_submitted");
}
export function rejectPrepared(t: RuntimeTransaction, token: VideoLease, index: number): void {
  checkLease(t, token);
  const s = segment(t, index);
  if (s.state !== "prepared") fail("absence_unproven");
  settleFinal(t, s, "not_submitted");
}
export function finalize(t: RuntimeTransaction, token: VideoLease, index: number, outcome: "provider_completed" | "failed"): void {
  checkLease(t, token);
  const s = segment(t, index);
  if (terminal(s)) return;
  if (!s.providerTaskId) fail("task_missing");
  settleFinal(t, s, outcome);
}
function settleFinal(t: RuntimeTransaction, s: RuntimeSegment, outcome: "provider_completed" | "failed" | "not_submitted") {
  s.state = outcome;
  const p = t.permits.find(p => p.attemptId === s.permitAttemptId);
  if (p) p.status = "released";
  evidence(t, s, outcome === "not_submitted" ? "released" : "consumed");
}
export function publishReceipt(t: RuntimeTransaction, token: VideoLease, index: number, receipt: CandidateReceipt): void {
  checkLease(t, token);
  const s = segment(t, index);
  if (s.state === "collected") { if (digest(s.receipt) !== digest(receipt)) fail("receipt_conflict"); return; }
  if (s.state !== "provider_completed") fail("terminal_required");
  validateReceipt(t.binding, s, receipt);
  s.receipt = receipt; s.state = "collected";
}
