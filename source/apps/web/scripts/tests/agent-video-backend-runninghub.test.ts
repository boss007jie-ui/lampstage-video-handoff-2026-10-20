import test from "node:test";
import assert from "node:assert/strict";
import { createRunningHubBackend } from "../../lib/video/backends/runninghub";
import { buildRunningHubSubmitRequest, buildRunningHubQueryRequest, parseRunningHubSubmission, parseRunningHubOutputs } from "../../lib/video/backends/runninghub-protocol";
import { publicVideoResults, cancelVideoTask } from "../../lib/video/backends/contracts";
import type { VideoSubmissionGate, VideoSubmissionIntent } from "../../lib/video/backends/contracts";
import type { RunningHubApplication, RunningHubRequest, RunningHubTransport } from "../../lib/video/backends/runninghub-protocol";

const FAKE_KEY = "fake-offline-key-do-not-use";
const TASK = "1979110509284917250";
const application: RunningHubApplication = {
  accountId: "offline", webappId: "900000000000000001", mappingVersion: "fixture-v1",
  mappingEvidence: "offline-fixture-only",
  bindings: [{ inputKey: "prompt", nodeId: "900", fieldName: "text" }, { inputKey: "reference", nodeId: "901", fieldName: "image" }],
};
const values = { prompt: "商品展示", reference: "api/offline-reference.png" };
const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
const accepted = () => response({ code: 0, msg: "success", data: { taskId: TASK, taskStatus: "RUNNING" } });
const complete = (url = "https://media.example.test/result.mp4?signature=old") => response({ code: 0, data: [{ fileUrl: url, fileType: "mp4", nodeId: "902", consumeCoins: "17" }] });

function fixture(transport: RunningHubTransport = async () => accepted(), gate?: VideoSubmissionGate) {
  const calls: RunningHubRequest[] = [];
  const claimed = new Set<string>();
  const warnings: string[] = [];
  const backend = createRunningHubBackend({ apiKey: FAKE_KEY, application, transport: async request => { calls.push(request); return transport(request); },
    gate: gate ?? { claim: async intent => { if (claimed.has(intent.attempt.attemptId)) return "already_claimed"; claimed.add(intent.attempt.attemptId); return "claimed"; } },
    warn: code => warnings.push(code),
  });
  const intent: VideoSubmissionIntent = { intentId: "intent-1", fencingToken: 1, attempt: {
    backendId: backend.backendId, userId: "user-1", runId: "run-1", jobId: "job-1", stepKey: "segment-0", inputDigest: "frozen-input-digest", attemptId: "attempt-1",
  } };
  return { backend, intent, calls, warnings, task: { backendId: backend.backendId, taskId: TASK } };
}

test("请求只使用显式应用映射，ID 保持字符串且凭据仅在私有请求中", () => {
  const built = buildRunningHubSubmitRequest(FAKE_KEY, application, values);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.request.url, "https://www.runninghub.cn/task/openapi/ai-app/run");
  assert.equal(built.request.method, "POST");
  assert.equal(built.request.redirect, "error");
  assert.equal(built.request.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(JSON.parse(built.request.body), { apiKey: FAKE_KEY, webappId: application.webappId, nodeInfoList: [
    { nodeId: "900", fieldName: "text", fieldValue: values.prompt }, { nodeId: "901", fieldName: "image", fieldValue: values.reference },
  ] });
  assert.equal(built.request.url.includes(FAKE_KEY), false);
  const query = buildRunningHubQueryRequest(FAKE_KEY, TASK);
  assert.equal(query.ok, true);
  if (query.ok) {
    assert.equal(query.request.url, "https://www.runninghub.cn/task/openapi/outputs");
    assert.deepEqual(JSON.parse(query.request.body), { apiKey: FAKE_KEY, taskId: TASK });
  }
});

test("缺少已验证映射、遗漏输入或多余节点字段均在网络前拒绝", async () => {
  assert.equal(buildRunningHubSubmitRequest(FAKE_KEY, undefined, values).ok, false);
  assert.equal(buildRunningHubSubmitRequest(FAKE_KEY, { ...application, mappingEvidence: "" }, values).ok, false);
  assert.equal(buildRunningHubSubmitRequest(FAKE_KEY, application, { prompt: "x" }).ok, false);
  assert.equal(buildRunningHubSubmitRequest(FAKE_KEY, application, { ...values, apiKey: "override" }).ok, false);
  assert.equal(buildRunningHubSubmitRequest(FAKE_KEY, { ...application, bindings: [application.bindings[0], application.bindings[0]] }, values).ok, false);
  const f = fixture();
  const result = await f.backend.submit({ intent: f.intent, values: { prompt: "x" } });
  assert.equal(result.kind, "definite_not_submitted");
  assert.equal(f.calls.length, 0);
});

