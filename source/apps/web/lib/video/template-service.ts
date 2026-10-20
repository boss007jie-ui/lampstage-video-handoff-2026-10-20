import { canonicalCharacterRecipe, resolveCharacterRecipe, CharacterBindingError } from "../characters/bindings";
import { Prisma, type PrismaClient, type VideoTemplate, type VideoJobFeedback } from "@prisma/client";
import { prisma } from "../db";
import { videoData } from "./types";
import type { VideoFeedbackDecision, VideoTemplateCreatePayload, VideoTemplateDetail, VideoTemplateSummary } from "./template-contracts";
import { cleanTemplateRecipe, templateStructureSignature, TemplateRecipeError } from "./template-recipe";
import { ensureVideoAssetSha256 } from "./asset-hash";
import { privateMediaUrl } from "./storage";

type Result<T> = { ok: true; value: T } | { ok: false; status: number; body: { error: string } };
const fail = (status: number, error: string): Result<never> => ({ ok: false, status, body: { error } });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const field = (value: unknown, max: number, required = false): string | null =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && (!required || value.trim().length > 0) ? value.trim() : null;
const notesField = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.trim() : null;
type SummaryRow = VideoTemplate & { versions?: { source_job: { id: string; data: Prisma.JsonValue;
  source_asset: { storage_key: string; mime: string } } }[] };
