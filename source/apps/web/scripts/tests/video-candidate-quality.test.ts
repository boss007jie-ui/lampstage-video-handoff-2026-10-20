import assert from "node:assert/strict";
import test from "node:test";
import type { VideoJob } from "@prisma/client";
import { applyCandidateReview, candidateReviewToken } from "../../lib/video/candidate-review";
import { jobView } from "../../lib/video/repository";
import type { VideoJobData } from "../../lib/video/types";

const hash = "a".repeat(64);
function candidate(actual = 107 / 24, source = 3.711): VideoJobData {
  return { version: 1, generationMode: "six_references", workflowProfile: "sixref-v1", imageCalls: 0,
    sourceDuration: source, referenceImages: [], segments: [{ index: 0, start: 0, duration: 4, trimStart: 0,
      sourceWindowDuration: source, instructions: "完成原动作", beforeState: "动作开始", afterState: "动作完成",
      candidateKey: "videos/test/candidate.mp4", candidateSha256: hash, tailKey: "videos/test/tail.png", tailSha256: hash,
      candidateMedia: { duration: actual, width: 704, height: 1280, fps: 24, frameCount: 107 } }] };
}
function view(data: VideoJobData) {
  return jobView({ id: "quality-test", title: "test", status: "review", stage: "待审阅", instructions: "动作复刻",
    preserve_audio: false, data, created_at: new Date(0), updated_at: new Date(0) } as unknown as VideoJob);
}
const accept = (trim_start?: number) => [{ segment_index: 0, candidate_sha256: hash, action: "accept", ...(trim_start === undefined ? {} : { trim_start }) }];

test("实际4.458秒候选在查询中明确标出时长不兼容且不改变原数据", () => {
  const data = candidate(); const before = structuredClone(data);
  const timing = (view(data).segments[0] as any).candidate_timing;
  assert.equal(timing?.status, "incompatible");
  assert.equal(timing.reason, "duration_out_of_range");
  assert.equal(timing.actual_duration, 107 / 24);
  assert.equal(timing.requested_duration, 4);
  assert.equal(timing.source_duration, 3.711);
  assert.equal(timing.delivery_duration, 3.7);
  assert.ok(Math.abs(timing.allowed_kept_duration.max - 4.255) < 1e-9);
  assert.equal(timing.visual_review_required, true);
  assert.deepEqual(data, before);
});

test("审阅在源窗合法但30fps交付窗口超限时提前拒绝", () => {
  const data = candidate(4.26);
  assert.ok(4.26 / 3.711 < 1.15);
  assert.throws(() => applyCandidateReview(data, accept()), (error: any) => error.reason === "duration_incompatible" && error.segmentIndex === 0);
  assert.equal(data.segments[0].accepted, undefined);
});

test("缺少实际时长的历史候选保持可读但不能被当作已兼容接受", () => {
  const data = candidate(); delete data.segments[0].candidateMedia;
  const timing = (view(data).segments[0] as any).candidate_timing;
  assert.equal(timing?.status, "unknown");
  assert.equal(timing.reason, "actual_duration_unknown");
  assert.throws(() => applyCandidateReview(data, accept()), (error: any) => error.reason === "actual_duration_unknown");
});

test("旧5.166秒候选对4.8秒源窗仍兼容且接受不自动剪辑", () => {
  const data = candidate(124 / 24, 4.8); data.segments[0].duration = 5;
  assert.equal((view(data).segments[0] as any).candidate_timing?.status, "compatible");
  const next = applyCandidateReview(data, accept());
  assert.equal(next.segments[0].accepted, true);
  assert.equal(next.segments[0].candidateTrimStart, 0);
  assert.equal(next.segments[0].candidateSha256, hash);
  assert.equal(data.segments[0].accepted, undefined);
});

test("只使用明确给出的已审阅剪辑，不自动计算或应用最小trim", () => {
  const data = candidate();
  assert.throws(() => applyCandidateReview(data, accept()), (error: any) => error.reason === "duration_incompatible");
  const next = applyCandidateReview(data, accept(0.21));
  assert.equal(next.segments[0].candidateTrimStart, 0.21);
  assert.equal(next.segments[0].accepted, true);
  assert.equal(data.segments[0].candidateTrimStart, undefined);
  assert.equal((view(next).segments[0] as any).candidate_timing?.status, "compatible");
});

test("审阅凭据绑定实际媒体、源窗和交付时间线", () => {
  const data = candidate(4);
  const original = candidateReviewToken("job", data);
  for (const mutate of [
    (copy: VideoJobData) => { copy.segments[0].candidateMedia!.duration = 4.458333; },
    (copy: VideoJobData) => { copy.segments[0].sourceWindowDuration = 3.7; },
    (copy: VideoJobData) => { copy.segments[0].start = 0.01; },
    (copy: VideoJobData) => { copy.segments[0].candidateMedia!.frameCount = 108; },
  ]) {
    const changed = structuredClone(data); mutate(changed);
    assert.notEqual(candidateReviewToken("job", changed), original);
  }
});
