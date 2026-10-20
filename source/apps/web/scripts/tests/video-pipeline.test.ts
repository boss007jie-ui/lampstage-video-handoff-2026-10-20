import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleVideo, inspectSource, prepareMotionSegment, prepareSegment, probeMedia, segmentTimeline } from "../../lib/video/media";
import { VIDEO_MAX_SECONDS } from "../../lib/video/types";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { reconciliationPlan, segmentAction, verifyRenderConsent } from "../../lib/video/processor";
import type { VideoJobData } from "../../lib/video/types";
import type { prisma } from "../../lib/db";
import { claimJob, heartbeatLease, LeaseLostError, patchJob } from "../../lib/video/repository";

test("4–30 second source windows cover the entire timeline without omitted tail", () => {
  for (const seconds of [4, 4.01, 4.9, 5, 5.01, 6, 7.5, 8, 9.99, 10, 10.01, 11, 12, 14.99, 15, 15.01, 16.3, 20, 25, 29.99, 30]) {
    const segments = segmentTimeline(seconds);
    let cursor = 0;
    let assembledDuration = 0;
    for (const segment of segments) {
      assert.ok(segment.duration === 4 || segment.duration === 5);
      assert.ok(segment.start >= 0 && segment.trimStart >= 0 && segment.trimStart < segment.duration);
      assert.ok(Math.abs(segment.start + segment.trimStart - cursor) < 0.00001);
      const length = Math.min(segment.duration - segment.trimStart, seconds - cursor);
      assembledDuration += length;
      cursor += length;
    }
    assert.ok(Math.abs(assembledDuration - seconds) < 0.00001);
    // 新契约：30 秒上限 ⇒ 最多 6 段（每段上游固定 4/5 秒）。仍要求完整覆盖时间轴，不放松。
    assert.ok(segments.length <= Math.ceil(VIDEO_MAX_SECONDS / 4));
    assert.equal(segments.length, segmentTimeline(seconds).length);
  }
});

test("invalid source durations reject before generation", () => {
  // 平台契约：参考片总时长 4–30 秒（单一来源 VIDEO_MIN_SECONDS / VIDEO_MAX_SECONDS）。
  for (const value of [NaN, Infinity, 0, 3.99, 30.001]) assert.throws(() => segmentTimeline(value));
  for (const value of [4, 4.01, 5, 5.01, 15, 15.01, 16.3, 29.99, 30]) assert.doesNotThrow(() => segmentTimeline(value));
});

test("a 16.3 second source is covered end to end without losing or duplicating the tail", () => {
  const segments = segmentTimeline(16.3);
  assert.deepEqual(segments.map(s => ({
    start: Number(s.start.toFixed(3)), duration: s.duration,
    trimStart: Number(s.trimStart.toFixed(3)),
  })), [
    { start: 0, duration: 5, trimStart: 0 },
    { start: 5, duration: 5, trimStart: 0 },
    { start: 10, duration: 5, trimStart: 0 },
    { start: 12.3, duration: 4, trimStart: 2.7 },
  ]);
  // 每一段都必须在源片范围内，且时间轴连续覆盖到片尾。
  for (const segment of segments) assert.ok(segment.start + segment.duration <= 16.3 + 1e-6);
  const tail = segments[segments.length - 1];
  assert.equal(Number((tail.start + tail.duration).toFixed(3)), 16.3);
  assert.equal(segments[segments.length - 1].index, segments.length - 1);
});

test("30 seconds uses six upstream-sized segments, never a single long one", () => {
  const segments = segmentTimeline(30);
  assert.equal(segments.length, 6);
  for (const segment of segments) assert.ok(segment.duration === 4 || segment.duration === 5);
  const tail = segments[segments.length - 1];
  assert.equal(Number((tail.start + tail.duration).toFixed(3)), 30);
});

test("an ambiguous submission can never be submitted again", () => {
  const segment = { index: 0, start: 0, duration: 4 as const, trimStart: 0 };
  assert.equal(segmentAction(segment, false), "submit");
  assert.throws(() => segmentAction({ ...segment, submissionIntentAt: new Date().toISOString() }, false));
  assert.throws(() => segmentAction(segment, true));
  assert.equal(segmentAction({ ...segment, submissionIntentAt: "intent", buildId: "existing" }, true), "inspect");
  assert.equal(segmentAction({ ...segment, buildId: "existing" }, false), "inspect");
  assert.equal(segmentAction({ ...segment, candidateKey: "stored" }, true), "reuse");
});

