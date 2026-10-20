import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeMedia, VideoPipelineError, type MediaInfo } from "./media";
import type { VideoSegment } from "./types";
import { assessCandidateTiming, sixDeliveryWindow, SIX_DELIVERY_FPS } from "./candidate-quality";

const ffmpeg = () => process.env.VIDEO_FFMPEG_PATH || "ffmpeg";
const ffprobe = () => process.env.VIDEO_FFPROBE_PATH || "ffprobe";
const FPS = SIX_DELIVERY_FPS;
const WIDTH = 720;
const HEIGHT = 1280;
const MAX_CLIP_BYTES = 30 * 1024 * 1024;
const MAX_RETIME = 0.15;
const DURATION_TOLERANCE = 0.12;

/** No shell and no provider/media diagnostics in errors; wait for process exit on cancellation. */
async function run(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new VideoPipelineError("本地媒体处理已取消。"));
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failed = false;
    let done = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const clear = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); if (forceTimer) clearTimeout(forceTimer); };
    const stop = (message: string) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => { child.kill("SIGKILL"); reject(new VideoPipelineError(message)); }, 2_000);
      child.once("close", () => { if (forceTimer) clearTimeout(forceTimer); reject(new VideoPipelineError(message)); });
    };
    const abort = () => stop("本地媒体处理已取消。");
    const timeout = setTimeout(() => stop("本地媒体处理超时，请检查素材。"), 180_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 2_000_000) output += chunk.toString(); else failed = true;
    });
    child.stderr.resume();
    child.on("error", () => {
      if (done) return;
      done = true; clear(); reject(new VideoPipelineError("本地媒体工具不可用，请检查 FFmpeg 配置。"));
    });
    child.on("close", code => {
      if (done) return;
      done = true; clear();
      if (code !== 0 || failed) reject(new VideoPipelineError("媒体无法解码或处理，请检查文件格式。"));
      else resolve(output);
    });
  });
}

function sourceWindow(segment: VideoSegment): number {
  const window = segment.sourceWindowDuration;
  if (!Number.isFinite(window) || !window || window <= 0 || !Number.isFinite(segment.start) || segment.start < 0 ||
      ![4, 5, 6, 8].includes(segment.duration)) {
    throw new VideoPipelineError("六参考片段缺少有效的源动作窗口。");
  }
  return window;
}

function checkRetime(from: number, to: number): void {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0 ||
      Math.max(from / to, to / from) > 1 + MAX_RETIME + 1e-6) {
    throw new VideoPipelineError("片段速度调整超过 15%，已保留供人工核对。");
  }
}

function checkDuration(actual: number, expected: number): void {
  if (Math.abs(actual - expected) > DURATION_TOLERANCE) {
    throw new VideoPipelineError("视频时长偏离目标，已保留供人工核对。");
  }
}

async function fullDecode(file: string, signal?: AbortSignal): Promise<void> {
  await run(ffmpeg(), ["-nostdin", "-v", "error", "-xerror", "-i", file,
    "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"], signal);
}

/** Entire source action window, retimed into an H3-sized motion guide with a silent waveform. */
export async function prepareSixMotionSegment(source: string, segment: VideoSegment, workspace: string, signal?: AbortSignal): Promise<string> {
  const window = sourceWindow(segment);
  checkRetime(window, segment.duration);
  const sourceInfo = await probeMedia(source, signal);
  if (segment.start + window > sourceInfo.duration + 0.02) {
    throw new VideoPipelineError("源片动作窗口超出实际视频长度。");
  }
  const clip = path.join(workspace, `six-source-${segment.index}.mp4`);
  const frameCount = Math.round(segment.duration * FPS);
  await run(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-xerror", "-ss", String(segment.start),
    "-t", String(window), "-i", source, "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=48000",
    "-map", "0:v:0", "-map", "1:a:0", "-vf",
    `trim=duration=${window},setpts=(PTS-STARTPTS)*${segment.duration / window},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS}`,
    "-frames:v", String(frameCount), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-maxrate", "8M", "-bufsize", "16M",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-ar", "48000", "-ac", "1",
    "-af", `atrim=duration=${segment.duration},asetpts=PTS-STARTPTS`, "-t", String(segment.duration),
    "-movflags", "+faststart", clip], signal);
  if ((await stat(clip)).size > MAX_CLIP_BYTES) throw new VideoPipelineError("参考片段超过 30MB，无法提交。");
  const info = await probeMedia(clip, signal);
  checkDuration(info.duration, segment.duration);
  if (info.width !== WIDTH || info.height !== HEIGHT || info.videoCodec !== "h264" ||
      !info.hasAudio || info.audioCodec !== "aac") throw new VideoPipelineError("六参考动态片格式校验失败。");
  await fullDecode(clip, signal);
  return clip;
}

export interface SixCandidateTail {
  file: string;
  media: MediaInfo;
  fps?: number;
  frameCount?: number;
}

