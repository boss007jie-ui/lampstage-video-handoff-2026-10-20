import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { privateStorageReady } from "./storage";
import { videoMaintenanceReason, videoWorkerPaused } from "./control";
import { VIDEO_MAX_BYTES, VIDEO_MAX_SECONDS, VIDEO_MIN_SECONDS, segmentCoinQuote, type VideoCapabilities, type VideoGenerationMode } from "./types";

export class VideoHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function betaEligible(user: { role: string; email: string | null } | null): boolean {
  if (!user) return false;
  const emails = `${process.env.VIDEO_BETA_EMAILS || ""},${process.env.ADMIN_EMAILS || ""}`.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  return user.role === "ADMIN" || Boolean(user.email && emails.includes(user.email.toLowerCase()));
}
export async function requireVideoUser(request?: NextRequest) {
  if (request && !["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    // Next dev can normalize nextUrl to localhost while the browser uses 127.0.0.1.
    // Host is the actual browser-facing destination and cannot be set by a cross-origin browser request.
    const expectedOrigin = `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`;
    if (origin && origin !== expectedOrigin) throw new VideoHttpError(403, "请求来源无效，请刷新页面。");
  }
  const user = await getCurrentUser();
  if (!user) throw new VideoHttpError(401, "请先登录。");
  if (!betaEligible(user)) throw new VideoHttpError(403, "视频生成正在内测，请联系管理员开通。");
  return user;
}
export async function workerState() {
  return prisma.videoWorker.findFirst({ where: { heartbeat_at: { gt: new Date(Date.now() - 60000) } }, orderBy: { heartbeat_at: "desc" } });
}
export async function requireVideoWorker(video = false, requireImages = true, mode?: VideoGenerationMode) {
  // 运维暂停 / 付费开关关闭时统一在入口拦下：不写意图、不领任务、不产生付费调用。
  const maintenance = videoMaintenanceReason();
  if (maintenance) throw new VideoHttpError(503, maintenance);
  if (!privateStorageReady()) throw new VideoHttpError(503, "私有视频存储尚未配置。");
  const worker = await workerState();
  if (!worker) throw new VideoHttpError(503, "视频处理服务尚未启动，暂时无法提交。");
  if (mode === "six_references" && !worker.sixref_ready) throw new VideoHttpError(503, "六图视频处理服务尚未就绪。");
  if (requireImages && !worker.image_ready) throw new VideoHttpError(503, "原有图片生成工具尚未就绪。");
  if (video && !(mode === "six_references" ? worker.sixref_ready : worker.video_ready)) throw new VideoHttpError(503, "RunningHub 01 视频服务尚未就绪。");
}
export async function videoCapabilities(): Promise<VideoCapabilities> {
  const maintenance = videoMaintenanceReason();
  const paused = videoWorkerPaused() || maintenance !== null;
  const result: VideoCapabilities = { beta: true, signed_in: false, eligible: false, database_ready: false,
    storage_ready: privateStorageReady(), worker_ready: false, image_ready: false, video_ready: false, ready: false, reason: null,
    paused, maintenance,
    limits: { min_seconds: VIDEO_MIN_SECONDS, max_seconds: VIDEO_MAX_SECONDS, max_bytes: VIDEO_MAX_BYTES, aspect_ratio: "9:16", resolution: "768P" },
    pricing: { per_segment_coins: segmentCoinQuote(), pricing_basis: segmentCoinQuote() === null ? "unpriced_technical_cap" as const : "configured_quote" as const, image_billing: "internal_beta" } };
  try {
    const user = await getCurrentUser();
    result.signed_in = Boolean(user); result.eligible = betaEligible(user);
    // A live query checks that the additive video tables have actually been installed.
    const worker = await workerState();
    result.database_ready = true;
    result.worker_ready = Boolean(worker);
    result.image_ready = worker?.image_ready ?? false;
    result.video_ready = worker?.video_ready ?? false;
  } catch { result.reason = "数据库连接或视频数据表尚未就绪。"; }
  // ready 表示"现在真的能跑"：暂停/未开放时即使数据库和密钥都在，也不能显示为可用。
  // ready 表示"现在真的能跑"。单段报价未配置不再算阻塞（未定价模式仍可运行），
  // 但 pricing_basis 会如实告诉调用方"这次没有已定价报价"。
  result.ready = !paused && result.database_ready && result.storage_ready && result.worker_ready && result.image_ready && result.video_ready;
  result.reason ??= paused ? maintenance
    : !result.storage_ready ? "私有视频存储尚未配置。" : !result.worker_ready ? "视频处理服务尚未启动。" : !result.image_ready ? "图片生成工具尚未就绪。" : !result.video_ready ? "RunningHub 01 视频连接待配置。" : null;
  return result;
}
export async function videoRoute(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); }
  catch (error) {
    if (error instanceof VideoHttpError) return NextResponse.json({ error: error.message }, { status: error.status });
    // Provider/database diagnostics can contain credentials. They do not belong in HTTP output.
    console.error("[video-api] operation failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "视频服务暂时不可用，请稍后再试。" }, { status: 503 });
  }
}
export async function readVideoJson(request: NextRequest): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > 16000) throw new VideoHttpError(413, "请求内容过长。");
  try { const value = JSON.parse(raw); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch { /* invalid input */ }
  throw new VideoHttpError(400, "请求格式无效。");
}
export function textField(value: unknown, max: number, fallback = ""): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > max) throw new VideoHttpError(400, "输入内容无效或过长。");
  return value.trim();
}
