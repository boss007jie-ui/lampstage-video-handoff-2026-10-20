import test from "node:test";
import assert from "node:assert/strict";
import { runSingleCall } from "../../lib/video-calls/engine";
import type { SingleCall } from "../../lib/video-calls/contract";

function fixture(extra: Partial<SingleCall> = {}) {
  const call = { ...extra } as SingleCall;
  const events: string[] = [];
  const io = { prepare: async () => { events.push("prepare"); }, reserve: async () => { events.push("reserve"); },
    authorize: async () => { events.push("authorize"); }, save: async () => { events.push("save"); },
    submit: async (before: () => Promise<void>, receipt: (id: string) => Promise<void>) => { await before(); events.push("submit"); await receipt("build1"); return "build1"; },
    inspect: async () => ({ state: "completed" as "completed" | "working" | "failed" | "unknown" }),
    resume: async (): Promise<{ ready: boolean; taskId?: string }> => { events.push("resume"); return { ready: true, taskId: "existing-task" }; },
    collect: async () => { events.push("collect"); },
    release: async () => { events.push("release"); }, unknown: async () => { events.push("unknown"); }, refund: async () => { events.push("refund"); },
    finish: async (status: string) => { events.push(status); }, wait: async () => {}, stopped: () => false };
  return { call, io, events };
}
test("提交前持久化意图且成功不退平台积分", async () => {
  const f = fixture();
  assert.equal(await runSingleCall(f.call, f.io), "safe");
  assert.ok(f.events.indexOf("save") < f.events.indexOf("submit"));
  assert.ok(!f.events.includes("refund"));
  assert.equal(f.events.at(-1), "completed");
});

test("已有working回执在runtime重启后恢复一次，保存原供应商任务且不重新提交", async () => {
  const f = fixture({ build_id: "known", submission_intent_at: "recorded" });
  let polls = 0, resumed = false;
  f.io.inspect = async () => { polls++; return { state: resumed && polls >= 3 ? "completed" : "working" }; };
  f.io.resume = async () => { f.events.push("resume"); resumed = true; return { ready: true, taskId: "existing-task" }; };
  f.io.stopped = () => polls >= 5;
  assert.equal(await runSingleCall(f.call, f.io), "safe");
  assert.equal(f.events.filter(event => event === "resume").length, 1);
  assert.equal(f.call.provider_task_id, "existing-task");
  assert.ok(f.events.indexOf("save") > f.events.indexOf("resume"));
  assert.ok(!f.events.some(event => ["prepare", "reserve", "authorize", "submit", "refund"].includes(event)));
  assert.equal(f.events.at(-1), "completed");
});

test("恢复helper缺持久供应商回执时停止，不重复恢复、不重投、不退款释放占槽", async () => {
  const f = fixture({ build_id: "known", submission_intent_at: "recorded" });
  let polls = 0;
  f.io.inspect = async () => { polls++; return { state: "working" }; };
  f.io.resume = async () => { f.events.push("resume"); return { ready: false }; };
  f.io.stopped = () => polls >= 3;
  assert.equal(await runSingleCall(f.call, f.io), "needs_review");
  assert.equal(polls, 1);
  assert.deepEqual(f.events, ["resume", "unknown", "attention"]);
});

test("终态、未知提交及新提交的working均不恢复运行时", async () => {
  for (const state of ["completed", "failed", "unknown"] as const) {
    const f = fixture({ build_id: "known", submission_intent_at: "recorded" });
    f.io.inspect = async () => ({ state });
    await runSingleCall(f.call, f.io);
    assert.ok(!f.events.includes("resume"));
    assert.ok(!f.events.includes("submit"));
  }
  const unknown = fixture({ submission_intent_at: "recorded" });
  await runSingleCall(unknown.call, unknown.io);
  assert.deepEqual(unknown.events, ["unknown", "attention"]);
  const fresh = fixture();
  let polls = 0;
  fresh.io.inspect = async () => ({ state: ++polls === 1 ? "working" : "completed" });
  await runSingleCall(fresh.call, fresh.io);
  assert.ok(fresh.events.includes("submit"));
  assert.ok(!fresh.events.includes("resume"));
});
test("提交超时保留账本和占槽，重入绝不重投", async () => {
  const f = fixture();
  f.io.submit = async before => { await before(); throw new Error("timeout"); };
  assert.equal(await runSingleCall(f.call, f.io), "needs_review");
  assert.ok(f.events.includes("unknown"));
  assert.ok(!f.events.includes("refund"));
  const again = fixture(f.call);
  await runSingleCall(again.call, again.io);
  assert.ok(!again.events.includes("submit"));
});
test("已有回执仅查询不准备不submit；明确失败才退款", async () => {
  const f = fixture({ build_id: "known" });
  f.io.inspect = async () => ({ state: "failed" });
  await runSingleCall(f.call, f.io);
  assert.ok(!f.events.includes("prepare"));
  assert.ok(!f.events.includes("submit"));
  assert.ok(f.events.includes("refund"));
  assert.equal(f.events.at(-1), "failed");
});
test("意图落库失败不会submit；保守保留不确定状态", async () => {
  const f = fixture();
  f.io.save = async () => { throw new Error("db unavailable"); };
  await runSingleCall(f.call, f.io);
  assert.ok(!f.events.includes("submit"));
  assert.ok(!f.events.includes("refund"));
});
test("免费准备失败退实际平台积分且不进入付费边界", async () => {
  const f = fixture();
  f.io.prepare = async () => { throw new Error("hash mismatch"); };
  await runSingleCall(f.call, f.io);
  assert.ok(!f.events.includes("submit"));
  assert.ok(f.events.includes("refund"));
  assert.equal(f.events.at(-1), "failed");
});

test("持久失败证据在退款中断后可恢复，不依赖供应商再次查询", async () => {
  const first = fixture({ build_id: "known", submission_intent_at: "recorded" });
  let persisted: SingleCall | undefined;
  first.io.inspect = async () => ({ state: "failed" });
  first.io.save = async () => { persisted = structuredClone(first.call); };
  first.io.refund = async () => { throw new Error("refund transaction interrupted"); };
  assert.equal(await runSingleCall(first.call, first.io), "needs_review");
  assert.equal(persisted?.terminal_failure, true);

  const again = fixture(persisted);
  again.io.inspect = async () => { again.events.push("inspect"); throw new Error("provider lookup unavailable"); };
  assert.equal(await runSingleCall(again.call, again.io), "safe");
  assert.deepEqual(again.events, ["release", "refund", "failed"]);
});
