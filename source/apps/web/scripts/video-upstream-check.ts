/**
 * RunningHub 只读核对（不产生生成请求、不消耗额度）。
 *
 * 四个层次**分开报告**，不得混为一谈：
 *   1. config_present —— 配置存在（本地判断）
 *   2. account_auth_ok —— 远端只读账户查询是否成功
 *   3. workflow_read  —— 工作流图是否真的解析成功（须按 `data.prompt` 解析，见 lib/video/upstream.ts）
 *   4. generation_ok  —— 真实生成，恒为 null（本脚本永不做）
 *
 * 自动验收语义：任一只读项失败 ⇒ **非零退出码**（不能"打印失败然后正常退出"）。
 * 输出里不出现 Key、Key 片段、签名 URL 或连接串。
 *
 *   npx --no-install tsx scripts/video-upstream-check.ts
 */
import { loadEnvConfig } from "@next/env";
import {
  ACCOUNT_STATUS_PATH, DEFAULT_WORKFLOW_ID, WORKFLOW_PATH,
  parseWorkflowPayload, readOnlyRequest,
} from "../lib/video/upstream";

loadEnvConfig(process.cwd());

const WORKFLOW_ID = process.env.VIDEO_H3_WORKFLOW_ID?.trim() || DEFAULT_WORKFLOW_ID;

type Layer = { http_status: number | null; business_code: unknown; ok: boolean; detail: string | null };

async function callReadOnly(path: string, apiKey: string, body: Record<string, unknown>): Promise<{ layer: Layer; payload: unknown }> {
  const { url, init } = readOnlyRequest(path, apiKey, body);
  try {
    const response = await fetch(url, init);
    const payload: unknown = await response.json().catch(() => null);
    const code = payload && typeof payload === "object" ? (payload as { code?: unknown }).code : null;
    const message = payload && typeof payload === "object" && typeof (payload as { msg?: unknown }).msg === "string" ? (payload as { msg: string }).msg : null;
    return { payload, layer: { http_status: response.status, business_code: code ?? null, ok: response.ok && code === 0, detail: message } };
  } catch (error) {
    // 只报错误类型名：异常消息可能带 URL 或账号信息。
    return { payload: null, layer: { http_status: null, business_code: null, ok: false, detail: error instanceof Error ? error.name : "UnknownError" } };
  }
}

async function main() {
  const apiKey = process.env.RUNNINGHUB_API_KEY_01?.trim() ?? "";
  const config = {
    runner_runtime_configured: Boolean(process.env.VIDEO_HYPIT_RUNTIME?.trim()),
    runner_package_root_configured: Boolean(process.env.VIDEO_HYPIT_PACKAGE_ROOT?.trim()),
    api_key_configured: apiKey.length > 0,
    workflow_id: WORKFLOW_ID,
  };
  if (!apiKey) {
    console.log(JSON.stringify({ ...config, account_auth_ok: false, workflow_read: false, generation_ok: null,
      note: "account 01 credential is not configured; nothing was sent upstream." }, null, 2));
    process.exitCode = 1;
    return;
  }

  // 层次 2：账户只读查询
  const account = await callReadOnly(ACCOUNT_STATUS_PATH, apiKey, {});
  // 层次 3：工作流读取（Bearer 头 + workflowId 请求体）
  const workflow = await callReadOnly(WORKFLOW_PATH, apiKey, { workflowId: WORKFLOW_ID });
  const parsed = workflow.payload ? parseWorkflowPayload(workflow.payload) : { ok: false as const, reason: "no_response" };

  console.log(JSON.stringify({
    ...config,
    account: { http_status: account.layer.http_status, business_code: account.layer.business_code, detail: account.layer.detail },
    account_auth_ok: account.layer.ok,
    workflow: { http_status: workflow.layer.http_status, business_code: workflow.layer.business_code },
    workflow_read: parsed.ok,
    workflow_nodes: parsed.ok ? parsed.nodeCount : null,
    workflow_nodes_with_inputs: parsed.ok ? parsed.inputsSeen : null,
    workflow_model_files: parsed.ok ? parsed.modelFiles : [],
    workflow_failure_reason: parsed.ok ? null : parsed.reason,
    generation_ok: null,
    note: parsed.ok
      ? "read-only workflow graph retrieved and validated; generation was NOT attempted."
      : "workflow graph not validated; report this as a failure, do not claim the upstream works.",
  }, null, 2));

  // 自动验收：任一失败即非零退出码。
  if (!account.layer.ok || !parsed.ok) process.exitCode = 1;
}

void main().catch(error => {
  console.error("upstream_check_failed:", error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
});
