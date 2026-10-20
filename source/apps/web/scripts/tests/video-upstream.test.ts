import test from "node:test";
import assert from "node:assert/strict";
import { extractModelFiles, parseWorkflowPayload, readOnlyRequest, WORKFLOW_PATH } from "../../lib/video/upstream";

/** 官方结构：data.prompt 是**字符串**，解析后节点字段在 graph[nodeId].inputs。 */
function payloadWithGraph(graph: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { code: 0, msg: "success", data: { prompt: JSON.stringify({ graph }), ...overrides } };
}

const GOOD_GRAPH = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "clip_l.safetensors" } },
  "3": { class_type: "KSampler", inputs: { steps: 20, cfg: 1 } },
};

test("a well-formed response yields a validated graph and the model files", () => {
  const parsed = parseWorkflowPayload(payloadWithGraph(GOOD_GRAPH));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.nodeCount, 3);
  assert.equal(parsed.inputsSeen, 3);
  assert.ok(parsed.modelFiles.includes("minimax_h3_ref2va_pruned_int8_convrot.safetensors"));
  // 非模型字段（steps/cfg）不应被当成权重文件
  assert.equal(parsed.modelFiles.some(f => f === "20"), false);
});

test("a non-zero business code is reported as a failure with the code", () => {
  const parsed = parseWorkflowPayload({ code: 301, msg: "user not exist", data: null });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.reason, /business_code_301/);
  assert.match(parsed.reason, /user not exist/);
});

test("missing / empty / non-JSON prompt never counts as a successful read", () => {
  assert.deepEqual(parseWorkflowPayload({ code: 0, data: {} }), { ok: false, reason: "missing_prompt" });
  assert.deepEqual(parseWorkflowPayload({ code: 0, data: { prompt: "   " } }), { ok: false, reason: "missing_prompt" });
  assert.deepEqual(parseWorkflowPayload({ code: 0, data: { prompt: "{not json" } }), { ok: false, reason: "prompt_not_json" });
  assert.deepEqual(parseWorkflowPayload({ code: 0 }), { ok: false, reason: "missing_data" });
  assert.deepEqual(parseWorkflowPayload(null), { ok: false, reason: "invalid_payload" });
});

test("an empty graph or a graph without node inputs is a failure, not a success", () => {
  assert.deepEqual(parseWorkflowPayload({ code: 0, data: { prompt: "{}" } }), { ok: false, reason: "empty_graph" });
  // 有节点但都没有 inputs ⇒ 不能算读到工作流
  assert.deepEqual(parseWorkflowPayload(payloadWithGraph({ "1": { class_type: "Note" }, "2": { class_type: "Note" } })),
    { ok: false, reason: "no_node_inputs" });
  // 字符串数组等非对象结构一律拒绝
  assert.equal(parseWorkflowPayload({ code: 0, data: { prompt: "[1,2,3]" } }).ok, false);
});

test("both wrapped and flat prompt graphs are accepted; model extraction is scoped to inputs", () => {
  const flat = parseWorkflowPayload({ code: 0, data: { prompt: JSON.stringify(GOOD_GRAPH) } });
  assert.equal(flat.ok, true);
  const wrapped = parseWorkflowPayload({ code: 0, data: { prompt: JSON.stringify({ graph: GOOD_GRAPH }) } });
  assert.equal(wrapped.ok, true);
  assert.deepEqual(extractModelFiles({ "1": { inputs: { unet_name: "a.safetensors" } }, "2": { inputs: { steps: 4 } } }), ["a.safetensors"]);
});

test("the read-only request carries both a Bearer header and a body apiKey, and never puts the key in the URL", () => {
  const key = "test-key-value-not-a-real-secret";
  const { url, init } = readOnlyRequest(WORKFLOW_PATH, key, { workflowId: "2102537586127491074" });
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${key}`);
  // 实测过：只给 Bearer 会被判 "param apiKey is required"，所以 body 必须也带 apiKey。
  assert.deepEqual(JSON.parse(String(init.body)), { apiKey: key, workflowId: "2102537586127491074" });
  // 但 Key 绝不能出现在 URL 里（会被日志/代理记录）
  assert.equal(url.includes(key), false);
  assert.equal(init.method, "POST");
});
