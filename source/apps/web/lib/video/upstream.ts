/**
 * RunningHub 只读核对的可测解析层。
 *
 * 上一版的错误（审查文档已指出，此处修正）：
 *   1. 请求缺 `Authorization: Bearer ...`。
 *   2. 把 `data` 当成节点字典 —— **官方结构是 `data.prompt` 里的 JSON 字符串**，
 *      节点字段在解析后的 `graph[nodeId].inputs`。
 *   3. mock 里只有一个模型节点就报了"读取成功"。空图、JSON 解析失败、错误结构
 *      必须**明确失败**，并且自动验收失败要有非零退出码。
 *
 * 这里只做纯解析与判定，网络调用留在脚本里，便于 mock 测试三种响应形态。
 */

export const DEFAULT_WORKFLOW_ID = "2102537586127491074";
export const RUNNINGHUB_BASE = "https://www.runninghub.cn";
export const ACCOUNT_STATUS_PATH = "/uc/openapi/accountStatus";
export const WORKFLOW_PATH = "/api/openapi/getJsonApiFormat";

export type WorkflowGraph = Record<string, { inputs?: Record<string, unknown> }>;

export type WorkflowParse =
  | { ok: true; nodeCount: number; modelFiles: string[]; inputsSeen: number }
  | { ok: false; reason: string };

const MODEL_FILE = /\.(safetensors|ckpt|pth|pt)$/i;

/**
 * 从 getJsonApiFormat 的响应体里取出工作流图。
 * 依次校验：业务码 → `data` → `data.prompt` 是字符串 → JSON 可解析 → 有非空节点与 inputs。
 * 任何一步不满足都返回 ok:false（**不报"读取成功"**）。
 */
export function parseWorkflowPayload(payload: unknown): WorkflowParse {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "invalid_payload" };
  const body = payload as { code?: unknown; msg?: unknown; data?: unknown };
  if (body.code !== 0) {
    const code = typeof body.code === "number" ? body.code : "missing";
    const msg = typeof body.msg === "string" && body.msg ? ` (${body.msg})` : "";
    return { ok: false, reason: `business_code_${code}${msg}` };
  }
  const data = body.data;
  if (!data || typeof data !== "object") return { ok: false, reason: "missing_data" };
  const prompt = (data as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return { ok: false, reason: "missing_prompt" };
  let parsed: unknown;
  try { parsed = JSON.parse(prompt); } catch { return { ok: false, reason: "prompt_not_json" }; }
  const graph = unwrapGraph(parsed);
  if (!graph) return { ok: false, reason: "invalid_graph_shape" };
  const nodeIds = Object.keys(graph);
  if (!nodeIds.length) return { ok: false, reason: "empty_graph" };
  const withInputs = nodeIds.filter(id => graph[id] && typeof graph[id] === "object" && graph[id].inputs && typeof graph[id].inputs === "object");
  if (!withInputs.length) return { ok: false, reason: "no_node_inputs" };
  return { ok: true, nodeCount: nodeIds.length, inputsSeen: withInputs.length, modelFiles: extractModelFiles(graph) };
}

/** prompt 里可能是 `graph` 包裹，也可能是直接是节点字典；两种都接受，但必须是非数组对象。 */
function unwrapGraph(parsed: unknown): WorkflowGraph | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const candidate = record.graph;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as WorkflowGraph;
  // 空对象也当作"空图"，由上层给出 empty_graph，而不是含糊的形状错误。
  return record as WorkflowGraph;
}

/** 只提取模型权重文件名，用于确认"确实读到了真实的节点配置"。 */
export function extractModelFiles(graph: WorkflowGraph, limit = 20): string[] {
  const found = new Set<string>();
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== "object" || !node.inputs) continue;
    for (const value of Object.values(node.inputs)) {
      if (typeof value === "string" && MODEL_FILE.test(value)) found.add(value);
    }
  }
  return Array.from(found).slice(0, limit);
}

/**
 * 请求构造。**两处都要给凭据**：
 *   - `Authorization: Bearer <key>`（官方示例要求）
 *   - body 里的 `apiKey`（缺了返回 code 1601 `param apiKey is required`）
 * 实测：只给 Bearer 不给 body apiKey ⇒ "param apiKey is required"；只给 body 不给 Bearer ⇒ 鉴权失败。
 * 密钥只从进程环境读取，绝不写进日志或报告。
 */
export function readOnlyRequest(path: string, apiKey: string, body: Record<string, unknown>): { url: string; init: RequestInit } {
  return {
    url: `${RUNNINGHUB_BASE}${path}`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ apiKey, ...body }),
      signal: AbortSignal.timeout(30_000),
    },
  };
}
