import type { BusinessPreparer } from "../../agent/business-preparer";
import { assertApproval, assertStepPolicy, digest } from "../../agent/policy";
import { allocateReservationSlotsInTransaction } from "../../agent/prisma-settlement";
import { json, lockRun, readState } from "../../agent/prisma-state";
import { createBinding, fail, parseBinding, parsePreparation, record } from "./binding";
import { lockPermitAccount, lockVideoJob, runtimeJobData, validateMaterials } from "./prisma-runtime";
import type { ImageStorageConfig } from "../../jobs/image-storage-port";
import { validatePreparedJob } from "./preparation";

/** 注册到 core 的 video.generate 准备器，仅使用调用方事务；存储域名由服务端显式传入。 */
export function createVideoBusinessPreparer(storageConfig: ImageStorageConfig = {}): BusinessPreparer {
  return async ({ tx, actor, step, approval, reservationRefs }) => {
  if (!approval || typeof step.input.jobId !== "string") fail("approval_required");
  await lockRun(tx, actor, step.runId);
  const state = await readState(tx, actor, step.runId);
  assertStepPolicy(actor, state.snapshot.run, step, step.quote, state.snapshot.run.plan.pricingVersion);
  assertApproval(approval, state.snapshot.run, step, state.now);
  const hint = await tx.videoJob.findFirst({ where: { id: step.input.jobId, user_id: actor.userId } });
  if (!hint) return fail("job_missing");
  const { preparation: prepared, consent } = parsePreparation(hint.data);
  if (prepared.quoteVersion !== state.snapshot.run.plan.pricingVersion || consent.acceptedAt > state.now) fail("preparation_mismatch");
  await lockPermitAccount(tx, prepared.accountId);
  const job = await lockVideoJob(tx, actor.userId, hint.id);
  if (digest(parsePreparation(job.data).preparation) !== digest(prepared)) fail("preparation_changed");
  if (record(job.data).videoRuntime) {
    const old = parseBinding(job.data);
    if (old.coreAttemptId !== step.attemptId || old.runId !== step.runId || old.stepKey !== step.stepKey || old.userId !== actor.userId
      || old.approvalId !== approval.id || old.approvalRevision !== approval.revision || old.coreInputDigest !== step.inputDigest
      || old.reviewDigest !== step.input.reviewDigest || old.jobId !== step.input.jobId) fail("job_already_bound");
    if (!await validateMaterials(tx, job, old, storageConfig)) fail("material_changed");
    return { jobId: job.id };
  }
  const b = createBinding(actor, step, approval, job.data);
  if (!await validateMaterials(tx, job, b, storageConfig)) fail("material_changed");
  if (!validatePreparedJob(job, prepared, true) || await tx.videoPermit.count({ where: { job_id: job.id } })) fail("job_not_prepared");
  if (reservationRefs.length !== 1 || reservationRefs[0].unit !== "video_second"
    || reservationRefs[0].attemptId !== step.attemptId || reservationRefs[0].runId !== step.runId) fail("reservation_mismatch");
  await allocateReservationSlotsInTransaction(tx, actor, reservationRefs[0], b.segments.map(s => ({ slotAttemptId: s.slotAttemptId, amount: s.duration })));
  await tx.videoJob.update({ where: { id: job.id }, data: { data: json(runtimeJobData(job.data, b)), revision: { increment: 1 } } });
  return { jobId: job.id };
  };
}
export const prepareVideoBusinessJob = createVideoBusinessPreparer();
