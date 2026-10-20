import test from "node:test";
import assert from "node:assert/strict";
import type { Prisma, VideoJob } from "@prisma/client";
import { acceptVideoCall, callView } from "../../lib/video-calls/service";
import { isSingleCallJob, inputDigest, parseCallInput, type SingleCall } from "../../lib/video-calls/contract";
import { generationMode } from "../../lib/video/reference-inputs";
import { videoData } from "../../lib/video/types";

const input = parseCallInput({ request_id: "one", motion_asset_id: "motion", reference_assets: [{ asset_id: "image" }], prompt: "first\nsecond", duration: 4, max_credits: 20 });
const base: SingleCall = { version: 1, kind: "single_call", request_id: "one", input_digest: inputDigest(input), input,
  motion: { asset_id: "motion", key: "videos/vc_test/motion.mp4", sha256: "a".repeat(64), mime: "video/mp4", size_bytes: 100 },
  references: [{ asset_id: "image", key: "videos/vc_test/ref.png", sha256: "b".repeat(64), mime: "image/png", size_bytes: 100 }],
  quote_credits: 12, max_credits: 20, billing: { mode: "standard", charged_credits: 0, refunded_credits: 0 } };
function fixture(unlimited = false, initialBalance = 30) {
  let job: VideoJob | null = null, balance = initialBalance, debitCount = 0;
  const tx = {
    $queryRaw: async () => [{ credit_balance: balance, credits_unlimited: unlimited }],
    videoJob: { findFirst: async () => job, count: async () => 0, create: async ({ data }: any) => { job = { ...data, revision: 0, created_at: new Date(), updated_at: new Date(), error: null }; return job; } },
    user: { update: async ({ data }: any) => { balance -= data.credit_balance.decrement; return { credit_balance: balance }; } },
    creditTransaction: { findUnique: async () => null, create: async ({ data }: any) => { debitCount++; return data; } },
  } as unknown as Prisma.TransactionClient;
  return { tx, balance: () => balance, debitCount: () => debitCount };
}
test("同幂等键恢复原任务与原账本，异摘要409", async () => {
  const f = fixture();
  const first = await acceptVideoCall(f.tx, "u", "vc_test", structuredClone(base));
  const second = await acceptVideoCall(f.tx, "u", "vc_test", structuredClone(base));
  assert.equal(second.reused, true);
  assert.equal(first.job.id, second.job.id);
  assert.equal(f.balance(), 18);
  assert.equal(f.debitCount(), 1);
  await assert.rejects(acceptVideoCall(f.tx, "u", "vc_test", { ...structuredClone(base), input_digest: "different" }), { code: "request_id_conflict", status: 409 });
});

test("免扣账户零余额零上限受理，真实quote为0且供应商费用unknown", async () => {
  const f = fixture(true, 0);
  const call = { ...structuredClone(base), max_credits: 0 };
  const result = await acceptVideoCall(f.tx, "u", "vc_free", call);
  const view = callView(result.job);
  assert.equal(view.quote.credits, 0);
  assert.equal(view.quote.billing_mode, "internal_test");
  assert.equal(view.billing.charged_credits, 0);
  assert.equal(view.billing.supplier_cost, null);
  assert.equal(view.billing.supplier_cost_status, "unknown");
  assert.equal(f.balance(), 0);
  assert.equal(f.debitCount(), 0);
});

test("标准账户零上限拒绝；免扣模式撤销后零报价不转为收费", async () => {
  const f = fixture();
  await assert.rejects(acceptVideoCall(f.tx, "u", "vc_cap", { ...structuredClone(base), max_credits: 0 }), { code: "max_credits_exceeded" });
  await assert.rejects(acceptVideoCall(f.tx, "u", "vc_changed", { ...structuredClone(base), quote_credits: 0, billing: { mode: "internal_test", charged_credits: 0, refunded_credits: 0 } }), { code: "authorization_changed" });
  assert.equal(f.balance(), 30);
  assert.equal(f.debitCount(), 0);
});
test("singleCall可显式分流且旧generationMode解析器拒绝；视图不泄露存储键和provider回执", async () => {
  const f = fixture();
  const result = await acceptVideoCall(f.tx, "u", "vc_test", structuredClone(base));
  assert.equal(isSingleCallJob(result.job.data), true);
  assert.throws(() => generationMode(videoData(result.job.data)));
  assert.equal(isSingleCallJob({ version: 1, segments: [] }), false);
  assert.equal(isSingleCallJob({ singleCall: null }), true);
  const view = callView(result.job);
  assert.equal(view.billing.charged_credits, 12);
  assert.equal(view.billing.supplier_cost, null);
  assert.ok(!JSON.stringify(view).includes("videos/"));
});
