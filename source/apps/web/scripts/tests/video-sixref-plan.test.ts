import assert from "node:assert/strict";
import test from "node:test";
import { parseVideoReferenceInput, referenceDigest } from "../../lib/video/reference-inputs";
import { parseSixReferencePlan, SixReferencePlanError, assertSixStartStateReferences, assertSixStartStatePlan, sixReferencesReady, sixPlanDigest, validateSemanticWindows, readySixSegments, effectiveSixReferences, sixSegmentDirection } from "../../lib/video/six-reference-plan";
import { checkReviewToken, validateRenderConsent } from "../../lib/video/consent";
import type { VideoJobData } from "../../lib/video/types";
import { reviewToken } from "../../lib/video/review-token";
import { applyCandidateReview, candidateReviewToken } from "../../lib/video/candidate-review";

const refs = [
  { asset_id: "state", role: "start_state", label: "起态和衣着" },
  { asset_id: "baby", role: "character", label: "只替换宝宝外观，保留衣服" },
  { asset_id: "product", role: "product", label: "确认商品结构" },
  { asset_id: "mom", role: "character", label: "妈妈" },
  { asset_id: "bed", role: "scene", label: "绿床" },
];
const body = () => ({ generation_mode: "six_references", reference_assets: refs, segment_plan: [
  { start: 0, source_duration: 5, duration: 5, instructions: "两只袖子逐一穿入", before_state: "上衣开放，两袖未穿", after_state: "两袖已穿，斜襟开放" },
  { start: 5, source_duration: 6, duration: 6, instructions: "斜襟对齐扣合并放下下摆", before_state: "两袖已穿，斜襟开放", after_state: "衣摆放下，裤前开放" },
  { start: 11, source_duration: 5.3, duration: 5, instructions: "裤前腰部操作", before_state: "衣摆放下，裤前开放", after_state: "裤腰整理完成", start_from_segment: 1 },
] });
const startStateError = "每段第一张参考必须是唯一的 start_state 完整起态图；请核对起始人物、衣物、场景和姿态。";
const rejectsStartState = (run: () => unknown) => assert.throws(run, error =>
  error instanceof SixReferencePlanError && error.message === startStateError);
function prepared() {
  const data = parseVideoReferenceInput(body(), "");
  data.sourceDuration = 16.3;
  for (const s of data.segments) {
    s.clipKey = `videos/job/segments/${s.index}/source.mp4`;
    s.referenceImages = s.referenceImages!.map((r, i) => ({ ...r, key: `videos/job/segments/${s.index}/references/${i}.png`, sha256: "a".repeat(64) }));
  }
  return data;
}
test("sixref keeps five ordered roles and full 16.3 timeline without equal-time cuts", () => {
  const data = prepared();
  assert.equal(data.workflowProfile, "sixref-v1");
  assert.deepEqual(data.segments.map(s => s.duration), [5, 6, 5]);
  assert.equal(data.segments[0].referenceImages![0].role, "start_state");
  validateSemanticWindows(data.segments, 16.3);
  assert.throws(() => validateSemanticWindows(data.segments, 16.8));
  assert.throws(() => validateSemanticWindows(data.segments, 16.38));
  assert.deepEqual(readySixSegments(data).map(s => s.index), [0, 1]);
  const consent = validateRenderConsent(data, 500, 120);
  assert.equal(consent.ok, true);
  if (consent.ok) { assert.equal(consent.estimate, 240); assert.deepEqual(consent.segmentIndices, [0, 1]); }
});
test("missing, >6, discontinuous, cyclic, unsupported-duration plans reject before generation", () => {
  const noPlan = { ...body(), segment_plan: undefined };
  assert.throws(() => parseVideoReferenceInput(noPlan, ""));
  assert.throws(() => parseVideoReferenceInput({ ...body(), reference_assets: [...refs, { ...refs[0], asset_id: "x" }, { ...refs[0], asset_id: "y" }] }, ""));
  for (const patch of [{ start: .2 }, { duration: 7 }, { source_duration: 2 }, { source_duration: 5.1, duration: 6 }, { start_from_segment: 2 }]) {
    const input = body(); Object.assign(input.segment_plan[0], patch);
    assert.throws(() => parseVideoReferenceInput(input, ""));
  }
});
test("new plans reject missing, later and repeated start_state in inherited and overridden references", () => {
  for (const invalid of [
    refs.slice(1),
    [refs[1], refs[0], ...refs.slice(2)],
    [refs[0], { ...refs[0], asset_id: "another-state" }, ...refs.slice(1)],
  ]) {
    rejectsStartState(() => parseSixReferencePlan({ ...body(), reference_assets: invalid }));
    const input = body();
    rejectsStartState(() => parseSixReferencePlan({ ...input, segment_plan: input.segment_plan.map((segment, index) =>
      index === 1 ? { ...segment, reference_assets: invalid } : segment) }));
  }
  rejectsStartState(() => assertSixStartStateReferences(undefined));
  const data = prepared();
  assertSixStartStatePlan(data);
  data.segments[1].referenceImages = [data.segments[1].referenceImages![1], data.segments[1].referenceImages![0]];
  rejectsStartState(() => assertSixStartStatePlan(data, [1]));
  assertSixStartStatePlan(data, [0]);
});
test("legacy stored sixref order and digest remain readable without global validation", () => {
  const data = prepared();
  const first = data.segments[0].referenceImages!;
  data.segments[0].referenceImages = [first[1], first[0], ...first.slice(2)];
  assert.equal(sixReferencesReady(data), true);
  const original = data.segments[0].referenceImages!.map(ref => ref.assetId);
  const digest = sixPlanDigest(data);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(sixPlanDigest(data), digest);
  assert.deepEqual(data.segments[0].referenceImages!.map(ref => ref.assetId), original);
  rejectsStartState(() => assertSixStartStatePlan(data, [0]));
});
test("segment prompt describes only its operation, identity does not force changing clothes", () => {
  const data = prepared();
  const prompt = sixSegmentDirection(data.segments[1].referenceImages!, data.segments[1], "保留纸尿裤和原商品");
  assert.match(prompt, /斜襟对齐扣合/);
  assert.doesNotMatch(prompt, /两只袖子逐一穿入|裤前腰部操作|Replace only the corresponding referenced people and product/);
  assert.doesNotMatch(prompt, /preserve all other original attributes/);
  assert.match(prompt, /Picture 1.*complete action-start scene.*people, clothing state, setting and pose/);
  assert.match(prompt, /identity and product pictures must not override the starting clothing state/);
  assert.match(prompt, /Video 1 supplies motion, contact and timing/);
});

