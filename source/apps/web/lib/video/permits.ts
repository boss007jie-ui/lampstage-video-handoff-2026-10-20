import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";

const ACCOUNT_VIDEO_LIMIT = 3;

export type VideoPermitRequest = {
  /** Stable provider account identity, never an API key or key hash. */
  accountId: string;
  /** `${jobId}:${segmentIndex}:${attempt}`; retain across recovery. */
  attemptId: string;
  jobId: string;
  segmentIndex: number;
  /** Estimate only. Null means no reliable quote was available. */
  reservedCoins: number | null;
  /** Approved maximum for this attempt, not an upstream billing cap. */
  maxCoins: number;
};

export type VideoPermitAcquisition =
  | { acquired: true; alreadyAcquired: boolean; attemptId: string }
  | { acquired: false; reason: "busy"; activeCount: number }
  | { acquired: false; reason: "blocked"; blockedBy: "unknown" | "attempt_finalized" | "job_inactive" };

export type AdoptedVideoPermit = {
  attemptId: string;
  status: "active" | "unknown" | "released";
  alreadyPresent: boolean;
};

export class VideoPermitSubmissionBlockedError extends Error {
  constructor(public readonly reason: "missing" | "inactive" | "account_unknown") {
    super(`Video submission blocked: ${reason}`);
    this.name = "VideoPermitSubmissionBlockedError";
  }
}

function validate(request: VideoPermitRequest): void {
  if (!request.accountId.trim() || !request.attemptId.trim() || !request.jobId.trim()) {
    throw new Error("Video permit requires accountId, attemptId, and jobId");
  }
  if (!Number.isSafeInteger(request.segmentIndex) || request.segmentIndex < 0) {
    throw new Error("Video permit segmentIndex must be a nonnegative integer");
  }
  if (!Number.isSafeInteger(request.maxCoins) || request.maxCoins < 0 ||
      (request.reservedCoins !== null &&
        (!Number.isSafeInteger(request.reservedCoins) || request.reservedCoins < 0 || request.reservedCoins > request.maxCoins))) {
    throw new Error("Video permit budget must be nonnegative and reservedCoins cannot exceed maxCoins");
  }
}

/**
 * The account update takes a PostgreSQL row lock until the transaction commits.
 * All acquire/unknown/release writers use this same lock before reading permits.
 * There is deliberately no lease expiry: an uncertain paid request needs an
 * explicit terminal reconciliation before its slot can be reused.
 */
async function lockAccount(tx: Prisma.TransactionClient, accountId: string) {
  await tx.videoPermitAccount.upsert({
    where: { id: accountId },
    create: { id: accountId },
    // A non-empty update keeps Prisma's PostgreSQL upsert atomic under a first-use race.
    update: { lock_version: { increment: 1 } },
  });
  await tx.videoPermitAccount.update({
    where: { id: accountId },
    data: { lock_version: { increment: 1 } },
  });
}

