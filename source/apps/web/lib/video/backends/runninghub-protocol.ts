import type { VideoBackendOutput, VideoReadError, VideoResultsResult, VideoSubmissionResult } from "./contracts";

/** 只读官方协议依据与新旧接口决策见同目录 README.md。 */
export const RUNNINGHUB_AI_APP_RUN = "https://www.runninghub.cn/task/openapi/ai-app/run";
export const RUNNINGHUB_OUTPUTS = "https://www.runninghub.cn/task/openapi/outputs";
export interface RunningHubApplication {
  readonly accountId: string;
  readonly webappId: string;
  readonly mappingVersion: string;
  /** 我方核对应用 API 配置的证据引用，不接受模型生成的自我声明。 */
  readonly mappingEvidence: string;
  readonly bindings: readonly { readonly inputKey: string; readonly nodeId: string; readonly fieldName: string }[];
}
/** 仅在后端与显式 transport 之间传递，含凭据，禁止日志/异常/公开投影。 */
export interface RunningHubRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: "error";
  readonly signal?: AbortSignal;
}
export interface RunningHubResponse { readonly status: number; readonly body: string }
/** 注入方负责单次请求，不得在内部重试付费 POST、跟随重定向或记录请求。 */
export type RunningHubTransport = (request: RunningHubRequest) => Promise<RunningHubResponse>;
export type RunningHubBuildResult = { ok: true; request: RunningHubRequest } | { ok: false; code: "backend_not_configured" | "invalid_input" | "invalid_task_id" };

const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value);
export const isRunningHubTaskId = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,64}$/.test(value);
const credentialPresent = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\r\n\s]/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function isVerifiedRunningHubApplication(value: RunningHubApplication | undefined): value is RunningHubApplication {
  if (!value || !identifier(value.accountId) || !isRunningHubTaskId(value.webappId) || !identifier(value.mappingVersion) ||
    typeof value.mappingEvidence !== "string" || !value.mappingEvidence.trim() || !Array.isArray(value.bindings) || !value.bindings.length) return false;
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const binding of value.bindings) {
    if (!binding || !identifier(binding.inputKey) || !isRunningHubTaskId(binding.nodeId) || !identifier(binding.fieldName)) return false;
    const target = `${binding.nodeId}:${binding.fieldName}`;
    if (names.has(binding.inputKey) || targets.has(target)) return false;
    names.add(binding.inputKey); targets.add(target);
  }
  return true;
}

