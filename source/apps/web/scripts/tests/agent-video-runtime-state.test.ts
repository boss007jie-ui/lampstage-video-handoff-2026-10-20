import assert from "node:assert/strict";
import test from "node:test";
import type { ActorContext, AgentStep, Approval, ReservationSlot, RunSnapshot } from "../../lib/agent/contracts";
import { digest } from "../../lib/agent/policy";
import { allocateSlots, applySlotEvidence } from "../../lib/agent/settlement";
import type { VideoGenerationBackend, VideoSubmissionGate, VideoSubmissionResult } from "../../lib/video/backends/contracts";
import { createRunningHubBackend } from "../../lib/video/backends/runninghub";
import { collectorIdentity, createBinding, intentFor, parentOutcome, parseBinding, rejectLegacy, reviewDigest, validateReceipt, type VideoPreparation } from "../../lib/video/backend-runtime/binding";
import { candidateIdentityDigest, candidateKey, type CandidateCollector } from "../../lib/video/backend-runtime/collector";
import type { RuntimeStore } from "../../lib/video/backend-runtime/prisma-runtime";
import { VideoRuntime } from "../../lib/video/backend-runtime/runner";
import { authorized, claimLease, finalize, gate, observeSubmission, publishReceipt, rejectPrepared, release, type RuntimeTransaction } from "../../lib/video/backend-runtime/transitions";

const actor: ActorContext = { userId: "user", source: "worker", permissions: ["video.generate"] };
function fixture(count = 1) {
  const p: VideoPreparation = { version: 1, userId: "user", jobId: "job", backendId: "fake", accountId: "account", configurationDigest: digest("config"), preparedJobDigest: digest("prepared-job"),
    mode: "direct_references", pricingBasis: "approved-request-duration", quoteVersion: "v1", materials: [
      { kind: "video_asset", role: "source", assetId: "asset", sha256: digest("asset"), storageKey: "videos/source.mp4" },
      { kind: "uploaded_asset", role: "product", assetId: "product", sha256: digest("image"), imageContentId: "content", assetLocation: "/uploads/user/asset.png", contentLocation: "/uploads/user/content.png" }],
    segments: Array.from({ length: count }, (_, index) => ({ index, duration: 2, width: 64, height: 64, maxCoins: 12, window: { start: index * 2, end: index * 2 + 2 },
      input: { applicationId: "fake-app", mappingVersion: "v1", configurationDigest: digest("config"), values: { prompt: "private-material-description" } } })) };
  const data = { videoPreparation: p, videoConsent: { version: 1, userId: "user", reviewDigest: reviewDigest(p), acceptedAt: 1, revokedAt: null }, segments: [] };
  const input = { jobId: "job", reviewDigest: reviewDigest(p) }, quote = { video_second: count * 2 };
  const step: AgentStep = { runId: "run", userId: "user", stepKey: "video", attemptId: "core-attempt", modelTurnId: "turn", toolCallId: "call",
    toolName: "video.generate", planDigest: "plan", inputDigest: digest(input), quoteDigest: digest(quote), input, quote, requiresApproval: true,
    status: "pending", approvalId: "approval", approvalRevision: 1, submissionFence: 1, jobId: "job", outcome: null, businessManaged: true };
  const approval: Approval = { id: "approval", runId: "run", userId: "user", planDigest: "plan", pricingVersion: "v1", allowedTools: ["video.generate"],
    limits: { maxToolCalls: 1, budget: quote }, expiresAt: 100000, revokedAt: null, revision: 1 };
  const b = createBinding(actor, step, approval, data);
  const core: RunSnapshot = { run: { id: "run", userId: "user", threadId: "thread", clientRequestId: "request", creationDigest: "creation", planDigest: "plan",
    plan: { revision: 1, pricingVersion: "v1", actions: [] }, limits: { maxModelCalls: 2, maxToolCalls: 1, budget: quote }, status: "waiting_job", revision: 1,
    fence: 99, lease: null, modelCalls: 1, toolCalls: 1 }, steps: [step], approvals: [approval], reservations: [{ runId: "run", userId: "user", approvalId: "approval",
    attemptId: "core-attempt", unit: "video_second", reservedAmount: count * 2, settledAmount: 0, releasedAmount: 0, status: "reserved", settlementBasis: null }], turns: [] };
  const state: RuntimeTransaction = { now: 1000, actor, binding: b, currentData: data, core, materialsValid: true, permits: [], jobs: [], effects: [] };
  return new MemoryStore(state);
}
class MemoryStore implements RuntimeStore {
  private tail: Promise<unknown> = Promise.resolve();
  slots: ReservationSlot[];
  fault: ((state: RuntimeTransaction) => boolean) | null = null;
  constructor(public state: RuntimeTransaction) { this.slots = allocateSlots(state.core.reservations[0], state.binding.segments.map(s => ({ slotAttemptId: s.slotAttemptId, amount: s.duration }))); }
  atomic<T>(who: ActorContext, jobId: string, operation: (t: RuntimeTransaction) => T): Promise<T> {
    const run = this.tail.then(() => {
      assert.equal(who.userId, this.state.binding.userId); assert.equal(jobId, this.state.binding.jobId);
      const next = structuredClone(this.state), slots = structuredClone(this.slots); next.effects = [];
      const result = operation(next);
      for (const effect of next.effects) {
        const update = applySlotEvidence(next.core.reservations[0], slots, effect);
        next.core.reservations[0] = update.reservation;
        slots[slots.findIndex(s => s.slotAttemptId === update.slot.slotAttemptId)] = update.slot;
      }
      if (this.fault?.(next)) throw new Error("persistence_failed");
      const b = next.binding;
      next.jobs = [...next.jobs.filter(j => j.id !== b.jobId), { id: b.jobId, status: "generating", phase: "render", owner: b.lease?.owner ?? null,
        until: b.lease?.expiresAt ?? null, segments: b.segments.map(s => ({ index: s.index, attempt: s.attempt })) }];
      this.state = next; this.slots = slots; return structuredClone(result);
    });
    this.tail = run.catch(() => {}); return run;
  }
}
const collector: CandidateCollector = { recover: async () => null, collect: async identity => ({ key: candidateKey(identity), identityDigest: candidateIdentityDigest(identity),
  sha256: digest("video-bytes"), sizeBytes: 1234, duration: identity.requestedDuration, width: identity.width, height: identity.height }) };