/** Select the last *decoded* video frame; a requested timestamp is never reported as fact. */
export async function extractSixCandidateTail(candidate: string, to: string, signal?: AbortSignal): Promise<SixCandidateTail> {
  const media = await probeMedia(candidate, signal);
  const raw = await run(ffprobe(), ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames,avg_frame_rate", "-of", "json", candidate], signal);
  const parsed = JSON.parse(raw) as { streams?: { nb_read_frames?: string; avg_frame_rate?: string }[] };
  const stream = parsed.streams?.[0];
  const frameCount = Number(stream?.nb_read_frames);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new VideoPipelineError("无法确认生成片段的最后画面。");
  const [numerator, denominator] = (stream?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = denominator > 0 && Number.isFinite(numerator / denominator) ? numerator / denominator : undefined;
  await run(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-xerror", "-i", candidate,
    "-map", "0:v:0", "-vf", `select=eq(n\\,${frameCount - 1})`, "-vsync", "vfr", "-frames:v", "1", to], signal);
  if ((await stat(to)).size === 0) throw new VideoPipelineError("无法提取生成片段的最后画面。");
  return { file: to, media, fps, frameCount };
}

export interface AssembleSixVideoInput {
  candidates: string[];
  segments: VideoSegment[];
  source: string;
  duration: number;
  preserveAudio: boolean;
  workspace: string;
  signal?: AbortSignal;
}

/** Retimes complete candidate actions to contiguous source windows, then restores source audio. */
export async function assembleSixVideo(input: AssembleSixVideoInput): Promise<string> {
  if (input.candidates.length !== input.segments.length || input.segments.length === 0 ||
      !Number.isFinite(input.duration) || input.duration <= 0) throw new VideoPipelineError("六参考片段列表无效。");
  let cursor = 0;
  const normalized: { file: string; frameCount: number }[] = [];
  for (let i = 0; i < input.segments.length; i++) {
    const segment = input.segments[i];
    const targetDuration = sourceWindow(segment);
    if (segment.index !== i || Math.abs(segment.start - cursor) > 0.02) {
      throw new VideoPipelineError("源片动作窗口不连续。");
    }
    cursor += targetDuration;
    // Quantize cumulative boundaries, so fractional windows cannot lose frames by
    // rounding each length independently. The delivery timeline is exactly 30fps.
    const delivery = sixDeliveryWindow(input.segments, i);
    if (!delivery) throw new VideoPipelineError("源片动作窗口短于一帧或时间线无效。");
    const frameCount = delivery.frames;
    const deliveryDuration = delivery.duration;
    const info = await probeMedia(input.candidates[i], input.signal);
    const trimStart = segment.candidateTrimStart ?? 0;
    if (!Number.isFinite(trimStart) || trimStart < 0 || trimStart >= info.duration) throw new VideoPipelineError("已审阅的片段剪辑范围无效。");
    const keptDuration = info.duration - trimStart;
    if (assessCandidateTiming(input.segments, i, { actualDuration: info.duration, trimStart }).status !== "compatible") {
      throw new VideoPipelineError("片段速度调整超过 15%，已保留供人工核对。");
    }
    const target = path.join(input.workspace, `six-normalized-${i}.mp4`);
    // 显式起点可能落在两帧之间。最多保留末帧一个交付帧（1/30 秒），
    // 并继续检查精确帧数；不扩大剪辑或变速范围，不填补更长的内容不足。
    await run(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-xerror", "-i", input.candidates[i],
      "-map", "0:v:0", "-an", "-vf",
      `trim=start=${trimStart},setpts=(PTS-STARTPTS)*${deliveryDuration / keptDuration},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},tpad=stop_mode=clone:stop=1`,
      "-frames:v", String(frameCount), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", target], input.signal);
    const normalizedInfo = await probeMedia(target, input.signal);
    checkDuration(normalizedInfo.duration, targetDuration);
    if (Math.abs(normalizedInfo.duration - deliveryDuration) > 1 / 30000) {
      throw new VideoPipelineError("标准化片段未覆盖完整交付帧数。");
    }
    normalized.push({ file: target, frameCount });
  }
  if (Math.abs(cursor - input.duration) > 0.02) throw new VideoPipelineError("动作窗口未覆盖完整视频。");
  const manifest = path.join(input.workspace, "six-concat.txt");
  // FFmpeg 5.1 otherwise offsets the next file using MP4's millisecond-rounded
  // container duration (e.g. 6.167 instead of 185/30), creating a non-CFR join.
  await writeFile(manifest, normalized.map(({ file, frameCount }) =>
    `file '${path.basename(file)}'\nduration ${frameCount / FPS}`).join("\n"));
  const sourceInfo = await probeMedia(input.source, input.signal);
  if (sourceInfo.duration + 0.02 < input.duration) throw new VideoPipelineError("源片音轨短于目标视频。");
  const output = path.join(input.workspace, "six-output.mp4");
  const args = ["-nostdin", "-y", "-v", "error", "-xerror", "-f", "concat", "-safe", "1", "-i", manifest];
  const keepAudio = input.preserveAudio && sourceInfo.hasAudio;
  if (keepAudio) args.push("-i", input.source);
  args.push("-map", "0:v:0", "-c:v", "copy");
  if (keepAudio) args.push("-map", "1:a:0", "-af", `atrim=duration=${input.duration},asetpts=PTS-STARTPTS,apad=whole_dur=${input.duration}`,
    "-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-movflags", "+faststart", output);
  await run(ffmpeg(), args, input.signal);
  const final = await probeMedia(output, input.signal);
  checkDuration(final.duration, input.duration);
  if (final.width !== WIDTH || final.height !== HEIGHT || final.videoCodec !== "h264" ||
      final.hasAudio !== keepAudio || (keepAudio && final.audioCodec !== "aac")) {
    throw new VideoPipelineError("六参考合成结果格式校验失败。");
  }
  await fullDecode(output, input.signal);
  return output;
}