test("默认创建不读环境或联网，应用能力保持未知且未启用", async () => {
  const backend = createRunningHubBackend();
  assert.equal(backend.capabilities.submit, false);
  assert.deepEqual(backend.capabilities.enabledModes, []);
  assert.deepEqual(backend.capabilities.sixReferences, { enabled: false, verification: "unknown" });
  assert.deepEqual(backend.capabilities.sourceWindow, { enabled: false, verification: "unknown" });
  assert.deepEqual(backend.capabilities.audio, { enabled: false, verification: "unknown" });
  const f = fixture();
  assert.deepEqual(f.backend.capabilities.enabledModes, []);
  assert.equal(f.backend.capabilities.billing, false);
  assert.equal(JSON.stringify(f.backend).includes(FAKE_KEY), false);
  const result = await backend.submit({ intent: { ...f.intent, attempt: { ...f.intent.attempt, backendId: backend.backendId } }, values });
  assert.equal(result.kind, "definite_not_submitted");
});

test("成功回执提供同一 taskId，重复调用不再次提交", async () => {
  const f = fixture();
  assert.deepEqual(await f.backend.submit({ intent: f.intent, values }), { kind: "accepted", taskId: TASK });
  assert.equal((await f.backend.submit({ intent: f.intent, values })).kind, "submission_unknown");
  assert.equal(f.calls.length, 1);
});

test("门禁原子串行化并发，跨 backend 实例共享门禁仍只发起一次", async () => {
  let used = false;
  const gate: VideoSubmissionGate = { claim: async () => { if (used) return "already_claimed"; used = true; return "claimed"; } };
  const f = fixture(async () => accepted(), gate);
  const g = fixture(async () => accepted(), gate);
  const results = await Promise.all([f.backend.submit({ intent: f.intent, values }), g.backend.submit({ intent: g.intent, values })]);
  assert.equal(results.filter(r => r.kind === "accepted").length, 1);
  assert.equal(results.filter(r => r.kind === "submission_unknown").length, 1);
  assert.equal(f.calls.length + g.calls.length, 1);
});

test("失效授权和门禁故障均不发请求，故障不能声称可重试提交", async () => {
  const denied = fixture(undefined, { claim: async () => "not_authorized" });
  assert.deepEqual(await denied.backend.submit({ intent: denied.intent, values }), { kind: "definite_not_submitted", code: "authorization_denied" });
  const broken = fixture(undefined, { claim: async () => { throw new Error(FAKE_KEY); } });
  assert.deepEqual(await broken.backend.submit({ intent: broken.intent, values }), { kind: "submission_unknown", code: "intent_claim_unavailable" });
  assert.equal(denied.calls.length + broken.calls.length, 0);
  assert.equal(JSON.stringify(broken.warnings).includes(FAKE_KEY), false);
});

test("明确业务拒绝与不明业务错误分开，HTTP 错误不能当作未提交证明", async () => {
  for (const code of [301, 416, 802, 803, 812, 901]) {
    const f = fixture(async () => response({ code, msg: `sensitive ${FAKE_KEY}`, data: null }));
    const result = await f.backend.submit({ intent: f.intent, values });
    assert.equal(result.kind, "definite_not_submitted");
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
    assert.equal(f.calls.length, 1);
  }
  for (const code of [500, 804, 805, 813, 999999]) {
    assert.equal(parseRunningHubSubmission(response({ code, msg: FAKE_KEY })).kind, "submission_unknown");
  }
  for (const httpStatus of [400, 401, 403, 408, 429, 500, 504]) {
    const f = fixture(async () => response({ code: 301, msg: FAKE_KEY }, httpStatus));
    assert.equal((await f.backend.submit({ intent: f.intent, values })).kind, "submission_unknown");
  }
});

test("断连和非法 JSON 进入 unknown，之后不能自动补发同一 intent", async () => {
  for (const transport of [async () => { throw new Error(`timeout ${FAKE_KEY} https://secret.example.test/?token=secret`); }, async () => ({ status: 200, body: "not-json" })]) {
    const f = fixture(transport);
    const first = await f.backend.submit({ intent: f.intent, values });
    const second = await f.backend.submit({ intent: f.intent, values });
    assert.equal(first.kind, "submission_unknown");
    assert.equal(second.kind, "submission_unknown");
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify([first, second, f.warnings]).includes(FAKE_KEY), false);
    assert.equal(JSON.stringify([first, second, f.warnings]).includes("secret.example.test"), false);
  }
});

