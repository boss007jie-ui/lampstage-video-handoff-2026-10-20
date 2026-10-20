import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { VIDEO_MAX_SECONDS, VIDEO_MIN_SECONDS, type VideoSegment } from "./types";

export class VideoPipelineError extends Error {}
const ffmpeg = () => process.env.VIDEO_FFMPEG_PATH || "ffmpeg";
const ffprobe = () => process.env.VIDEO_FFPROBE_PATH || "ffprobe";

/** Arguments go directly to the executable; no shell and no raw stderr in user-visible errors. */
async function run(executable: string, args: string[], timeout = 180_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new VideoPipelineError("本地媒体处理已取消。")); return; }
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let overflow = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    /**
     * 取消/超时后必须**有界等待子进程真正退出**，必要时升级为强杀。
     * 只调 kill() 就宣告结束是不够的：子进程可能仍在写文件，后续阶段会读到半成品。
     */
    const terminate = (reason: VideoPipelineError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); reject(reason); }, 2_000);
      // 优先等 close 事件（子进程真的退出了）再 reject；2 秒兜底强杀。
      child.once("close", () => { if (killTimer) clearTimeout(killTimer); reject(reason); });
    };
    const onAbort = () => terminate(new VideoPipelineError("本地媒体处理已取消。"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => terminate(new VideoPipelineError("本地媒体处理超时，请检查素材。")), timeout);
    if (settled) return;
    child.stdout.on("data", (chunk: Buffer) => { if (output.length < 2_000_000) output += chunk.toString(); else overflow = true; });
    child.stderr.resume();
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(new VideoPipelineError("本地媒体工具不可用，请检查 FFmpeg 配置。"));
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0 || overflow) reject(new VideoPipelineError("媒体无法解码或处理，请检查文件格式。")); else resolve(output);
    });
  });
}

export async function mediaReadiness(): Promise<boolean> {
  try { await run(ffmpeg(), ["-version"], 10_000); await run(ffprobe(), ["-version"], 10_000); return true; } catch { return false; }
}

