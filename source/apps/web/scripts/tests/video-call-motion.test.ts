import test from "node:test";
import assert from "node:assert/strict";
import * as assets from "../../lib/video-calls/assets";

// 当前H3工作流会编码参考音频；必须在任何供应商提交之前拦截缺轨素材。
const validate = (media: object) => {
  const fn = (assets as unknown as Record<string, unknown>).assertCallMotionReady;
  assert.equal(typeof fn, "function", "motion validation must be available before paid submission");
  (fn as (value: object) => void)(media);
};
const base = { duration: 5, width: 720, height: 1280, hasAudio: true, videoCodec: "h264", audioCodec: "aac" };
test("当前H3动作参考缺音轨或无可识别音频编码时免费拒绝", () => {
  assert.throws(() => validate({ ...base, hasAudio: false, audioCodec: undefined }), { code: "motion_audio_required" });
  assert.throws(() => validate({ ...base, audioCodec: "" }), { code: "motion_audio_required" });
});
test("有效音频参考可以继续；画幅和时长边界保持拒绝", () => {
  assert.doesNotThrow(() => validate(base));
  assert.throws(() => validate({ ...base, width: 1280, height: 720 }), { code: "unsupported_motion_media" });
  assert.throws(() => validate({ ...base, duration: 31 }), { code: "unsupported_motion_media" });
});