test("target appearance replaces source appearance and explicit shot instructions take precedence", () => {
  const data = prepared();
  const prompt = sixSegmentDirection(data.segments[1].referenceImages!, data.segments[1], "人物和碎花服装以参考图为准；无切镜。");
  assert.match(prompt, /Replace the source video's corresponding appearance with the target appearance defined by the pictures/);
  assert.match(prompt, /Preserve unspecified appearance from Picture 1/);
  assert.match(prompt, /Character references define identity only; do not copy their unrelated clothes/);
  assert.match(prompt, /Explicit requirements below override source camera movement and shot changes/);
  assert.match(prompt, /无切镜/);
  assert.doesNotMatch(prompt, /not dedicated endpoint ports/);
});

test("a token reviewed before the direction correction cannot authorize the new prompt", () => {
  const data: VideoJobData = { version: 1, generationMode: "six_references", workflowProfile: "sixref-v1", imageCalls: 0,
    segments: [{ index: 0, start: 0, duration: 5, trimStart: 0, sourceWindowDuration: 5, attempt: 0,
      instructions: "Close the front", beforeState: "Open front", afterState: "Closed front", clipKey: "videos/job/segments/0/source.mp4",
      referenceImages: [{ assetId: "state", role: "start_state", label: "Target scene", key: "videos/job/segments/0/references/0.png", sha256: "a".repeat(64) }] }] };
  // 2026-10-18 修改前由真实 reviewToken() 取得的固定夹具，不重新实现旧摘要算法。
  const previousToken = "11d579be72bb7f5e541825783515f2ef5f4876ecf8d5bfc59ca7681d578cedd7";
  const current = reviewToken({ jobId: "job", data, quote: null });
  assert.deepEqual(checkReviewToken(previousToken, current), { ok: false, status: 409, reason: "review_changed" });
  assert.deepEqual(checkReviewToken(current, current), { ok: true });
});
test("segment prompt allows a planned final hold without a contradictory blanket still-frame ban", () => {
  const data = prepared();
  const segment = { ...data.segments[2], instructions: "Finish the waist adjustment, then hold on the prone baby.",
    afterState: "The camera holds still on the finished clothing." };
  const prompt = sixSegmentDirection(segment.referenceImages!, segment, "Follow the source action and its final pause.");
  assert.match(prompt, /Action: Finish the waist adjustment, then hold on the prone baby\./);
  assert.match(prompt, /After: The camera holds still on the finished clothing\./);
  assert.doesNotMatch(prompt, /or hold a still frame\./);
  assert.match(prompt, /Preserve.*pauses.*holds.*source motion.*segment plan/);
});
test("completed predecessor cannot be used until exact candidate reviewed; review binds dependency and quote", () => {
  let data = prepared();
  const before = referenceDigest(data);
  const token = reviewToken({ jobId: "job", data, quote: 100 });
  const previous = data.segments[1];
  Object.assign(previous, { candidateKey: "videos/job/segments/1/attempt-0/candidate.mp4", candidateSha256: "b".repeat(64), tailKey: "videos/job/segments/1/attempt-0/tail.png", tailSha256: "c".repeat(64), candidateMedia: { duration: 6, width: 704, height: 1280 } });
  assert.throws(() => effectiveSixReferences(data, data.segments[2]));
  assert.equal(referenceDigest(data), before, "unaccepted result cannot mutate the approved input plan");
  assert.throws(() => applyCandidateReview(data, [{ segment_index: 1, candidate_sha256: "wrong", action: "accept" }]));
  const candidateToken = candidateReviewToken("job", data);
  data = applyCandidateReview(data, [{ segment_index: 1, candidate_sha256: previous.candidateSha256, action: "accept" }]);
  assert.notEqual(candidateReviewToken("job", data), candidateToken);
  assert.notEqual(referenceDigest(data), before);
  assert.deepEqual(readySixSegments(data).map(s => s.index), [0, 2]);
  assert.equal(effectiveSixReferences(data, data.segments[2])[0].sha256, previous.tailSha256);
  assert.deepEqual(effectiveSixReferences(data, data.segments[2]).slice(1).map(ref => ref.assetId), data.segments[2].referenceImages!.slice(1).map(ref => ref.assetId));
  assert.deepEqual(data.segments[2].referenceImages!.map(ref => ref.assetId), refs.map(ref => ref.asset_id));
  assert.notEqual(reviewToken({ jobId: "job", data, quote: 100 }), token);
  assert.notEqual(reviewToken({ jobId: "job", data, quote: 101 }), reviewToken({ jobId: "job", data, quote: 100 }));
});
test("selected retry preserves old receipt and requires fresh consent; used predecessor retry rejects", () => {
  const data = prepared();
  Object.assign(data.segments[1], { candidateKey: "old.mp4", candidateSha256: "b".repeat(64), tailKey: "tail.png", tailSha256: "c".repeat(64), buildId: "build-old", accepted: true });
  const next = applyCandidateReview(data, [{ segment_index: 1, candidate_sha256: "b".repeat(64), action: "retry", reason: "袖口外观不符合目标" }]);
  assert.equal(next.segments[1].attempt, 1);
  assert.equal(next.segments[1].history![0].buildId, "build-old");
  assert.equal(next.segments[1].buildId, undefined);
  assert.equal(next.renderConsent, undefined);
  assert.deepEqual(readySixSegments(next).map(s => s.index), [0, 1]);
  data.segments[2].submissionIntentAt = new Date().toISOString();
  assert.throws(() => applyCandidateReview(data, [{ segment_index: 1, candidate_sha256: "b".repeat(64), action: "retry", reason: "不符合" }]));
});

test("a known pre-submit failure requires explicit retry before it becomes ready again", () => {
  const data = prepared();
  data.segments[0].terminalFailure = true;
  assert.deepEqual(readySixSegments(data).map(s => s.index), [1]);
  const next = applyCandidateReview(data, [{ segment_index: 0, candidate_sha256: "failed", action: "retry", reason: "已修复素材读取错误" }]);
  assert.equal(next.segments[0].attempt, 1);
  assert.deepEqual(readySixSegments(next).map(s => s.index), [0, 1]);
});


test("reviewed leading repeat can be trimmed without another paid attempt and trim binds acceptance", () => {
  const data = prepared();
  Object.assign(data.segments[1], { candidateKey: "old.mp4", candidateSha256: "b".repeat(64), tailKey: "tail.png", tailSha256: "c".repeat(64), buildId: "build-old", candidateMedia: { duration: 6.583333, width: 704, height: 1280 } });
  const before = candidateReviewToken("job", data);
  const next = applyCandidateReview(data, [{ segment_index: 1, candidate_sha256: "b".repeat(64), action: "accept", trim_start: .8 }]);
  assert.equal(next.segments[1].candidateTrimStart, .8);
  assert.equal(next.segments[1].buildId, "build-old");
  assert.notEqual(candidateReviewToken("job", next), before);
  assert.throws(() => applyCandidateReview(data, [{ segment_index: 1, candidate_sha256: "b".repeat(64), action: "accept", trim_start: 6 }]));
});
