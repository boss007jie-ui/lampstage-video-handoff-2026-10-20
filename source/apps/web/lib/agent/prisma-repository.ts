import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { AgentError, type ActorContext, type AgentRun, type AgentThread, type PublicEvent } from "./contracts";
import type { BusinessPreparers } from "./business-preparer";
import type { CreateRunRequest, AgentSessionRepository } from "./repository";
export type { AgentThreadRepository } from "./repository";
import { AgentRepositoryBase, createRunState, type StoredRun } from "./repository-base";
import { assertEventPage, assertSessionKey, digest } from "./policy";
import { appendEvents, databaseNow, lockAccount, lockRun, readState, runData, runFromRow, safe, saveState, validateActor } from "./prisma-state";

/** 显式注入 client，无生产单例、进程缓存或进程内锁。外部工具只在事务提交后执行。 */
export class PrismaAgentRepository extends AgentRepositoryBase implements AgentSessionRepository {
  private readonly preparers: BusinessPreparers;
  constructor(private readonly client: PrismaClient, options: { preparers?: BusinessPreparers } = {}) {
    super();
    this.preparers = Object.freeze({ ...options.preparers });
  }
  async createThread(actor: ActorContext): Promise<AgentThread> {
    return safe(() => this.client.$transaction(async tx => {
      await lockAccount(tx, actor);
      const t = await tx.agentThread.create({ data: { id: randomUUID(), user_id: actor.userId } });
      return { id: t.id, userId: t.user_id, createdAt: t.created_at.getTime() };
    }));
  }
  async loadThread(actor: ActorContext, threadId: string): Promise<AgentThread> {
    validateActor(actor);
    return safe(async () => {
      const t = await this.client.agentThread.findFirst({ where: { id: threadId, user_id: actor.userId } });
      if (!t) throw new AgentError("not_found");
      return { id: t.id, userId: t.user_id, createdAt: t.created_at.getTime() };
    });
  }
  protected readState(actor: ActorContext, runId: string): Promise<StoredRun> {
    return safe(() => this.client.$transaction(tx => readState(tx, actor, runId), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
  }
  async findRunByClientRequestId(actor: ActorContext, threadId: string, clientRequestId: string): Promise<AgentRun | null> {
    validateActor(actor);
    return safe(() => this.client.$transaction(async tx => {
      if (!await tx.agentThread.findFirst({ where: { id: threadId, user_id: actor.userId }, select: { id: true } })) throw new AgentError("not_found");
      assertSessionKey(clientRequestId);
      const row = await tx.agentRun.findUnique({ where: { user_id_thread_id_client_request_id: {
        user_id: actor.userId, thread_id: threadId, client_request_id: clientRequestId } } });
      return row ? runFromRow(row) : null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
  }
  async publicEventPage(actor: ActorContext, runId: string, after: number, take: number, signal?: AbortSignal): Promise<PublicEvent[]> {
    assertEventPage(after, take, signal); validateActor(actor);
    return safe(async () => {
      if (!await this.client.agentRun.findFirst({ where: { id: runId, user_id: actor.userId }, select: { id: true } })) throw new AgentError("not_found");
      assertEventPage(after, take, signal);
      const rows = await this.client.agentEvent.findMany({ where: { run_id: runId, user_id: actor.userId, event_seq: { gt: after } },
        orderBy: { event_seq: "asc" }, take, select: { event_seq: true, type: true, run_status: true, step_number: true, step_status: true } });
      assertEventPage(after, take, signal);
      return rows.map(e => ({ seq: e.event_seq, type: e.type as PublicEvent["type"], runStatus: e.run_status as PublicEvent["runStatus"],
        ...(e.step_number === null ? {} : { stepNumber: e.step_number }), ...(e.step_status === null ? {} : { stepStatus: e.step_status as PublicEvent["stepStatus"] }) }));
    });
  }
  protected async atomic<T>(actor: ActorContext, runId: string, change: (draft: StoredRun) => T, signal?: AbortSignal): Promise<T> {
    this.assertNotAborted(signal);
    return safe(() => this.client.$transaction(async tx => {
      await lockRun(tx, actor, runId);
      this.assertNotAborted(signal);
      const draft = await readState(tx, actor, runId);
      this.assertNotAborted(signal);
      const previousCount = draft.events.length;
      const beforeDigest = digest([draft.snapshot, draft.events]);
      const planned = new Set(draft.snapshot.steps.filter(s => s.status === "planned").map(s => s.attemptId));
      const result = change(draft);
      this.assertNotAborted(signal);
      if (beforeDigest === digest([draft.snapshot, draft.events])) return structuredClone(result);
      const submitting = draft.snapshot.steps.filter(s => planned.has(s.attemptId) && s.status === "submitting");
      for (const step of submitting) {
        const prepare = Object.hasOwn(this.preparers, step.toolName) ? this.preparers[step.toolName] : undefined;
        if (!prepare && (step.requiresApproval || Object.values(step.quote).some(n => n > 0))) throw new AgentError("business_preparer_required");
        step.businessManaged = !!prepare;
      }
      draft.snapshot.run.revision++;
      await saveState(tx, draft);
      for (const step of submitting) {
        if (!step.businessManaged) continue;
        const reservations = draft.snapshot.reservations.filter(r => r.attemptId === step.attemptId);
        const prepared = await this.preparers[step.toolName]({ tx, actor: structuredClone(actor), step: structuredClone(step),
          approval: structuredClone(draft.snapshot.approvals.find(a => a.id === step.approvalId) ?? null), reservations: structuredClone(reservations),
          reservationRefs: reservations.map(r => ({ runId: r.runId, attemptId: r.attemptId, unit: r.unit })) });
        if (!prepared || typeof prepared.jobId !== "string" || !prepared.jobId || prepared.jobId.length > 200) throw new AgentError("invalid_business_preparation");
        step.jobId = prepared.jobId;
        await tx.agentStep.update({ where: { attempt_id: step.attemptId }, data: { job_id: prepared.jobId } });
      }
      await appendEvents(tx, draft, previousCount);
      // 必须等待事务实际提交/回滚；此处以后进入 commit 的操作只能依靠持久恢复。
      this.assertNotAborted(signal);
      return structuredClone(result);
    }, { maxWait: 15000, timeout: 15000 }));
  }
  async createRun(actor: ActorContext, input: CreateRunRequest): Promise<AgentRun> {
    const record = createRunState(actor, input, 0);
    return safe(async () => {
      try {
        return await this.client.$transaction(async tx => {
          await lockAccount(tx, actor);
          if (!await tx.agentThread.findFirst({ where: { id: input.threadId, user_id: actor.userId } })) throw new AgentError("not_found");
          record.now = await databaseNow(tx);
          // 不先查幂等键；由唯一约束决定创建者，冲突事务结束后再读取原请求。
          await tx.agentRun.create({ data: runData(record.snapshot.run) });
          await appendEvents(tx, record, 0);
          return structuredClone(record.snapshot.run);
        }, { maxWait: 15000, timeout: 15000 });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        const original = await this.client.agentRun.findUnique({ where: { user_id_thread_id_client_request_id: {
          user_id: actor.userId, thread_id: input.threadId, client_request_id: input.clientRequestId } } });
        if (!original) throw new AgentError("repository_failure");
        if (original.creation_digest !== record.snapshot.run.creationDigest) throw new AgentError("idempotency_conflict");
        return (await this.readState(actor, original.id)).snapshot.run;
      }
    });
  }
}
