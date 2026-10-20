import test from "node:test";
import assert from "node:assert/strict";
import { VideoBackendRegistry } from "../../lib/video/backends/registry";
import { createRunningHubBackend } from "../../lib/video/backends/runninghub";
import type { VideoAttemptBinding, VideoGenerationBackend } from "../../lib/video/backends/contracts";

function fake(id: string): VideoGenerationBackend {
  const unknown = { enabled: false as const, verification: "unknown" as const };
  return { backendId: id, capabilities: { submit: true, status: true, results: true, cancel: false, billing: false,
    enabledModes: ["direct_references"], sixReferences: unknown, sourceWindow: unknown, audio: unknown },
  submit: async () => ({ kind: "accepted", taskId: "1" }), status: async () => ({ kind: "running" }), results: async () => ({ kind: "running" }) };
}
const attempt = (backendId: string): VideoAttemptBinding => ({ backendId, userId: "u", jobId: "j", runId: "r", stepKey: "s", inputDigest: "d", attemptId: "a" });

test("新 job 选择冻结 backendId；修改默认后在途 attempt 仍使用原 backend", () => {
  const a = fake("a"), b = fake("b");
  const registry = new VideoBackendRegistry([a, b], "a");
  const selection = registry.bindNewJob("j", "direct_references");
  assert.equal(selection.ok, true);
  if (!selection.ok) return;
  assert.equal(selection.binding.backendId, "a");
  assert.equal(Object.isFrozen(selection.binding), true);
  assert.equal(registry.setDefault("b").ok, true);
  const resumed = registry.forAttempt(selection.binding, attempt("a"));
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.equal(resumed.backend, a);
  const next = registry.bindNewJob("new", "direct_references");
  if (next.ok) assert.equal(next.binding.backendId, "b");
  else assert.fail("新任务应选择新的默认后端");
});

test("未知历史后端、缺失 pin 和 attempt/job 绑定冲突不能回退到默认", () => {
  const registry = new VideoBackendRegistry([fake("a")], "a");
  assert.deepEqual(registry.forAttempt({ jobId: "j", backendId: "missing" }, attempt("missing")), { ok: false, code: "backend_not_registered" });
  assert.deepEqual(registry.forAttempt({ jobId: "j", backendId: "a" }, attempt("b")), { ok: false, code: "backend_binding_mismatch" });
  assert.deepEqual(registry.forAttempt({ jobId: "another", backendId: "a" }, attempt("a")), { ok: false, code: "backend_binding_mismatch" });
  assert.deepEqual(registry.forAttempt({ jobId: "j", backendId: "" }, attempt("a")), { ok: false, code: "backend_binding_mismatch" });
});

test("配置完整但应用 mode 未验收时拒绝新任务；恢复查询不受新任务能力开关影响", () => {
  const backend = createRunningHubBackend();
  const registry = new VideoBackendRegistry([backend], backend.backendId);
  assert.deepEqual(registry.bindNewJob("j", "six_references"), { ok: false, code: "backend_capability_unverified" });
  const resumed = registry.forAttempt({ jobId: "j", backendId: backend.backendId }, attempt(backend.backendId));
  assert.equal(resumed.ok, true);
});

test("重复注册或缺失默认值返回固定安全码，不能静默替换已注册实例", () => {
  const a = fake("a");
  const registry = new VideoBackendRegistry([a], "a");
  assert.deepEqual(registry.register(fake("a")), { ok: false, code: "backend_already_registered" });
  assert.deepEqual(registry.setDefault("not-found"), { ok: false, code: "backend_not_registered" });
  const resumed = registry.forAttempt({ jobId: "j", backendId: "a" }, attempt("a"));
  if (resumed.ok) assert.equal(resumed.backend, a);
  else assert.fail("原注册后端必须保留");
  assert.deepEqual(new VideoBackendRegistry().bindNewJob("j", "direct_references"), { ok: false, code: "backend_not_registered" });
});
