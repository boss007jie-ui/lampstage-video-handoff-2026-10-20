import type { ProviderReportedUsage } from "./types";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Project a known provider usage object onto a small, serializable allowlist. */
export function extractProviderReportedUsage(payload: unknown): ProviderReportedUsage | undefined {
  const body = record(payload);
  if (!body) return undefined;

  const gemini = record(body.usageMetadata);
  const openAi = gemini ? null : record(body.usage);
  if (!gemini && !openAi) return undefined;

  const usage = gemini ?? openAi!;
  const counts = gemini ? {
    input_tokens: tokenCount(usage.promptTokenCount),
    output_tokens: tokenCount(usage.candidatesTokenCount),
    total_tokens: tokenCount(usage.totalTokenCount),
    cached_tokens: tokenCount(usage.cachedContentTokenCount),
  } : {
    input_tokens: tokenCount(usage.input_tokens ?? usage.prompt_tokens),
    output_tokens: tokenCount(usage.output_tokens ?? usage.completion_tokens),
    total_tokens: tokenCount(usage.total_tokens),
    cached_tokens: tokenCount(usage.cached_tokens ?? record(usage.input_tokens_details)?.cached_tokens ?? record(usage.prompt_tokens_details)?.cached_tokens),
  };

  if (Object.values(counts).every(value => value === null)) return undefined;
  return { source: "provider_reported", ...counts };
}
