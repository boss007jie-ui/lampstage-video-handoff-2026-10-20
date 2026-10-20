import type { Prisma, VideoJob } from "@prisma/client";
import { prisma } from "../db";
import { consumeVideoCallCredits } from "../credits";
import { videoMaintenanceReason } from "../video/control";
import { privateStorageReady } from "../video/storage";
import { videoData, VIDEO_JOB_LIMIT } from "../video/types";
import { callIdentity, callBillingPolicy, inputDigest, isSingleCallJob, VideoCallError, type CallInput, type SingleCall } from "./contract";
import { inspectCallAssets } from "./assets";

export function callView(job: VideoJob) {
  const call = videoData(job.data).singleCall;
  if (!call || call.version !== 1 || call.kind !== "single_call") throw new VideoCallError("not_found", 404);
  return { id: job.id, kind: "single_call", request_id: call.request_id, status: job.status, stage: job.stage, error: job.error,
    created_at: job.created_at.toISOString(), updated_at: job.updated_at.toISOString(),
    quote: { credits: call.quote_credits, unit: "platform_credits", billing_mode: call.billing.mode },
    billing: { charged_credits: call.billing.charged_credits, refunded_credits: call.billing.refunded_credits,
      debit_id: call.billing.debit_id ?? null, refund_id: call.billing.refund_id ?? null,
      supplier_cost: null, supplier_cost_status: "unknown" },
    provider_receipt: { supplier: "runninghub",
      task_id: call.provider_task_id && /^[A-Za-z0-9_-]{1,128}$/.test(call.provider_task_id) ? call.provider_task_id : null,
      submitted_at: call.submission_intent_at ?? null },
    motion_asset: { asset_id: call.motion.asset_id, sha256: call.motion.sha256 },
    reference_assets: call.references.map((r, i) => ({ picture: i + 1, asset_id: r.asset_id, role: r.role, label: r.label, sha256: r.sha256 })),
    output_url: call.output ? `/api/v1/video-calls/${encodeURIComponent(job.id)}/output` : null,
    output_sha256: call.output?.sha256 ?? null,
    output_media: call.output ? { duration: call.output.duration, width: call.output.width, height: call.output.height } : null,
  };
}
export async function callAvailability(creditsUnlimited = false) {
  const { credits } = callBillingPolicy(creditsUnlimited);
  const reasons: string[] = [];
  if (credits === null) reasons.push("single_call_price_unconfigured");
  if (videoMaintenanceReason()) reasons.push("video_generation_paused");
  if (!privateStorageReady()) reasons.push("private_storage_unavailable");
  const worker = await prisma.videoWorker.findFirst({ where: { id: { startsWith: "video-single-call-v1-" }, heartbeat_at: { gt: new Date(Date.now() - 60_000) }, sixref_ready: true } });
  if (!worker) reasons.push("single_call_worker_unavailable");
  return { available: reasons.length === 0, reasons, quote: credits === null ? null : { credits, unit: "platform_credits" as const } };
}
export async function previewVideoCall(userId: string, input: CallInput) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { credits_unlimited: true } });
  if (!user) throw new VideoCallError("not_found", 404);
  const availability = await callAvailability(user.credits_unlimited);
  try {
    const assets = await inspectCallAssets(userId, input);
    return { ...availability, billing_mode: user.credits_unlimited ? "internal_test" : "standard", charged_credits: 0,
      supplier_cost: null, supplier_cost_status: "unknown", duration: input.duration,
      motion_asset: { asset_id: assets.motion.asset_id, sha256: assets.motion.sha256, duration: assets.media.duration },
      reference_assets: assets.references.map((r, i) => ({ picture: i + 1, asset_id: r.asset_id, sha256: r.sha256, role: r.role, label: r.label })) };
  } catch (error) {
    if (error instanceof VideoCallError) return { ...availability, available: false, reasons: [...availability.reasons, error.code], billing_mode: user.credits_unlimited ? "internal_test" : "standard", charged_credits: 0, supplier_cost: null, supplier_cost_status: "unknown" };
    throw error;
  }
}
export function matchExistingCall(job: VideoJob, digest: string) {
  if (!isSingleCallJob(job.data) || job.data.singleCall?.input_digest !== digest) throw new VideoCallError("request_id_conflict", 409);
  return job;
}
/** 用户行锁串行化同键竞争；扣款、账本、受理意图在同一事务中提交。 */
export async function acceptVideoCall(tx: Prisma.TransactionClient, userId: string, id: string, call: SingleCall) {
  const users = await tx.$queryRaw<{ credits_unlimited: boolean }[]>`SELECT "credits_unlimited" FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const existing = await tx.videoJob.findFirst({ where: { id, user_id: userId } });
  if (existing) return { job: matchExistingCall(existing, call.input_digest), reused: true };
  if (!users.length) throw new VideoCallError("not_found", 404);
  if (users[0].credits_unlimited) call.quote_credits = 0;
  else if (call.billing.mode !== "standard" || !Number.isSafeInteger(call.quote_credits) || call.quote_credits <= 0) throw new VideoCallError("authorization_changed", 409);
  if (call.quote_credits > call.max_credits) throw new VideoCallError("max_credits_exceeded", 409);
  const count = await tx.videoJob.count({ where: { user_id: userId, status: { in: ["draft", "queued", "preparing", "review", "generating", "assembling", "attention"] } } });
  if (count >= VIDEO_JOB_LIMIT) throw new VideoCallError("video_job_limit", 409);
  const debit = await consumeVideoCallCredits(tx, userId, id, call.quote_credits);
  call.billing = { mode: debit.billingMode, charged_credits: debit.chargedCredits, refunded_credits: 0, ...(debit.transactionId ? { debit_id: debit.transactionId } : {}) };
  // 旧部署的 generationMode 解析器会拒绝该独立模式，不能把它解释为 legacy_frames。
  const data = { version: 1, generationMode: "single_call", imageCalls: 0, segments: [{ index: 0, start: 0, duration: call.input.duration, trimStart: 0, attempt: 0 }], singleCall: call };
  const job = await tx.videoJob.create({ data: { id, user_id: userId, source_asset_id: call.motion.asset_id, product_asset_id: call.references[0].asset_id,
    title: "单次视频模型调用", instructions: call.input.prompt, preserve_audio: false, status: "queued", phase: "render", stage: "等待单次视频生成",
    data: data as unknown as Prisma.InputJsonValue } });
  return { job, reused: false };
}
export async function createVideoCall(userId: string, input: CallInput) {
  const id = callIdentity(userId, input.request_id!);
  const digest = inputDigest(input);
  const existing = await prisma.videoJob.findFirst({ where: { id, user_id: userId } });
  if (existing) return { job: matchExistingCall(existing, digest), reused: true };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { credits_unlimited: true } });
  if (!user) throw new VideoCallError("not_found", 404);
  const readiness = await callAvailability(user.credits_unlimited);
  if (!readiness.available || !readiness.quote) throw new VideoCallError(readiness.reasons[0] ?? "unavailable", 503);
  if (readiness.quote.credits > input.max_credits!) throw new VideoCallError("max_credits_exceeded", 409);
  const assets = await inspectCallAssets(userId, input, id);
  const call: SingleCall = { version: 1, kind: "single_call", request_id: input.request_id!, input_digest: digest, input,
    motion: assets.motion, references: assets.references, quote_credits: readiness.quote.credits, max_credits: input.max_credits!,
    billing: { mode: user.credits_unlimited ? "internal_test" : "standard", charged_credits: 0, refunded_credits: 0 } };
  return prisma.$transaction(tx => acceptVideoCall(tx, userId, id, call), { maxWait: 15_000, timeout: 15_000 });
}
