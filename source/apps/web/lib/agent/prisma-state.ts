import { Prisma, type AgentRun as RunRow, type AgentReservation as ReservationRow, type AgentReservationSlot as SlotRow } from "@prisma/client";
import { AgentError, type ActorContext, type Approval, type AgentStep, type AgentRun, type ModelTurn, type Reservation, type ReservationSlot, type PublicEvent } from "./contracts";
import type { AgentTransaction } from "./business-preparer";
import type { StoredRun } from "./repository-base";

export const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
export const nullableJson = (value: unknown) => value === null ? Prisma.DbNull : json(value);
export function validateActor(actor: ActorContext): void {
  if (!actor.userId || !["session", "api_key", "worker"].includes(actor.source) || !Array.isArray(actor.permissions)) throw new AgentError("not_found");
}
export async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { if (error instanceof AgentError) throw error; throw new AgentError("repository_failure"); }
}
export async function lockAccount(tx: AgentTransaction, actor: ActorContext): Promise<void> {
  validateActor(actor);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${actor.userId} FOR UPDATE`;
  if (!rows.length) throw new AgentError("not_found");
}
/** 全部写入口共用：账户 → run → approval → step → reservation → slot → 业务表 → event。
 * 同账户锁也保护 model turn、线程及空结果；每类行按稳定键排序。调用者不能预先锁业务表。
 */
export async function lockRun(tx: AgentTransaction, actor: ActorContext, runId: string): Promise<void> {
  await lockAccount(tx, actor);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AgentRun" WHERE id = ${runId} AND user_id = ${actor.userId} FOR UPDATE`;
  if (!rows.length) throw new AgentError("not_found");
  await tx.$queryRaw`SELECT id FROM "AgentApproval" WHERE run_id = ${runId} ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT attempt_id FROM "AgentStep" WHERE run_id = ${runId} ORDER BY attempt_id FOR UPDATE`;
  await tx.$queryRaw`SELECT attempt_id FROM "AgentReservation" WHERE run_id = ${runId} ORDER BY attempt_id, unit FOR UPDATE`;
  await tx.$queryRaw`SELECT slot_attempt_id FROM "AgentReservationSlot" WHERE run_id = ${runId} ORDER BY attempt_id, unit, slot_attempt_id FOR UPDATE`;
}
export async function databaseNow(tx: AgentTransaction): Promise<number> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now.getTime();
}
function amount(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new AgentError("repository_failure");
  return n;
}
export function reservationFromRow(r: ReservationRow): Reservation {
  return { runId: r.run_id, userId: r.user_id, approvalId: r.approval_id, attemptId: r.attempt_id,
    unit: r.unit as Reservation["unit"], reservedAmount: amount(r.reserved_amount), settledAmount: r.settled_amount === null ? null : amount(r.settled_amount),
    releasedAmount: amount(r.released_amount), status: r.status as Reservation["status"], settlementBasis: r.settlement_basis as Reservation["settlementBasis"] };
}
export function slotFromRow(s: SlotRow): ReservationSlot {
  return { runId: s.run_id, attemptId: s.attempt_id, unit: s.unit as ReservationSlot["unit"], slotAttemptId: s.slot_attempt_id,
    allocatedAmount: amount(s.allocated_amount), settledAmount: amount(s.settled_amount), releasedAmount: amount(s.released_amount),
    status: s.status as ReservationSlot["status"], evidenceDigest: s.evidence_digest, evidence: s.evidence as unknown as ReservationSlot["evidence"] };
}
export function runFromRow(r: RunRow): AgentRun {
  return { id: r.id, userId: r.user_id, threadId: r.thread_id, clientRequestId: r.client_request_id,
    creationDigest: r.creation_digest, planDigest: r.plan_digest, plan: r.plan as unknown as AgentRun["plan"], limits: r.limits as unknown as AgentRun["limits"],
    status: r.status as AgentRun["status"], revision: r.revision, fence: r.fence, modelCalls: r.model_calls, toolCalls: r.tool_calls,
    lease: r.lease_worker_id && r.lease_expires_at ? { workerId: r.lease_worker_id, expiresAt: r.lease_expires_at.getTime(), fence: r.fence } : null };
}
export async function readState(tx: AgentTransaction, actor: ActorContext, runId: string): Promise<StoredRun> {
  validateActor(actor);
  const r = await tx.agentRun.findFirst({ where: { id: runId, user_id: actor.userId } });
  if (!r) throw new AgentError("not_found");
  const run = runFromRow(r);
  const turns: ModelTurn[] = (await tx.agentModelTurn.findMany({ where: { run_id: runId }, orderBy: { turn_index: "asc" } })).map(t => ({
    id: t.id, index: t.turn_index, planDigest: t.plan_digest, status: t.status as ModelTurn["status"], assistantText: t.assistant_text,
    calls: t.calls as unknown as ModelTurn["calls"], ...(t.finish ? { finish: t.finish as ModelTurn["finish"] } : {}) }));
  const approvals: Approval[] = (await tx.agentApproval.findMany({ where: { run_id: runId }, orderBy: { approval_index: "asc" } })).map(a => ({
    id: a.id, runId: a.run_id, userId: a.user_id, revision: a.revision, planDigest: a.plan_digest, pricingVersion: a.pricing_version,
    allowedTools: a.allowed_tools as string[], limits: a.limits as unknown as Approval["limits"], expiresAt: a.expires_at.getTime(), revokedAt: a.revoked_at?.getTime() ?? null }));
  const steps: AgentStep[] = (await tx.agentStep.findMany({ where: { run_id: runId }, orderBy: { step_index: "asc" } })).map(s => ({
    runId: s.run_id, userId: s.user_id, stepKey: s.step_key, attemptId: s.attempt_id, modelTurnId: s.model_turn_id, toolCallId: s.tool_call_id,
    toolName: s.tool_name, planDigest: s.plan_digest, inputDigest: s.input_digest, quoteDigest: s.quote_digest, input: s.input as AgentStep["input"],
    quote: s.quote as AgentStep["quote"], requiresApproval: s.requires_approval, status: s.status as AgentStep["status"], approvalId: s.approval_id,
    approvalRevision: s.approval_revision, submissionFence: s.submission_fence, jobId: s.job_id, outcome: s.outcome as unknown as AgentStep["outcome"], businessManaged: s.business_managed }));
  const reservations = (await tx.agentReservation.findMany({ where: { run_id: runId }, orderBy: [{ attempt_id: "asc" }, { unit: "asc" }] })).map(reservationFromRow);
  const events: PublicEvent[] = (await tx.agentEvent.findMany({ where: { run_id: runId }, orderBy: { event_seq: "asc" } })).map(e => ({
    seq: e.event_seq, type: e.type as PublicEvent["type"], runStatus: e.run_status as PublicEvent["runStatus"],
    ...(e.step_number === null ? {} : { stepNumber: e.step_number }), ...(e.step_status === null ? {} : { stepStatus: e.step_status as PublicEvent["stepStatus"] }) }));
  return { snapshot: { run, turns, approvals, steps, reservations }, events, now: await databaseNow(tx) };
}
export function runData(r: AgentRun) {
  return { id: r.id, thread_id: r.threadId, user_id: r.userId, client_request_id: r.clientRequestId, creation_digest: r.creationDigest,
    plan_digest: r.planDigest, plan: json(r.plan), limits: json(r.limits), status: r.status, revision: r.revision, fence: r.fence,
    lease_worker_id: r.lease?.workerId ?? null, lease_expires_at: r.lease ? new Date(r.lease.expiresAt) : null, model_calls: r.modelCalls, tool_calls: r.toolCalls };
}
export async function saveState(tx: AgentTransaction, record: StoredRun): Promise<void> {
  const { run, turns, approvals, steps, reservations } = record.snapshot;
  await tx.agentRun.update({ where: { id: run.id }, data: runData(run) });
  for (const t of turns) {
    const data = { id: t.id, run_id: run.id, turn_index: t.index, plan_digest: t.planDigest, status: t.status, assistant_text: t.assistantText, calls: json(t.calls), finish: t.finish ?? null };
    await tx.agentModelTurn.upsert({ where: { id: t.id }, create: data, update: data });
  }
  for (const [index, a] of approvals.entries()) {
    const data = { id: a.id, run_id: a.runId, user_id: a.userId, approval_index: index, revision: a.revision, plan_digest: a.planDigest,
      pricing_version: a.pricingVersion, allowed_tools: json(a.allowedTools), limits: json(a.limits), expires_at: new Date(a.expiresAt), revoked_at: a.revokedAt === null ? null : new Date(a.revokedAt) };
    await tx.agentApproval.upsert({ where: { id: a.id }, create: data, update: data });
  }
  for (const [index, s] of steps.entries()) {
    const data = { attempt_id: s.attemptId, run_id: s.runId, user_id: s.userId, step_index: index, step_key: s.stepKey, model_turn_id: s.modelTurnId,
      tool_call_id: s.toolCallId, tool_name: s.toolName, plan_digest: s.planDigest, input_digest: s.inputDigest, quote_digest: s.quoteDigest,
      input: json(s.input), quote: json(s.quote), requires_approval: s.requiresApproval, status: s.status, approval_id: s.approvalId,
      approval_revision: s.approvalRevision, submission_fence: s.submissionFence, job_id: s.jobId, business_managed: s.businessManaged, outcome: nullableJson(s.outcome) };
    await tx.agentStep.upsert({ where: { attempt_id: s.attemptId }, create: data, update: data });
  }
  for (const r of reservations) {
    const data = { run_id: r.runId, attempt_id: r.attemptId, unit: r.unit, user_id: r.userId, approval_id: r.approvalId, reserved_amount: BigInt(r.reservedAmount),
      settled_amount: r.settledAmount === null ? null : BigInt(r.settledAmount), released_amount: BigInt(r.releasedAmount), status: r.status, settlement_basis: r.settlementBasis };
    await tx.agentReservation.upsert({ where: { run_id_attempt_id_unit: { run_id: r.runId, attempt_id: r.attemptId, unit: r.unit } }, create: data, update: data });
  }
}
export async function appendEvents(tx: AgentTransaction, record: StoredRun, previousCount: number): Promise<void> {
  for (const e of record.events.slice(previousCount)) await tx.agentEvent.create({ data: {
    run_id: record.snapshot.run.id, user_id: record.snapshot.run.userId, event_seq: e.seq, type: e.type, run_status: e.runStatus,
    step_number: e.stepNumber, step_status: e.stepStatus } });
}