test("响应矛盾时保留已知 taskId 供核对，缺失或不安全 ID 不冒充 accepted", () => {
  assert.deepEqual(parseRunningHubSubmission(response({ code: 301, data: { taskId: TASK } })), { kind: "submission_unknown", code: "submission_conflict", taskId: TASK });
  for (const taskId of [undefined, "", "https://example.test/?secret=x", Number(TASK)]) {
    assert.equal(parseRunningHubSubmission(response({ code: 0, data: { taskId } })).kind, "submission_unknown");
  }
  assert.equal(parseRunningHubSubmission(response({ taskId: TASK, status: "SUCCESS" })).kind, "submission_unknown");
});

test("拒绝码携带数值或非法非空 taskId 时保持 unknown 且不回传原始值", async () => {
  const rejectionCodes = [301, 380, 416, 433, 801, 802, 803, 806, 810, 811, 812, 901];
  const invalidIds: unknown[] = [Number(TASK), 123, 0, `task-${TASK}`, FAKE_KEY, `https://secret.example.test/?token=${FAKE_KEY}`, { value: TASK }, [TASK], false];
  for (const code of rejectionCodes) {
    for (const taskId of invalidIds) {
      const reply = response({ code, msg: FAKE_KEY, data: { taskId } });
      const expected = { kind: "submission_unknown", code: "submission_conflict" };
      assert.deepEqual(parseRunningHubSubmission(reply), expected);
      const f = fixture(async () => reply);
      assert.deepEqual(await f.backend.submit({ intent: f.intent, values }), expected);
      assert.equal((await f.backend.submit({ intent: f.intent, values })).kind, "submission_unknown");
      assert.equal(f.calls.length, 1);
      assert.equal(JSON.stringify(f.warnings).includes(FAKE_KEY), false);
      assert.deepEqual(parseRunningHubSubmission({ ...reply, status: 500 }), { kind: "submission_unknown", code: "submission_http_unknown" });
    }
    assert.deepEqual(parseRunningHubSubmission(response({ code, data: { taskId: TASK } })), { kind: "submission_unknown", code: "submission_conflict", taskId: TASK });
  }
});

test("拒绝响应仅在 taskId 字段完全缺失时按明确未提交处理，空值字段仍保守 unknown", () => {
  for (const code of [301, 380, 416, 433, 801, 802, 803, 806, 810, 811, 812, 901]) {
    for (const body of [{ code }, { code, data: null }, { code, data: {} }]) {
      assert.deepEqual(parseRunningHubSubmission(response(body)), { kind: "definite_not_submitted", code: "provider_submission_rejected" });
    }
    for (const taskId of [null, "", " "]) {
      assert.deepEqual(parseRunningHubSubmission(response({ code, data: { taskId } })), { kind: "submission_unknown", code: "submission_conflict" });
    }
  }
});

test("已知任务的 running/queued/completed/failed 只查询 outputs 原 taskId", async () => {
  const queue = [response({ code: 804 }), response({ code: 813 }), complete(), response({ code: 805, data: { failedReason: { exception_message: FAKE_KEY } } })];
  const f = fixture(async () => queue.shift()!);
  assert.deepEqual(await f.backend.status(f.task), { kind: "running" });
  assert.deepEqual(await f.backend.status(f.task), { kind: "queued" });
  assert.deepEqual(await f.backend.status(f.task), { kind: "completed" });
  assert.deepEqual(await f.backend.results(f.task), { kind: "failed", code: "provider_task_failed" });
  assert.equal(f.calls.length, 4);
  for (const call of f.calls) {
    assert.equal(call.url.endsWith("/task/openapi/outputs"), true);
    assert.equal(JSON.parse(call.body).taskId, TASK);
  }
});

test("未知状态、空结果和未知结构不能映射 completed；不存在不代表失败或未提交", () => {
  for (const body of [{ code: 0, data: [] }, { code: 0, data: "NEW_STATUS" }, { code: 0, data: [{ fileUrl: "javascript:alert(1)", fileType: "mp4" }] }, { status: "SUCCESS", results: [] }]) {
    assert.equal(parseRunningHubOutputs(response(body)).kind, "read_error");
  }
  for (const code of [423, 807]) assert.deepEqual(parseRunningHubOutputs(response({ code })), { kind: "read_error", code: "provider_task_not_found", retryable: false });
  assert.deepEqual(parseRunningHubOutputs(response({ code: 999 })), { kind: "read_error", code: "provider_response_unknown", retryable: false });
});

