/**
 * 额度原子操作：扣减、退款。
 *
 * 设计：
 * - 所有改 credit_balance 的地方走这里，绝不直接 update
 * - 必须在 Prisma 事务里调用（接 tx 参数）
 * - 同时写 CreditTransaction 留痕
 */
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

const NEW_USER_GRANT = 20;

/**
 * 扣减额度。原子的：先 SELECT FOR UPDATE 锁定行，再更新。
 *
 * 余额 < amount 抛 InsufficientCreditsError，调用方需捕获并回滚事务。
 */
export class InsufficientCreditsError extends Error {
  constructor() {
    super("INSUFFICIENT_CREDITS");
    this.name = "InsufficientCreditsError";
  }
}

export async function consumeCredits(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  relatedJobId: string,
  note: string = "generation_consume",
): Promise<{ balanceAfter: number; chargedCredits: number; billingMode: "standard" | "internal_test" }> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("consumeCredits: amount must be a positive integer");

  // Postgres-specific: SELECT ... FOR UPDATE 在事务里锁住该用户行
  const rows = await tx.$queryRaw<{ credit_balance: number; credits_unlimited: boolean }[]>`
    SELECT "credit_balance", "credits_unlimited" FROM "User" WHERE id = ${userId} FOR UPDATE
  `;
  if (rows.length === 0) throw new Error(`user ${userId} not found`);
  const before = rows[0].credit_balance;
  if (rows[0].credits_unlimited) {
    return { balanceAfter: before, chargedCredits: 0, billingMode: "internal_test" };
  }
  if (before < amount) throw new InsufficientCreditsError();

  await tx.user.update({
    where: { id: userId },
    data: { credit_balance: { decrement: amount } },
  });
  await tx.creditTransaction.create({
    data: {
      user_id: userId,
      type: "consume",
      amount: -amount,
      related_job_id: relatedJobId,
      note,
    },
  });
  return { balanceAfter: before - amount, chargedCredits: amount, billingMode: "standard" };
}

/**
 * 退款额度（生成失败用）。
 */
export async function refundCredits(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  relatedJobId: string,
  note: string = "generation_refund",
): Promise<{ balanceAfter: number }> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("refundCredits: amount must be a positive integer");
  // Refund only actual, outstanding debits for this job. A later account-mode change
  // must never mint credits for a free test job or suppress a paid job's refund.
  const rows = await tx.$queryRaw<{ credit_balance: number }[]>`
    SELECT "credit_balance" FROM "User" WHERE id = ${userId} FOR UPDATE
  `;
  if (rows.length === 0) throw new Error(`user ${userId} not found`);
  const ledger = await tx.creditTransaction.aggregate({
    where: { user_id: userId, related_job_id: relatedJobId, type: { in: ["consume", "refund"] } },
    _sum: { amount: true },
  });
  const refundable = Math.min(amount, Math.max(0, -(ledger._sum.amount ?? 0)));
  if (refundable === 0) return { balanceAfter: rows[0].credit_balance };
  const updated = await tx.user.update({
    where: { id: userId },
    data: { credit_balance: { increment: refundable } },
  });
  await tx.creditTransaction.create({
    data: {
      user_id: userId,
      type: "refund",
      amount: refundable,
      related_job_id: relatedJobId,
      note,
    },
  });
  return { balanceAfter: updated.credit_balance };
}

export const constants = { NEW_USER_GRANT };

/** 视频引用独立于 GenerationJob 外键；确定性主键与用户行锁共同防止重扣/重退。 */
export function videoCallLedgerId(userId: string, callId: string, type: "consume" | "refund") {
  return `video_call_${type}_${createHash("sha256").update(JSON.stringify([userId, callId])).digest("hex")}`;
}
export async function consumeVideoCallCredits(tx: Prisma.TransactionClient, userId: string, callId: string, amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0 || !/^vc_[A-Za-z0-9_-]+$/.test(callId)) throw new Error("invalid_video_call_debit");
  const rows = await tx.$queryRaw<{ credit_balance: number; credits_unlimited: boolean }[]>`SELECT "credit_balance", "credits_unlimited" FROM "User" WHERE id = ${userId} FOR UPDATE`;
  if (!rows.length) throw new Error("user_not_found");
  if (amount === 0 && !rows[0].credits_unlimited) throw new Error("invalid_video_call_debit");
  const id = videoCallLedgerId(userId, callId, "consume");
  const existing = await tx.creditTransaction.findUnique({ where: { id } });
  if (existing) {
    if (existing.user_id !== userId || existing.amount !== -amount || existing.type !== "consume" || existing.related_job_id !== null) throw new Error("video_call_debit_conflict");
    return { balanceAfter: rows[0].credit_balance, chargedCredits: amount, billingMode: "standard" as const, transactionId: id };
  }
  if (rows[0].credits_unlimited) return { balanceAfter: rows[0].credit_balance, chargedCredits: 0, billingMode: "internal_test" as const, transactionId: undefined };
  if (rows[0].credit_balance < amount) throw new InsufficientCreditsError();
  await tx.user.update({ where: { id: userId }, data: { credit_balance: { decrement: amount } } });
  await tx.creditTransaction.create({ data: { id, user_id: userId, type: "consume", amount: -amount, related_job_id: null, note: `video_call:${callId}:consume` } });
  return { balanceAfter: rows[0].credit_balance - amount, chargedCredits: amount, billingMode: "standard" as const, transactionId: id };
}
export async function refundVideoCallCredits(tx: Prisma.TransactionClient, userId: string, callId: string, amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0 || !/^vc_[A-Za-z0-9_-]+$/.test(callId)) throw new Error("invalid_video_call_refund");
  const rows = await tx.$queryRaw<{ credit_balance: number }[]>`SELECT "credit_balance" FROM "User" WHERE id = ${userId} FOR UPDATE`;
  if (!rows.length) throw new Error("user_not_found");
  const id = videoCallLedgerId(userId, callId, "refund");
  const debit = await tx.creditTransaction.findUnique({ where: { id: videoCallLedgerId(userId, callId, "consume") } });
  const existing = await tx.creditTransaction.findUnique({ where: { id } });
  if (existing) {
    if (existing.user_id !== userId || existing.type !== "refund" || existing.related_job_id !== null || !debit || existing.amount > -debit.amount) throw new Error("video_call_refund_conflict");
    return { balanceAfter: rows[0].credit_balance, refundedCredits: existing.amount, transactionId: id };
  }
  if (!debit) return { balanceAfter: rows[0].credit_balance, refundedCredits: 0, transactionId: undefined };
  if (debit.user_id !== userId || debit.type !== "consume" || debit.related_job_id !== null || debit.amount >= 0) throw new Error("video_call_debit_conflict");
  if (amount === 0) throw new Error("invalid_video_call_refund");
  const refund = Math.min(amount, -debit.amount);
  await tx.user.update({ where: { id: userId }, data: { credit_balance: { increment: refund } } });
  await tx.creditTransaction.create({ data: { id, user_id: userId, type: "refund", amount: refund, related_job_id: null, note: `video_call:${callId}:refund` } });
  return { balanceAfter: rows[0].credit_balance + refund, refundedCredits: refund, transactionId: id };
}