/** Shared with closeVideoJob. Always Account -> Job; closure never takes Account. */
async function lockJob(tx: Prisma.TransactionClient, jobId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "VideoJob" WHERE id = ${jobId} FOR UPDATE`;
  if (rows.length !== 1) return null;
  return tx.videoJob.findUnique({ where: { id: jobId }, select: {
    id: true, status: true, phase: true, lease_owner: true, lease_until: true, data: true,
  } });
}
function renderingAttempt(job: Awaited<ReturnType<typeof lockJob>>, request: VideoPermitRequest): boolean {
  if (!job || job.status !== "generating" || job.phase !== "render" || !job.lease_owner || !job.lease_until || job.lease_until <= new Date()) return false;
  const data = job.data as { segments?: { index: number; attempt?: number }[] } | null;
  const segment = Array.isArray(data?.segments) ? data.segments.find(s => s.index === request.segmentIndex) : undefined;
  return Boolean(segment && request.attemptId === `${job.id}:${segment.index}:${segment.attempt ?? 0}`);
}

/** A crashed worker cannot leave an apparently healthy slot while other workers spend. */
async function quarantineOrphanPermits(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
  const active = await tx.videoPermit.findMany({ where: { account_id: accountId, status: "active" } });
  if (!active.length) return;
  const jobs = await tx.videoJob.findMany({ where: { id: { in: [...new Set(active.map(p => p.job_id))] } },
    select: { id: true, status: true, phase: true, lease_owner: true, lease_until: true, data: true } });
  const now = new Date();
  for (const permit of active) {
    const job = jobs.find(j => j.id === permit.job_id);
    const value = job?.data as { segments?: { index: number; attempt?: number }[] } | undefined;
    const segment = Array.isArray(value?.segments) ? value.segments.find(s => s.index === permit.segment_index) : undefined;
    if (!job || job.status !== "generating" || job.phase !== "render" || !job.lease_owner || !job.lease_until || job.lease_until <= now ||
      !segment || permit.attempt_id !== `${job.id}:${segment.index}:${segment.attempt ?? 0}`) {
      await tx.videoPermit.update({ where: { attempt_id: permit.attempt_id }, data: { status: "unknown", unknown_at: now } });
    }
  }
}

/** Persist a slot before sending a paid RunningHub request. */
export async function acquireVideoPermit(
  request: VideoPermitRequest,
  client: PrismaClient = prisma,
): Promise<VideoPermitAcquisition> {
  validate(request);
  return client.$transaction(async (tx) => {
    await lockAccount(tx, request.accountId);
    await quarantineOrphanPermits(tx, request.accountId);
    const existing = await tx.videoPermit.findUnique({ where: { attempt_id: request.attemptId } });
    if (existing) {
      if (existing.account_id !== request.accountId || existing.job_id !== request.jobId ||
          existing.segment_index !== request.segmentIndex || existing.reserved_coins !== request.reservedCoins ||
          existing.max_coins !== request.maxCoins) {
        throw new Error(`Video permit attempt ID ${request.attemptId} was reused with different details`);
      }
      if (existing.status === "active" && !renderingAttempt(await lockJob(tx, request.jobId), request))
        return { acquired: false as const, reason: "blocked" as const, blockedBy: "job_inactive" as const };
      return existing.status === "active"
        ? { acquired: true as const, alreadyAcquired: true, attemptId: request.attemptId }
        : { acquired: false as const, reason: "blocked" as const, blockedBy: "attempt_finalized" as const };
    }

    // Any uncertain outcome pauses all NEW paid submissions for this account.
    const unknown = await tx.videoPermit.findFirst({
      where: { account_id: request.accountId, status: "unknown" },
      select: { attempt_id: true },
    });
    if (unknown) return { acquired: false as const, reason: "blocked" as const, blockedBy: "unknown" as const };

    const activeCount = await tx.videoPermit.count({
      where: { account_id: request.accountId, status: "active" },
    });
    if (activeCount >= ACCOUNT_VIDEO_LIMIT) {
      return { acquired: false as const, reason: "busy" as const, activeCount };
    }
    if (!renderingAttempt(await lockJob(tx, request.jobId), request))
      return { acquired: false as const, reason: "blocked" as const, blockedBy: "job_inactive" as const };
    await tx.videoPermit.create({
      data: {
        attempt_id: request.attemptId,
        account_id: request.accountId,
        job_id: request.jobId,
        segment_index: request.segmentIndex,
        reserved_coins: request.reservedCoins,
        max_coins: request.maxCoins,
        status: "active",
      },
    });
    return { acquired: true as const, alreadyAcquired: false, attemptId: request.attemptId };
  });
}

/**
 * Register a paid submission intent/receipt saved before permits were deployed.
 * This never authorizes a new submission and deliberately bypasses slot capacity:
 * the upstream work may already exist, so an unknown row must block future spend.
 */
export async function adoptExistingVideoPermit(
  request: VideoPermitRequest,
  client: PrismaClient = prisma,
): Promise<AdoptedVideoPermit> {
  validate(request);
  return client.$transaction(async (tx) => {
    await lockAccount(tx, request.accountId);
    const existing = await tx.videoPermit.findUnique({ where: { attempt_id: request.attemptId } });
    if (existing) {
      if (existing.account_id !== request.accountId || existing.job_id !== request.jobId ||
          existing.segment_index !== request.segmentIndex) {
        throw new Error(`Video permit attempt ID ${request.attemptId} was reused with different identity`);
      }
      return { attemptId: request.attemptId,
        status: existing.status as AdoptedVideoPermit["status"], alreadyPresent: true };
    }
    const job = await lockJob(tx, request.jobId);
    if (!job || !["queued", "preparing", "review", "generating", "assembling", "attention"].includes(job.status))
      throw new VideoPermitSubmissionBlockedError("inactive");
    await tx.videoPermit.create({ data: {
      attempt_id: request.attemptId,
      account_id: request.accountId,
      job_id: request.jobId,
      segment_index: request.segmentIndex,
      reserved_coins: request.reservedCoins,
      max_coins: request.maxCoins,
      status: "unknown",
      unknown_at: new Date(),
    } });
    return { attemptId: request.attemptId, status: "unknown", alreadyPresent: false };
  });
}

/** Final durable gate immediately before the paid upstream submission. */
export async function assertVideoPermitMaySubmit(attemptId: string, client: PrismaClient = prisma): Promise<void> {
  if (!attemptId.trim()) throw new VideoPermitSubmissionBlockedError("missing");
  const record = await client.videoPermit.findUnique({
    where: { attempt_id: attemptId }, select: { account_id: true, job_id: true },
  });
  if (!record) throw new VideoPermitSubmissionBlockedError("missing");
  await client.$transaction(async (tx) => {
    await lockAccount(tx, record.account_id);
    await lockJob(tx, record.job_id);
    await quarantineOrphanPermits(tx, record.account_id);
    const current = await tx.videoPermit.findUnique({ where: { attempt_id: attemptId } });
    if (!current || current.status !== "active") throw new VideoPermitSubmissionBlockedError("inactive");
    const unknown = await tx.videoPermit.findFirst({
      where: { account_id: current.account_id, status: "unknown" },
      select: { attempt_id: true },
    });
    if (unknown) throw new VideoPermitSubmissionBlockedError("account_unknown");
  });
}

async function transitionVideoPermit(
  attemptId: string,
  next: "unknown" | "released",
  client: PrismaClient,
): Promise<"missing" | "active" | "unknown" | "released"> {
  if (!attemptId.trim()) throw new Error("Video permit attemptId is required");
  const record = await client.videoPermit.findUnique({
    where: { attempt_id: attemptId }, select: { account_id: true },
  });
  if (!record) return "missing";
  return client.$transaction(async (tx) => {
    await lockAccount(tx, record.account_id);
    const current = await tx.videoPermit.findUnique({ where: { attempt_id: attemptId } });
    if (!current) return "missing";
    if (current.status === "released" || current.status === next) return current.status as "unknown" | "released";
    await tx.videoPermit.update({
      where: { attempt_id: attemptId },
      data: next === "unknown"
        ? { status: "unknown", unknown_at: new Date() }
        : { status: "released", released_at: new Date() },
    });
    return next;
  });
}

/** Keep the slot and block new submissions after an uncertain upstream outcome. */
export function markVideoPermitUnknown(attemptId: string, client: PrismaClient = prisma) {
  return transitionVideoPermit(attemptId, "unknown", client);
}

/** Call only after a known upstream terminal result, including terminal failure. */
export function releaseVideoPermit(attemptId: string, client: PrismaClient = prisma) {
  return transitionVideoPermit(attemptId, "released", client);
}

/** Recovery/audit view; active and unknown rows survive worker restarts. */
export function listUnresolvedVideoPermits(accountId: string, client: PrismaClient = prisma) {
  if (!accountId.trim()) throw new Error("Video permit accountId is required");
  return client.videoPermit.findMany({
    where: { account_id: accountId, status: { in: ["active", "unknown"] } },
    orderBy: { created_at: "asc" },
  });
}
