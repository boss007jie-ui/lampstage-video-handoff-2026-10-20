import { createHash } from "node:crypto";
import type { VideoBackendCapabilities, VideoBackendErrorCode, VideoGenerationBackend, VideoResultsResult, VideoSubmissionGate, VideoSubmissionIntent, VideoSubmissionResult, VideoSubmitRequest, VideoTaskReference } from "./contracts";
import { buildRunningHubQueryRequest, buildRunningHubSubmitRequest, isVerifiedRunningHubApplication, parseRunningHubOutputs, parseRunningHubSubmission } from "./runninghub-protocol";
import type { RunningHubApplication, RunningHubRequest, RunningHubResponse, RunningHubTransport } from "./runninghub-protocol";

export interface RunningHubBackendOptions {
  readonly apiKey?: string;
  readonly application?: RunningHubApplication;
  readonly transport?: RunningHubTransport;
  readonly gate?: VideoSubmissionGate;
  readonly timeoutMs?: number;
  /** 回调只能接收枚举安全码，永不接收请求、响应、URL 或原始异常。 */
  readonly warn?: (code: VideoBackendErrorCode) => void;
}

function validIntent(intent: VideoSubmissionIntent): boolean {
  return !!intent && typeof intent.intentId === "string" && !!intent.intentId.trim() && Number.isSafeInteger(intent.fencingToken) && intent.fencingToken > 0 &&
    !!intent.attempt && [intent.attempt.backendId, intent.attempt.userId, intent.attempt.runId, intent.attempt.jobId, intent.attempt.stepKey, intent.attempt.inputDigest, intent.attempt.attemptId]
      .every(value => typeof value === "string" && value.length > 0);
}

/** 无默认 fetch、环境读取、凭据文件、上传、自动轮询或付费重试。 */
export function createRunningHubBackend(options: RunningHubBackendOptions = {}): VideoGenerationBackend {
  const { apiKey, transport, gate } = options;
  const supplied = options.application;
  // 冻结应用映射与账户身份；在途任务不能因调用方修改配置对象而换应用。
  const application: RunningHubApplication | undefined = isVerifiedRunningHubApplication(supplied) ? Object.freeze({
    accountId: supplied.accountId, webappId: supplied.webappId, mappingVersion: supplied.mappingVersion, mappingEvidence: supplied.mappingEvidence,
    bindings: Object.freeze(supplied.bindings.map(binding => Object.freeze({ ...binding }))),
  }) : undefined;
  const configurationDigest = createHash("sha256").update(JSON.stringify(application ? { accountId: application.accountId, webappId: application.webappId,
    mappingVersion: application.mappingVersion, bindings: application.bindings, queryProtocol: "legacy-outputs-v1" } : null)).digest("hex");
  const backendId = application ? `runninghub.ai-app.${application.accountId}.${application.webappId}.${application.mappingVersion}.legacy-outputs-v1.${configurationDigest}` : "runninghub.ai-app.unconfigured.legacy-outputs-v1";
  const credentialConfigured = buildRunningHubQueryRequest(apiKey, "1").ok;
  const configured = credentialConfigured && !!application && !!transport && !!gate;
  const unknown = Object.freeze({ enabled: false as const, verification: "unknown" as const });
  const capabilities: VideoBackendCapabilities = Object.freeze({ submit: configured, status: credentialConfigured && !!transport && !!application, results: credentialConfigured && !!transport && !!application,
    cancel: false, billing: false, enabledModes: Object.freeze([]), sixReferences: unknown, sourceWindow: unknown, audio: unknown });
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs! > 0 && options.timeoutMs! <= 120_000 ? options.timeoutMs! : 30_000;
  const log = options.warn ?? ((code: VideoBackendErrorCode) => console.warn("[video-backend]", code));
  function warn(code: VideoBackendErrorCode) { try { log(code); } catch { /* 诊断接收器不能改变付费结果分类。 */ } }
  async function send(request: RunningHubRequest): Promise<RunningHubResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => transport!({ ...request, signal: controller.signal })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("transport_timeout")); }, timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async function results(task: VideoTaskReference): Promise<VideoResultsResult> {
    if (!task || task.backendId !== backendId) return { kind: "read_error", code: "backend_mismatch", retryable: false };
    if (!transport || !application) return { kind: "read_error", code: "backend_not_configured", retryable: false };
    const built = buildRunningHubQueryRequest(apiKey, task.taskId);
    if (!built.ok) return { kind: "read_error", code: built.code, retryable: false };
    let result: VideoResultsResult;
    try {
      result = parseRunningHubOutputs(await send(built.request));
      // 凭据被恶意反射到成功链接时也不能作为私有下载描述继续传递。
      if (result.kind === "completed" && result.outputs.some(output => output.downloadUrl.includes(apiKey!) || output.downloadUrl.includes(encodeURIComponent(apiKey!)))) {
        result = { kind: "read_error", code: "provider_results_invalid", retryable: false };
      }
    } catch { result = { kind: "read_error", code: "provider_transport_unavailable", retryable: true }; }
    if (result.kind === "read_error" || result.kind === "failed") warn(result.code);
    return result;
  }

  return Object.freeze({ backendId, capabilities, results,
    async status(task: VideoTaskReference) {
      const result = await results(task);
      return result.kind === "completed" ? { kind: "completed" as const } : result;
    },
    async submit(input: VideoSubmitRequest): Promise<VideoSubmissionResult> {
      if (!input || !validIntent(input.intent)) return { kind: "definite_not_submitted", code: "invalid_input" };
      if (input.intent.attempt.backendId !== backendId) return { kind: "definite_not_submitted", code: "backend_mismatch" };
      if (!configured) return { kind: "definite_not_submitted", code: "backend_not_configured" };
      const built = buildRunningHubSubmitRequest(apiKey, application, input.values);
      if (!built.ok) return { kind: "definite_not_submitted", code: built.code };
      // 门禁与发送使用同一份快照，异步等待期间外部不能更改授权对象或输入。
      const intent = Object.freeze({ ...input.intent, attempt: Object.freeze({ ...input.intent.attempt }) });
      const prepared = Object.freeze({ applicationId: application!.webappId, mappingVersion: application!.mappingVersion, configurationDigest, values: Object.freeze({ ...input.values }) });
      let claim: Awaited<ReturnType<VideoSubmissionGate["claim"]>>;
      try { claim = await gate!.claim(intent, prepared); }
      catch { warn("intent_claim_unavailable"); return { kind: "submission_unknown", code: "intent_claim_unavailable" }; }
      if (claim === "not_authorized") return { kind: "definite_not_submitted", code: "authorization_denied" };
      if (claim !== "claimed") { warn("intent_already_claimed"); return { kind: "submission_unknown", code: "intent_already_claimed" }; }
      let result: VideoSubmissionResult;
      try {
        result = parseRunningHubSubmission(await send(built.request));
        if ("taskId" in result && result.taskId?.includes(apiKey!)) result = { kind: "submission_unknown", code: "submission_response_unknown" };
      }
      catch { result = { kind: "submission_unknown", code: "submission_transport_unknown" }; }
      if (result.kind !== "accepted") warn(result.code);
      return result;
    },
  });
}
