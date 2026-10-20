import { createHash } from "node:crypto";
import { getImageModel, type ImageModelId } from "../image-models";
import { logToolCall } from "../tool-log";
import { extractGeminiImage } from "./gemini-response";
import { readImageReferences, resolveImageBytes } from "./image-io";
import { buildImage25Request, buildNano21Request, extractOpenAiImage, IMAGE_25_ENDPOINT, NANO_21_ENDPOINT } from "./image-requests";
import { extractProviderReportedUsage } from "./provider-usage";
import { buildSafeImageFailureDiagnostics, classifyImageFailure, type SafeImageFailureDiagnostics } from "./image-diagnostics";
import type { GenSingleResult, IGenerationProvider, ProviderAttempt, ProviderReportedUsage } from "./types";

type Dependencies = {
  fetch: typeof fetch;
  readReferences: typeof readImageReferences;
  resolveImage: typeof resolveImageBytes;
  log: typeof logToolCall;
  apiKey: () => string;
};

/** Each job pins one provider. No old model, mixed-model strategy, or automatic retry. */
export function createOpenLuxImageProvider(id: ImageModelId, overrides: Partial<Dependencies> = {}): IGenerationProvider {
  const model = getImageModel(id);
  const isNano = id === "nano_banana_21";
  const tool = isNano ? "nano-banana" : "gpt-image-2";
  const dependencies: Dependencies = {
    fetch: (...args) => fetch(...args),
    readReferences: readImageReferences,
    resolveImage: resolveImageBytes,
    log: logToolCall,
    apiKey: () => {
      const key = process.env.OPENLUX_API_KEY?.trim();
      if (!key) throw new Error("Image service is not configured.");
      return key;
    },
    ...overrides,
  };
  return {
    name: model.name,
    async generate(input): Promise<GenSingleResult> {
      const startedAt = Date.now();
      let httpStatus: number | undefined;
      let result: GenSingleResult;
      let usage: ProviderReportedUsage | undefined;
      let responseDiagnostics: SafeImageFailureDiagnostics | undefined;
      let requestDiagnostics: {
        request_body_bytes?: number;
        request_body_sha256?: string;
        reference_count: number;
        references: { bytes: number; mime: string; width?: number; height?: number }[];
      } | undefined;
      const attempt: ProviderAttempt = { status: "not_submitted", http_status: null };
      try {
        if (input.imageSize !== undefined && (!isNano || input.imageSize !== "2K")) throw new Error("Unsupported native image size.");
        const key = dependencies.apiKey();
        const references = await dependencies.readReferences(input, model.maxReferences);
        // 参考图预处理是异步的，期间租约/授权可能已变；先查取消，再跑调用方给的闸门，
        // 然后才真正发出 HTTP POST —— 这是"付费请求真的发出去"的最后一道门。
        input.signal?.throwIfAborted();
        await input.beforeSend?.();
        input.signal?.throwIfAborted();
        const body = isNano ? JSON.stringify(buildNano21Request(input.prompt, references, input.imageSize)) : buildImage25Request(input.prompt, references);
        requestDiagnostics = {
          ...(typeof body === "string" ? {
            request_body_bytes: Buffer.byteLength(body, "utf8"),
            request_body_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
          } : {}),
          reference_count: references.length,
          references: references.map(reference => {
            const bytes = reference.bytes;
            // 预处理输出 PNG；只读取已有 IHDR，不增加文件 IO 或解码依赖。
            const isPng = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR";
            return { bytes: bytes.length, mime: ["image/png", "image/jpeg", "image/webp"].includes(reference.mime) ? reference.mime : "other",
              ...(isPng ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : {}) };
          }),
        };
        const deadline = AbortSignal.timeout(input.requestTimeoutMs || 180_000);
        attempt.status = "unknown";
        const response = await dependencies.fetch(isNano ? NANO_21_ENDPOINT : IMAGE_25_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, ...(isNano ? { "Content-Type": "application/json" } : {}) },
          body,
          // 父信号与本次 deadline 合并：任一触发都真正中断 HTTP 请求。
          signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
        });
        httpStatus = response.status;
        attempt.status = "response_received";
        attempt.http_status = response.status;
        if (!response.ok) {
          // 原始字节只在内存中用于摘要、脱敏和用量投影，永不写入日志或返回。
          try {
            let failure: unknown;
            if (typeof response.arrayBuffer === "function") {
              const bytes = Buffer.from(await response.arrayBuffer());
              responseDiagnostics = buildSafeImageFailureDiagnostics({ body: bytes, httpStatus: response.status,
                contentType: response.headers.get("content-type"), apiKey: key, prompt: input.prompt,
                correlationId: response.headers.get("x-request-id") ?? response.headers.get("request-id") });
              failure = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
            } else {
              // 兼容只实现 JSON 的注入适配器；拿不到原始字节时不伪造摘要。
              failure = await response.json();
            }
            usage = extractProviderReportedUsage(failure);
            const category = classifyImageFailure(failure, response.status);
            if (category !== "unknown") attempt.error_category = category;
          } catch { /* 非 JSON 仅保留安全摘要；读取失败时保留 HTTP 状态。 */ }
          if (response.status === 413) attempt.error_category = "request_too_large";
          throw new Error("provider_http_error");
        }
        const payload: unknown = await response.json();
        usage = extractProviderReportedUsage(payload);
        const image = isNano ? extractGeminiImage(payload) : extractOpenAiImage(payload);
        if (!image) {
          const category = classifyImageFailure(payload, response.status);
          if (category !== "unknown") attempt.error_category = category;
          throw new Error("provider_no_image");
        }
        const verified = await dependencies.resolveImage(image, input.signal);
        result = { ok: true, ...verified, attempt, ...(usage ? { usage } : {}) };
      } catch {
        // Provider bodies and download URLs can contain secrets or signed links; never expose them.
        result = { ok: false, error: `${model.name}: image generation did not complete${httpStatus ? ` (HTTP ${httpStatus})` : ""}.`, attempt, ...(usage ? { usage } : {}) };
      }
      await dependencies.log({
        tool, model: model.apiModel, jobId: input.jobId,
        status: result.ok ? "ok" : "failed", httpStatus: httpStatus ?? null,
        durationMs: Date.now() - startedAt, error: result.ok ? null : result.error,
        resultJson: JSON.stringify({ attempt, ...(usage ? { usage } : {}),
          ...(!result.ok && responseDiagnostics ? { diagnostics: {
            ...(requestDiagnostics ? { request: requestDiagnostics } : {}),
            ...(responseDiagnostics ? { response: responseDiagnostics } : {}),
          } } : {}) }),
      });
      return result;
    },
  };
}

export const nanoBanana21Provider = createOpenLuxImageProvider("nano_banana_21");
export const image25Provider = createOpenLuxImageProvider("image_25");