function engine(store: MemoryStore, options: { submit?: VideoSubmissionResult; status?: string; modes?: boolean;
  beforeGate?: () => void; afterGate?: () => void; afterPost?: () => void; swallowGateError?: boolean } = {}) {
  const calls = { posts: 0, reads: [] as string[] };
  const runtime = new VideoRuntime(store, (b, g: VideoSubmissionGate): VideoGenerationBackend => ({ backendId: "fake",
    capabilities: { submit: true, status: true, results: true, cancel: false, billing: false, enabledModes: options.modes === false ? [] : ["direct_references"],
      sixReferences: { enabled: false, verification: "unknown" }, sourceWindow: { enabled: false, verification: "unknown" }, audio: { enabled: false, verification: "unknown" } },
    submit: async request => {
      options.beforeGate?.();
      let decision;
      try { decision = await g.claim(request.intent, b.segments.find(s => s.intentId === request.intent.intentId)!.input); }
      catch (error) { if (options.swallowGateError) return { kind: "submission_unknown", code: "submission_transport_unknown" }; throw error; }
      if (decision !== "claimed") return { kind: "definite_not_submitted", code: "authorization_denied" };
      options.afterGate?.(); calls.posts++; options.afterPost?.();
      return options.submit ?? { kind: "accepted", taskId: "original-task" };
    },
    status: async task => { calls.reads.push(task.taskId); return options.status === "failed" ? { kind: "failed", code: "provider_task_failed" }
      : options.status === "read_error" ? { kind: "read_error", code: "provider_task_not_found", retryable: true }
      : options.status === "running" ? { kind: "running" } : { kind: "completed" }; },
    results: async () => ({ kind: "completed", outputs: [{ downloadUrl: "https://private.example/video?sig=secret", mediaType: "video", expiresAt: null }] }),
  }), collector);
  const run = async () => { const token = await runtime.claim(actor, "job", "worker"); assert.ok(token); return runtime.run(actor, token); };
  return { runtime, calls, run };
}
test("fixed mapping and consent covers backend/configuration/material/windows/coins", () => {
  const f = fixture(2), b = f.state.binding;
  assert.match(b.segments[0].slotAttemptId, /^[a-zA-Z0-9_.-]+$/); assert.equal(b.segments[0].permitAttemptId, "job:0:1");
  for (const mutate of [(p: VideoPreparation) => p.backendId = "other", (p: VideoPreparation) => p.configurationDigest = digest("other"),
    (p: VideoPreparation) => p.segments[0].maxCoins++, (p: VideoPreparation) => p.segments[0].window.end++, (p: VideoPreparation) => p.materials[0].sha256 = digest("changed")]) {
    const changed = structuredClone(b.preparation); mutate(changed); assert.notEqual(reviewDigest(changed), b.reviewDigest);
  }
  assert.equal(parseBinding({ videoRuntime: b }).segments[0].intentId, b.segments[0].intentId);
});
test("binding refuses legacy history, cross-user and model-supplied fields", () => {
  const f = fixture(), { binding: b, core } = f.state;
  for (const legacy of [{ buildId: "old" }, { segments: [{ index: 0, providerTaskId: "old" }] }, { submissionIntent: {} }])
    assert.throws(() => createBinding(actor, core.steps[0], core.approvals[0], { ...f.state.currentData as object, ...legacy }), /legacy_job/);
  assert.throws(() => createBinding({ ...actor, userId: "other" }, core.steps[0], core.approvals[0], f.state.currentData), /preparation_mismatch/);
  assert.throws(() => createBinding(actor, { ...core.steps[0], input: { ...core.steps[0].input, accountId: "forged" } }, core.approvals[0], f.state.currentData), /preparation_mismatch/);
  assert.throws(() => parseBinding({ videoRuntime: { ...b, version: 2 } }), /invalid_binding/);
});
test("concurrent claim and gate commit exactly one intent; stale same-owner fence rejected", async () => {
  const f = fixture(), e = engine(f), claims = await Promise.all([e.runtime.claim(actor, "job", "worker"), e.runtime.claim(actor, "job", "worker")]);
  assert.equal(claims.filter(Boolean).length, 1); const token = claims.find(Boolean)!;
  const b = f.state.binding, s = b.segments[0];
  const results = await Promise.all([0, 1].map(() => f.atomic(actor, "job", t => gate(t, token, intentFor(b, s), s.input))));
  assert.deepEqual(results, ["claimed", "already_claimed"]); assert.equal(f.state.permits.length, 1);
  await e.runtime.release(actor, token); assert.equal(f.state.permits[0].status, "unknown");
  const next = await e.runtime.claim(actor, "job", "worker"); assert.equal(next!.fence, token.fence + 1);
  await assert.rejects(e.runtime.release(actor, token), /lease_lost/);
});
for (const reason of ["expired", "revoked", "revision", "material", "configuration", "consent", "cancel", "terminal-step"] as const) {
  test(`gate denies ${reason} before POST`, async () => {
    const f = fixture(), e = engine(f, { beforeGate: () => {
      if (reason === "expired") f.state.core.approvals[0].expiresAt = 0;
      if (reason === "revoked") f.state.core.approvals[0].revokedAt = 1;
      if (reason === "revision") f.state.core.approvals[0].revision++;
      if (reason === "material") f.state.materialsValid = false;
      if (reason === "configuration") (f.state.currentData as any).videoPreparation.configurationDigest = digest("changed");
      if (reason === "consent") (f.state.currentData as any).videoConsent.revokedAt = 1;
      if (reason === "cancel") f.state.core.run.status = "cancel_requested";
      if (reason === "terminal-step") f.state.core.steps[0].status = "succeeded";
    } });
    await e.run(); assert.equal(e.calls.posts, 0); assert.equal(f.state.permits.length, 0); assert.equal(f.state.binding.segments[0].state, "prepared");
  });
}
for (const at of ["afterGate", "afterPost"] as const) test(`cancel ${at} preserves original intent and recovers original task`, async () => {
  const f = fixture(), e = engine(f, { [at]: () => { f.state.core.run.status = "cancel_requested"; } });
  await e.run(); assert.equal(e.calls.posts, 1); assert.equal(f.state.binding.segments[0].state, "unknown");
  assert.equal(f.state.permits[0].status, "unknown"); assert.equal(f.slots[0].status, "unknown");
  const final = await e.run(); assert.equal(final.kind, "succeeded"); assert.equal(e.calls.posts, 1); assert.deepEqual(e.calls.reads, ["original-task"]);
  assert.equal(f.slots[0].settledAmount, 2); assert.equal(f.state.permits[0].status, "released");
});
for (const response of [{ kind: "submission_unknown", code: "submission_http_unknown", taskId: "original-task" },
  { kind: "submission_unknown", code: "submission_transport_unknown" }] as const) test(`unknown ${response.code} never resubmits`, async () => {
  const f = fixture(), e = engine(f, { submit: response, status: "read_error" });
  await e.run(); await e.run(); assert.equal(e.calls.posts, 1); assert.equal(f.slots[0].status, "unknown");
  assert.equal(f.state.permits[0].status, "unknown"); assert.equal(f.state.binding.segments[0].providerTaskId, "taskId" in response ? response.taskId : null);
});
test("late approval expiry returns already_claimed and late terminal contradictions cannot rewrite settlement", async () => {
  const f = fixture(), e = engine(f); await e.run();
  const token = (await e.runtime.claim(actor, "job", "worker"))!, b = f.state.binding, s = b.segments[0];
  f.state.core.approvals[0].expiresAt = 0;
  assert.equal(await f.atomic(actor, "job", t => gate(t, token, intentFor(b, s), s.input)), "already_claimed");
  await f.atomic(actor, "job", t => finalize(t, token, 0, "failed"));
  await f.atomic(actor, "job", t => finalize(t, token, 0, "provider_completed"));
  assert.equal(f.state.binding.segments[0].state, "failed"); assert.equal(f.slots[0].settledAmount, 2); assert.equal(f.slots[0].releasedAmount, 0);
  assert.equal(f.state.permits[0].maxCoins, 12); assert.equal(parentOutcome(f.state.binding, 1).kind, "failed");
});
test("definite rejection releases requested seconds; closed modes issue zero POST", async () => {
  for (const options of [{ submit: { kind: "definite_not_submitted", code: "provider_submission_rejected" } as const }, { modes: false }]) {
    const f = fixture(), e = engine(f, options), result = await e.run();
    assert.equal(result.kind, "failed"); assert.equal(f.slots[0].releasedAmount, 2); assert.equal(f.slots[0].settledAmount, 0);
    assert.equal(e.calls.posts, "modes" in options ? 0 : 1);
    assert.equal((result as any).disposition, "charged");
  }
});
test("unknown account blocks siblings and a valid legacy lease counts toward shared cap", async () => {
  for (const state of ["unknown", "full", "orphan"] as const) {
    const f = fixture(), e = engine(f);
    for (let i = 0; i < (state === "full" ? 3 : 1); i++) {
      f.state.permits.push({ accountId: "account", jobId: `old${i}`, attemptId: `old${i}:0:1`, segmentIndex: 0, maxCoins: 3, status: state === "unknown" ? "unknown" : "active" });
      if (state === "full") f.state.jobs.push({ id: `old${i}`, status: "generating", phase: "render", owner: "old-worker", until: 90000, segments: [{ index: 0, attempt: 1 }] });
    }
    await e.run(); assert.equal(e.calls.posts, 0); assert.equal(f.state.binding.segments[0].state, "prepared");
    if (state === "orphan") assert.equal(f.state.permits[0].status, "unknown");
  }
});
test("receipt save failure stops pass; original artifact/task remains recoverable without extra POST", async () => {
  const f = fixture(2), e = engine(f);
  // 第一片段仍 active 时可提交第二片段；释放租约时两者都保守隔离。
  await e.run(); assert.equal(e.calls.posts, 2);
  f.fault = t => t.binding.segments[0].state === "collected";
  await assert.rejects(e.run(), /persistence_failed/); assert.equal(e.calls.posts, 2);
  assert.equal(f.state.binding.segments[0].state, "provider_completed"); assert.equal(f.slots[0].settledAmount, 2);
  f.fault = null; assert.equal((await e.run()).kind, "succeeded"); assert.equal(e.calls.posts, 2);
});
test("submission receipt failure never resends, gate persistence failure is propagated even if backend swallows it", async () => {
  const f = fixture(), e = engine(f); f.fault = t => t.binding.segments[0].state === "accepted";
  await assert.rejects(e.run(), /persistence_failed/); assert.equal(e.calls.posts, 1);
  f.fault = null; await e.run(); assert.equal(e.calls.posts, 1); assert.equal(f.state.binding.segments[0].providerTaskId, null);
  const g = fixture(), other = engine(g, { swallowGateError: true }); g.fault = t => t.binding.segments[0].state === "submitting";
  await assert.rejects(other.run(), /persistence_failed/); assert.equal(other.calls.posts, 0); assert.equal(g.state.permits.length, 0);
});
test("cross-account receipt and corrupt persisted collected state are rejected; public outcome has no private fields", async () => {
  const f = fixture(), e = engine(f); await e.run();
  const token = (await e.runtime.claim(actor, "job", "worker"))!;
  await f.atomic(actor, "job", t => finalize(t, token, 0, "provider_completed"));
  const identity = collectorIdentity(f.state.binding, f.state.binding.segments[0]);
  const bad = await collector.collect({ ...identity, userId: "other" }, "private");
  await assert.rejects(f.atomic(actor, "job", t => publishReceipt(t, token, 0, bad)), /receipt_mismatch/);
  const b = structuredClone(f.state.binding); b.segments[0].state = "collected";
  assert.throws(() => parseBinding({ videoRuntime: b }), /receipt_mismatch/);
  const good = await collector.collect(identity, "private"); await f.atomic(actor, "job", t => publishReceipt(t, token, 0, good));
  assert.equal(/private|https|prompt|sig=|account|task/.test(JSON.stringify(parentOutcome(f.state.binding, 0))), false);
});
test("stored artifact recovery publishes receipt after crash without backend lookup or new submit", async () => {
  const f = fixture(), e = engine(f); await e.run();
  let token = (await e.runtime.claim(actor, "job", "worker"))!;
  await f.atomic(actor, "job", t => finalize(t, token, 0, "provider_completed"));
  await e.runtime.release(actor, token);
  const receipt = await collector.collect(collectorIdentity(f.state.binding, f.state.binding.segments[0]), "unused");
  let resolutions = 0;
  const runtime = new VideoRuntime(f, () => { resolutions++; return null; }, { collect: collector.collect, recover: async () => receipt });
  token = (await runtime.claim(actor, "job", "worker"))!;
  f.fault = t => t.binding.segments[0].state === "collected";
  await assert.rejects(runtime.run(actor, token), /persistence_failed/);
  assert.equal(f.state.binding.segments[0].receipt, null);
  f.fault = null; token = (await runtime.claim(actor, "job", "worker"))!;
  assert.equal((await runtime.run(actor, token)).kind, "succeeded");
  assert.equal(resolutions, 0); assert.equal(e.calls.posts, 1);
});
test("missing historical configuration stops recovery without new submit or releasing unresolved permit", async () => {
  const f = fixture(), e = engine(f); await e.run();
  const runtime = new VideoRuntime(f, () => null, collector), token = (await runtime.claim(actor, "job", "worker"))!;
  await assert.rejects(runtime.run(actor, token), /configuration_unavailable/);
  assert.equal(e.calls.posts, 1); assert.equal(f.state.permits[0].status, "unknown"); assert.equal(f.slots[0].settledAmount, 0);
});
test("actual RunningHub adapter capabilities remain closed and runtime performs zero transport calls", async () => {
  const f = fixture(); let calls = 0;
  const options = { apiKey: "offline-fixture-key", application: { accountId: "offline", webappId: "900000000000000001", mappingVersion: "v1",
    mappingEvidence: "offline-test-only", bindings: [{ inputKey: "prompt", nodeId: "900", fieldName: "text" }] },
    transport: async () => { calls++; return { status: 200, body: JSON.stringify({ code: 0, data: { taskId: "123" } }) }; } };
  const backendId = createRunningHubBackend({ ...options, gate: { claim: async () => "claimed" } }).backendId;
  const data = f.state.currentData as any; data.videoPreparation.backendId = backendId;
  data.videoConsent.reviewDigest = reviewDigest(data.videoPreparation);
  const step = f.state.core.steps[0]; step.input.reviewDigest = data.videoConsent.reviewDigest; step.inputDigest = digest(step.input);
  f.state.binding = createBinding(actor, step, f.state.core.approvals[0], data);
  const runtime = new VideoRuntime(f, (_, gate) => createRunningHubBackend({ ...options, gate }), collector);
  const token = (await runtime.claim(actor, "job", "worker"))!;
  assert.equal((await runtime.run(actor, token)).kind, "failed"); assert.equal(calls, 0); assert.equal(f.state.permits.length, 0);
});
test("legacy intent, candidate, terminal and history evidence never receives a new attempt", () => {
  for (const evidence of [{ submissionIntentAt: "2026-10-16T00:00:00Z" }, { candidateKey: "old.mp4" }, { candidateSha256: digest("old") },
    { terminalFailure: true }, { accepted: false }, { attempt: 1 }, { history: [{ attempt: 0, reason: "unknown" }] },
    { history: [{ attempt: 0, submissionIntentAt: "old", buildId: "old", providerTaskId: "old", candidateKey: "old" }] }]) {
    assert.throws(() => rejectLegacy({ ...evidence, segments: [] }), /legacy_job/);
    assert.throws(() => rejectLegacy({ segments: [{ index: 0, ...evidence }] }), /legacy_job/);
  }
  assert.doesNotThrow(() => rejectLegacy({ segments: [{ index: 0, attempt: 0, history: [] }] }));
});
test("receipt publication uses the same 0.5 second drift ceiling as collection", async () => {
  const f = fixture(), b = f.state.binding, s = b.segments[0];
  const receipt = await collector.collect(collectorIdentity(b, s), "unused");
  assert.doesNotThrow(() => validateReceipt(b, s, { ...receipt, duration: s.duration + 0.5 }));
  assert.throws(() => validateReceipt(b, s, { ...receipt, duration: s.duration + 0.500001 }), /receipt_mismatch/);
});
