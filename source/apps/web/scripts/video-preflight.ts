/**
 * 只读的免费素材预检。
 *
 * 用真实的 COS 素材走一遍"下载 → 校验 → 分段 → 抽首尾帧"，把**计划中的付费调用数**算出来，
 * 然后清理临时目录退出。它**不导入也不调用** processVideoJob，不调用 prepare/render API、
 * generateReference、submitH3、build 或 runtime up，不上传任何新对象，也不修改任何任务/资产记录。
 *
 * 因此它可以在"付费开关关闭"的维护状态下安全运行——这正是它存在的意义：
 * 在没有放开 worker 的情况下，验证修复后的下载与媒体链路真的能跑通。
 *
 *   npx --no-install tsx scripts/video-preflight.ts --job <jobId> --read-only
 */
import { loadEnvConfig } from "@next/env";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

loadEnvConfig(process.cwd());

async function main() {
  const argv = process.argv.slice(2);
  const readOnly = argv.includes("--read-only");
  const jobIndex = argv.indexOf("--job");
  const jobId = jobIndex >= 0 ? argv[jobIndex + 1] : undefined;
  if (!readOnly || !jobId) {
    console.error("usage: video-preflight.ts --job <jobId> --read-only");
    process.exitCode = 2;
    return;
  }

  const [{ prisma }, { privateDownloadTo }, { inspectSource, segmentTimeline, prepareSegment }, { getObjectBytes }] = await Promise.all([
    import("../lib/db"), import("../lib/video/storage"), import("../lib/video/media"), import("../lib/storage"),
  ]);

  const job = await prisma.videoJob.findFirst({
    where: { id: jobId },
    select: { id: true, user_id: true, status: true, phase: true, revision: true, source_asset_id: true, product_asset_id: true, data: true },
  });
  if (!job) throw new Error("job_not_found");
  const source = await prisma.videoAsset.findFirst({ where: { id: job.source_asset_id, user_id: job.user_id }, select: { id: true, storage_key: true, size_bytes: true, status: true } });
  if (!source) throw new Error("source_asset_not_found");
  const product = await prisma.uploadedAsset.findFirst({ where: { id: job.product_asset_id, user_id: job.user_id }, select: { id: true, image_url: true } });
  if (!product) throw new Error("product_asset_not_found");
  const before = (job.data ?? {}) as { imageCalls?: number; segments?: unknown[] };

  // 独立临时目录：绝不复用生产任务目录，也就不可能覆盖源片或回执。
  const root = await mkdtemp(path.join(os.tmpdir(), "lampstage-preflight-"));
  const startedAt = Date.now();
  try {
    const sourcePath = path.join(root, "source.mp4");
    const downloaded = await privateDownloadTo(source.storage_key, sourcePath, { expectedBytes: source.size_bytes });
    const downloadMs = Date.now() - startedAt;

    const validateStart = Date.now();
    const info = await inspectSource(sourcePath);
    const segments = segmentTimeline(info.duration);
    const validateMs = Date.now() - validateStart;

    const extractStart = Date.now();
    const frames: number[] = [];
    for (const segment of segments) {
      const files = await prepareSegment(sourcePath, segment, root);
      frames.push((await stat(files.opening)).size, (await stat(files.ending)).size);
    }
    const extractMs = Date.now() - extractStart;

    const productStart = Date.now();
    const productData = await getObjectBytes(product.image_url, { timeoutMs: 30_000 });
    const productMs = Date.now() - productStart;

    // 只报告阶段、耗时、字节数与调用计划；不输出提示词、签名 URL 或任何密钥。
    console.log(JSON.stringify({
      job_id: job.id,
      job_status: job.status,
      job_phase: job.phase,
      job_revision: job.revision,
      source_asset_id: source.id,
      source_status: source.status,
      source_bytes: downloaded,
      source_duration: info.duration,
      source_width: info.width,
      source_height: info.height,
      source_has_audio: info.hasAudio,
      source_video_codec: info.videoCodec,
      segments: segments.length,
      segment_plan: segments.map(s => ({ index: s.index, start: Number(s.start.toFixed(3)), duration: s.duration, trimStart: Number(s.trimStart.toFixed(3)) })),
      extracted_frame_bytes: frames,
      product_bytes: productData.bytes.length,
      planned_reference_calls: segments.length * 2,
      planned_video_calls: segments.length,
      paid_calls_executed: 0,
      image_calls_before: before.imageCalls ?? 0,
      timings_ms: { download: downloadMs, validate: validateMs, extract: extractMs, product: productMs, total: Date.now() - startedAt },
    }, null, 2));

    // 结束后核对：预检不得改动任务。有问题就以非零退出码暴露，不静默。
    const after = await prisma.videoJob.findFirst({ where: { id: job.id }, select: { revision: true, status: true, data: true } });
    const afterData = (after?.data ?? {}) as { imageCalls?: number; segments?: unknown[] };
    if (!after || after.revision !== job.revision || after.status !== job.status || (afterData.imageCalls ?? 0) !== (before.imageCalls ?? 0)) {
      throw new Error("preflight_changed_job_state");
    }
    console.log("preflight_ok: job revision/status/imageCalls unchanged, paid_calls_executed=0");
  } finally {
    await rm(root, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

void main().catch(error => {
  console.error("preflight_failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