async function summary(row: SummaryRow): Promise<VideoTemplateSummary> {
  const sourceData = row.versions?.[0] ? videoData(row.versions[0].source_job.data) : null;
  const sourceJob = row.versions?.[0]?.source_job;
  const sourceFallback = sourceJob ? `/api/account/video-jobs/${encodeURIComponent(sourceJob.id)}/media?kind=source` : null;
  const previewFallback = sourceJob && sourceData?.outputKey ? `/api/account/video-jobs/${encodeURIComponent(sourceJob.id)}/media?kind=output` : null;
  return { id: row.id, code: row.code, name: row.name, category: row.category, archived: row.archived,
    latest_version_id: row.latest_version_id ?? "", version_count: row.version_count,
    source_asset_id: row.source_asset_id, source_sha256: row.source_sha256, source_duration: row.source_duration,
    thumbnail_url: null,
    source_url: sourceJob ? (await privateMediaUrl(sourceJob.source_asset.storage_key, sourceJob.source_asset.mime)) ?? sourceFallback : null,
    preview_url: sourceData?.outputKey ? (await privateMediaUrl(sourceData.outputKey, "video/mp4")) ?? previewFallback : null,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}
const includeLatest = { versions: { orderBy: { version: "desc" as const }, take: 1, include: { source_job: {
  select: { id: true, data: true, source_asset: { select: { storage_key: true, mime: true } } } } } } };
function cursorDecode(raw: string | undefined): { created_at: Date; id: string } | null {
  if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try { const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (c.v !== 1 || !id(c.id) || typeof c.created_at !== "string" || new Date(c.created_at).toISOString() !== c.created_at) return null;
    return { id: c.id, created_at: new Date(c.created_at) };
  } catch { return null; }
}
export async function listVideoTemplates(userId: string, query: { status?: string; source_asset_id?: string; source_sha256?: string; limit?: string; cursor?: string }, db: PrismaClient = prisma): Promise<Result<{ templates: VideoTemplateSummary[]; next_cursor: string | null }>> {
  const status = query.status ?? "active";
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!["active", "archived", "all"].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 50 ||
    (query.limit !== undefined && !/^\d+$/.test(query.limit)) || (query.source_asset_id !== undefined && !id(query.source_asset_id)) ||
    (query.source_sha256 !== undefined && !sha(query.source_sha256))) return fail(400, "invalid_video_template_query");
  const cursor = query.cursor === undefined ? null : cursorDecode(query.cursor);
  if (query.cursor !== undefined && !cursor) return fail(400, "invalid_video_template_cursor");
  const source = query.source_asset_id ? await db.videoAsset.findFirst({ where: { id: query.source_asset_id, user_id: userId },
    select: { id: true, sha256: true } }) : null;
  if (query.source_asset_id && !source) return fail(404, "not_found");
  const rows = await db.videoTemplate.findMany({ where: { user_id: userId,
    ...(status === "all" ? {} : { archived: status === "archived" }),
    ...(source ? { OR: source.sha256 ? [{ source_asset_id: source.id }, { source_sha256: source.sha256 }] : [{ source_asset_id: source.id }] } : {}),
    ...(query.source_sha256 ? { source_sha256: query.source_sha256 } : {}),
    ...(cursor ? { AND: [{ OR: [{ created_at: { lt: cursor.created_at } }, { created_at: cursor.created_at, id: { lt: cursor.id } }] }] } : {}) },
    orderBy: [{ created_at: "desc" }, { id: "desc" }], take: limit + 1, include: includeLatest });
  const page = rows.slice(0, limit); const last = page[page.length - 1];
  return ok({ templates: await Promise.all(page.map(summary)), next_cursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ v: 1, created_at: last.created_at.toISOString(), id: last.id })).toString("base64url") : null });
}
export async function getVideoTemplate(userId: string, templateId: string, versionId?: string, db: PrismaClient = prisma): Promise<Result<VideoTemplateDetail>> {
  if (!id(templateId) || (versionId !== undefined && !id(versionId))) return fail(404, "not_found");
  const row = await db.videoTemplate.findFirst({ where: { id: templateId, user_id: userId }, include: {
    versions: { orderBy: { version: "desc" }, include: { source_job: {
      select: { id: true, data: true, source_asset: { select: { storage_key: true, mime: true } } } } } } } });
  if (!row) return fail(404, "not_found");
  const chosen = versionId ? row.versions.find(v => v.id === versionId) : row.versions[0];
  if (!chosen || ![1, 2].includes(chosen.recipe_schema_version) || chosen.workflow_profile !== "sixref-v1") return fail(404, "not_found");
  let resolved;
  try { resolved = await resolveCharacterRecipe(db, userId, chosen); }
  catch (e) { return fail(e instanceof CharacterBindingError ? e.status : 409, e instanceof CharacterBindingError ? e.code : "template_recipe_invalid"); }
  return ok({ template: await summary({ ...row, versions: row.versions.slice(0, 1) }),
    versions: row.versions.map(v => ({ id: v.id, version: v.version, created_at: v.created_at.toISOString(), source_job_id: v.source_job_id, output_sha256: v.output_sha256 })),
    selected_version: { id: chosen.id, version: chosen.version, source_asset_id: chosen.source_asset_id,
      source_sha256: chosen.source_sha256, output_sha256: chosen.output_sha256,
      workflow_profile: "sixref-v1", recipe_schema_version: chosen.recipe_schema_version as 1 | 2,
      create_payload: resolved.create_payload, character_bindings: resolved.character_bindings } });
}
export async function updateVideoTemplate(userId: string, templateId: string, patch: Record<string, unknown>, db: PrismaClient = prisma): Promise<Result<{ template: VideoTemplateSummary }>> {
  if (!id(templateId) || !patch || typeof patch !== "object" || Array.isArray(patch) ||
    Object.keys(patch).some(k => !["name", "category", "archived"].includes(k)) || !Object.keys(patch).length) return fail(400, "invalid_video_template_update");
  const name = patch.name === undefined ? undefined : field(patch.name, 80, true);
  const category = patch.category === undefined ? undefined : field(patch.category, 40);
  if (name === null || category === null || (patch.archived !== undefined && typeof patch.archived !== "boolean")) return fail(400, "invalid_video_template_update");
  return db.$transaction(async tx => {
    const users = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (!users.length) return fail(404, "not_found");
    const count = await tx.videoTemplate.updateMany({ where: { id: templateId, user_id: userId }, data: {
      ...(name !== undefined ? { name } : {}), ...(category !== undefined ? { category } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived as boolean } : {}) } });
    if (!count.count) return fail(404, "not_found");
    const row = await tx.videoTemplate.findFirst({ where: { id: templateId, user_id: userId }, include: includeLatest });
    return row ? ok({ template: await summary(row) }) : fail(404, "not_found");
  }, { maxWait: 15000, timeout: 15000 });
}

