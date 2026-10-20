import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { getObjectBytes } from "../storage";
import { inspectOriginalImage, MAX_IMAGE_BYTES, ownedOriginalPath } from "../assets/image-content";
import { inspectSource, type MediaInfo } from "../video/media";
import { privateDownloadTo, privateUploadFile, privateWrite } from "../video/storage";
import { sha256, VideoCallError, type CallInput, type FrozenAsset } from "./contract";

/** 当前H3工作流会编码参考音频；在免费预检拦截空AUDIO对象，避免收费后才报waveform缺失。 */
export function assertCallMotionReady(media: MediaInfo) {
  if (media.duration > 30 || Math.abs(media.width / media.height - 9 / 16) > 0.025 || media.width < 144 || media.height > 8192)
    throw new VideoCallError("unsupported_motion_media");
  if (!media.hasAudio || !media.audioCodec) throw new VideoCallError("motion_audio_required");
}

/** 所有哈希来自实际读取；快照写入在数据库事务之外完成。 */
export async function inspectCallAssets(userId: string, input: CallInput, freezeForJob?: string) {
  const source = await prisma.videoAsset.findFirst({ where: { id: input.motion_asset_id, user_id: userId, status: "ready" } });
  if (!source) throw new VideoCallError("motion_asset_not_found", 404);
  const root = path.resolve(process.env.VIDEO_WORK_ROOT || path.join(process.cwd(), ".video-work"), "single-call-validation");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "check-"));
  const prefix = freezeForJob ? `videos/${freezeForJob}/single-call/${randomUUID()}` : "";
  try {
    const file = path.join(dir, "motion.mp4");
    await privateDownloadTo(source.storage_key, file, { expectedBytes: source.size_bytes });
    const bytes = await readFile(file);
    const hash = sha256(bytes);
    if (source.sha256 && source.sha256 !== hash) throw new VideoCallError("motion_content_changed", 409);
    // 完整解码核验音视频，不能以容器里有个audio标签冒充可用波形。
    const media = await inspectSource(file);
    assertCallMotionReady(media);
    const motion: FrozenAsset = { asset_id: source.id, key: freezeForJob ? `${prefix}/motion.mp4` : "", sha256: hash, size_bytes: bytes.length, mime: source.mime };
    if (freezeForJob) await privateUploadFile(motion.key, file, source.mime);
    const references: (FrozenAsset & { role?: string; label?: string })[] = [];
    for (const [index, ref] of input.reference_assets.entries()) {
      const asset = await prisma.uploadedAsset.findFirst({ where: { id: ref.asset_id, user_id: userId }, include: { image_content: true } });
      if (!asset || (asset.image_content && asset.image_content.user_id !== userId)) throw new VideoCallError("reference_asset_not_found", 404);
      const image = await getObjectBytes(ownedOriginalPath(userId, asset.image_url), { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 30_000 });
      const meta = await inspectOriginalImage(image.bytes);
      if (asset.image_content && asset.image_content.sha256 !== meta.sha256) throw new VideoCallError("reference_content_changed", 409);
      const key = freezeForJob ? `${prefix}/reference-${index}.${meta.ext}` : "";
      if (freezeForJob) await privateWrite(key, image.bytes, meta.mime);
      references.push({ ...ref, key, sha256: meta.sha256, size_bytes: meta.size_bytes, mime: meta.mime });
    }
    return { motion, references, media };
  } finally {
    // dir 来自该固定工作根下的 mkdtemp，不使用用户传入路径。
    if (dir.startsWith(root + path.sep)) await rm(dir, { recursive: true, force: true });
  }
}
