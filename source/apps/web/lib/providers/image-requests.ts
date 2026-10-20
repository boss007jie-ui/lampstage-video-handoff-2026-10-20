import { getImageModel } from "../image-models";

export type ImageReference = { bytes: Buffer; mime: string };
export const NANO_21_ENDPOINT = "https://api.openlux.ai/v1beta/models/gemini-nano-banana-2.1:generateContent";
export const IMAGE_25_ENDPOINT = "https://api.openlux.ai/v1/images/edits";

function checkReferences(references: ImageReference[], max: number) {
  if (!references.length || references.length > max) throw new Error("Unsupported reference image count.");
  for (const reference of references) {
    if (!reference.bytes.length || !["image/jpeg", "image/png", "image/webp"].includes(reference.mime)) {
      throw new Error("Invalid reference image.");
    }
  }
}

/** Match AI-media-tools' verified minimal native request; do not add unverified options. */
export function buildNano21Request(prompt: string, references: ImageReference[], imageSize?: "2K") {
  checkReferences(references, getImageModel("nano_banana_21").maxReferences);
  if (imageSize !== undefined && imageSize !== "2K") throw new Error("Unsupported native image size.");
  return {
    contents: [{ role: "user", parts: [
      { text: prompt },
      ...references.map(reference => ({ inlineData: { mimeType: reference.mime, data: reference.bytes.toString("base64") } })),
    ] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"],
      ...(imageSize === "2K" ? { imageConfig: { aspectRatio: "1:1", imageSize } } : {}) },
  };
}

/** OpenLux multi-file alias support is unverified; image[] follows the OpenAI-compatible edit convention. */
export function buildImage25Request(prompt: string, references: ImageReference[]): FormData {
  checkReferences(references, getImageModel("image_25").maxReferences);
  const form = new FormData();
  form.append("model", getImageModel("image_25").apiModel);
  form.append("prompt", prompt);
  references.forEach((reference, index) => {
    const suffix = reference.mime === "image/png" ? "png" : reference.mime === "image/webp" ? "webp" : "jpg";
    const filename = references.length === 1 ? `product.${suffix}` : `reference-${String(index + 1).padStart(2, "0")}.${suffix}`;
    form.append(references.length === 1 ? "image" : "image[]",
      new Blob([new Uint8Array(reference.bytes)], { type: reference.mime }), filename);
  });
  return form;
}

export function extractOpenAiImage(payload: unknown): { b64: string } | { url: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.b64_json === "string" && item.b64_json) return { b64: item.b64_json };
    if (typeof item.url === "string" && item.url) return { url: item.url };
  }
  return null;
}
