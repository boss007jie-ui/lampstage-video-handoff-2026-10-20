import { apiJson } from "../public-api";
import { InsufficientCreditsError } from "../credits";
import { ImageContentError } from "../assets/image-content";
import { VideoCallError } from "./contract";

export async function videoCallHttp(fn: () => Promise<Response>) {
  try { return await fn(); }
  catch (error) {
    if (error instanceof VideoCallError || error instanceof ImageContentError) return apiJson({ error: error.code }, { status: error.status });
    if (error instanceof InsufficientCreditsError) return apiJson({ error: "insufficient_credits" }, { status: 402 });
    console.warn("Single video call API unavailable");
    return apiJson({ error: "video_call_unavailable" }, { status: 503 });
  }
}
export async function callBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 100_000) throw new VideoCallError("request_too_large", 413);
  // 提示词以 UTF-16 字符数限制；整个 JSON 另有上限。
  const text = await request.text();
  if (text.length > 100_000) throw new VideoCallError("request_too_large", 413);
  try { return JSON.parse(text) as unknown; } catch { throw new VideoCallError("invalid_json"); }
}
