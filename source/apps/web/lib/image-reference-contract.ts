/** Application request policy, independent of upstream model limits. */
import { APP_MAX_IMAGE_REFERENCES } from "./image-models";
export const IMAGE_REFERENCE_LIMIT = APP_MAX_IMAGE_REFERENCES;
export const IMAGE_REFERENCE_ROLES = ["character", "product", "product_detail", "scene", "start_state", "end_state"] as const;
export type ImageReferenceRole = typeof IMAGE_REFERENCE_ROLES[number];
export type ImageAssetReference = {
  asset_id: string;
  role: ImageReferenceRole;
  label: string;
  character_version_id?: string;
  image_index?: number;
};
export class ImageInputError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
const fail = (code: string): never => { throw new ImageInputError(code); };
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const present = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);

export function imageOutputCount(value: unknown, required = false): number | undefined {
  if (value === undefined && !required) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 4) return fail("bad_image_count");
  return value as number;
}

/** Explicit references replace the entire old single-asset/composition input. Never merge or reorder. */
export function parseImageReferences(body: Record<string, unknown>): ImageAssetReference[] | undefined {
  if (!present(body, "reference_assets")) return undefined;
  if (present(body, "asset_id") || present(body, "uploaded_asset_id")) return fail("ambiguous_image_references");
  if (Object.keys(body).some(key => !["reference_assets", "custom_prompt", "image_count", "image_model", "image_size", "platform_style", "aspect_ratio",
    "scene_kind", "template_id", "recommended_prompt_en"].includes(key))) return fail("bad_image_parameter");
  if (!Array.isArray(body.reference_assets) || body.reference_assets.length < 1 || body.reference_assets.length > IMAGE_REFERENCE_LIMIT)
    return fail("bad_reference_assets");
  if ((present(body, "scene_kind") && body.scene_kind !== "custom") || present(body, "template_id") || present(body, "recommended_prompt_en"))
    return fail("reference_scene_conflict");
  if (typeof body.custom_prompt !== "string" || !body.custom_prompt.trim() || body.custom_prompt.trim().length > 12000)
    return fail("missing_or_invalid_prompt");
  imageOutputCount(body.image_count, true);
  const seen = new Set<string>();
  return body.reference_assets.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("bad_reference_assets");
    const r = value as Record<string, unknown>;
    if (Object.keys(r).some(key => !["asset_id", "role", "label", "character_version_id", "image_index"].includes(key)) ||
      !id(r.asset_id) || !IMAGE_REFERENCE_ROLES.includes(r.role as ImageReferenceRole) ||
      typeof r.label !== "string" || !r.label.trim() || r.label.trim().length > 80 || /[\x00-\x1f\x7f]/.test(r.label)) return fail("bad_reference_assets");
    if (seen.has(r.asset_id)) return fail("duplicate_reference_asset");
    seen.add(r.asset_id);
    const hasVersion = present(r, "character_version_id"), hasIndex = present(r, "image_index");
    if (hasVersion !== hasIndex || (hasVersion && (r.role !== "character" || !id(r.character_version_id) ||
      !Number.isInteger(r.image_index) || (r.image_index as number) < 0 || (r.image_index as number) > 5))) return fail("invalid_character_binding");
    return { asset_id: r.asset_id, role: r.role as ImageReferenceRole, label: r.label.trim(),
      ...(hasVersion ? { character_version_id: r.character_version_id as string, image_index: r.image_index as number } : {}) };
  });
}

/** Return only the public, account-scoped manifest; storage locations and bytes are never exposed. */
export function recordedImageInputs(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const value = metadata as Record<string, unknown>;
  const count = { ...(Number.isInteger(value.image_count) && (value.image_count as number) >= 1 && (value.image_count as number) <= 4
    ? { image_count: value.image_count as number } : {}),
    ...(value.image_size === "2K" && value.image_model === "nano_banana_21" ? { image_size: "2K" as const } : {}) };
  if (value.reference_schema_version !== 1 || !Array.isArray(value.reference_assets)) return count;
  try {
    const raw = value.reference_assets as Array<Record<string, unknown>>;
    const refs = parseImageReferences({ reference_assets: raw.map(r => ({ asset_id: r.asset_id, role: r.role, label: r.label,
      ...(r.character_version_id === undefined ? {} : { character_version_id: r.character_version_id, image_index: r.image_index }) })),
      custom_prompt: "metadata", image_count: 1 })!;
    if (raw.some(r => typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256))) return count;
    return { ...count, reference_schema_version: 1, reference_count: refs.length,
      reference_assets: refs.map((ref, i) => ({ ...ref, sha256: raw[i].sha256 as string })) };
  } catch { return count; }
}

export function buildReferenceImagePrompt(prompt: string, references: ImageAssetReference[], platform: string): string {
  const manifest = references.map((ref, index) => `Image ${index + 1}: role=${ref.role}; label=${JSON.stringify(ref.label)}.`).join("\n");
  return `Create one coherent image following the user's instructions and the ordered reference manifest below.
Each Image number identifies exactly one attached image in the same order. Use each image only for its assigned role. Keep different characters distinct; preserve each character's identity and each product's appearance. Scene references guide the environment. Product-detail references guide the corresponding product details. Start/end-state references guide the depicted state. Do not treat the first image as a product by default. Do not create a reference-sheet collage unless requested.

Ordered reference manifest:
${manifest}

User instructions:
${prompt.trim()}

${platform === "brand_site" ? "Use polished editorial composition suitable for a brand website." : "Use clear, well-composed campaign imagery suitable for e-commerce."}
Render at 1:1 square aspect ratio. Keep lighting, perspective, proportions and shadows coherent. Avoid unrequested text and watermarks.`;
}
