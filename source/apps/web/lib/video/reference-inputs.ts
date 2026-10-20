import { extractCharacterBindings, CharacterBindingError } from "../characters/bindings";
import { parseSixReferencePlan, sixReferencesReady, sixPlanDigest, parseSixReferences } from "./six-reference-plan";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { emptyVideoData, type VideoGenerationMode, type VideoJobData, type VideoReferenceImage } from "./types";

export const DIRECT_REFERENCE_CAPABILITY = {
  reference_image_count: 3,
  additional_reference_count: 2,
  generated_endpoint_frames: false,
  reference_roles: ["character", "scene", "product_detail"],
} as const;
const extraRoles = new Set<string>(DIRECT_REFERENCE_CAPABILITY.reference_roles);
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const validLabel = (label: unknown): label is string => typeof label === "string" && label.trim().length > 0 && label.length <= 80 && !/[\u0000-\u001f\u007f]/.test(label);

export class VideoReferenceInputError extends Error {}
export function generationMode(data: VideoJobData): VideoGenerationMode {
  if (data.generationMode === undefined || data.generationMode === "legacy_frames") return "legacy_frames";
  if (data.generationMode === "direct_references") return "direct_references";
  if (data.generationMode === "six_references") return "six_references";
  throw new VideoReferenceInputError("视频生成模式无效，请核对原任务。");
}

/** The current upstream has three connected image slots. Never invent or discard references. */
export function parseVideoReferenceInput(body: Record<string, unknown>, productId: string): VideoJobData {
  try { extractCharacterBindings(body); } catch (e) { if (e instanceof CharacterBindingError) throw new VideoReferenceInputError(e.code); throw e; }
  const mode = body.generation_mode ?? "legacy_frames";
  if (mode === "six_references") return parseSixReferencePlan(body);
  if (mode !== "direct_references" && mode !== "legacy_frames") throw new VideoReferenceInputError("不支持该视频生成模式。");
  if (mode === "legacy_frames") {
    if (body.reference_assets !== undefined) throw new VideoReferenceInputError("使用人物或场景参考图时，必须明确指定 direct_references 模式。");
    return { ...emptyVideoData(), generationMode: mode };
  }
  if (!Array.isArray(body.reference_assets) || body.reference_assets.length !== 2) {
    throw new VideoReferenceInputError("直接参考模式需要产品图及另外两张参考图；目前共支持三张，不会自动补图或舍弃额外图片。");
  }
  const referenceImages: VideoReferenceImage[] = [{ assetId: productId, role: "product", label: "产品" }];
  for (const raw of body.reference_assets) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.asset_id !== "string" || !idPattern.test(raw.asset_id) ||
      !extraRoles.has(raw.role) || !validLabel(raw.label)) throw new VideoReferenceInputError("每张参考图必须包含有效的 asset_id、角色及 1–80 字符的名称。");
    referenceImages.push({ assetId: raw.asset_id, role: raw.role, label: raw.label.trim() });
  }
  const data: VideoJobData = { ...emptyVideoData(), generationMode: mode, referenceImages };
  referenceImagesFor(data);
  return data;
}

export function referenceImagesFor(data: VideoJobData): VideoReferenceImage[] {
  const refs = data.referenceImages;
  if (generationMode(data) !== "direct_references" || !Array.isArray(refs) || refs.length !== 3 ||
    refs.some((r, i) => !r || typeof r.assetId !== "string" || !idPattern.test(r.assetId) || !validLabel(r.label) || (i === 0 ? r.role !== "product" : !extraRoles.has(r.role))) ||
    new Set(refs.map(r => r.assetId)).size !== 3) throw new VideoReferenceInputError("三张参考图记录缺失、重复或角色不明确，请先核对素材。");
  return refs;
}

export function preparedReferencesReady(data: VideoJobData): boolean {
  if (generationMode(data) === "six_references") return sixReferencesReady(data);
  try {
    return data.imageCalls === 0 && referenceImagesFor(data).every(r =>
      typeof r.key === "string" && /^videos\/[a-zA-Z0-9_-]+\/references\/[0-2]\.png$/.test(r.key) &&
      typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256));
  } catch { return false; }
}

/** Persist this digest in consent so changing order, identity, role or bytes invalidates approval. */
export function referenceDigest(data: VideoJobData): string {
  if (generationMode(data) === "six_references") return sixPlanDigest(data);
  if (!preparedReferencesReady(data)) throw new VideoReferenceInputError("参考图尚未完成准备与校验。");
  return createHash("sha256").update(JSON.stringify({ mode: generationMode(data), refs: referenceImagesFor(data).map(r =>
    ({ assetId: r.assetId, role: r.role, label: r.label, key: r.key, sha256: r.sha256 })) })).digest("hex");
}

/** Free preparation only: no generation dependency or API is available to this function. */
export async function snapshotReferenceImages(refs: VideoReferenceImage[], jobId: string, io: {
  read: (assetId: string) => Promise<Buffer>;
  write: (key: string, bytes: Buffer) => Promise<void>;
}, segmentIndex?: number): Promise<VideoReferenceImage[]> {
  if (!idPattern.test(jobId)) throw new VideoReferenceInputError("任务标识无效。");
  if (segmentIndex === undefined) referenceImagesFor({ ...emptyVideoData(), generationMode: "direct_references", referenceImages: refs });
  else parseSixReferences(refs.map(r => ({ asset_id: r.assetId, role: r.role, label: r.label })));
  const normalized: Buffer[] = [];
  for (const ref of refs) {
    const bytes = await io.read(ref.assetId);
    if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new VideoReferenceInputError("参考图片为空或超过 30MB。");
    try {
      normalized.push(await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).rotate()
        .resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png().toBuffer());
    } catch { throw new VideoReferenceInputError("参考图片无法解码，请更换清晰有效的图片。"); }
  }
  const result: VideoReferenceImage[] = [];
  for (let i = 0; i < refs.length; i++) {
    const key = `videos/${jobId}/${segmentIndex === undefined ? "" : `segments/${segmentIndex}/`}references/${i}.png`;
    await io.write(key, normalized[i]);
    result.push({ assetId: refs[i].assetId, role: refs[i].role, label: refs[i].label, key,
      sha256: createHash("sha256").update(normalized[i]).digest("hex") });
  }
  return result;
}

export function referenceVideoDirection(refs: VideoReferenceImage[], instructions: string): string {
  const descriptions = refs.map((r, i) => {
    const purpose = r.role === "product" || r.role === "product_detail"
      ? "product appearance and construction; preserve the user's confirmed structure and dressing method"
      : r.role === "scene" ? "scene appearance, materials, color and lighting"
      : "the specified character's identity and appearance, including visible hands and clothing";
    return `Picture ${i + 1} (${r.role}, ${r.label}): ${purpose}.`;
  }).join("\n");
  return `${descriptions}\nVideo 1 is the motion and timing reference: preserve the source sequence, actual contact, before/contact/after states and camera movement. Preserve source scene details unless a supplied reference or the user's instructions changes them. Replace only the corresponding referenced people and product; keep each character assigned to its label, without merging identities. Reference pictures define appearance, not still shots to display or required starting/ending states. Do not skip, reverse or replace required operations with a completed-pose shot. Keep natural continuous motion and hand/fabric contact. No added lettering or logos. Generated audio is not used in the final assembly.\nUser-confirmed requirements:\n${instructions.trim()}`;
}