test("consent applies to the whole job and changed quotes cannot silently expand scope", () => {
  const data: VideoJobData = { version: 1, imageCalls: 4, segments: segmentTimeline(9), renderConsent: { at: new Date().toISOString(), maxCoins: 200, estimatedCoins: 200, perSegmentCoins: 100, segmentIndices: [0, 1] } };
  assert.doesNotThrow(() => verifyRenderConsent(data, 100));
  assert.throws(() => verifyRenderConsent(data, 101));
  assert.throws(() => verifyRenderConsent(data, null));
  assert.throws(() => verifyRenderConsent({ ...data, renderConsent: undefined }, 100));
  assert.throws(() => verifyRenderConsent({ ...data, renderConsent: { ...data.renderConsent!, maxCoins: 199 } }, 100));
  assert.throws(() => verifyRenderConsent({ ...data, segments: segmentTimeline(15) }, 100));
});

test("partial resume consent stays stable across checkpoints and only covers explicitly approved segments", () => {
  const segments = segmentTimeline(15);
  segments[0].candidateKey = "already-paid";
  const data: VideoJobData = { version: 1, imageCalls: 6, segments, renderConsent: { at: new Date().toISOString(), maxCoins: 200, estimatedCoins: 200, perSegmentCoins: 100, segmentIndices: [1, 2] } };
  assert.doesNotThrow(() => verifyRenderConsent(data, 100, 1));
  assert.throws(() => verifyRenderConsent(data, 100, 0));
  segments[1].submissionIntentAt = "checkpoint";
  segments[1].buildId = "receipt";
  segments[1].candidateKey = "saved";
  assert.doesNotThrow(() => verifyRenderConsent(data, 100, 2));
  assert.throws(() => verifyRenderConsent({ ...data, renderConsent: { ...data.renderConsent!, segmentIndices: [2, 2] } }, 100, 2));
});

test("a stale revision cannot overwrite durable provider receipts", async () => {
    const calls: any[] = [];
    const db = { videoJob: { updateMany: async (args: unknown) => { calls.push(args); return { count: 0 }; } } } as unknown as Pick<typeof prisma, "videoJob">;
    await assert.rejects(patchJob("job", "worker-old", { expectedRevision: 3 }, { version: 1, imageCalls: 0, segments: [] }, db), LeaseLostError);
    const args = calls[0];
    assert.equal(args.where.revision, 3);
    assert.equal(args.where.lease_owner, "worker-old");
    assert.ok(args.where.lease_until.gt instanceof Date);
    assert.equal(args.data.revision.increment, 1);
});

test("heartbeat renews only a live owner's lease without changing data revision", async () => {
    const calls: any[] = [];
    const db = { videoJob: { updateMany: async (args: unknown) => { calls.push(args); return { count: 1 }; } } } as unknown as Pick<typeof prisma, "videoJob">;
    await heartbeatLease("job", "worker", db);
    const args = calls[0];
    assert.equal(args.where.lease_owner, "worker");
    assert.ok(args.where.lease_until.gt instanceof Date);
    assert.deepEqual(Object.keys(args.data), ["lease_until"]);
});

test("claim expires interrupted jobs to attention and loses a raced CAS without processing", async () => {
    const calls: any[] = [];
    const db = { videoJob: {
      updateMany: async (args: unknown) => { calls.push(args); return { count: 0 }; },
      findMany: async () => [{ id: "job", revision: 7, phase: "render" }],
    } } as unknown as Pick<typeof prisma, "videoJob">;
    assert.equal(await claimJob("worker-new", db), null);
    const expiry = calls[0];
    assert.equal(expiry.data.status, "attention");
    assert.equal(expiry.data.revision.increment, 1);
    const claim = calls[1];
    assert.equal(claim.where.status, "queued");
    assert.equal(claim.where.revision, 7);
    assert.equal(claim.data.lease_owner, "worker-new");
});

test("partial reconciliation recovers an existing build while leaving later unsubmitted segments untouched", () => {
  const segments = segmentTimeline(10);
  segments[0].buildId = "existing-paid-build";
  segments[0].submissionIntentAt = "intent";
  const plan = reconciliationPlan(segments);
  assert.deepEqual(plan.recoverable.map(s => s.index), [0]);
  assert.deepEqual(plan.missing.map(s => s.index), [1]);
  assert.equal(segmentAction(plan.recoverable[0], true), "inspect");
  assert.equal(segments[1].submissionIntentAt, undefined);
  assert.throws(() => segmentAction(plan.missing[0], true));
});

const MEDIA_CASES = [{ seconds: 16.3, expectedSegments: 4 }, { seconds: 30, expectedSegments: 6 }] as const;