test("只读 HTTP/网络异常有可重试分类，认证错误不自动重试", async () => {
  for (const status of [408, 429, 500, 503, 504]) {
    const f = fixture(async () => ({ status, body: FAKE_KEY }));
    const result = await f.backend.results(f.task);
    assert.deepEqual(result, { kind: "read_error", code: "provider_http_unavailable", retryable: true });
    assert.equal(f.calls.length, 1);
  }
  assert.deepEqual(parseRunningHubOutputs(response({ msg: FAKE_KEY }, 401)), { kind: "read_error", code: "provider_auth_rejected", retryable: false });
  const f = fixture(async () => { throw new Error(FAKE_KEY); });
  assert.deepEqual(await f.backend.status(f.task), { kind: "read_error", code: "provider_transport_unavailable", retryable: true });
  assert.equal(f.calls.length, 1);
});

test("签名链接过期后只重新查询原任务；URL 只留私有收取结果且不推测有效期", async () => {
  const oldUrl = "https://media.example.test/result.mp4?signature=old";
  const newUrl = "https://media.example.test/result.mp4?signature=new";
  const queue = [complete(oldUrl), complete(newUrl)];
  const f = fixture(async () => queue.shift()!);
  const oldResult = await f.backend.results(f.task);
  const download = (url: string) => ({ status: url === oldUrl ? 403 : 200 });
  assert.equal(oldResult.kind === "completed" && download(oldResult.outputs[0].downloadUrl).status, 403);
  const refreshed = await f.backend.results(f.task);
  assert.equal(oldResult.kind, "completed");
  assert.equal(refreshed.kind, "completed");
  if (oldResult.kind !== "completed" || refreshed.kind !== "completed") return;
  assert.equal(oldResult.outputs[0].downloadUrl, oldUrl);
  assert.equal(refreshed.outputs[0].downloadUrl, newUrl);
  assert.equal(download(refreshed.outputs[0].downloadUrl).status, 200);
  assert.equal(refreshed.outputs[0].expiresAt, null);
  assert.deepEqual(publicVideoResults(refreshed), { kind: "completed", outputCount: 1 });
  assert.equal(JSON.stringify(publicVideoResults(refreshed)).includes("signature"), false);
  assert.equal(f.calls.length, 2);
});

test("取消不支持；跨后端 task/intent 和不合法 taskId 均不触发网络", async () => {
  const f = fixture();
  assert.equal(f.backend.cancel, undefined);
  assert.deepEqual(await cancelVideoTask(f.backend, f.task), { kind: "unsupported", code: "cancel_unsupported" });
  assert.equal((await f.backend.submit({ intent: { ...f.intent, attempt: { ...f.intent.attempt, backendId: "other" } }, values })).kind, "definite_not_submitted");
  assert.equal((await f.backend.status({ ...f.task, backendId: "other" })).kind, "read_error");
  assert.equal((await f.backend.results({ ...f.task, taskId: "bad-id" })).kind, "read_error");
  assert.equal(f.calls.length, 0);
});

test("真实计时器超时中止 transport 信号且不重发，晚到回执不改变已返回 unknown", async () => {
  let finish!: (result: ReturnType<typeof accepted>) => void;
  let signal: AbortSignal | undefined;
  let calls = 0;
  let used = false;
  const backend = createRunningHubBackend({ apiKey: FAKE_KEY, application, timeoutMs: 5, warn: () => undefined,
    gate: { claim: async () => { if (used) return "already_claimed"; used = true; return "claimed"; } },
    transport: async request => { calls += 1; signal = request.signal; return new Promise(resolve => { finish = resolve; }); },
  });
  const f = fixture();
  const result = await backend.submit({ intent: f.intent, values });
  assert.deepEqual(result, { kind: "submission_unknown", code: "submission_transport_unknown" });
  assert.equal(signal?.aborted, true);
  finish(accepted());
  assert.equal((await backend.submit({ intent: f.intent, values })).kind, "submission_unknown");
  assert.equal(calls, 1);
});

