import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { withIsolatedAgentPostgres } from "./helpers/isolated-agent-postgres";
import { PrismaAgentRepository } from "../../lib/agent/prisma-repository";
import type { ActorContext, Plan } from "../../lib/agent/contracts";
import { reviewDigest, parseBinding, intentFor, parentOutcome, type VideoPreparation } from "../../lib/video/backend-runtime/binding";
import { preparedJobDigest } from "../../lib/video/backend-runtime/preparation";
import { prepareVideoBusinessJob } from "../../lib/video/backend-runtime/preparer";
import { PrismaVideoRuntimeStore, type RuntimeFaultPoint } from "../../lib/video/backend-runtime/prisma-runtime";
import { claimLease, gate, heartbeat, observeSubmission, release, finalize, rejectPrepared } from "../../lib/video/backend-runtime/transitions";
import { VideoRuntime } from "../../lib/video/backend-runtime/runner";
import { candidateKey, candidateIdentityDigest, type CandidateCollector, type CandidateReceipt } from "../../lib/video/backend-runtime/collector";
import type { VideoGenerationBackend } from "../../lib/video/backends/contracts";
import { segmentTimeline } from "../../lib/video/media";

test("video runtime: isolated PostgreSQL migrations, binding, fencing and atomic gate", { timeout: 180000 }, async t => {
  await withIsolatedAgentPostgres(async url => {
    const a = new PrismaClient({ datasourceUrl: url, log: [] });
    const b = new PrismaClient({ datasourceUrl: url, log: [] });
    try {
      const migrations = path.resolve("prisma/migrations");
      for (const name of (await readdir(migrations)).filter(n => /^\d/.test(n)).sort()) {
        const sql = (await readFile(path.join(migrations, name, "migration.sql"), "utf8")).replace(/^\s*--.*$/gm, "");
        for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await a.$executeRawUnsafe(statement);
      }
      const repo = (client: PrismaClient) => new PrismaAgentRepository(client, { preparers: { "video.generate": prepareVideoBusinessJob } });
      const storeA = new PrismaVideoRuntimeStore(a), storeB = new PrismaVideoRuntimeStore(b);
      async function fixture(options: { count?: number; jobData?: Record<string, unknown>; accountId?: string; failAfterPrepare?: boolean;
        status?: string; phase?: string; sourceOwnerMismatch?: boolean; sourceHashMismatch?: boolean;
        uploadOwnerMismatch?: boolean; contentOwnerMismatch?: boolean; contentHashMismatch?: boolean } = {}) {
        const actor: ActorContext = { userId: randomUUID(), source: "session", permissions: ["video.generate"] };
        await a.user.create({ data: { id: actor.userId } });
        const source = await a.videoAsset.create({ data: { user_id: actor.userId, storage_key: `private/${randomUUID()}`, mime: "video/mp4", size_bytes: 100, status: "ready", sha256: "a".repeat(64) } });
        const jobId = randomUUID(), count = options.count ?? 2;
        const images = [];
        for (const [index, role] of ["product", "character", "scene"].entries()) {
          const sha256 = String.fromCharCode(98 + index).repeat(64);
          const contentLocation = `/uploads/${actor.userId}/content-${jobId}-${index}.png`;
          const assetLocation = `/uploads/${actor.userId}/asset-${jobId}-${index}.png`;
          const content = await a.imageContent.create({ data: { user_id: actor.userId, sha256,
            storage_url: contentLocation, mime: "image/png", size_bytes: 100, width: 64, height: 64 } });
          const asset = await a.uploadedAsset.create({ data: { user_id: actor.userId, image_url: assetLocation,
            image_content_id: content.id, file_type: "image/png", width: 64, height: 64 } });
          images.push({ index, role, asset, content, sha256, assetLocation, contentLocation });
        }
        const product = images[0].asset;
        const sourceDuration = count * 4;
        const actualSegments = segmentTimeline(sourceDuration);
        assert.equal(actualSegments.length, count);
        const requestedSeconds = actualSegments.reduce((total, segment) => total + segment.duration, 0);
        const oldData = { version: 1, generationMode: "direct_references", imageCalls: 0,
          sourceDuration, sourceHasAudio: false,
          referenceImages: images.map(image => ({ assetId: image.asset.id, role: image.role, label: image.role,
            key: `videos/${jobId}/references/${image.index}.png`, sha256: image.sha256 })),
          segments: actualSegments.map(segment => ({ ...segment,
            clipKey: `videos/${jobId}/segments/${segment.index}/source.mp4` })) };
        const suppliedData = { ...options.jobData };
        if (Array.isArray(suppliedData.segments)) suppliedData.segments = suppliedData.segments.map((segment, index) => ({
          ...oldData.segments[index], ...(segment as Record<string, unknown>),
          clipKey: `videos/${jobId}/segments/${index}/source.mp4`,
        }));
        const initial = await a.videoJob.create({ data: { id: jobId, user_id: actor.userId, source_asset_id: source.id,
          product_asset_id: product.id, title: "isolated video", instructions: "private instruction", preserve_audio: false,
          status: options.status ?? "review", phase: options.phase ?? "prepare_references",
          data: { ...oldData, ...suppliedData } as unknown as Prisma.InputJsonValue } });
        const preparation: VideoPreparation = { version: 1, userId: actor.userId, jobId, backendId: "fake-video", accountId: options.accountId ?? `acct-${randomUUID()}`,
          configurationDigest: "c".repeat(64), mode: "direct_references", pricingBasis: "test-quote", quoteVersion: "price-video-1",
          preparedJobDigest: preparedJobDigest(initial),
          materials: [{ kind: "video_asset", role: "source", assetId: source.id, sha256: source.sha256!, storageKey: source.storage_key },
            ...images.map(image => ({ kind: "uploaded_asset" as const, role: image.index === 0 ? "product" as const : "reference" as const,
              assetId: image.asset.id, sha256: image.sha256, imageContentId: image.content.id,
              assetLocation: image.assetLocation, contentLocation: image.contentLocation }))],
          segments: actualSegments.map(segment => ({ index: segment.index, duration: segment.duration, width: 64, height: 64,
            window: { start: segment.start, end: segment.start + segment.duration }, maxCoins: 9,
            input: { applicationId: "fake-app", mappingVersion: "v1", configurationDigest: "c".repeat(64), values: { prompt: `private-${segment.index}` } } })) };
        const consent = { version: 1, userId: actor.userId, reviewDigest: reviewDigest(preparation), acceptedAt: Date.now() - 1000, revokedAt: null };
        await a.videoJob.update({ where: { id: jobId }, data: { data: { ...oldData, ...suppliedData,
          videoPreparation: preparation, videoConsent: suppliedData.videoConsent ?? consent } as unknown as Prisma.InputJsonValue } });
        if (options.sourceOwnerMismatch || options.uploadOwnerMismatch || options.contentOwnerMismatch) {
          const other = randomUUID(); await a.user.create({ data: { id: other } });
          if (options.sourceOwnerMismatch) await a.videoAsset.update({ where: { id: source.id }, data: { user_id: other } });
          if (options.uploadOwnerMismatch) await a.uploadedAsset.update({ where: { id: product.id }, data: { user_id: other } });
          if (options.contentOwnerMismatch) await a.imageContent.update({ where: { id: images[1].content.id }, data: { user_id: other } });
        }
        if (options.sourceHashMismatch) await a.videoAsset.update({ where: { id: source.id }, data: { sha256: "e".repeat(64) } });
        if (options.contentHashMismatch) await a.imageContent.update({ where: { id: images[1].content.id }, data: { sha256: "f".repeat(64) } });
        const primary = options.failAfterPrepare ? new PrismaAgentRepository(a, { preparers: { "video.generate": async context => {
          await prepareVideoBusinessJob(context); throw new Error("after_video_preparer");
        } } }) : repo(a);
        const secondary = repo(b), thread = await primary.createThread(actor);
        const plan: Plan = { revision: 1, pricingVersion: "price-video-1", actions: [{ actionKey: "video-step", toolName: "video.generate",
          input: { jobId, reviewDigest: consent.reviewDigest }, quote: { video_second: requestedSeconds }, requiresApproval: true }] };
        const run = await primary.createRun(actor, { threadId: thread.id, clientRequestId: "video-request", plan,
          limits: { maxModelCalls: 3, maxToolCalls: 1, budget: { video_second: requestedSeconds } } });
        const approval = await primary.grantApproval(actor, { runId: run.id, planDigest: run.planDigest, pricingVersion: "price-video-1",
          allowedTools: ["video.generate"], expiresAt: Date.now() + 600000,
          limits: { maxToolCalls: 1, budget: { video_second: requestedSeconds } } });
        const coreLease = (await primary.claimLease(actor, run.id, "core-worker", 60000))!;
        const turn = await primary.beginModelTurn(coreLease);
        await primary.saveModelTurn(coreLease, turn.id, { assistantText: "private", toolCalls: [{ toolCallId: "video-call", actionKey: "video-step", toolName: "video.generate", input: plan.actions[0].input }] });
        const submit = () => primary.beginSubmission(coreLease, "video-step", { video_second: requestedSeconds }, "price-video-1");
        return { actor, source, product, images, jobId, preparation, consent, primary, secondary, run, approval, coreLease, submit };
      }
      const binding = async (jobId: string) => parseBinding((await b.videoJob.findUniqueOrThrow({ where: { id: jobId } })).data);
      const gateFirst = async (store: PrismaVideoRuntimeStore, actor: ActorContext, token: NonNullable<Awaited<ReturnType<typeof claimLease>>>, jobId: string, index = 0) => {
        const current = await binding(jobId), segment = current.segments[index];
        return store.atomic(actor, jobId, tx => gate(tx, token, intentFor(tx.binding, tx.binding.segments[index]), segment.input));
      };

      await t.test("preparer binds original job once and creates stable child slots", async () => {
        const f = await fixture();
        const reviewed = await b.videoJob.findUniqueOrThrow({ where: { id: f.jobId } });
        assert.equal(reviewed.status, "review"); assert.equal(reviewed.phase, "prepare_references");
        assert.equal(f.preparation.preparedJobDigest, preparedJobDigest(reviewed));
        assert.deepEqual(f.preparation.materials.map(m => m.kind), ["video_asset", "uploaded_asset", "uploaded_asset", "uploaded_asset"]);
        const first = await f.submit(); assert.equal(first.kind, "dispatch"); assert.equal(first.step.jobId, f.jobId);
        const initial = await binding(f.jobId);
        assert.equal(initial.segments.length, 2);
        assert.equal(new Set(initial.segments.map(s => s.slotAttemptId)).size, 2);
        assert.ok(initial.segments.every(s => !s.slotAttemptId.includes(":") && s.permitAttemptId === `${f.jobId}:${s.index}:1`));
        const slots = await b.agentReservationSlot.findMany({ where: { run_id: f.run.id } });
        assert.deepEqual(new Set(slots.map(s => s.slot_attempt_id)), new Set(initial.segments.map(s => s.slotAttemptId)));
        assert.deepEqual(slots.map(s => Number(s.allocated_amount)).sort(), [4, 5]);
        assert.equal((await f.secondary.beginSubmission(f.coreLease, "video-step", { video_second: 9 }, "price-video-1")).kind, "existing");
        assert.deepEqual(await binding(f.jobId), initial);
        assert.equal(await b.videoJob.count({ where: { id: f.jobId } }), 1);
      });

      await t.test("preparer rejects mismatched consent and legacy submission with no slots", async () => {
        const legacyData: Record<string, unknown>[] = [
          { videoConsent: { version: 1, userId: "wrong", reviewDigest: "x", acceptedAt: 1, revokedAt: null } },
          { buildId: "old-build" }, { providerTaskId: "old-task" }, { submissionIntentAt: "2026-01-01T00:00:00Z" },
          { outputKey: "videos/old/output.mp4" }, { cancellation: { at: "2026-01-01T00:00:00Z", reason: "user_cancelled" } },
          ...[{ buildId: "old-build" }, { providerTaskId: "old-task" }, { submissionIntentAt: "2026-01-01T00:00:00Z" },
            { candidateKey: "videos/old/candidate.mp4" }, { terminalFailure: true }, { attempt: 1 },
            { history: [{ attempt: 0, reason: "old" }] }].map(extra => ({ segments: [{ index: 0, start: 0, duration: 4, trimStart: 0,
              clipKey: "videos/old/source.mp4", ...extra }] })),
        ];
        for (const jobData of legacyData) {
          const f = await fixture({ count: 1, jobData });
          await assert.rejects(f.submit(), /repository_failure/);
          assert.equal(await b.agentReservationSlot.count({ where: { run_id: f.run.id } }), 0);
          assert.equal(await b.videoPermit.count({ where: { job_id: f.jobId } }), 0);
          assert.equal((await b.videoJob.findUniqueOrThrow({ where: { id: f.jobId } })).revision, 0);
        }
      });

      await t.test("preparer rejects invalid state, phase, source and uploaded image ownership or hash", async () => {
        const cases = [{ status: "ready" }, { phase: "render" }, { phase: "reconcile" },
          { sourceOwnerMismatch: true }, { sourceHashMismatch: true }, { uploadOwnerMismatch: true },
          { contentOwnerMismatch: true }, { contentHashMismatch: true }] as const;
        for (const options of cases) {
          const f = await fixture({ count: 1, ...options });
          await assert.rejects(f.submit(), /repository_failure/);
          assert.equal(await b.agentReservationSlot.count({ where: { run_id: f.run.id } }), 0);
          assert.equal(await b.videoPermit.count({ where: { job_id: f.jobId } }), 0);
        }
      });

      await t.test("failure after preparer returns rolls back binding, slots and core reservation", async () => {
        const f = await fixture({ count: 2, failAfterPrepare: true });
        const before = await f.secondary.load(f.actor, f.run.id);
        await assert.rejects(f.submit(), /repository_failure/);
        assert.equal(await b.agentReservationSlot.count({ where: { run_id: f.run.id } }), 0);
        assert.equal(await b.agentReservation.count({ where: { run_id: f.run.id } }), 0);
        assert.equal((await b.videoJob.findUniqueOrThrow({ where: { id: f.jobId } })).revision, 0);
        assert.deepEqual(await f.secondary.load(f.actor, f.run.id), before);
      });

      await t.test("two Prisma clients serialize claim and gate; a reused owner string cannot reuse an old fence", async () => {
        const f = await fixture({ count: 1 }); await f.submit();
        const claims = await Promise.all([storeA.atomic(f.actor, f.jobId, tx => claimLease(tx, "same-owner", 60000)),
          storeB.atomic(f.actor, f.jobId, tx => claimLease(tx, "same-owner", 60000))]);
        assert.equal(claims.filter(Boolean).length, 1);
        const token = claims.find(Boolean)!;
        const results = await Promise.all([gateFirst(storeA, f.actor, token, f.jobId), gateFirst(storeB, f.actor, token, f.jobId)]);
        assert.deepEqual(results.sort(), ["already_claimed", "claimed"]);
        assert.equal(await b.videoPermit.count({ where: { job_id: f.jobId } }), 1);
        assert.equal((await b.videoJob.findUniqueOrThrow({ where: { id: f.jobId } })).lease_owner, "same-owner");
        await storeA.atomic(f.actor, f.jobId, tx => release(tx, token));
        const next = (await storeB.atomic(f.actor, f.jobId, tx => claimLease(tx, "same-owner", 60000)))!;
        assert.equal(next.fence, token.fence + 1);
        for (const op of [() => storeA.atomic(f.actor, f.jobId, tx => heartbeat(tx, token, 60000)),
          () => storeA.atomic(f.actor, f.jobId, tx => observeSubmission(tx, token, 0, { kind: "accepted", taskId: "late" })),
          () => storeA.atomic(f.actor, f.jobId, tx => release(tx, token))]) await assert.rejects(op(), /lease_lost/);
        assert.equal((await binding(f.jobId)).segments[0].state, "unknown");
        assert.equal((await b.videoPermit.findFirstOrThrow({ where: { job_id: f.jobId } })).status, "unknown");
      });

      await t.test("faults after permit, binding and slot writes roll back the entire gate", async () => {
        for (const point of ["after_permits", "after_binding", "after_slots"] as RuntimeFaultPoint[]) {
          const f = await fixture({ count: 1 }); await f.submit();
          const token = (await storeA.atomic(f.actor, f.jobId, tx => claimLease(tx, "fault-worker", 60000)))!;
          const before = await binding(f.jobId);
          const faulty = new PrismaVideoRuntimeStore(b, where => { if (where === point) throw new Error("injected"); });
          await assert.rejects(gateFirst(faulty, f.actor, token, f.jobId), /persistence_failed/);
          assert.deepEqual(await binding(f.jobId), before);
          assert.equal(await a.videoPermit.count({ where: { job_id: f.jobId } }), 0);
          const slots = await a.agentReservationSlot.findMany({ where: { run_id: f.run.id } });
          assert.ok(slots.every(s => s.settled_amount === 0n && s.released_amount === 0n));
          assert.equal(await gateFirst(storeA, f.actor, token, f.jobId), "claimed");
        }
      });

      await t.test("after_slots fault on final settlement rolls back slot, permit and binding", async () => {
        const f = await fixture({ count: 1 }); await f.submit();
        const token = (await storeA.atomic(f.actor, f.jobId, tx => claimLease(tx, "settlement-fault", 60000)))!;
        assert.equal(await gateFirst(storeA, f.actor, token, f.jobId), "claimed");
        await storeA.atomic(f.actor, f.jobId, tx => observeSubmission(tx, token, 0, { kind: "accepted", taskId: "settle-task" }));
        const beforeBinding = await binding(f.jobId);
        const beforePermit = await b.videoPermit.findFirstOrThrow({ where: { job_id: f.jobId } });
        const beforeSlot = await b.agentReservationSlot.findFirstOrThrow({ where: { run_id: f.run.id } });
        const beforeReservation = await b.agentReservation.findFirstOrThrow({ where: { run_id: f.run.id } });
        const faulty = new PrismaVideoRuntimeStore(b, point => { if (point === "after_slots") throw new Error("injected_after_slots"); });
        await assert.rejects(faulty.atomic(f.actor, f.jobId, tx => finalize(tx, token, 0, "failed")), /persistence_failed/);
        assert.deepEqual(await binding(f.jobId), beforeBinding);
        assert.deepEqual(await b.videoPermit.findFirstOrThrow({ where: { job_id: f.jobId } }), beforePermit);
        assert.deepEqual(await b.agentReservationSlot.findFirstOrThrow({ where: { run_id: f.run.id } }), beforeSlot);
        assert.deepEqual(await b.agentReservation.findFirstOrThrow({ where: { run_id: f.run.id } }), beforeReservation);
      });

      await t.test("cancellation before gate blocks submission; cancellation after gate preserves intent and permit", async () => {
        const before = await fixture({ count: 1 }); await before.submit();
        const beforeToken = (await storeA.atomic(before.actor, before.jobId, tx => claimLease(tx, "before", 60000)))!;
        await before.secondary.cancelRun(before.actor, before.run.id);
        assert.equal(await gateFirst(storeA, before.actor, beforeToken, before.jobId), "not_authorized");
        assert.equal(await a.videoPermit.count({ where: { job_id: before.jobId } }), 0);
        const after = await fixture({ count: 1 }); await after.submit();
        const afterToken = (await storeA.atomic(after.actor, after.jobId, tx => claimLease(tx, "after", 60000)))!;
        assert.equal(await gateFirst(storeA, after.actor, afterToken, after.jobId), "claimed");
        await after.secondary.cancelRun(after.actor, after.run.id);
        assert.equal(await gateFirst(storeB, after.actor, afterToken, after.jobId), "already_claimed");
        await storeB.atomic(after.actor, after.jobId, tx => observeSubmission(tx, afterToken, 0, { kind: "submission_unknown", code: "submission_transport_unknown", taskId: "original-task" }));
        assert.equal((await binding(after.jobId)).segments[0].providerTaskId, "original-task");
        assert.equal((await a.videoPermit.findFirstOrThrow({ where: { job_id: after.jobId } })).status, "unknown");
      });

      await t.test("revoked approval, changed source/uploaded material or preparation close the gate without permit", async () => {
        for (const cause of ["approval", "source_hash", "uploaded_location", "content_hash", "job_instructions", "configuration"] as const) {
          const f = await fixture({ count: 1 }); await f.submit();
          const token = (await storeA.atomic(f.actor, f.jobId, tx => claimLease(tx, cause, 60000)))!;
          if (cause === "approval") await f.secondary.revokeApproval(f.actor, f.run.id, f.approval.id);
          if (cause === "source_hash") await a.videoAsset.update({ where: { id: f.source.id }, data: { sha256: "d".repeat(64) } });
          if (cause === "uploaded_location") await a.uploadedAsset.update({ where: { id: f.product.id },
            data: { image_url: `/uploads/${f.actor.userId}/changed.png` } });
          if (cause === "content_hash") await a.imageContent.update({ where: { id: f.images[1].content.id },
            data: { sha256: "f".repeat(64) } });
          if (cause === "job_instructions") await a.videoJob.update({ where: { id: f.jobId },
            data: { instructions: "changed after review" } });
          if (cause === "configuration") {
            const job = await a.videoJob.findUniqueOrThrow({ where: { id: f.jobId } });
            const data = job.data as Record<string, unknown>;
            await a.videoJob.update({ where: { id: f.jobId }, data: { data: { ...data, videoPreparation: { ...f.preparation,
              configurationDigest: "e".repeat(64) } } as unknown as Prisma.InputJsonValue } });
          }
          assert.equal(await gateFirst(storeB, f.actor, token, f.jobId), "not_authorized");
          assert.equal(await b.videoPermit.count({ where: { job_id: f.jobId } }), 0);
          assert.equal((await binding(f.jobId)).segments[0].state, "prepared");
        }
      });

      await t.test("accepted task terminal failure settles exact child slot; duplicate terminal cannot charge again", async () => {
        const f = await fixture({ count: 1 }); await f.submit();
        const token = (await storeA.atomic(f.actor, f.jobId, tx => claimLease(tx, "terminal", 60000)))!;
        assert.equal(await gateFirst(storeA, f.actor, token, f.jobId), "claimed");
        await storeB.atomic(f.actor, f.jobId, tx => observeSubmission(tx, token, 0, { kind: "accepted", taskId: "task-1" }));
        await storeA.atomic(f.actor, f.jobId, tx => finalize(tx, token, 0, "failed"));
        const settled = await a.agentReservationSlot.findFirstOrThrow({ where: { run_id: f.run.id } });
        assert.equal(settled.settled_amount, 4n); assert.equal(settled.released_amount, 0n);
        assert.equal((await a.videoPermit.findFirstOrThrow({ where: { job_id: f.jobId } })).status, "released");
        await storeB.atomic(f.actor, f.jobId, tx => finalize(tx, token, 0, "provider_completed"));
        assert.equal((await binding(f.jobId)).segments[0].state, "failed");
        assert.deepEqual(await b.agentReservationSlot.findFirstOrThrow({ where: { run_id: f.run.id } }), settled);
      });

      await t.test("core pending releases its lease; original job settles two child slots before parent outcome", async () => {
        const f = await fixture({ count: 2 });
        const submitted = await f.submit(), step = submitted.step;
        await f.primary.recordOutcome(f.coreLease, step.stepKey, step.attemptId,
          { kind: "pending", jobId: f.jobId, nextCheckAt: Date.now() + 1000 });
        await f.primary.releaseLease(f.coreLease);
        const token = (await storeB.atomic(f.actor, f.jobId, tx => claimLease(tx, "video-after-core", 60000)))!;
        assert.equal(await gateFirst(storeB, f.actor, token, f.jobId, 0), "claimed");
        await storeB.atomic(f.actor, f.jobId, tx => observeSubmission(tx, token, 0, { kind: "accepted", taskId: "core-task" }));
        await storeA.atomic(f.actor, f.jobId, tx => finalize(tx, token, 0, "failed"));
        await storeA.atomic(f.actor, f.jobId, tx => rejectPrepared(tx, token, 1));
        const bound = await binding(f.jobId);
        const slots = await a.agentReservationSlot.findMany({ where: { run_id: f.run.id } });
        assert.deepEqual(slots.map(s => [Number(s.settled_amount), Number(s.released_amount)]).sort(), [[0, 4], [5, 0]]);
        const parent = parentOutcome(bound, Date.now());
        assert.equal(parent.kind, "failed");
        if (parent.kind === "failed") { assert.equal(parent.disposition, "charged"); assert.equal(parent.usage?.video_second, 5); }
        const nextCore = (await f.secondary.claimLease(f.actor, f.run.id, "core-recovery", 60000))!;
        await f.secondary.recordOutcome(nextCore, step.stepKey, step.attemptId, parent);
        const core = await f.secondary.load(f.actor, f.run.id);
        assert.equal(core.steps[0].jobId, f.jobId);
        assert.equal(core.steps[0].status, "failed");
        assert.equal(core.reservations[0].settledAmount, 5);
        assert.equal(core.reservations[0].releasedAmount, 4);
      });

      await t.test("bounded runtime makes one POST; restart queries original task and never resubmits", async () => {
        const f = await fixture({ count: 1 }); await f.submit();
        let posts = 0, reads = 0;
        const collector: CandidateCollector = { async collect() { throw new Error("unused"); }, async recover() { return null; } };
        const makeRuntime = (store: PrismaVideoRuntimeStore) => new VideoRuntime(store, (bound, submissionGate): VideoGenerationBackend => ({
          backendId: bound.backendId,
          capabilities: { submit: true, status: true, results: true, cancel: false, billing: false, enabledModes: ["direct_references"],
            sixReferences: { enabled: false, verification: "unknown" }, sourceWindow: { enabled: false, verification: "unknown" },
            audio: { enabled: false, verification: "unknown" } },
          async submit(request) {
            const decision = await submissionGate.claim(request.intent, bound.segments[0].input);
            if (decision !== "claimed") return { kind: "definite_not_submitted", code: "intent_claim_unavailable" };
            posts++; return { kind: "accepted", taskId: "task-original" };
          },
          async status(task) { reads++; assert.equal(task.taskId, "task-original"); return { kind: "running" }; },
          async results() { throw new Error("unused"); },
        }), collector);
        const first = makeRuntime(storeA);
        const token = (await first.claim(f.actor, f.jobId, "submitter"))!;
        assert.equal((await first.run(f.actor, token)).kind, "pending");
        assert.equal(posts, 1);
        assert.equal((await binding(f.jobId)).segments[0].providerTaskId, "task-original");
        const firstIntent = (await binding(f.jobId)).segments[0].intentId;
        assert.equal((await b.videoPermit.findFirstOrThrow({ where: { job_id: f.jobId } })).status, "unknown");
        const resumed = makeRuntime(storeB), next = (await resumed.claim(f.actor, f.jobId, "recoverer"))!;
        assert.equal((await resumed.run(f.actor, next)).kind, "pending");
        assert.equal(posts, 1); assert.equal(reads, 1);
        assert.equal((await binding(f.jobId)).segments[0].intentId, firstIntent);
      });

      await t.test("runner cancellation barriers before gate, after commit and after POST", async () => {
        for (const barrier of ["before_gate", "after_gate", "after_post"] as const) {
          const f = await fixture({ count: 1 }); await f.submit();
          let posts = 0;
          const collector: CandidateCollector = { async collect() { throw new Error("unused"); }, async recover() { return null; } };
          const runtime = new VideoRuntime(storeA, (bound, submissionGate): VideoGenerationBackend => ({
            backendId: bound.backendId,
            capabilities: { submit: true, status: true, results: true, cancel: false, billing: false, enabledModes: ["direct_references"],
              sixReferences: { enabled: false, verification: "unknown" }, sourceWindow: { enabled: false, verification: "unknown" },
              audio: { enabled: false, verification: "unknown" } },
            async submit(request) {
              if (barrier === "before_gate") await f.secondary.cancelRun(f.actor, f.run.id);
              const decision = await submissionGate.claim(request.intent, bound.segments[0].input);
              if (decision !== "claimed") return { kind: "definite_not_submitted", code: "intent_claim_unavailable" };
              if (barrier === "after_gate") await f.secondary.cancelRun(f.actor, f.run.id);
              posts++;
              if (barrier === "after_post") await f.secondary.cancelRun(f.actor, f.run.id);
              return { kind: "accepted", taskId: `barrier-${barrier}` };
            },
            async status() { return { kind: "running" }; }, async results() { throw new Error("unused"); },
          }), collector);
          const token = (await runtime.claim(f.actor, f.jobId, `barrier-${barrier}`))!;
          await runtime.run(f.actor, token);
          assert.equal(posts, barrier === "before_gate" ? 0 : 1);
          assert.equal(await b.videoPermit.count({ where: { job_id: f.jobId } }), barrier === "before_gate" ? 0 : 1);
          if (barrier !== "before_gate") {
            assert.equal((await binding(f.jobId)).segments[0].providerTaskId, `barrier-${barrier}`);
            assert.equal((await b.videoPermit.findFirstOrThrow({ where: { job_id: f.jobId } })).status, "unknown");
          }
        }
      });

      await t.test("successful receipt publication crash recovers stored artifact and fills exact core outcome", async () => {
        const f = await fixture({ count: 1 }); const { step } = await f.submit();
        await f.primary.recordOutcome(f.coreLease, step.stepKey, step.attemptId, { kind: "pending", jobId: f.jobId, nextCheckAt: 0 });
        await f.primary.releaseLease(f.coreLease);
        let stored: CandidateReceipt | null = null, posts = 0, downloads = 0, resolutions = 0;
        const collector: CandidateCollector = { async recover() { return stored; }, async collect(identity) {
          downloads++; stored = { key: candidateKey(identity), identityDigest: candidateIdentityDigest(identity), sha256: "f".repeat(64),
            sizeBytes: 123, duration: 4, width: 64, height: 64 }; return stored;
        } };
        const resolver = (bound: ReturnType<typeof parseBinding>, submissionGate: import("../../lib/video/backends/contracts").VideoSubmissionGate): VideoGenerationBackend => {
          resolutions++; return { backendId: bound.backendId,
            capabilities: { submit: true, status: true, results: true, cancel: false, billing: false, enabledModes: ["direct_references"],
              sixReferences: { enabled: false, verification: "unknown" }, sourceWindow: { enabled: false, verification: "unknown" }, audio: { enabled: false, verification: "unknown" } },
            async submit(request) { assert.equal(await submissionGate.claim(request.intent, bound.segments[0].input), "claimed"); posts++; return { kind: "accepted", taskId: "one-task" }; },
            async status(task) { assert.equal(task.taskId, "one-task"); return { kind: "completed" }; },
            async results() { return { kind: "completed", outputs: [{ mediaType: "video", downloadUrl: "https://private.test/video?sig=offline", expiresAt: null }] }; },
          };
        };
        const first = new VideoRuntime(storeA, resolver, collector);
        await first.run(f.actor, (await first.claim(f.actor, f.jobId, "send"))!);
        const failing = new PrismaVideoRuntimeStore(b, point => { if (stored && point === "after_binding") throw new Error("receipt_publish_crash"); });
        const second = new VideoRuntime(failing, resolver, collector);
        await assert.rejects(second.run(f.actor, (await second.claim(f.actor, f.jobId, "collect"))!), /persistence_failed/);
        assert.ok(stored); assert.equal((await binding(f.jobId)).segments[0].state, "provider_completed");
        assert.equal((await a.agentReservationSlot.findFirstOrThrow({ where: { run_id: f.run.id } })).settled_amount, 4n);
        // 清理失败也会回滚；同时让两处租约字段过期，以模拟重启。
        const saved = await a.videoJob.findUniqueOrThrow({ where: { id: f.jobId } }), bound = parseBinding(saved.data);
        bound.lease!.expiresAt = 0;
        await a.videoJob.update({ where: { id: f.jobId }, data: { lease_until: new Date(0), data: { ...saved.data as object, videoRuntime: bound } as unknown as Prisma.InputJsonValue } });
        const previousResolutions = resolutions, third = new VideoRuntime(storeB, resolver, collector);
        const outcome = await third.run(f.actor, (await third.claim(f.actor, f.jobId, "restore"))!);
        assert.equal(outcome.kind, "succeeded"); assert.equal(posts, 1); assert.equal(downloads, 1); assert.equal(resolutions, previousResolutions);
        assert.equal((await a.videoJob.findUniqueOrThrow({ where: { id: f.jobId } })).status, "review");
        const token = (await f.secondary.claimLease(f.actor, f.run.id, "parent", 60000))!;
        await f.secondary.recordOutcome(token, step.stepKey, step.attemptId, outcome);
        assert.equal((await f.primary.load(f.actor, f.run.id)).steps[0].status, "succeeded");
      });

      await t.test("expired runtime lease quarantines its original task and stale fence cannot finalize it", async () => {
        const f = await fixture({ count: 1 }); await f.submit();
        const old = (await storeA.atomic(f.actor, f.jobId, tx => claimLease(tx, "same-owner", 60000)))!;
        await gateFirst(storeA, f.actor, old, f.jobId);
        await storeA.atomic(f.actor, f.jobId, tx => observeSubmission(tx, old, 0, { kind: "accepted", taskId: "keep-original" }));
        const job = await a.videoJob.findUniqueOrThrow({ where: { id: f.jobId } }), bound = parseBinding(job.data); bound.lease!.expiresAt = 0;
        await a.videoJob.update({ where: { id: f.jobId }, data: { lease_until: new Date(0), data: { ...job.data as object, videoRuntime: bound } as unknown as Prisma.InputJsonValue } });
        const next = (await storeB.atomic(f.actor, f.jobId, tx => claimLease(tx, "same-owner", 60000)))!;
        assert.equal(next.fence, old.fence + 1); assert.equal((await binding(f.jobId)).segments[0].providerTaskId, "keep-original");
        assert.equal((await a.videoPermit.findFirstOrThrow({ where: { job_id: f.jobId } })).status, "unknown");
        await assert.rejects(storeA.atomic(f.actor, f.jobId, tx => finalize(tx, old, 0, "failed")), /lease_lost/);
        assert.equal((await a.agentReservationSlot.findFirstOrThrow({ where: { run_id: f.run.id } })).status, "unknown");
      });

      await t.test("unbound legacy job is never claimable and unknown account permit blocks a fresh gate", async () => {
        const f = await fixture({ count: 1 });
        await assert.rejects(storeA.atomic(f.actor, f.jobId, tx => claimLease(tx, "legacy", 60000)), /invalid_binding/);
        await f.submit();
        const token = (await storeA.atomic(f.actor, f.jobId, tx => claimLease(tx, "blocked", 60000)))!;
        await a.videoPermit.create({ data: { attempt_id: `old:${randomUUID()}`, account_id: f.preparation.accountId,
          job_id: `old-${randomUUID()}`, segment_index: 0, max_coins: 10, status: "unknown" } });
        assert.equal(await gateFirst(storeB, f.actor, token, f.jobId), "not_authorized");
        assert.equal(await b.videoPermit.count({ where: { job_id: f.jobId } }), 0);
      });

      await t.test("legacy permits coexist with a live new lease; cap and orphan quarantine preserve original task", async () => {
        const accountId = `shared-${randomUUID()}`;
        const first = await fixture({ count: 1, accountId }); await first.submit();
        const firstToken = (await storeA.atomic(first.actor, first.jobId, tx => claimLease(tx, "live-first", 60000)))!;
        assert.equal(await gateFirst(storeA, first.actor, firstToken, first.jobId), "claimed");
        const second = await fixture({ count: 1, accountId }); await second.submit();
        const secondToken = (await storeB.atomic(second.actor, second.jobId, tx => claimLease(tx, "live-second", 60000)))!;
        assert.equal((await a.videoPermit.findUniqueOrThrow({ where: { attempt_id: (await binding(first.jobId)).segments[0].permitAttemptId } })).status, "active");
        const oldIds: string[] = [];
        for (let i = 0; i < 2; i++) {
          const id = randomUUID(); oldIds.push(id);
          await a.videoJob.create({ data: { id, user_id: first.actor.userId, source_asset_id: first.source.id,
            product_asset_id: first.product.id, title: "old job", status: "generating", phase: "render",
            lease_owner: "old-worker", lease_until: new Date(Date.now() + 60000),
            data: { buildId: "old-build", segments: [{ index: 0, attempt: 1, providerTaskId: `old-task-${i}` }] } } });
          await a.videoPermit.create({ data: { attempt_id: `${id}:0:1`, account_id: accountId, job_id: id,
            segment_index: 0, max_coins: 9, status: "active" } });
        }
        assert.equal(await gateFirst(storeB, second.actor, secondToken, second.jobId), "not_authorized");
        assert.equal((await b.videoPermit.findUniqueOrThrow({ where: { attempt_id: (await binding(first.jobId)).segments[0].permitAttemptId } })).status, "active");
        const firstCore = await first.secondary.load(first.actor, first.run.id);
        const oldBefore = await a.videoJob.findUniqueOrThrow({ where: { id: oldIds[0] } });
        await a.videoJob.update({ where: { id: oldIds[0] }, data: { lease_until: new Date(0) } });
        assert.equal(await gateFirst(storeB, second.actor, secondToken, second.jobId), "not_authorized");
        assert.equal((await b.videoPermit.findUniqueOrThrow({ where: { attempt_id: `${oldIds[0]}:0:1` } })).status, "unknown");
        const oldAfter = await b.videoJob.findUniqueOrThrow({ where: { id: oldIds[0] } });
        assert.deepEqual(oldAfter.data, oldBefore.data);
        assert.equal(oldAfter.revision, oldBefore.revision);
        assert.deepEqual(await first.secondary.load(first.actor, first.run.id), firstCore);
        assert.equal((await b.videoPermit.findUniqueOrThrow({ where: { attempt_id: (await binding(first.jobId)).segments[0].permitAttemptId } })).status, "active");
      });
    } finally {
      await Promise.all([a.$disconnect(), b.$disconnect()]);
    }
  });
  console.log("agent_video_runtime_postgres_stopped_and_cleaned");
});