test("direct preparation writes only an action clip, with no opening or ending image", { skip: process.env.RUN_VIDEO_MEDIA_TESTS !== "1" }, async () => {
  const root = path.resolve(os.tmpdir());
  const workspace = await mkdtemp(path.join(root, "lamp-direct-media-"));
  try {
    const source = path.join(workspace, "source.mp4");
    await promisify(execFile)(process.env.VIDEO_FFMPEG_PATH || "ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30", "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", source], { windowsHide: true });
    const clip = await prepareMotionSegment(source, segmentTimeline(4)[0], workspace);
    assert.deepEqual((await readdir(workspace)).sort(), ["source-0.mp4", "source.mp4"]);
    assert.ok(Math.abs((await probeMedia(clip)).duration - 4) < 0.05);
  } finally {
    const resolved = path.resolve(workspace);
    assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith("lamp-direct-media-"));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("local synthetic media: 16.3s and 30s sources keep the full tail with and without audio", { skip: process.env.RUN_VIDEO_MEDIA_TESTS !== "1" }, async () => {
  const root = path.resolve(os.tmpdir());
  for (const mediaCase of MEDIA_CASES) {
    const workspace = await mkdtemp(path.join(root, "lamp-video-test-"));
    try {
      const source = path.join(workspace, "source.mp4");
      await promisify(execFile)(process.env.VIDEO_FFMPEG_PATH || "ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", String(mediaCase.seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", source], { windowsHide: true });
      const info = await inspectSource(source);
      const segments = segmentTimeline(info.duration);
      assert.equal(segments.length, mediaCase.expectedSegments, `${mediaCase.seconds}s should split into ${mediaCase.expectedSegments} segments`);
      // 片尾标记：最后一段必须真的覆盖到片尾，不能丢尾也不能重复尾段。
      const tail = segments[segments.length - 1];
      assert.ok(Math.abs(tail.start + tail.duration - info.duration) <= 0.12, `${mediaCase.seconds}s tail must reach the end of the source`);
      const candidates: string[] = [];
      for (const segment of segments) candidates.push((await prepareSegment(source, segment, workspace)).clip);
      for (const preserveAudio of [true, false]) {
        const output = await assembleVideo({ candidates, segments, source, duration: info.duration, preserveAudio, workspace });
        const result = await probeMedia(output);
        assert.ok(Math.abs(result.duration - info.duration) <= 0.12, `${mediaCase.seconds}s preserveAudio=${preserveAudio} duration drifted: ${result.duration}`);
        assert.equal(result.width, 720);
        assert.equal(result.height, 1280);
        assert.equal(result.videoCodec, "h264");
        assert.equal(result.hasAudio, preserveAudio);
        if (preserveAudio) assert.equal(result.audioCodec, "aac");
      }
    } finally {
      // Only remove this test's verified mkdtemp child, never a computed parent directory.
      const resolved = path.resolve(workspace);
      assert.equal(path.dirname(resolved), root);
      assert.ok(path.basename(resolved).startsWith("lamp-video-test-"));
      await rm(resolved, { recursive: true, force: true });
    }
  }
});

test("a cancelled media child is waited for (bounded), not killed and abandoned", {
  skip: process.platform === "win32" ? "Windows kill() maps to TerminateProcess, so the wait semantics differ" : process.env.RUN_VIDEO_MEDIA_TESTS !== "1",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lamp-video-cancel-"));
  const originalProbe = process.env.VIDEO_FFPROBE_PATH;
  try {
    // 一个忽略 SIGTERM 的子进程：只有强杀才能让它停，用来验证我们会等到它真的退出。
    const slow = path.join(root, "slow-ffprobe.sh");
    await writeFile(slow, "#!/bin/sh\ntrap '' TERM\nsleep 5\nexit 0\n", { mode: 0o755 });
    process.env.VIDEO_FFPROBE_PATH = slow;
    const controller = new AbortController();
    const started = Date.now();
    const pending = probeMedia(path.join(root, "missing.mp4"), controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending);
    const elapsed = Date.now() - started;
    // 必须等到子进程真正退出（或 2 秒兜底强杀）才 reject；只调 kill() 就返回会远小于这个下界。
    assert.ok(elapsed >= 1_900, `expected a bounded wait for the child to exit, got ${elapsed}ms`);
  } finally {
    if (originalProbe === undefined) delete process.env.VIDEO_FFPROBE_PATH; else process.env.VIDEO_FFPROBE_PATH = originalProbe;
    await rm(root, { recursive: true, force: true });
  }
});