test("成功链接反射 API key 被拒绝且不泄漏到安全投影/日志", async () => {
  const f = fixture(async () => complete(`https://media.example.test/video.mp4?token=${FAKE_KEY}`));
  const result = await f.backend.results(f.task);
  assert.deepEqual(result, { kind: "read_error", code: "provider_results_invalid", retryable: false });
  assert.equal(JSON.stringify([result, publicVideoResults(result), f.warnings]).includes(FAKE_KEY), false);
});

test("供应商 metadata/traceback/价格不会透传，恶意 URL 不成为结果", async () => {
  const f = fixture(async () => response({ code: 0, msg: FAKE_KEY, data: [{ fileUrl: "https://media.example.test/video.mp4", fileType: "mp4", consumeCoins: "17", traceback: FAKE_KEY, extra: FAKE_KEY }] }));
  const result = await f.backend.results(f.task);
  assert.equal(result.kind, "completed");
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(result).includes("consumeCoins"), false);
  for (const fileUrl of ["http://example.test/video.mp4", "file:///tmp/v.mp4", "https://user:password@example.test/v.mp4"]) {
    assert.equal(parseRunningHubOutputs(complete(fileUrl)).kind, "read_error");
  }
});

test("配置与授权输入在门禁等待期间冻结，调用者变更不能更改实际提交", async () => {
  const mutableConfig = { ...application, bindings: application.bindings.map(binding => ({ ...binding })) };
  const mutableValues = { ...values };
  let continueClaim!: () => void;
  let sent: RunningHubRequest | undefined;
  const backend = createRunningHubBackend({ apiKey: FAKE_KEY, application: mutableConfig, warn: () => undefined,
    gate: { claim: async (intent, prepared) => {
      assert.equal(Object.isFrozen(intent.attempt), true);
      assert.equal(Object.isFrozen(prepared.values), true);
      await new Promise<void>(resolve => { continueClaim = resolve; });
      assert.equal(prepared.values.prompt, values.prompt);
      return "claimed";
    } }, transport: async request => { sent = request; return accepted(); },
  });
  mutableConfig.webappId = "123";
  mutableConfig.bindings[0].nodeId = "456";
  const f = fixture();
  const pending = backend.submit({ intent: f.intent, values: mutableValues });
  mutableValues.prompt = "different";
  continueClaim();
  assert.equal((await pending).kind, "accepted");
  assert.equal(JSON.parse(sent!.body).webappId, application.webappId);
  assert.equal(JSON.parse(sent!.body).nodeInfoList[0].nodeId, "900");
  assert.equal(JSON.parse(sent!.body).nodeInfoList[0].fieldValue, values.prompt);
});

test("数字型凭据被反射为 taskId 时也不能泄漏 accepted/unknown 回执", async () => {
  const numericFakeKey = "99887766554433221100";
  for (const code of [0, 301]) {
    const warnings: string[] = [];
    const backend = createRunningHubBackend({ apiKey: numericFakeKey, application,
      transport: async () => response({ code, data: { taskId: numericFakeKey } }), gate: { claim: async () => "claimed" }, warn: value => warnings.push(value) });
    const f = fixture();
    const result = await backend.submit({ intent: f.intent, values });
    assert.equal(result.kind, "submission_unknown");
    assert.equal("taskId" in result, false);
    assert.equal(JSON.stringify([result, warnings]).includes(numericFakeKey), false);
  }
});

test("即使没有提升 mappingVersion，节点配置变更也使旧 attempt 不再匹配", async () => {
  const f = fixture();
  let calls = 0;
  const changed = createRunningHubBackend({ apiKey: FAKE_KEY, application: { ...application, bindings: application.bindings.map(binding => ({ ...binding, nodeId: `${binding.nodeId}0` })) },
    transport: async () => { calls += 1; return accepted(); }, gate: { claim: async () => "claimed" }, warn: () => undefined });
  assert.notEqual(changed.backendId, f.backend.backendId);
  assert.deepEqual(await changed.submit({ intent: f.intent, values }), { kind: "definite_not_submitted", code: "backend_mismatch" });
  assert.equal(calls, 0);
});

test("畸形凭据不会被能力声明误报为已配置可提交", () => {
  for (const apiKey of ["", " ", "bad\nheader"]) {
    const backend = createRunningHubBackend({ apiKey, application, transport: async () => accepted(), gate: { claim: async () => "claimed" } });
    assert.equal(backend.capabilities.submit, false);
    assert.equal(backend.capabilities.status, false);
    assert.equal(backend.capabilities.results, false);
  }
});
