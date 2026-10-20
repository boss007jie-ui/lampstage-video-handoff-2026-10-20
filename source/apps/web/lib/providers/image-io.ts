import sharp from "sharp";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getObjectBytes } from "@/lib/storage";
import type { GenInput } from "./types";
import type { ImageReference } from "./image-requests";
import { APP_MAX_IMAGE_REFERENCES } from "../image-models";

async function readReference(url: string): Promise<ImageReference> {
  // These are bundled public assets even when uploaded customer media uses R2.
  if (/^\/(?:scene-refs(?:-v2)?|templates|scene-examples)\//.test(url)) {
    const root = path.resolve(process.cwd(), "public");
    const file = path.resolve(root, `.${url}`);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid static reference path.");
    return { bytes: await readFile(file), mime: "image/png" };
  }
  return getObjectBytes(url);
}

/** Keep the full product reference, rather than shrinking its identifying details to 256 px. */
export async function readImageReferences(input: GenInput, maxReferences: number): Promise<ImageReference[]> {
  if (input.referenceImages !== undefined) {
    if (input.compositionReferenceData !== undefined || input.compositionReferenceUrl !== undefined || input.referenceImageData !== undefined) {
      throw new Error("Explicit reference images cannot be combined with legacy reference data or composition fields.");
    }
    if (!Array.isArray(input.referenceImages) || !input.referenceImages.length ||
      input.referenceImages.length > APP_MAX_IMAGE_REFERENCES || input.referenceImages.length > maxReferences) {
      throw new Error("Unsupported reference image count.");
    }
    // The URL remains a required legacy sentinel, but explicit bytes are the only source here.
    return prepareReferences(input.referenceImages);
  }
  const hasComposition = Boolean(input.compositionReferenceData || input.compositionReferenceUrl);
  if (hasComposition && maxReferences < 2) throw new Error("This image model accepts only the product reference.");
  const product = input.referenceImageData ?? await readReference(input.referenceImageUrl);
  const references = hasComposition
    ? [input.compositionReferenceData ?? await readReference(input.compositionReferenceUrl!), product]
    : [product];
  return prepareReferences(references);
}

async function prepareReferences(references: ImageReference[]): Promise<ImageReference[]> {
  const prepared = [];
  for (const reference of references) {
    if (!reference || !Buffer.isBuffer(reference.bytes) || !reference.bytes.length ||
      !["image/jpeg", "image/png", "image/webp"].includes(reference.mime)) {
      throw new Error("Invalid reference image.");
    }
    const bytes = await sharp(reference.bytes).rotate()
      .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
      .png().toBuffer();
    prepared.push({ bytes, mime: "image/png" });
  }
  return prepared;
}

/** Decode downloaded bytes before a request can count as a successful generation. */
export async function resolveImageBytes(image: { b64: string } | { url: string }, signal?: AbortSignal): Promise<ImageReference> {
  let bytes: Buffer;
  if ("b64" in image) bytes = Buffer.from(image.b64, "base64");
  else if (image.url.startsWith("data:")) {
    const matched = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image.url);
    if (!matched) throw new Error("Invalid image data.");
    bytes = Buffer.from(matched[1], "base64");
  } else {
    const remote = new URL(image.url);
    if (remote.protocol !== "https:" || remote.username || remote.password) throw new Error("Invalid image download address.");
    const deadline = AbortSignal.timeout(60_000);
    const response = await fetch(remote, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if (!response.ok) throw new Error(`Image download failed (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error("Invalid image size.");
  // Full decode catches truncated files that metadata alone might accept.
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).stats();
  if (!metadata.channels.length) throw new Error("Invalid image bytes.");
  const info = await sharp(bytes).metadata();
  const mime = info.format === "jpeg" ? "image/jpeg" : info.format === "png" ? "image/png" : info.format === "webp" ? "image/webp" : null;
  if (!mime || !info.width || !info.height) throw new Error("Invalid image bytes.");
  return { bytes, mime };
}
