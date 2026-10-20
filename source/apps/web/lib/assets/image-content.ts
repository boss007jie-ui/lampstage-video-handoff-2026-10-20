import { createHash } from "node:crypto";
import sharp from "sharp";
import type { BackgroundType, PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import { getObjectBytes, putUploadedAsset } from "../storage";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export class ImageContentError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export async function inspectOriginalImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ImageContentError("file_too_large");
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > 40_000_000 ||
      !["jpeg", "png", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) > 1) throw new Error();
    // Force a bounded decode; metadata alone can accept truncated files.
    await image.resize(1, 1).raw().toBuffer();
    return { sha256: createHash("sha256").update(bytes).digest("hex"), mime: `image/${meta.format}`,
      ext: meta.format === "jpeg" ? "jpg" : meta.format!, size_bytes: bytes.length, width: meta.width, height: meta.height };
  } catch { throw new ImageContentError("invalid_image"); }
}
type IO = { read?: typeof getObjectBytes; write?: typeof putUploadedAsset };
/** Only owned original-upload paths may be read by registration/backfill. Never follow arbitrary URLs. */
export function ownedOriginalPath(userId: string, url: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId) || /[%\\?#]/.test(url)) throw new ImageContentError("invalid_image_location");
  const base = process.env.R2_PUBLIC_BASE?.replace(/\/$/, "");
  let key = url;
  if (/^https?:\/\//.test(url)) {
    if (!base || !url.startsWith(`${base}/`)) throw new ImageContentError("invalid_image_location");
    key = url.slice(base.length);
  }
  if (!new RegExp(`^/?uploads/${userId}/[A-Za-z0-9_-]+\\.(?:jpg|jpeg|png|webp)$`).test(key))
    throw new ImageContentError("invalid_image_location");
  return url;
}
/** User lock serializes object creation, while product records always retain independent metadata. */
export async function uploadImageContent(userId: string, bytes: Buffer, options: { db?: PrismaClient; reuseAsset?: boolean;
  background_type?: BackgroundType; quality_warning?: string | null; io?: IO } = {}) {
  const meta = await inspectOriginalImage(bytes);
  const db = options.db ?? prisma;
  return db.$transaction(async tx => {
    const users = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (!users.length) throw new ImageContentError("not_found", 404);
    let content = await tx.imageContent.findUnique({ where: { user_id_sha256: { user_id: userId, sha256: meta.sha256 } } });
    const reused_content = Boolean(content);
    if (!content) {
      const storage_url = await (options.io?.write ?? putUploadedAsset)(`${userId}/${meta.sha256}.${meta.ext}`, bytes, meta.mime,
        { signal: AbortSignal.timeout(20_000) });
      const { sha256, mime, size_bytes, width, height } = meta;
      const fields = { sha256, mime, size_bytes, width, height };
      content = await tx.imageContent.create({ data: { user_id: userId, storage_url, ...fields } });
    }
    const existing = options.reuseAsset ? await tx.uploadedAsset.findFirst({ where: { user_id: userId, image_content_id: content.id },
      orderBy: [{ created_at: "asc" }, { id: "asc" }] }) : null;
    const asset = existing ?? await tx.uploadedAsset.create({ data: { user_id: userId, image_url: content.storage_url,
      image_content_id: content.id, file_type: meta.ext, width: meta.width, height: meta.height,
      background_type: options.background_type ?? "unknown", quality_warning: options.quality_warning ?? null } });
    return { asset, content, reused_content };
  }, { maxWait: 30_000, timeout: 30_000 });
}
/** Register an existing original without rewriting its URL, metadata, or storage object. */
export async function registerExistingImage(userId: string, assetId: string, options: { db?: PrismaClient; io?: IO; dryRun?: boolean } = {}) {
  const db = options.db ?? prisma;
  const asset = await db.uploadedAsset.findFirst({ where: { id: assetId, user_id: userId }, include: { image_content: true } });
  if (!asset) throw new ImageContentError("asset_not_found", 404);
  const { bytes } = await (options.io?.read ?? getObjectBytes)(ownedOriginalPath(userId, asset.image_url), { timeoutMs: 20_000, maxBytes: MAX_IMAGE_BYTES });
  const meta = await inspectOriginalImage(bytes);
  if (asset.image_content && asset.image_content.sha256 !== meta.sha256) throw new ImageContentError("image_content_changed", 409);
  if (options.dryRun) return { asset, content: asset.image_content, sha256: meta.sha256, size_bytes: meta.size_bytes };
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const selected = await tx.uploadedAsset.findFirst({ where: { id: assetId, user_id: userId }, include: { image_content: true } });
    if (!selected || selected.image_url !== asset.image_url || (selected.image_content && selected.image_content.sha256 !== meta.sha256))
      throw new ImageContentError("image_content_changed", 409);
    const { sha256, mime, size_bytes, width, height } = meta;
    const fields = { sha256, mime, size_bytes, width, height };
    const content = await tx.imageContent.upsert({ where: { user_id_sha256: { user_id: userId, sha256: meta.sha256 } },
      create: { user_id: userId, storage_url: asset.image_url, ...fields }, update: {} });
    if (!selected.image_content_id) await tx.uploadedAsset.update({ where: { id: selected.id }, data: { image_content_id: content.id } });
    return { asset: selected, content, sha256: meta.sha256, size_bytes: meta.size_bytes };
  }, { maxWait: 15_000, timeout: 15_000 });
}
export function verifyOriginalImage(bytes: Buffer, expectedSha256: string) {
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new ImageContentError("image_content_changed", 409);
}
