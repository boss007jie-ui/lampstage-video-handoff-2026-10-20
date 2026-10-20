import test from "node:test";
import assert from "node:assert/strict";
import { parseCallInput, callQuote, callIdentity, inputDigest, submissionAction, callBillingPolicy, callBillingAuthorized } from "../../lib/video-calls/contract";

const input = { motion_asset_id: "motion1", reference_assets: [{ asset_id: "image1" }], prompt: "第一行\n第二行", duration: 8, request_id: "request-1", max_credits: 20 };
test("单次调用保留完整提示词与顺序，不要求起态首槽或分段", () => {
  const parsed = parseCallInput(input);
  assert.equal(parsed.prompt, input.prompt);
  assert.equal(parsed.duration, 8);
  assert.equal(parsed.reference_assets[0].role, undefined);
  assert.throws(() => parseCallInput({ ...input, prompt: "x\u0000" }));
  assert.throws(() => parseCallInput({ ...input, reference_assets: Array(7).fill({ asset_id: "img" }) }));
  assert.throws(() => parseCallInput({ ...input, max_credits: 1.1 }));
});
test("同键跨用户隔离；摘要绑定顺序、角色、上限及完整提示词", () => {
  const a = parseCallInput(input);
  assert.equal(callIdentity("u1", a.request_id!), callIdentity("u1", a.request_id!));
  assert.notEqual(callIdentity("u1", a.request_id!), callIdentity("u2", a.request_id!));
  assert.notEqual(inputDigest(a), inputDigest({ ...a, max_credits: 21 }));
  assert.notEqual(inputDigest(a), inputDigest({ ...a, prompt: a.prompt + "!" }));
});
test("单次报价必须显式配置平台积分，不能借用旧coins估值", () => {
  assert.equal(callQuote({}), null);
  assert.equal(callQuote({ VIDEO_SINGLE_CALL_QUOTE_CREDITS: "1.2" }), null);
  assert.equal(callQuote({ VIDEO_SINGLE_CALL_QUOTE_CREDITS: "12" }), 12);
});
test("未知意图永不重投，已知回执仅查询，旧任务不进入single_call", () => {
  assert.equal(submissionAction({}), "submit");
  assert.equal(submissionAction({ submission_intent_at: "now" }), "unknown");
  assert.equal(submissionAction({ submission_intent_at: "now", build_id: "b1" }), "inspect");
});

test("零上限只是请求格式；免扣资格及零报价来自服务端账户", () => {
  assert.equal(parseCallInput({ ...input, max_credits: 0 }).max_credits, 0);
  assert.throws(() => parseCallInput({ ...input, max_credits: -1 }));
  assert.deepEqual(callBillingPolicy(true, {}), { credits: 0, mode: "internal_test" });
  assert.deepEqual(callBillingPolicy(false, {}), { credits: null, mode: "standard" });
  assert.deepEqual(callBillingPolicy(false, { VIDEO_SINGLE_CALL_QUOTE_CREDITS: "12" }), { credits: 12, mode: "standard" });
});

test("提交前免扣模式撤销或标准报价/上限变化均拒绝，供应商状态恢复不变", () => {
  const free = { quote_credits: 0, max_credits: 0, billing: { mode: "internal_test" as const, charged_credits: 0, refunded_credits: 0 } };
  assert.equal(callBillingAuthorized(free, true, {}), true);
  assert.equal(callBillingAuthorized(free, false, {}), false);
  assert.equal(callBillingAuthorized({ ...free, billing: { ...free.billing, charged_credits: 1 } }, true, {}), false);
  const paid = { quote_credits: 12, max_credits: 12, billing: { mode: "standard" as const, charged_credits: 12, refunded_credits: 0 } };
  const env = { VIDEO_SINGLE_CALL_QUOTE_CREDITS: "12" };
  assert.equal(callBillingAuthorized(paid, false, env), true);
  assert.equal(callBillingAuthorized({ ...paid, max_credits: 0 }, false, env), false);
  assert.equal(callBillingAuthorized(paid, false, {}), false);
  assert.equal(callBillingAuthorized(paid, true, env), false);
});
