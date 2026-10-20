import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "../db";
import { privateDownloadTo } from "./storage";
import { VIDEO_MAX_BYTES } from "./types";

/** Hash a legacy private source with bounded streaming and unconditional temp cleanup. */
export async function ensureVideoAssetSha256(userId: string, assetId: string, db = prisma): Promise<string | null> {
  const asset = await db.videoAsset.findFirst({ where: { id: assetId, user_id: userId, status: { in: ["ready", "uploaded"] } } });
  if (!asset) return null;
  if (asset.sha256 && /^[a-f0-9]{64}$/.test(asset.sha256)) return asset.sha256;
  if (asset.size_bytes <= 0 || asset.size_bytes > VIDEO_MAX_BYTES) return null;
  const directory = await mkdtemp(path.join(tmpdir(), "video-template-hash-"));
  try {
    const target = path.join(directory, `${randomUUID()}.video`);
    await privateDownloadTo(asset.storage_key, target, { maxBytes: VIDEO_MAX_BYTES, expectedBytes: asset.size_bytes, timeoutMs: 120_000 });
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(target)) digest.update(chunk);
    const value = digest.digest("hex");
    await db.videoAsset.updateMany({ where: { id: assetId, user_id: userId, sha256: null }, data: { sha256: value } });
    return value;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
