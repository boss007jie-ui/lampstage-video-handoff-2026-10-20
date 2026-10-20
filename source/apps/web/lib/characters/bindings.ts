import type { Prisma } from "@prisma/client";
import type { VideoJobData } from "../video/types";
import type { VideoTemplateCreatePayload } from "../video/template-contracts";
import type { CharacterBindingDisplay } from "./contracts";

export class CharacterBindingError extends Error { constructor(public code: string, public status = 400) { super(code); } }
const bad = (code = "invalid_character_binding", status = 400): never => { throw new CharacterBindingError(code, status); };
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export type CharacterSlotSelection = { segment_index: number; reference_index: number; asset_id: string;
  character_version_id: string | null; image_index?: number };
export type CharacterSlotPin = { segment_index: number; reference_index: number; character_version_id: string; image_index: number };
/** Called before the legacy parser strips public fields into the established three-field runtime shape. */
export function validateReferenceBinding(raw: Record<string, unknown>, mode: string) {
  if (Object.keys(raw).some(k => !["asset_id", "role", "label", "character_version_id", "image_index"].includes(k))) return bad();
  const hasVersion = Object.prototype.hasOwnProperty.call(raw, "character_version_id");
  const hasIndex = Object.prototype.hasOwnProperty.call(raw, "image_index");
  if (!hasVersion && !hasIndex) return;
  if (mode !== "six_references") return bad("character_binding_mode_unsupported");
  if (!hasVersion || raw.role !== "character") return bad();
  if (raw.character_version_id === null) { if (hasIndex) return bad(); return; }
  if (!id(raw.character_version_id) || !Number.isInteger(raw.image_index) || (raw.image_index as number) < 0 || (raw.image_index as number) > 5) return bad();
}
export function extractCharacterBindings(body: Record<string, unknown>): CharacterSlotSelection[] {
  const result: CharacterSlotSelection[] = [];
  const mode = String(body.generation_mode ?? "legacy_frames");
  const visit = (refs: unknown, segment_index: number) => {
    if (!Array.isArray(refs)) return;
    refs.forEach((value, reference_index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
      const r = value as Record<string, unknown>;
      validateReferenceBinding(r, mode);
      if (Object.prototype.hasOwnProperty.call(r, "character_version_id")) {
        if (!id(r.asset_id)) return bad();
        result.push({ segment_index, reference_index, asset_id: r.asset_id, character_version_id: r.character_version_id as string | null,
          ...(r.image_index === undefined ? {} : { image_index: r.image_index as number }) });
      }
    });
  };
  visit(body.reference_assets, -1);
  if (Array.isArray(body.segment_plan)) body.segment_plan.forEach((segment, index) => {
    if (segment && typeof segment === "object") visit(segment.reference_assets ?? body.reference_assets, index);
  });
  return result;
}
export function requireTemplateBindingSelections(pins: CharacterSlotPin[], selections: CharacterSlotSelection[]) {
  for (const pin of pins) if (!selections.some(s => s.segment_index === pin.segment_index && s.reference_index === pin.reference_index))
    return bad("character_binding_required", 409);
}
/** Caller holds User lock. Validate slot provenance and immutable image linkage again at insertion. */
export async function validateDraftCharacterBindings(tx: Prisma.TransactionClient, userId: string, data: VideoJobData,
  selections: CharacterSlotSelection[], templatePins: CharacterSlotPin[] = []): Promise<CharacterSlotPin[]> {
  if (selections.length && data.generationMode !== "six_references") return bad("character_binding_mode_unsupported");
  requireTemplateBindingSelections(templatePins, selections);
  const slots = new Set<string>(); const pins: CharacterSlotPin[] = [];
  for (const s of selections) {
    const slot = `${s.segment_index}:${s.reference_index}`;
    if (!Number.isInteger(s.segment_index) || s.segment_index < -1 || !Number.isInteger(s.reference_index) || s.reference_index < 0 || s.reference_index > 5 || slots.has(slot)) return bad();
    slots.add(slot);
    const ref = (s.segment_index === -1 ? data.referenceImages : data.segments[s.segment_index]?.referenceImages)?.[s.reference_index];
    if (!ref || ref.role !== "character" || ref.assetId !== s.asset_id) return bad();
    if (s.character_version_id === null) { if (s.image_index !== undefined) return bad(); continue; }
    if (!id(s.character_version_id) || !Number.isInteger(s.image_index) || s.image_index! < 0 || s.image_index! > 5) return bad();
    const version = await tx.characterVersion.findFirst({ where: { id: s.character_version_id, character: { user_id: userId } },
      include: { character: true, images: { where: { position: s.image_index }, include: { asset: true, image_content: true } } } });
    const image = version?.images[0];
    if (!version || !image || image.asset_id !== s.asset_id || image.asset.user_id !== userId ||
      image.image_content.user_id !== userId || image.asset.image_content_id !== image.image_content_id) return bad("character_image_mismatch");
    if (version.character.archived && !templatePins.some(p => p.segment_index === s.segment_index && p.reference_index === s.reference_index &&
      p.character_version_id === s.character_version_id && p.image_index === s.image_index)) return bad("character_archived", 409);
    pins.push({ segment_index: s.segment_index, reference_index: s.reference_index,
      character_version_id: s.character_version_id, image_index: s.image_index! });
  }
  return pins;
}
type CanonicalRef = { role: string; label: string; asset_id?: string; character_version_id?: string; image_index?: number };
type CanonicalRecipe = Omit<VideoTemplateCreatePayload, "reference_assets" | "segment_plan"> & {
  reference_assets: CanonicalRef[];
  segment_plan: Array<Omit<VideoTemplateCreatePayload["segment_plan"][number], "reference_assets"> & { reference_assets: CanonicalRef[] }>;
};
function slot(recipe: CanonicalRecipe, pin: CharacterSlotPin) {
  return (pin.segment_index === -1 ? recipe.reference_assets : recipe.segment_plan[pin.segment_index]?.reference_assets)?.[pin.reference_index];
}
export function canonicalCharacterRecipe(recipe: VideoTemplateCreatePayload, pins: CharacterSlotPin[]): CanonicalRecipe {
  const cleanRef = ({ asset_id, role, label }: VideoTemplateCreatePayload["reference_assets"][number]): CanonicalRef => ({ asset_id, role, label });
  const canonical: CanonicalRecipe = { ...structuredClone(recipe), reference_assets: recipe.reference_assets.map(cleanRef),
    segment_plan: recipe.segment_plan.map(s => ({ ...structuredClone(s), reference_assets: s.reference_assets.map(cleanRef) })) };
  for (const pin of pins) {
    const ref = slot(canonical, pin);
    if (!ref || ref.role !== "character") return bad("template_character_binding_invalid", 409);
    delete ref.asset_id;
    ref.character_version_id = pin.character_version_id; ref.image_index = pin.image_index;
  }
  return canonical;
}
export async function resolveCharacterRecipe(tx: Prisma.TransactionClient, userId: string, version: {
  id: string; recipe_schema_version: number; create_payload: Prisma.JsonValue }) {
  if (![1, 2].includes(version.recipe_schema_version)) return bad("template_schema_unsupported", 409);
  const recipe = structuredClone(version.create_payload) as unknown as CanonicalRecipe;
  if (version.recipe_schema_version === 1) return { create_payload: recipe as VideoTemplateCreatePayload, character_bindings: [] as CharacterBindingDisplay[] };
  const pins = await tx.videoTemplateCharacterBinding.findMany({ where: { template_version_id: version.id },
    orderBy: [{ segment_index: "asc" }, { reference_index: "asc" }], include: { character_version: {
      include: { character: true, images: { include: { asset: true, image_content: true } } } } } });
  if (!pins.length || !Array.isArray(recipe.reference_assets) || !Array.isArray(recipe.segment_plan)) return bad("template_character_binding_invalid", 409);
  const found = new Set<string>(); const displays: CharacterBindingDisplay[] = [];
  for (const pin of pins) {
    const ref = slot(recipe, pin), version = pin.character_version, character = version.character;
    const image = version.images.find(i => i.position === pin.image_index);
    if (!ref || ref.role !== "character" || ref.asset_id !== undefined || ref.character_version_id !== version.id || ref.image_index !== pin.image_index ||
      character.user_id !== userId || !image || image.asset.user_id !== userId || image.image_content.user_id !== userId || image.asset.image_content_id !== image.image_content_id)
      return bad("template_character_binding_invalid", 409);
    ref.asset_id = image.asset_id; found.add(`${pin.segment_index}:${pin.reference_index}`);
    displays.push({ segment_index: pin.segment_index, reference_index: pin.reference_index, character_id: character.id,
      code: character.code, name: character.name, character_version_id: version.id, version: version.version, image_index: pin.image_index });
  }
  const refs = [{ index: -1, refs: recipe.reference_assets }, ...recipe.segment_plan.map((s, index) => ({ index, refs: s.reference_assets }))];
  for (const group of refs) group.refs.forEach((ref, i) => {
    if ((ref.character_version_id !== undefined || ref.image_index !== undefined) && !found.has(`${group.index}:${i}`)) return bad("template_character_binding_invalid", 409);
  });
  return { create_payload: recipe as VideoTemplateCreatePayload, character_bindings: displays };
}

