import { createHash } from "node:crypto";

/** 公共任务元数据只保留固定分类；脱敏摘要仅供内部工具日志使用。 */
export const IMAGE_ERROR_CATEGORIES = [
  "invalid_argument", "content_filtered", "request_too_large", "resource_exhausted", "unknown",
] as const;
export type ImageErrorCategory = typeof IMAGE_ERROR_CATEGORIES[number];

export interface SafeImageFailureDiagnostics {
  response_body_bytes: number;
  response_body_sha256: string;
  response_content_type: "json" | "html" | "text" | "other" | "missing";
  response_structure: "error_object" | "error_string" | "message_object" | "other_json" | "non_json" | "empty";
  error_category: ImageErrorCategory;
  error?: { code?: string | number; type?: string; status?: string; message?: string };
  message?: string;
  correlation_id_sha256?: string;
}

// 用户上限12000字符之外还有有序参考清单和固定包装；此界限覆盖完整wire prompt。
const MAX_DIAGNOSTIC_PROMPT_CHARACTERS = 24_000;

/** 固定八码点滑窗合并遮盖回显区间，保留其余错误原因；有界线性处理。 */
function redactPromptFragments(message: string, prompt: string): string | undefined {
  if (prompt.length > MAX_DIAGNOSTIC_PROMPT_CHARACTERS || message.length > 16_384) return undefined;
  const promptPoints = Array.from(prompt.replace(/\s+/g, " "));
  const messagePoints = Array.from(message);
  const windowKey = (points: string[], index: number) => points.slice(index, index + 8).join("").normalize("NFKC").toLowerCase();
  const fragments = new Set<string>();
  for (let index = 0; index + 8 <= promptPoints.length; index++) {
    fragments.add(windowKey(promptPoints, index));
  }
  const mask = new Uint8Array(messagePoints.length);
  for (let index = 0; index + 8 <= messagePoints.length; index++) {
    if (fragments.has(windowKey(messagePoints, index))) mask.fill(1, index, index + 8);
  }
  const result: string[] = [];
  for (let index = 0; index < messagePoints.length; index++) {
    if (!mask[index]) result.push(messagePoints[index]);
    else if (index === 0 || !mask[index - 1]) result.push("[redacted]");
  }
  return result.join("");
}

/** 先清除凭据再截断；超长消息不取片段，避免截断破坏凭据边界。 */
function safeFailureMessage(value: unknown, apiKey?: string, prompt?: string): string | undefined {
  if (typeof value !== "string" || !value || value.length > 16_384) return undefined;
  if (prompt && prompt.length > MAX_DIAGNOSTIC_PROMPT_CHARACTERS) return undefined;
  let text = value;
  for (const sensitive of [apiKey, prompt]) {
    if (!sensitive) continue;
    const variants = new Set([sensitive, Buffer.from(sensitive).toString("base64"), Buffer.from(sensitive).toString("base64").replace(/=+$/, ""),
      Buffer.from(sensitive).toString("base64url"), Buffer.from(sensitive).toString("hex"), JSON.stringify(sensitive).slice(1, -1)]);
    variants.add([...Buffer.from(sensitive)].map(byte => `%${byte.toString(16).padStart(2, "0")}`).join(""));
    try {
      variants.add(encodeURIComponent(sensitive));
      variants.add(encodeURI(sensitive));
      variants.add(encodeURIComponent(encodeURIComponent(sensitive)));
    } catch { /* 非法 Unicode 仍按原文和字节编码脱敏。 */ }
    for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
      if (variant && variant.length <= text.length) text = text.split(variant).join("[redacted]");
    }
    // 百分号编码的十六进制字符大小写等价。
    for (const variant of variants) {
      if (variant.length <= text.length && variant.includes("%")) {
        const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp(escaped, "gi"), "[redacted]");
      }
    }
  }
  if (text.length > 16_384) return undefined;
  const sanitized = text
    .replace(/data:[^\s<>"']+/gi, "[redacted]")
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+/gi, "[redacted]")
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, "[redacted]")
    .replace(/\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|secret|password|authorization|credential|signature|x-amz-signature|x-goog-signature)\b["']?\s*[:=]\s*[^\r\n,;}]+/gi, "[redacted]")
    .replace(/\?[^\s<>"']+/g, "[redacted]")
    .replace(/\b(?:sk|lmp)[_-][a-z0-9_-]+/gi, "[redacted]")
    .replace(/[a-z0-9_+/=-]{24,}/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, " ")
    .replace(/\s+/g, " ").trim();
  const message = prompt ? redactPromptFragments(sanitized, prompt) : sanitized;
  return message?.slice(0, 320) || undefined;
}

function safeFailureIdentifier(value: unknown, apiKey?: string, prompt?: string): string | number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 999_999) {
    return apiKey && String(value).includes(apiKey) ? undefined : value;
  }
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,47}$/.test(value)) return undefined;
  const boundedPrompt = prompt && prompt.length <= MAX_DIAGNOSTIC_PROMPT_CHARACTERS ? prompt : undefined;
  return safeFailureMessage(value, apiKey, boundedPrompt) === value ? value : undefined;
}

