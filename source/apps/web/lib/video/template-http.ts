import { apiJson } from "../public-api";
import { getVideoDelivery } from "./delivery-service";
import { getVideoTemplate, listVideoTemplates, submitVideoFeedback, updateVideoTemplate, type FeedbackInput } from "./template-service";

export async function deliveryResponse(userId: string, jobId: string) {
  const result = await getVideoDelivery(userId, jobId);
  return result.ok ? apiJson(result.value) : apiJson(result.body, { status: result.status });
}
export async function listTemplatesResponse(userId: string, request: Request) {
  const q = new URL(request.url).searchParams;
  const result = await listVideoTemplates(userId, { status: q.get("status") ?? undefined,
    source_asset_id: q.get("source_asset_id") ?? undefined, source_sha256: q.get("source_sha256") ?? undefined,
    limit: q.get("limit") ?? undefined, cursor: q.get("cursor") ?? undefined });
  return result.ok ? apiJson(result.value) : apiJson(result.body, { status: result.status });
}
export async function getTemplateResponse(userId: string, templateId: string, request: Request) {
  const versionId = new URL(request.url).searchParams.get("version_id") ?? undefined;
  const result = await getVideoTemplate(userId, templateId, versionId);
  return result.ok ? apiJson(result.value) : apiJson(result.body, { status: result.status });
}
async function bodyObject(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 16_000) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = ""; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_000) { await reader.cancel(); return null; }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } catch { return null; }
  finally { reader.releaseLock(); }
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { return null; }
}
export async function feedbackResponse(userId: string, jobId: string, request: Request) {
  const body = await bodyObject(request);
  if (!body || Object.keys(body).some(k => !["decision", "output_sha256", "notes", "name", "category", "template_id"].includes(k)))
    return apiJson({ error: "invalid_video_feedback" }, { status: 400 });
  const result = await submitVideoFeedback(userId, jobId, body as FeedbackInput);
  return result.ok ? apiJson(result.value) : apiJson(result.body, { status: result.status });
}
export async function patchTemplateResponse(userId: string, templateId: string, request: Request) {
  const body = await bodyObject(request);
  if (!body) return apiJson({ error: "invalid_video_template_update" }, { status: 400 });
  const result = await updateVideoTemplate(userId, templateId, body);
  return result.ok ? apiJson(result.value) : apiJson(result.body, { status: result.status });
}
