import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../../lib/agent/policy";
import { segmentTimeline } from "../../lib/video/media";
import type { VideoJobData } from "../../lib/video/types";
import type { VideoPreparation } from "../../lib/video/backend-runtime/binding";
import { preparedJobDigest, validatePreparedJob, type PreparedJobView } from "../../lib/video/backend-runtime/preparation";
import { runtimeJobData } from "../../lib/video/backend-runtime/prisma-runtime";

function fixture(mode: VideoPreparation["mode"] = "direct_references") {
  const references = ["product", "character", "scene"].map((role, index) => ({ assetId: `image-${index}`, role, label: role,
    key: `videos/job/references/${index}.png`, sha256: digest(`normalized-${index}`) }));
  const data: VideoJobData = { version: 1, generationMode: mode, sourceDuration: 8, sourceHasAudio: false, imageCalls: mode === "legacy_frames" ? 4 : 0,
    segments: segmentTimeline(8).map(s => ({ ...s, clipKey: `videos/job/segments/${s.index}/source.mp4`,
      ...(mode === "legacy_frames" ? { openingKey: `videos/job/segments/${s.index}/opening.png`, endingKey: `videos/job/segments/${s.index}/ending.png` } : {}) })),
    ...(mode === "direct_references" ? { referenceImages: references as VideoJobData["referenceImages"] } : {}) };
  if (mode === "six_references") {
    data.workflowProfile = "sixref-v1";
    data.referenceImages = [{ assetId: "unused-default", role: "start_state", label: "未用于本轮片段的默认图" }];
    data.segments = [0, 1].map(index => ({ index, start: index * 4, duration: 4, trimStart: 0, sourceWindowDuration: 4,
      instructions: "完整动作", beforeState: "开始", afterState: "结束", clipKey: `videos/job/segments/${index}/source.mp4`,
      referenceImages: [{ assetId: "image-1", role: "start_state", label: "起态", key: `videos/job/segments/${index}/references/0.png`, sha256: digest("normalized-1") },
        { assetId: "image-0", role: "product", label: "商品", key: `videos/job/segments/${index}/references/1.png`, sha256: digest("normalized-0") }] }));
  }
  const job: PreparedJobView = { id: "job", user_id: "user", source_asset_id: "source", product_asset_id: "image-0", instructions: "保留动作", preserve_audio: false,
    status: "review", phase: { direct_references: "prepare_references", legacy_frames: "prepare", six_references: "prepare_sixref" }[mode], data, lease_owner: null, lease_until: null };
  const p: VideoPreparation = { version: 1, jobId: "job", userId: "user", backendId: "fake", accountId: "account", configurationDigest: digest("config"),
    preparedJobDigest: preparedJobDigest(job), mode, pricingBasis: "test", quoteVersion: "v1", materials: [
      { kind: "video_asset", role: "source", assetId: "source", sha256: digest("video"), storageKey: "videos/source.mp4" },
      ...references.map((r, i) => ({ kind: "uploaded_asset" as const, role: i === 0 ? "product" as const : "reference" as const, assetId: r.assetId,
        sha256: digest(`original-${i}`), imageContentId: `content-${i}`, assetLocation: `/uploads/user/asset-${i}.png`, contentLocation: `/uploads/user/content-${i}.png` }))],
    segments: data.segments.map(s => ({ index: s.index, duration: s.duration, width: 64, height: 64, maxCoins: 12,
      window: { start: s.start, end: s.start + (s.sourceWindowDuration ?? s.duration) },
      input: { applicationId: "app", configurationDigest: digest("config"), mappingVersion: "v1", values: { prompt: "fake" } } })) };
  return { job, p, data };
}

test("合法准备完成状态复用真实 timeline 和参考快照；任意 review 不能绑定", () => {
  for (const mode of ["legacy_frames", "direct_references", "six_references"] as const) {
    const { job, p } = fixture(mode); assert.equal(validatePreparedJob(job, p, true), true);
    for (const state of [{ status: "ready", phase: "review" }, { status: "review", phase: "render" }, { status: "queued", phase: job.phase },
      { lease_owner: "other", lease_until: new Date(Date.now() + 60000) }]) assert.equal(validatePreparedJob({ ...job, ...state }, p, true), false);
  }
  const { job, p, data } = fixture();
  delete data.segments[0].clipKey; p.preparedJobDigest = preparedJobDigest(job);
  assert.equal(validatePreparedJob(job, p, true), false);
});
test("legacy/direct 不能把伪造4加4时间线当作8秒已准备任务", () => {
  const { job, p, data } = fixture();
  data.segments[0].duration = 4; data.segments[1].trimStart = 0;
  p.segments[0].duration = 4; p.segments[0].window.end = 4; p.preparedJobDigest = preparedJobDigest(job);
  assert.equal(validatePreparedJob(job, p, true), false);
});
test("六图未使用的默认参考不要求快照；选中依赖片段在本批失败关闭", () => {
  const { job, p, data } = fixture("six_references");
  assert.equal(data.referenceImages![0].key, undefined); assert.equal(validatePreparedJob(job, p, true), true);
  data.segments[1].startFromSegment = 0; p.preparedJobDigest = preparedJobDigest(job);
  assert.equal(validatePreparedJob(job, p, true), false);
  p.segments = p.segments.slice(0, 1);
  assert.equal(validatePreparedJob(job, p, true), true);
});
test("准备摘要固定说明/音频/窗口/引用；runtime attempt 不改变它且保留未选片段", () => {
  const { job, p } = fixture();
  const changed = { ...job, instructions: "changed" }; assert.equal(validatePreparedJob(changed, p, false), false);
  assert.equal(validatePreparedJob({ ...job, preserve_audio: true }, p, false), false);
  const data = runtimeJobData(job.data, { segments: [{ index: 0, attempt: 1 }] } as any);
  assert.equal(data.segments.length, 2); assert.equal(data.segments[0].attempt, 1);
  assert.equal(preparedJobDigest({ ...job, data }), p.preparedJobDigest);
  assert.equal(validatePreparedJob({ ...job, data, status: "generating", phase: "render", lease_owner: "worker", lease_until: new Date() }, p, false), true);
});
