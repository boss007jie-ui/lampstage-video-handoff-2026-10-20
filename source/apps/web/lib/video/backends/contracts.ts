/** 独立后端契约；不依赖现有 processor、数据库或供应商 SDK。 */
export type VideoBackendMode = "legacy_frames" | "direct_references" | "six_references";
export type UnverifiedVideoCapability = Readonly<{ enabled: false; verification: "unknown" }>;
export interface VideoBackendCapabilities {
  readonly submit: boolean;
  readonly status: boolean;
  readonly results: boolean;
  readonly cancel: boolean;
  readonly billing: boolean;
  readonly enabledModes: readonly VideoBackendMode[];
  readonly sixReferences: UnverifiedVideoCapability;
  readonly sourceWindow: UnverifiedVideoCapability;
  readonly audio: UnverifiedVideoCapability;
}

/** 由服务端持久化并绑定 ActorContext；模型不能创建或修改身份。 */
export interface VideoAttemptBinding {
  readonly backendId: string;
  readonly userId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly stepKey: string;
  readonly inputDigest: string;
  readonly attemptId: string;
}
export interface VideoSubmissionIntent {
  readonly intentId: string;
  readonly fencingToken: number;
  readonly attempt: VideoAttemptBinding;
}
export type VideoBackendErrorCode =
  | "backend_not_configured" | "backend_mismatch" | "invalid_input" | "invalid_task_id"
  | "authorization_denied" | "intent_already_claimed" | "intent_claim_unavailable"
  | "provider_submission_rejected" | "submission_conflict" | "submission_response_unknown"
  | "submission_http_unknown" | "submission_transport_unknown" | "provider_transport_unavailable"
  | "provider_http_unavailable" | "provider_http_rejected" | "provider_auth_rejected"
  | "provider_task_not_found" | "provider_task_failed" | "provider_response_unknown"
  | "provider_results_invalid" | "cancel_unsupported";

/** unknown 必须保持预算/permit 占用，禁止自动创建替代 attempt。 */
export type VideoSubmissionResult =
  | { kind: "definite_not_submitted"; code: VideoBackendErrorCode }
  | { kind: "accepted"; taskId: string }
  | { kind: "submission_unknown"; code: VideoBackendErrorCode; taskId?: string };

export interface VideoPreparedInput {
  readonly applicationId: string;
  readonly mappingVersion: string;
  readonly configurationDigest: string;
  readonly values: Readonly<Record<string, string>>;
}
/**
 * 必须注入一次性门禁。生产实现须在同一原子操作中核对身份、输入摘要、审批、
 * permit、fencing 与唯一 intent，再落盘 submitting 后返回 claimed。
 * 已提交/unknown 先于授权失效判定，返回 already_claimed，不能返回 not_authorized。
 * 这是持久化端口，后端实例内的 Set 不能替代它；Wave 1 仅使用测试假实现。
 */
export interface VideoSubmissionGate {
  claim(intent: VideoSubmissionIntent, input: VideoPreparedInput): Promise<"claimed" | "not_authorized" | "already_claimed">;
}
export interface VideoSubmitRequest {
  readonly intent: VideoSubmissionIntent;
  readonly values: Readonly<Record<string, string>>;
}
/** 查询前调用方须从受归属检查的 job/attempt 读取此引用，不能接模型提供的 taskId。 */
export interface VideoTaskReference { readonly backendId: string; readonly taskId: string }
export type VideoReadError = { kind: "read_error"; code: VideoBackendErrorCode; retryable: boolean };
export type VideoStatusResult =
  | { kind: "queued" | "running" | "completed" }
  | { kind: "failed"; code: "provider_task_failed" }
  | VideoReadError;
/** 私有下载描述，不能直接用作 REST/MCP/SSE 返回值或持久化公开事件。 */
export interface VideoBackendOutput {
  readonly downloadUrl: string;
  readonly mediaType: "video" | "image" | "audio" | "unknown";
  readonly expiresAt: null;
}
export type VideoResultsResult = Exclude<VideoStatusResult, { kind: "queued" | "running" | "completed" }>
  | { kind: "queued" | "running" }
  | { kind: "completed"; outputs: readonly VideoBackendOutput[] };
export type VideoCancelResult = { kind: "unsupported"; code: "cancel_unsupported" } | { kind: "requested" } | VideoReadError;
export interface VideoGenerationBackend {
  readonly backendId: string;
  readonly capabilities: VideoBackendCapabilities;
  submit(request: VideoSubmitRequest): Promise<VideoSubmissionResult>;
  status(task: VideoTaskReference): Promise<VideoStatusResult>;
  results(task: VideoTaskReference): Promise<VideoResultsResult>;
  cancel?(task: VideoTaskReference): Promise<VideoCancelResult>;
}

/** 公开投影只保留状态/安全代码/数量；供应商签名 URL 仅用于服务端收取。 */
export function publicVideoResults(result: VideoResultsResult) {
  if (result.kind === "completed") return { kind: result.kind, outputCount: result.outputs.length };
  if (result.kind === "read_error") return { kind: result.kind, code: result.code, retryable: result.retryable };
  if (result.kind === "failed") return { kind: result.kind, code: result.code };
  return { kind: result.kind };
}
export async function cancelVideoTask(backend: VideoGenerationBackend, task: VideoTaskReference): Promise<VideoCancelResult> {
  if (task.backendId !== backend.backendId) return { kind: "read_error", code: "backend_mismatch", retryable: false };
  if (!backend.capabilities.cancel || !backend.cancel) return { kind: "unsupported", code: "cancel_unsupported" };
  return backend.cancel(task);
}
