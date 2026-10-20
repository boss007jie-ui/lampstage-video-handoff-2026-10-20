import test from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { consumeVideoCallCredits, refundVideoCallCredits } from "../../lib/credits";

function fake(unlimited = false) {
  let balance = 30, locks = 0;
  const rows = new Map<string, { id: string; user_id: string; amount: number; related_job_id: null; note: string; type: string }>();
  const tx = { $queryRaw: async () => { locks++; return [{ credit_balance: balance, credits_unlimited: unlimited }]; },
    creditTransaction: { findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      create: async ({ data }: { data: any }) => { assert.equal(data.related_job_id, null); assert.ok(!rows.has(data.id)); rows.set(data.id, data); return data; } },
    user: { update: async ({ data }: any) => { balance += (data.credit_balance.increment ?? 0) - (data.credit_balance.decrement ?? 0); return { credit_balance: balance }; } } };
  return { tx: tx as unknown as Prisma.TransactionClient, rows, balance: () => balance, locks: () => locks };
}
test("视频账本单次扣款退款去重且不写GenerationJob FK", async () => {
  const f = fake();
  await consumeVideoCallCredits(f.tx, "user", "vc_job", 12);
  await consumeVideoCallCredits(f.tx, "user", "vc_job", 12);
  assert.equal(f.balance(), 18);
  await refundVideoCallCredits(f.tx, "user", "vc_job", 99);
  await refundVideoCallCredits(f.tx, "user", "vc_job", 99);
  assert.equal(f.balance(), 30);
  assert.equal(f.rows.size, 2);
  assert.equal(f.locks(), 4);
});
test("内测免扣不产生虚构扣款与退款", async () => {
  const f = fake(true);
  const result = await consumeVideoCallCredits(f.tx, "user", "vc_job", 12);
  assert.equal(result.chargedCredits, 0);
  assert.equal(result.billingMode, "internal_test");
  await refundVideoCallCredits(f.tx, "user", "vc_job", 12);
  assert.equal(f.balance(), 30);
  assert.equal(f.rows.size, 0);
});
test("退款后不能再扣款，改变金额也不能复用扣款引用", async () => {
  const f = fake();
  await consumeVideoCallCredits(f.tx, "user", "vc_job", 12);
  await refundVideoCallCredits(f.tx, "user", "vc_job", 12);
  await consumeVideoCallCredits(f.tx, "user", "vc_job", 12);
  assert.equal(f.balance(), 30);
  await assert.rejects(consumeVideoCallCredits(f.tx, "user", "vc_job", 13));
});

test("零金额仅服务端免扣账户可消费，不制造零值账本", async () => {
  const free = fake(true);
  const result = await consumeVideoCallCredits(free.tx, "user", "vc_zero", 0);
  assert.equal(result.billingMode, "internal_test");
  assert.equal(result.chargedCredits, 0);
  await refundVideoCallCredits(free.tx, "user", "vc_zero", 0);
  assert.equal(free.rows.size, 0);
  const paid = fake();
  await assert.rejects(consumeVideoCallCredits(paid.tx, "user", "vc_zero", 0), /invalid_video_call_debit/);
  assert.equal(paid.rows.size, 0);
  await consumeVideoCallCredits(paid.tx, "user", "vc_paid", 12);
  await assert.rejects(refundVideoCallCredits(paid.tx, "user", "vc_paid", 0), /invalid_video_call_refund/);
  assert.equal(paid.rows.size, 1);
  assert.equal(paid.balance(), 18);
});