export type FeedbackInput = { decision: VideoFeedbackDecision; output_sha256: string; notes?: string; name?: string; category?: string; template_id?: string };
type FeedbackResponse = { feedback: { decision: VideoFeedbackDecision; notes: string; template_id: string | null; template_version_id: string | null };
  template: VideoTemplateSummary | null; version_id: string | null };
export async function submitVideoFeedback(userId: string, jobId: string, input: FeedbackInput, db: PrismaClient = prisma): Promise<Result<FeedbackResponse>> {
  if (!id(jobId) || !["satisfied_save_template", "satisfied", "needs_changes"].includes(input.decision) || !sha(input.output_sha256) ||
    (input.notes !== undefined && notesField(input.notes) === null) ||
    (input.name !== undefined && field(input.name, 80) === null) ||
    (input.category !== undefined && field(input.category, 40) === null) ||
    (input.template_id !== undefined && (!id(input.template_id) || input.decision !== "satisfied_save_template"))) return fail(400, "invalid_video_feedback");
  const preliminary = await db.videoJob.findFirst({ where: { id: jobId, user_id: userId }, select: { source_asset_id: true } });
  if (!preliminary) return fail(404, "not_found");
  if (input.decision === "satisfied_save_template") {
    const current = await db.videoJob.findFirst({ where: { id: jobId, user_id: userId }, select: {
      status: true, lease_owner: true, lease_until: true, data: true } });
    const currentData = videoData(current?.data);
    if (!current || current.status !== "completed" || current.lease_owner !== null || current.lease_until !== null ||
      !sha(currentData.outputSha256) || currentData.outputSha256 !== input.output_sha256 || !currentData.outputKey ||
      !currentData.segments.length || currentData.segments.some(s => !s.accepted || !s.candidateKey || !sha(s.candidateSha256)))
      return fail(409, "video_output_changed");
    if (currentData.generationMode !== "six_references" || currentData.workflowProfile !== "sixref-v1")
      return fail(409, "template_mode_unsupported");
  }
  let sourceSha: string | null = null;
  if (input.decision === "satisfied_save_template") {
    try { sourceSha = await ensureVideoAssetSha256(userId, preliminary.source_asset_id, db); }
    catch { return fail(503, "source_hash_unavailable"); }
    if (!sourceSha) return fail(503, "source_hash_unavailable");
  }
  return db.$transaction(async tx => {
    const users = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (!users.length) return fail(404, "not_found");
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoJob" WHERE id = ${jobId} AND user_id = ${userId} FOR UPDATE`;
    if (!locked.length) return fail(404, "not_found");
    const job = await tx.videoJob.findFirst({ where: { id: jobId, user_id: userId } });
    if (!job) return fail(404, "not_found");
    const data = videoData(job.data);
    if (job.status !== "completed" || job.lease_owner !== null || job.lease_until !== null ||
      !sha(data.outputSha256) || !data.outputKey || data.outputSha256 !== input.output_sha256 ||
      !data.segments.length || data.segments.some(s => !s.accepted || !s.candidateKey || !sha(s.candidateSha256))) return fail(409, "video_output_changed");
    let recipe: VideoTemplateCreatePayload | null = null; let signature = "";
    if (input.decision === "satisfied_save_template") {
      try { recipe = cleanTemplateRecipe({ source_asset_id: job.source_asset_id, product_asset_id: job.product_asset_id,
        title: job.title, instructions: job.instructions, preserve_audio: job.preserve_audio, data }); }
      catch (error) { return fail(409, error instanceof TemplateRecipeError ? error.code : "template_recipe_invalid"); }
      signature = templateStructureSignature(recipe, sourceSha!);
      const asset = await tx.videoAsset.findFirst({ where: { id: job.source_asset_id, user_id: userId, sha256: sourceSha } });
      if (!asset) return fail(409, "source_changed");
    }
    const prior = await tx.videoJobFeedback.findUnique({ where: { job_id_output_sha256: { job_id: jobId, output_sha256: input.output_sha256 } } });
    let templateId = prior?.template_id ?? null; let versionId = prior?.template_version_id ?? null;
    if (input.template_id && versionId && input.template_id !== templateId) return fail(409, "template_target_changed");
    if (input.decision === "satisfied_save_template" && !versionId) {
      let template: VideoTemplate | null = null;
      if (input.template_id) {
        template = await tx.videoTemplate.findFirst({ where: { id: input.template_id, user_id: userId, archived: false } });
        if (!template) return fail(404, "not_found");
        if (template.source_sha256 !== sourceSha || template.structure_signature !== signature) return fail(409, "template_structure_mismatch");
      } else {
        const [counter] = await tx.$queryRaw<{ next_code: bigint }[]>`
          SELECT COALESCE(MAX(substring(code from 2)::bigint), 0) + 1 AS next_code
          FROM "VideoTemplate" WHERE user_id = ${userId}`;
        const number = Number(counter.next_code);
        if (!Number.isSafeInteger(number)) return fail(409, "template_code_exhausted");
        const code = `T${String(number).padStart(3, "0")}`;
        const duration = data.sourceDuration ?? data.segments.reduce((n, s) => n + (s.sourceWindowDuration ?? s.duration), 0);
        const prefix = input.category ? `${field(input.category, 40)} · ` : "";
        const suffix = ` ${Math.round(duration)}秒`;
        const name = field(input.name, 80, true) ?? `${prefix}${job.title.slice(0, Math.max(0, 80 - prefix.length - suffix.length))}${suffix}`;
        template = await tx.videoTemplate.create({ data: { user_id: userId, code, name,
          category: field(input.category, 40) ?? "", source_asset_id: job.source_asset_id,
          source_sha256: sourceSha!, source_duration: duration, structure_signature: signature } });
      }
      const characterPins = await tx.videoJobCharacterBinding.findMany({ where: { job_id: job.id },
        select: { segment_index: true, reference_index: true, character_version_id: true, image_index: true } });
      const canonical = canonicalCharacterRecipe(recipe!, characterPins);
      const version = await tx.videoTemplateVersion.create({ data: { template_id: template.id,
        version: template.version_count + 1, source_job_id: jobId, source_asset_id: job.source_asset_id,
        source_sha256: sourceSha!, output_sha256: input.output_sha256,
        workflow_profile: "sixref-v1", recipe_schema_version: characterPins.length ? 2 : 1,
        create_payload: canonical as unknown as Prisma.InputJsonValue, structure_signature: signature } });
      if (characterPins.length) await tx.videoTemplateCharacterBinding.createMany({ data: characterPins.map(pin => ({ template_version_id: version.id, ...pin })) });
      await tx.videoTemplate.update({ where: { id: template.id }, data: { latest_version_id: version.id, version_count: { increment: 1 } } });
      templateId = template.id; versionId = version.id;
    }
    const notes = notesField(input.notes ?? "")!;
    const feedback: VideoJobFeedback = prior
      ? await tx.videoJobFeedback.update({ where: { id: prior.id }, data: { decision: input.decision, notes, template_id: templateId, template_version_id: versionId } })
      : await tx.videoJobFeedback.create({ data: { user_id: userId, job_id: jobId, output_sha256: input.output_sha256,
        decision: input.decision, notes, template_id: templateId, template_version_id: versionId } });
    const template = templateId ? await tx.videoTemplate.findFirst({ where: { id: templateId, user_id: userId }, include: includeLatest }) : null;
    return ok({ feedback: { decision: feedback.decision as VideoFeedbackDecision, notes: feedback.notes,
      template_id: feedback.template_id, template_version_id: feedback.template_version_id },
      template: template ? await summary(template) : null, version_id: versionId });
  }, { maxWait: 15000, timeout: 15000 });
}