/** 仅投影允许的字段，不保留正文、details、data、提示词或任意响应头。 */
export function buildSafeImageFailureDiagnostics(input: {
  body: Uint8Array | string;
  httpStatus: number;
  contentType?: string | null;
  apiKey?: string;
  prompt?: string;
  correlationId?: string | null;
}): SafeImageFailureDiagnostics {
  const bytes = Buffer.from(input.body);
  const contentType = (input.contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  const result: SafeImageFailureDiagnostics = {
    response_body_bytes: bytes.length,
    response_body_sha256: createHash("sha256").update(bytes).digest("hex"),
    response_content_type: !contentType ? "missing" : /^application\/(?:[a-z0-9.+-]+\+)?json$/.test(contentType)
      ? "json" : contentType === "text/html" ? "html" : contentType.startsWith("text/") ? "text" : "other",
    response_structure: bytes.length ? "non_json" : "empty",
    error_category: classifyImageFailure(undefined, input.httpStatus),
  };
  if (input.correlationId && input.correlationId.length <= 1024) {
    result.correlation_id_sha256 = createHash("sha256").update(input.correlationId).digest("hex");
  }
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); } catch { return result; }
  const body = record(payload);
  const error = record(body?.error);
  result.response_structure = error ? "error_object" : typeof body?.error === "string" ? "error_string"
    : typeof body?.message === "string" ? "message_object" : "other_json";
  result.error_category = classifyImageFailure(payload, input.httpStatus);
  if (body) {
    const identifiers = error ?? body;
    const code = safeFailureIdentifier(identifiers.code, input.apiKey, input.prompt);
    const type = safeFailureIdentifier(identifiers.type, input.apiKey, input.prompt);
    const status = safeFailureIdentifier(identifiers.status, input.apiKey, input.prompt);
    const message = safeFailureMessage(error?.message ?? (typeof body.error === "string" ? body.error : undefined), input.apiKey, input.prompt);
    const safeError = { ...(code !== undefined ? { code } : {}),
      ...(typeof type === "string" ? { type } : {}), ...(typeof status === "string" ? { status } : {}),
      ...(message ? { message } : {}) };
    if (Object.keys(safeError).length) result.error = safeError;
  }
  const message = safeFailureMessage(body?.message, input.apiKey, input.prompt);
  if (message) result.message = message;
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
export function imageErrorCategory(value: unknown): ImageErrorCategory | null {
  return typeof value === "string" && (IMAGE_ERROR_CATEGORIES as readonly string[]).includes(value)
    ? value as ImageErrorCategory : null;
}
const FILTER_REASONS = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
  "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);

/** 只有明确结构化标识才能分类；HTTP400/404本身不能推断原因。 */
export function classifyImageFailure(payload: unknown, httpStatus?: number): ImageErrorCategory {
  if (httpStatus === 413) return "request_too_large";
  const body = record(payload);
  const error = record(body?.error);
  if (error?.status === "INVALID_ARGUMENT") return "invalid_argument";
  if (error?.status === "RESOURCE_EXHAUSTED") return "resource_exhausted";
  const feedback = record(body?.promptFeedback);
  if (typeof feedback?.blockReason === "string" && FILTER_REASONS.has(feedback.blockReason)) return "content_filtered";
  const candidates = Array.isArray(body?.candidates) ? body.candidates.slice(0, 100) : [];
  if (candidates.some(value => {
    const candidate = record(value);
    return typeof candidate?.finishReason === "string" && FILTER_REASONS.has(candidate.finishReason);
  })) return "content_filtered";
  return "unknown";
}

/** 旧任务缺少分类时不回填；元数据中的任意扩展内容均忽略。 */
export function recordedImageDiagnostics(metadata: unknown): { provider_error_categories?: ImageErrorCategory[] } {
  const usage = record(record(metadata)?.usage);
  const attempts = Array.isArray(usage?.provider_attempts) ? usage.provider_attempts.slice(0, 100) : [];
  const categories = attempts.flatMap(value => {
    const category = imageErrorCategory(record(value)?.error_category);
    return category === null ? [] : [category];
  });
  return categories.length ? { provider_error_categories: categories } : {};
}