/** Fixed job associations are authoritative; neither a profile's latest version nor its archive flag changes an existing job. */
export async function loadJobCharacterImageHashes(tx: Prisma.TransactionClient, userId: string, jobId: string, data: VideoJobData) {
  const pins = await tx.videoJobCharacterBinding.findMany({ where: { job_id: jobId }, include: { character_version: {
    include: { character: true, images: { include: { asset: true, image_content: true } } } } } });
  const hashes = new Map<string, string>();
  for (const pin of pins) {
    const ref = (pin.segment_index === -1 ? data.referenceImages : data.segments[pin.segment_index]?.referenceImages)?.[pin.reference_index];
    const version = pin.character_version, image = version.images.find(i => i.position === pin.image_index);
    if (data.generationMode !== "six_references" || !ref || ref.role !== "character" || !image || ref.assetId !== image.asset_id ||
      version.character.user_id !== userId || image.asset.user_id !== userId || image.image_content.user_id !== userId ||
      image.asset.image_content_id !== image.image_content_id || !/^[a-f0-9]{64}$/.test(image.image_content.sha256))
      return bad("character_image_mismatch", 409);
    const existing = hashes.get(ref.assetId);
    if (existing && existing !== image.image_content.sha256) return bad("character_image_mismatch", 409);
    hashes.set(ref.assetId, image.image_content.sha256);
  }
  return hashes;
}
