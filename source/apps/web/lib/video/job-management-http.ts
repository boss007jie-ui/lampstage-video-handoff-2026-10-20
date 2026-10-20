import { getCurrentUser } from "../auth";
import { apiJson } from "../public-api";
import { listVideoJobs, closeVideoJob } from "./job-quota";

/** Account recovery is available to every signed-in owner, independently of beta access. */
export async function requireJobManagementUser(request: Request) {
  const user = await getCurrentUser();
  if (!user) return { response: apiJson({ error: "not_signed_in" }, { status: 401 }) } as const;
  if (!["GET", "HEAD"].includes(request.method)) {
    const url = new URL(request.url);
    const expected = `${url.protocol}//${request.headers.get("host") || url.host}`;
    if (request.headers.get("origin") !== expected) return { response: apiJson({ error: "invalid_origin" }, { status: 403 }) } as const;
  }
  return { user } as const;
}
export async function lifecycleHttp(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); }
  catch { return apiJson({ error: "video_service_unavailable", message: "视频任务服务暂时不可用，请稍后查看任务记录。" }, { status: 503 }); }
}
export async function videoJobListResponse(request: Request, userId: string) {
  const params = new URL(request.url).searchParams;
  const result = await listVideoJobs(userId, { status: params.get("status") ?? undefined, limit: params.get("limit") ?? undefined, cursor: params.get("cursor") ?? undefined });
  return result.ok ? apiJson(result.value) : apiJson(result.body, { status: result.status });
}
export async function videoJobCloseResponse(request: Request, userId: string, jobId: string) {
  // Bound the streamed body, including chunked requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return apiJson({ error: "invalid_expected_revision" }, { status: 400 });
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2048) { await reader.cancel(); return apiJson({ error: "request_too_large" }, { status: 413 }); }
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "expected_revision") ||
      !Number.isSafeInteger((body as { expected_revision?: unknown }).expected_revision) ||
      ((body as { expected_revision: number }).expected_revision < 0)) return apiJson({ error: "invalid_expected_revision" }, { status: 400 });
    const result = await closeVideoJob(userId, jobId, (body as { expected_revision: number }).expected_revision);
    return result.ok ? apiJson(result.value) : apiJson(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof SyntaxError) return apiJson({ error: "invalid_expected_revision" }, { status: 400 });
    throw error;
  } finally { reader.releaseLock(); }
}
