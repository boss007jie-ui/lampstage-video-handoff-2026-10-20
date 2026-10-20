import { AgentError, type Reservation, type ReservationSlot, type SlotEvidence } from "./contracts";
import { digest, validatePrivateJson, reservationUnresolved } from "./policy";

export interface SlotAllocation { slotAttemptId: string; amount: number }
export function allocateSlots(reservation: Reservation, allocations: readonly SlotAllocation[]): ReservationSlot[] {
  const ids = new Set<string>();
  let total = 0;
  for (const allocation of allocations) {
    if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(allocation.slotAttemptId) || ids.has(allocation.slotAttemptId)
      || !Number.isSafeInteger(allocation.amount) || allocation.amount <= 0) throw new AgentError("invalid_slot_allocation");
    ids.add(allocation.slotAttemptId);
    total += allocation.amount;
  }
  if (!Number.isSafeInteger(total) || total !== reservation.reservedAmount) throw new AgentError("invalid_slot_allocation");
  return allocations.map(a => ({ runId: reservation.runId, attemptId: reservation.attemptId, unit: reservation.unit,
    slotAttemptId: a.slotAttemptId, allocatedAmount: a.amount, settledAmount: 0, releasedAmount: 0,
    status: "pending", evidenceDigest: null, evidence: null }));
}

/** 纯结算变换；DB 层必须在锁定原预留及全部 slot 后使用，不能先读后写。 */
export function applySlotEvidence(reservation: Reservation, slots: readonly ReservationSlot[], evidence: SlotEvidence): {
  reservation: Reservation; slot: ReservationSlot; changed: boolean;
} {
  validatePrivateJson(evidence as unknown);
  if (!evidence.reference || !["unknown", "final"].includes(evidence.kind)) throw new AgentError("invalid_settlement");
  if (slots.some(s => s.runId !== reservation.runId || s.attemptId !== reservation.attemptId || s.unit !== reservation.unit)
    || slots.reduce((sum, s) => sum + s.allocatedAmount, 0) !== reservation.reservedAmount) throw new AgentError("invalid_slot_allocation");
  const original = slots.find(s => s.slotAttemptId === evidence.slotAttemptId);
  if (!original) throw new AgentError("invalid_slot_allocation");
  const evidenceDigest = digest(evidence);
  if (original.evidenceDigest === evidenceDigest) return { reservation: structuredClone(reservation), slot: structuredClone(original), changed: false };
  if (original.status === "final") throw new AgentError("settlement_conflict");
  const slot = structuredClone(original);
  if (evidence.kind === "final") {
    if (![evidence.settledAmount, evidence.releasedAmount].every(n => Number.isSafeInteger(n) && n >= 0)
      || evidence.settledAmount + evidence.releasedAmount !== slot.allocatedAmount) throw new AgentError("invalid_settlement");
    slot.settledAmount = evidence.settledAmount;
    slot.releasedAmount = evidence.releasedAmount;
    slot.status = "final";
  } else slot.status = "unknown";
  slot.evidence = structuredClone(evidence);
  slot.evidenceDigest = evidenceDigest;
  const all = slots.map(s => s.slotAttemptId === slot.slotAttemptId ? slot : s);
  const result = structuredClone(reservation);
  result.settledAmount = all.reduce((sum, s) => sum + s.settledAmount, 0);
  result.releasedAmount = all.reduce((sum, s) => sum + s.releasedAmount, 0);
  if (reservationUnresolved(result) < 0) throw new AgentError("invalid_settlement");
  result.settlementBasis = "actual";
  result.status = reservationUnresolved(result) === 0 ? (result.settledAmount === 0 ? "released" : "settled")
    : all.some(s => s.status === "unknown") ? "unknown" : "reserved";
  return { reservation: result, slot, changed: true };
}
