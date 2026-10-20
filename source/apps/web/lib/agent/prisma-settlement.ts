import { AgentError, type ActorContext, type ReservationRef, type SlotEvidence } from "./contracts";
import type { AgentTransaction } from "./business-preparer";
import { allocateSlots, applySlotEvidence, type SlotAllocation } from "./settlement";
import { json, lockRun, reservationFromRow, safe, slotFromRow } from "./prisma-state";
import { digest } from "./policy";

async function loadReservation(tx: AgentTransaction, actor: ActorContext, ref: ReservationRef) {
  await lockRun(tx, actor, ref.runId);
  const step = await tx.agentStep.findUnique({ where: { attempt_id: ref.attemptId } });
  if (!step || step.run_id !== ref.runId || step.user_id !== actor.userId || !step.business_managed || step.status === "planned") throw new AgentError("not_found");
  const row = await tx.agentReservation.findUnique({ where: { run_id_attempt_id_unit: { run_id: ref.runId, attempt_id: ref.attemptId, unit: ref.unit } } });
  if (!row || row.user_id !== actor.userId) throw new AgentError("not_found");
  const slots = await tx.agentReservationSlot.findMany({ where: { run_id: ref.runId, attempt_id: ref.attemptId, unit: ref.unit }, orderBy: { slot_attempt_id: "asc" } });
  return { reservation: reservationFromRow(row), slots: slots.map(slotFromRow) };
}
/** 必须先调用 core 入口取得锁，再更改业务表；使用调用者当前事务，绝不自行提交。 */
export function allocateReservationSlotsInTransaction(tx: AgentTransaction, actor: ActorContext, ref: ReservationRef, allocations: readonly SlotAllocation[]) {
  return safe(async () => {
    const { reservation, slots } = await loadReservation(tx, actor, ref);
    const next = allocateSlots(reservation, allocations);
    if (slots.length) {
      const shape = (values: typeof next) => values.map(s => [s.slotAttemptId, s.allocatedAmount]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      if (digest(shape(slots)) !== digest(shape(next))) throw new AgentError("slot_allocation_conflict");
      return slots;
    }
    if (reservation.releasedAmount !== 0 || (reservation.settledAmount ?? 0) !== 0) throw new AgentError("slot_allocation_conflict");
    for (const s of next) await tx.agentReservationSlot.create({ data: { run_id: s.runId, attempt_id: s.attemptId, unit: s.unit,
      slot_attempt_id: s.slotAttemptId, allocated_amount: BigInt(s.allocatedAmount), status: s.status } });
    return next;
  });
}
/** 业务 adapter 与 core 唯一共享结算写入口；可信业务证据须在同一事务中核验并记账。 */
export function settleAgentReservationInTransaction(tx: AgentTransaction, actor: ActorContext, ref: ReservationRef, evidence: SlotEvidence) {
  return safe(async () => {
    const { reservation, slots } = await loadReservation(tx, actor, ref);
    const result = applySlotEvidence(reservation, slots, evidence);
    if (!result.changed) return result;
    const s = result.slot;
    await tx.agentReservationSlot.update({ where: { run_id_attempt_id_unit_slot_attempt_id: {
      run_id: ref.runId, attempt_id: ref.attemptId, unit: ref.unit, slot_attempt_id: s.slotAttemptId } }, data: {
      settled_amount: BigInt(s.settledAmount), released_amount: BigInt(s.releasedAmount), status: s.status, evidence_digest: s.evidenceDigest, evidence: json(s.evidence) } });
    const r = result.reservation;
    await tx.agentReservation.update({ where: { run_id_attempt_id_unit: { run_id: ref.runId, attempt_id: ref.attemptId, unit: ref.unit } }, data: {
      settled_amount: BigInt(r.settledAmount ?? 0), released_amount: BigInt(r.releasedAmount), status: r.status, settlement_basis: r.settlementBasis } });
    await tx.agentRun.update({ where: { id: ref.runId }, data: { revision: { increment: 1 } } });
    return result;
  });
}