export interface MediaInfo { duration: number; width: number; height: number; hasAudio: boolean; videoCodec: string; audioCodec?: string }
export async function probeMedia(file: string, signal?: AbortSignal): Promise<MediaInfo> {
  const raw = await run(ffprobe(), ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", file], 180_000, signal);
  const parsed = JSON.parse(raw) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; duration?: string; width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[] };
  const video = parsed.streams?.find(s => s.codec_type === "video");
  const audio = parsed.streams?.find(s => s.codec_type === "audio");
  const streamDuration = Number(video?.duration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(parsed.format?.duration);
  if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) throw new VideoPipelineError("视频没有可用的画面或时长信息。");
  const rotation = Number(video.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  const swapped = Math.abs(rotation % 180) === 90;
  return { duration, width: swapped ? video.height : video.width, height: swapped ? video.width : video.height, hasAudio: Boolean(audio), videoCodec: video.codec_name ?? "", audioCodec: audio?.codec_name };
}

export async function inspectSource(file: string, signal?: AbortSignal): Promise<MediaInfo> {
  const info = await probeMedia(file, signal);
  if (info.duration < VIDEO_MIN_SECONDS || info.duration > VIDEO_MAX_SECONDS) throw new VideoPipelineError(`请上传 ${VIDEO_MIN_SECONDS}–${VIDEO_MAX_SECONDS} 秒的视频。`);
  if (Math.abs(info.width / info.height - 9 / 16) > 0.025 || info.width < 144 || info.height > 8192) throw new VideoPipelineError("请上传 9:16 竖屏视频。");
  await run(ffmpeg(), ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"], 180_000, signal);
  return info;
}

/** Final window ends at the source tail. trimStart removes its overlap with the previous window. */
export function segmentTimeline(seconds: number): VideoSegment[] {
  if (!Number.isFinite(seconds) || seconds < VIDEO_MIN_SECONDS || seconds > VIDEO_MAX_SECONDS) throw new VideoPipelineError("视频时长超出范围。");
  const result: VideoSegment[] = [];
  let covered = 0;
  while (covered < seconds - 0.000001) {
    const remaining = seconds - covered;
    const duration: 4 | 5 = remaining <= 4 ? 4 : 5;
    const start = Math.max(0, Math.min(covered, seconds - duration));
    result.push({ index: result.length, start, duration, trimStart: Math.max(0, covered - start) });
    covered = Math.min(seconds, start + duration);
  }
  return result;
}

export async function prepareMotionSegment(source: string, segment: VideoSegment, workspace: string, signal?: AbortSignal): Promise<string> {
  const clip = path.join(workspace, `source-${segment.index}.mp4`);
  await run(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-ss", String(segment.start), "-i", source,
    "-map", "0:v:0", "-an", "-vf", `scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=1`,
    "-t", String(segment.duration), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip], 180_000, signal);
  if ((await stat(clip)).size > 30 * 1024 * 1024) throw new VideoPipelineError("参考片段超过 30MB，无法提交。");
  return clip;
}

export async function prepareSegment(source: string, segment: VideoSegment, workspace: string, signal?: AbortSignal) {
  const clip = await prepareMotionSegment(source, segment, workspace, signal);
  const opening = path.join(workspace, `source-${segment.index}-opening.png`);
  const ending = path.join(workspace, `source-${segment.index}-ending.png`);
  for (const [position, out] of [[0, opening], [segment.duration - 1 / 30, ending]] as const) {
    await run(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-ss", String(position), "-i", clip, "-frames:v", "1", out], 180_000, signal);
  }
  return { clip, opening, ending };
}

export async function assembleVideo(input: { candidates: string[]; segments: VideoSegment[]; source: string; duration: number; preserveAudio: boolean; workspace: string; signal?: AbortSignal }): Promise<string> {
  const normalized: string[] = [];
  for (let i = 0; i < input.segments.length; i++) {
    const segment = input.segments[i];
    const candidate = input.candidates[i];
    const info = await probeMedia(candidate, input.signal);
    if (info.duration < segment.duration - 0.1) throw new VideoPipelineError("生成片段时长不足，已保留供人工核对。");
    const target = path.join(input.workspace, `normalized-${i}.mp4`);
    const keep = Math.min(segment.duration - segment.trimStart, input.duration - segment.start - segment.trimStart);
    await run(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-i", candidate, "-map", "0:v:0", "-an", "-vf",
      `scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=0.1,trim=start=${segment.trimStart}:duration=${keep},setpts=PTS-STARTPTS`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", target], 180_000, input.signal);
    normalized.push(target);
  }
  const manifest = path.join(input.workspace, "concat.txt");
  // Fixed generated basenames keep concat syntax independent of user filenames / workspace apostrophes.
  await writeFile(manifest, normalized.map(file => `file '${path.basename(file)}'`).join("\n"));
  const output = path.join(input.workspace, "output.mp4");
  const args = ["-nostdin", "-y", "-v", "error", "-f", "concat", "-safe", "1", "-i", manifest];
  if (input.preserveAudio) args.push("-i", input.source);
  args.push("-map", "0:v:0", "-c:v", "copy");
  if (input.preserveAudio) args.push("-map", "1:a:0", "-af", "apad", "-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-t", String(input.duration), "-movflags", "+faststart", output);
  await run(ffmpeg(), args, 180_000, input.signal);
  const final = await probeMedia(output, input.signal);
  if (Math.abs(final.duration - input.duration) > 0.12 || final.width !== 720 || final.height !== 1280 || final.videoCodec !== "h264" || final.hasAudio !== input.preserveAudio || (final.hasAudio && final.audioCodec !== "aac")) throw new VideoPipelineError("合成结果未通过时长或格式检查。");
  await run(ffmpeg(), ["-nostdin", "-v", "error", "-xerror", "-i", output, "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"], 180_000, input.signal);
  return output;
}
