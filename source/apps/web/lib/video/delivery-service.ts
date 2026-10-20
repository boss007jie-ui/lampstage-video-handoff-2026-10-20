import { allReferenceImages } from "./six-reference-plan";
import type { CharacterReference } from "../characters/contracts";
import { prisma } from "../db";
import type { PrismaClient } from "@prisma/client";
import { videoData } from "./types";
import { privateMediaUrl } from "./storage";
import type { VideoDelivery, VideoFeedbackDecision } from "./template-contracts";

const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const mediaPath = (id: string, kind: "source" | "output" | "candidate", segment?: number, download = false) =>
  `/api/account/video-jobs/${encodeURIComponent(id)}/media?kind=${kind}${segment === undefined ? "" : `&segment=${segment}`}${download ? "&download=1" : ""}`;
export async function getVideoDelivery(userId: string, jobId: string, db: PrismaClient = prisma): Promise<{ ok: true; value: VideoDelivery } | { ok: false; status: 404; body: { error: "not_found" } }> {
  const job = await db.videoJob.findFirst({ where: { id: jobId, user_id: userId }, include: { source_asset: true } });
  if (!job) return { ok: false, status: 404, body: { error: "not_found" } };
  const data = videoData(job.data);
  const outputSha = sha(data.outputSha256) && data.outputKey ? data.outputSha256 : null;
  const completed = job.status === "completed" && outputSha !== null && data.segments.length > 0 &&
    data.segments.every(s => s.accepted && s.candidateKey && sha(s.candidateSha256)) &&
    job.lease_owner === null && job.lease_until === null;
  const signed = async (key: string | undefined, mime: string, fallback: string, filename?: string) =>
    key ? (await privateMediaUrl(key, mime, filename).catch(() => null)) ?? fallback : fallback;
  const output = outputSha && data.outputKey ? { url: await signed(data.outputKey, "video/mp4", mediaPath(jobId, "output")),
    download_url: await signed(data.outputKey, "video/mp4", mediaPath(jobId, "output", undefined, true), `lampstage-${job.id}.mp4`),
    sha256: outputSha, media: data.outputMedia ?? null } : null;
  const segments = await Promise.all(data.segments.map(async s => ({ index: s.index, accepted: Boolean(s.accepted),
    url: s.candidateKey ? await signed(s.candidateKey, "video/mp4", mediaPath(jobId, "candidate", s.index)) : null,
    download_url: s.candidateKey ? await signed(s.candidateKey, "video/mp4", mediaPath(jobId, "candidate", s.index, true), `lampstage-${job.id}-segment-${s.index + 1}.mp4`) : null,
    sha256: sha(s.candidateSha256) ? s.candidateSha256 : null, media: s.candidateMedia ?? null })));
  const latest = outputSha ? await db.videoJobFeedback.findFirst({ where: { job_id: job.id, user_id: userId, output_sha256: outputSha } }) : null;
  const originals = allReferenceImages(data).filter(r => r.role === "character");
  const assets = originals.length ? await db.uploadedAsset.findMany({ where: { user_id: userId, id: { in: originals.map(r => r.assetId) } }, include: { image_content: true } }) : [];
  const bindings = originals.length ? await db.videoJobCharacterBinding.findMany({ where: { job_id: job.id, character_version: { character: { user_id: userId } } },
    include: { character_version: { include: { images: true } } } }) : [];
  const character_references: CharacterReference[] = [];
  for (const ref of originals) {
    if (character_references.some(r => r.asset_id === ref.assetId)) continue;
    const asset = assets.find(a => a.id === ref.assetId); if (!asset) continue;
    const pin = bindings.find(b => b.character_version.images.some(i => i.position === b.image_index && i.asset_id === asset.id));
    character_references.push({ asset_id: asset.id, label: ref.label, image_url: asset.image_url, sha256: asset.image_content?.sha256 ?? null,
      ...(pin ? { character_id: pin.character_version.character_id, character_version_id: pin.character_version_id, image_index: pin.image_index } : {}) });
  }
  return { ok: true, value: { job_id: job.id, title: job.title, status: job.status, output_sha256: outputSha,
    output, source: { url: await signed(job.source_asset.storage_key, job.source_asset.mime, mediaPath(jobId, "source")),
      sha256: job.source_asset.sha256, duration: data.sourceDuration ?? null }, segments,
    feedback: latest ? { decision: latest.decision as VideoFeedbackDecision, notes: latest.notes,
      template_id: latest.template_id, template_version_id: latest.template_version_id } : null,
    character_references, can_feedback: completed, template_save_supported: completed && data.generationMode === "six_references" && data.workflowProfile === "sixref-v1" } };
}
