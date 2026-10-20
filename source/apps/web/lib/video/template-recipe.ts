import { createHash } from "node:crypto";
import { parseSixReferencePlan } from "./six-reference-plan";
import type { VideoJobData, VideoReferenceImage } from "./types";
import type { VideoTemplateCreatePayload } from "./template-contracts";

export class TemplateRecipeError extends Error {
  constructor(public code: string) { super(code); }
}
const bad = (code: string): never => { throw new TemplateRecipeError(code); };
const ref = (value: VideoReferenceImage) => ({ asset_id: value.assetId, role: value.role, label: value.label });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Rebuild from an allowlist. Runtime keys, accepted frames and authorizations never enter a recipe. */
export function cleanTemplateRecipe(input: { source_asset_id: string; product_asset_id: string; title: string;
  instructions: string; preserve_audio: boolean; data: VideoJobData }): VideoTemplateCreatePayload {
  const data = input.data;
  if (data.generationMode !== "six_references" || data.workflowProfile !== "sixref-v1") return bad("template_mode_unsupported");
  if (!data.referenceImages || !data.segments.length) return bad("template_recipe_invalid");
  const payload: VideoTemplateCreatePayload = {
    source_asset_id: input.source_asset_id, product_asset_id: input.product_asset_id,
    title: input.title, instructions: input.instructions, preserve_audio: input.preserve_audio,
    generation_mode: "six_references", reference_assets: data.referenceImages.map(ref),
    segment_plan: data.segments.map((s) => {
      if (!s.sourceWindowDuration || !s.instructions || !s.beforeState || !s.afterState || !s.referenceImages) return bad("template_recipe_invalid");
      return { start: s.start, source_duration: s.sourceWindowDuration, duration: s.duration,
        instructions: s.instructions, before_state: s.beforeState, after_state: s.afterState,
        reference_assets: s.referenceImages.map(ref),
        ...(s.startFromSegment === undefined ? {} : { start_from_segment: s.startFromSegment }) };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 128 * 1024 || payload.title.length > 80 || payload.instructions.length > 2000) return bad("template_recipe_invalid");
  try {
    const parsed = parseSixReferencePlan(payload as unknown as Record<string, unknown>);
    if (parsed.segments.length !== data.segments.length || parsed.segments.some((s, i) =>
      s.start !== data.segments[i].start || s.duration !== data.segments[i].duration ||
      s.sourceWindowDuration !== data.segments[i].sourceWindowDuration || s.startFromSegment !== data.segments[i].startFromSegment)) return bad("template_recipe_invalid");
  } catch { return bad("template_recipe_invalid"); }
  return payload;
}

export function templateStructureSignature(payload: VideoTemplateCreatePayload, sourceSha256: string): string {
  return hash({ source: sourceSha256, workflow: "sixref-v1", preserve_audio: payload.preserve_audio,
    reference_roles: payload.reference_assets.map(r => r.role),
    segments: payload.segment_plan.map(s => ({ start: s.start, source_duration: s.source_duration, duration: s.duration,
      start_from_segment: s.start_from_segment ?? null, reference_roles: s.reference_assets.map(r => r.role) })) });
}

export function validateTemplateReuse(saved: VideoTemplateCreatePayload, proposed: Record<string, unknown>, sourceSha256: string, expectedSignature: string): boolean {
  if (proposed.generation_mode !== "six_references" || typeof proposed.source_asset_id !== "string") return false;
  try {
    const parsed = parseSixReferencePlan(proposed);
    const recipe = cleanTemplateRecipe({ source_asset_id: proposed.source_asset_id, product_asset_id: String(proposed.product_asset_id ?? ""),
      title: String(proposed.title ?? ""), instructions: String(proposed.instructions ?? ""),
      preserve_audio: proposed.preserve_audio === undefined ? true : proposed.preserve_audio === true, data: parsed });
    return sourceSha256.length === 64 && templateStructureSignature(recipe, sourceSha256) === expectedSignature &&
      templateStructureSignature(saved, sourceSha256) === expectedSignature;
  } catch { return false; }
}
