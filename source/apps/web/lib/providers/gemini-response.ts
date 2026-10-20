export type GeminiImage = { mime: string; b64: string } | { mime: string; url: string };

/** Gemini services return either inline bytes or a downloadable file reference. */
export function extractGeminiImage(payload: unknown): GeminiImage | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> };
  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.thought === true) continue;
      const inline = (part.inlineData ?? part.inline_data) as { data?: string; mimeType?: string; mime_type?: string } | undefined;
      if (inline?.data) return { mime: inline.mimeType ?? inline.mime_type ?? "image/png", b64: inline.data };
      const file = (part.fileData ?? part.file_data) as { fileUri?: string; file_uri?: string; mimeType?: string; mime_type?: string } | undefined;
      const url = file?.fileUri ?? file?.file_uri;
      if (url) return { mime: file?.mimeType ?? file?.mime_type ?? "image/png", url };
    }
  }
  return null;
}