function request(url: string, apiKey: string, body: Record<string, unknown>): RunningHubRequest {
  return Object.freeze({ url, method: "POST", headers: Object.freeze({ "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }),
    body: JSON.stringify({ apiKey, ...body }), redirect: "error" });
}
export function buildRunningHubSubmitRequest(apiKey: string | undefined, application: RunningHubApplication | undefined, values: Readonly<Record<string, string>>): RunningHubBuildResult {
  if (!credentialPresent(apiKey) || !isVerifiedRunningHubApplication(application)) return { ok: false, code: "backend_not_configured" };
  if (!object(values) || Object.keys(values).length !== application.bindings.length || application.bindings.some(binding =>
    !Object.prototype.hasOwnProperty.call(values, binding.inputKey) || typeof values[binding.inputKey] !== "string" || values[binding.inputKey].length > 1_000_000)) {
    return { ok: false, code: "invalid_input" };
  }
  const nodeInfoList = application.bindings.map(binding => ({ nodeId: binding.nodeId, fieldName: binding.fieldName, fieldValue: values[binding.inputKey] }));
  return { ok: true, request: request(RUNNINGHUB_AI_APP_RUN, apiKey, { webappId: application.webappId, nodeInfoList }) };
}
/** status 与 results 均采用官方 AI 应用示例的 outputs 轮询，不调用已停止维护的 status。 */
export function buildRunningHubQueryRequest(apiKey: string | undefined, taskId: string): RunningHubBuildResult {
  if (!credentialPresent(apiKey)) return { ok: false, code: "backend_not_configured" };
  if (!isRunningHubTaskId(taskId)) return { ok: false, code: "invalid_task_id" };
  return { ok: true, request: request(RUNNINGHUB_OUTPUTS, apiKey, { taskId }) };
}

function payload(response: RunningHubResponse): Record<string, unknown> | undefined {
  try { return object(JSON.parse(response.body)); } catch { return undefined; }
}
const successfulHttp = (status: number) => Number.isInteger(status) && status >= 200 && status < 300;
// 仅明确的参数/鉴权/应用不存在/创建余额不足；未知、繁忙、超时、已排队均不能证明未提交。
const definiteRejectionCodes = new Set([301, 380, 416, 433, 801, 802, 803, 806, 810, 811, 812, 901]);
export function parseRunningHubSubmission(response: RunningHubResponse): VideoSubmissionResult {
  const body = payload(response);
  const data = object(body?.data);
  const taskId = data?.taskId;
  // 字段存在就是潜在回执：数字可能已丢失精度，非法/空值也不能证明没有创建任务。
  const hasTaskId = !!data && Object.prototype.hasOwnProperty.call(data, "taskId");
  const knownTask = isRunningHubTaskId(taskId) ? { taskId } : {};
  if (!successfulHttp(response.status)) return { kind: "submission_unknown", code: "submission_http_unknown", ...knownTask };
  if (body?.code === 0 && isRunningHubTaskId(taskId)) return { kind: "accepted", taskId };
  if (hasTaskId) return { kind: "submission_unknown", code: "submission_conflict", ...knownTask };
  if (typeof body?.code === "number" && definiteRejectionCodes.has(body.code)) return { kind: "definite_not_submitted", code: "provider_submission_rejected" };
  return { kind: "submission_unknown", code: "submission_response_unknown" };
}

const readError = (code: VideoReadError["code"], retryable = false): VideoReadError => ({ kind: "read_error", code, retryable });
function output(value: unknown): VideoBackendOutput | undefined {
  const data = object(value);
  if (typeof data?.fileUrl !== "string" || typeof data.fileType !== "string") return undefined;
  try {
    const url = new URL(data.fileUrl);
    if (url.protocol !== "https:" || url.username || url.password || /[\r\n]/.test(data.fileUrl)) return undefined;
  } catch { return undefined; }
  const type = data.fileType.toLowerCase();
  const mediaType = ["mp4", "mov", "webm", "mkv"].includes(type) ? "video" : ["png", "jpg", "jpeg", "webp", "gif"].includes(type) ? "image" : ["mp3", "wav", "aac", "ogg"].includes(type) ? "audio" : "unknown";
  return { downloadUrl: data.fileUrl, mediaType, expiresAt: null };
}
export function parseRunningHubOutputs(response: RunningHubResponse): VideoResultsResult {
  if (!successfulHttp(response.status)) {
    if (response.status === 401 || response.status === 403) return readError("provider_auth_rejected");
    if (response.status === 408 || response.status === 429 || response.status >= 500) return readError("provider_http_unavailable", true);
    return readError("provider_http_rejected");
  }
  const body = payload(response);
  if (body?.code === 804) return { kind: "running" };
  if (body?.code === 813) return { kind: "queued" };
  if (body?.code === 805) return { kind: "failed", code: "provider_task_failed" };
  if (body?.code === 423 || body?.code === 807) return readError("provider_task_not_found");
  if ([801, 802, 806, 811, 1002].includes(body?.code as number)) return readError("provider_auth_rejected");
  if ([500, 1000, 1003, 1005, 1010, 1011, 1012].includes(body?.code as number)) return readError("provider_http_unavailable", true);
  if (body?.code !== 0) return readError("provider_response_unknown");
  if (!Array.isArray(body.data) || body.data.length === 0) return readError("provider_results_invalid");
  const outputs: VideoBackendOutput[] = [];
  for (const item of body.data) {
    const parsed = output(item);
    if (!parsed) return readError("provider_results_invalid");
    outputs.push(parsed);
  }
  return { kind: "completed", outputs };
}
