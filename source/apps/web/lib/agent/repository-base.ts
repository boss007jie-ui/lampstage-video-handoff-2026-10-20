import { randomUUID } from "node:crypto";
import {
  AgentError, type ActorContext, type AgentRun, type AgentStep, type ApprovalRequest, type Budget,
  type LeaseToken, type ModelReply, type ModelTurn, type Plan, type PublicEvent, type RunSnapshot, type RunStatus, type ToolOutcome, type SessionApprovalRequest, type SessionApprovalResult,
} from "./contracts";
import { createApprovalRecord } from "./approvals";
import { projectEvent } from "./events";
import { assertActor, assertApproval, assertCapacity, assertStepPolicy, budgetUnits, digest,
  validateBudget, validateLimits, validatePlan, validatePrivateJson, reservationUnresolved, assertRevision, assertSessionKey, sessionApprovalValidity } from "./policy";
import type { AgentRepository, CancelRunResult, CreateRunRequest, SubmissionDecision } from "./repository";
import { isTerminal, transitionRun } from "./state-machine";


export interface StoredRun { snapshot: RunSnapshot; events: PublicEvent[]; now: number }
export const isUnresolved = (step: AgentStep): boolean => ["submitting", "pending", "unknown"].includes(step.status);
export const isResolved = (step: AgentStep): boolean => step.status === "succeeded" || step.status === "failed";
export const SESSION_APPROVAL_TTL_MS = 15 * 60 * 1000;

export function createRunState(actor: ActorContext, input: CreateRunRequest, now: number): StoredRun {
  if (!actor.userId || !["session", "api_key", "worker"].includes(actor.source) || !Array.isArray(actor.permissions)) throw new AgentError("not_found");
  validatePlan(input.plan);
  validateLimits(input.limits);
  if (!input.threadId || !input.clientRequestId || !Number.isSafeInteger(input.limits.maxModelCalls) || input.limits.maxModelCalls < 1) throw new AgentError("invalid_run");
  const run: AgentRun = { id: randomUUID(), userId: actor.userId, threadId: input.threadId, clientRequestId: input.clientRequestId,
    creationDigest: digest(input), plan: structuredClone(input.plan), planDigest: digest(input.plan), limits: structuredClone(input.limits),
    status: "queued", revision: 0, fence: 0, lease: null, modelCalls: 0, toolCalls: 0 };
  const snapshot: RunSnapshot = { run, turns: [], steps: [], approvals: [], reservations: [] };
  return { snapshot, events: [projectEvent(snapshot, 1)], now };
}

/** 纯状态变更共用层：没有缓存、锁或外部 IO；存储实现为每次操作提供新快照和可信时间。 */
export abstract class AgentRepositoryBase implements AgentRepository {
  protected abstract atomic<T>(actor: ActorContext, runId: string, change: (draft: StoredRun) => T, signal?: AbortSignal): Promise<T>;
  protected abstract readState(actor: ActorContext, runId: string): Promise<StoredRun>;
  abstract createRun(actor: ActorContext, input: CreateRunRequest): Promise<AgentRun>;

  private fenced(record: StoredRun, token: LeaseToken): void {
    const lease = record.snapshot.run.lease;
    if (!lease || lease.workerId !== token.workerId || lease.fence !== token.fence || lease.expiresAt <= record.now) {
      throw new AgentError("lease_lost");
    }
  }

  protected assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AgentError("request_aborted");
  }

  private worker<T>(token: LeaseToken, change: (draft: StoredRun) => T, signal?: AbortSignal): Promise<T> {
    this.assertNotAborted(signal);
    const lease = structuredClone(token);
    return this.atomic(lease.actor, lease.runId, draft => { this.fenced(draft, lease); return change(draft); }, signal);
  }

  protected event(record: StoredRun, step?: AgentStep): void {
    record.events.push(projectEvent(record.snapshot, record.events.length + 1, step));
  }

  private status(record: StoredRun, status: RunStatus): void {
    if (record.snapshot.run.status !== status) {
      record.snapshot.run.status = transitionRun(record.snapshot.run.status, status);
      this.event(record);
    }
  }

  private step(record: StoredRun, stepKey: string): AgentStep {
    const step = record.snapshot.steps.find(s => s.stepKey === stepKey);
    if (!step) throw new AgentError("step_not_found");
    return step;
  }

  private assertUnfinishedPlan(record: StoredRun): void {
    const { run, turns, steps } = record.snapshot;
    const stale = turns.some(turn => turn.planDigest !== run.planDigest && (turn.status === "sampling"
      || turn.calls.some(call => {
        const step = steps.find(s => s.stepKey === call.stepKey);
        return !step || !isResolved(step);
      })));
    // W1 不会重写旧意图或自动重规划；必须在恢复/计入模型采样次数前拒绝。
    if (stale) throw new AgentError("plan_changed");
  }

  async load(actor: ActorContext, runId: string): Promise<RunSnapshot> {
    return structuredClone((await this.readState(actor, runId)).snapshot);
  }

  async publicEvents(actor: ActorContext, runId: string, afterSeq = 0): Promise<PublicEvent[]> {
    return structuredClone((await this.readState(actor, runId)).events.filter(event => event.seq > afterSeq));
  }

  async grantApproval(actor: ActorContext, input: ApprovalRequest) {
    return this.atomic(actor, input.runId, record => {
      if (isTerminal(record.snapshot.run.status) || record.snapshot.run.status === "cancel_requested") throw new AgentError("run_closed");
      const approval = createApprovalRecord(actor, record.snapshot.run, input, randomUUID(), record.now);
      record.snapshot.approvals.push(approval);
      return approval;
    });
  }

  async grantSessionApproval(actor: ActorContext, input: SessionApprovalRequest): Promise<SessionApprovalResult> {
    return this.atomic(actor, input.runId, record => {
      const { run, approvals } = record.snapshot;
      if (actor.source !== "session") throw new AgentError("human_approval_required");
      assertSessionKey(input.clientRequestId); assertRevision(input.expectedRevision);
      if (!/^[a-f0-9]{64}$/.test(input.planDigest)) throw new AgentError("invalid_plan_digest");
      const id = digest(["agent_session_approval_v1", actor.userId, run.id, input.clientRequestId]);
      const existing = approvals.find(a => a.id === id);
      if (existing) {
        if (existing.planDigest !== input.planDigest) throw new AgentError("idempotency_conflict");
        return { approval: existing, created: false, validity: sessionApprovalValidity(existing, run, actor, record.now) };
      }
      if (run.revision !== input.expectedRevision) throw new AgentError("revision_conflict");
      if (run.planDigest !== input.planDigest) throw new AgentError("plan_changed");
      if (isTerminal(run.status) || run.status === "cancel_requested") throw new AgentError("run_closed");
      const allowedTools = [...new Set(run.plan.actions.map(a => a.toolName))];
      if (allowedTools.some(tool => !actor.permissions.includes(tool))) throw new AgentError("tool_forbidden");
      const budget: Budget = {};
      for (const action of run.plan.actions) for (const unit of budgetUnits) if (action.quote[unit] !== undefined) {
        const amount = (budget[unit] ?? 0) + action.quote[unit]!;
        if (!Number.isSafeInteger(amount) || amount > (run.limits.budget[unit] ?? 0)) throw new AgentError("budget_exhausted");
        budget[unit] = amount;
      }
      if (run.plan.actions.length > run.limits.maxToolCalls) throw new AgentError("tool_limit");
      const approval = createApprovalRecord(actor, run, { runId: run.id, planDigest: run.planDigest,
        pricingVersion: run.plan.pricingVersion, allowedTools, limits: { maxToolCalls: run.plan.actions.length, budget },
        expiresAt: record.now + SESSION_APPROVAL_TTL_MS }, id, record.now);
      approvals.push(approval);
      return { approval, created: true, validity: "active" };
    });
  }

  async revokeApproval(actor: ActorContext, runId: string, approvalId: string): Promise<void> {
    await this.atomic(actor, runId, record => {
      if (actor.source !== "session") throw new AgentError("human_approval_required");
      const approval = record.snapshot.approvals.find(a => a.id === approvalId);
      if (!approval) throw new AgentError("not_found");
      if (approval.revokedAt === null) { approval.revokedAt = record.now; approval.revision++; }
    });
  }

  async replacePlan(actor: ActorContext, runId: string, expectedRevision: number, plan: Plan): Promise<void> {
    await this.atomic(actor, runId, record => {
      const { run, steps } = record.snapshot;
      if (actor.source !== "session") throw new AgentError("human_approval_required");
      if (run.revision !== expectedRevision) throw new AgentError("revision_conflict");
      if (isTerminal(run.status) || run.status === "cancel_requested" || steps.some(isUnresolved)) throw new AgentError("plan_locked");
      const replacement = structuredClone(plan);
      if (run.plan.sessionRequest) {
        if (replacement.sessionRequest && digest(replacement.sessionRequest) !== digest(run.plan.sessionRequest)) throw new AgentError("session_request_changed");
        replacement.sessionRequest = structuredClone(run.plan.sessionRequest);
      } else if (replacement.sessionRequest) throw new AgentError("session_request_changed");
      validatePlan(replacement);
      if (plan.revision <= run.plan.revision) throw new AgentError("plan_changed");
      run.plan = replacement;
      run.planDigest = digest(replacement);
      // 已保存回合不可重写；旧意图需要人工明确处理，不能自动套入新输入。
      if (run.status !== "queued" && run.status !== "waiting_review") this.status(record, "attention");
    });
  }

  async cancelRun(actor: ActorContext, runId: string): Promise<void>;
  async cancelRun(actor: ActorContext, runId: string, expectedRevision: number): Promise<CancelRunResult>;
  async cancelRun(actor: ActorContext, runId: string, expectedRevision?: number): Promise<void | CancelRunResult>;
  async cancelRun(actor: ActorContext, runId: string, expectedRevision?: number): Promise<void | CancelRunResult> {
    const changed = await this.atomic(actor, runId, record => {
      if (expectedRevision !== undefined) assertRevision(expectedRevision);
      if (record.snapshot.run.status === "cancel_requested" || record.snapshot.run.status === "cancelled") return false;
      if (expectedRevision !== undefined) {
        if (isTerminal(record.snapshot.run.status)) throw new AgentError("run_closed");
        if (expectedRevision !== record.snapshot.run.revision) throw new AgentError("revision_conflict");
      }
      this.status(record, "cancel_requested");
      return true;
    });
    // 旧调用保留 void；CAS 调用使用锁内结果决定是否发送唤醒提示。
    if (expectedRevision !== undefined) return { changed };
  }

  async resumeRun(actor: ActorContext, runId: string, expectedRevision: number): Promise<void> {
    await this.atomic(actor, runId, record => {
      const { run, steps } = record.snapshot;
      if (actor.source !== "session") throw new AgentError("human_approval_required");
      if (run.revision !== expectedRevision) throw new AgentError("revision_conflict");
      if (!["waiting_review", "waiting_approval", "attention"].includes(run.status) || steps.some(isUnresolved)) {
        throw new AgentError("invalid_transition");
      }
      this.assertUnfinishedPlan(record);
      this.status(record, "running");
    });
  }

  async claimLease(actor: ActorContext, runId: string, workerId: string, ttlMs: number, signal?: AbortSignal): Promise<LeaseToken | null> {
    this.assertNotAborted(signal);
    const owner = structuredClone(actor);
    return this.atomic(owner, runId, record => {
      const run = record.snapshot.run;
      if (!workerId || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(record.now + ttlMs)) throw new AgentError("invalid_lease");
      if (isTerminal(run.status) || run.status === "waiting_review" || (run.lease && run.lease.expiresAt > record.now)) return null;
      run.fence++;
      run.lease = { workerId, fence: run.fence, expiresAt: record.now + ttlMs };
      if (run.status === "queued") this.status(record, "running");
      return { runId, actor: owner, workerId, fence: run.fence };
    }, signal);
  }

  async releaseLease(token: LeaseToken): Promise<void> {
    await this.atomic(token.actor, token.runId, record => {
      const lease = record.snapshot.run.lease;
      // 允许释放自身过期租约；旧 owner 永远不能释放新 owner 的租约。
      if (lease?.workerId === token.workerId && lease.fence === token.fence) record.snapshot.run.lease = null;
    });
  }

  async setStatus(token: LeaseToken, status: RunStatus, signal?: AbortSignal): Promise<void> {
    await this.worker(token, record => {
      if (isTerminal(status) && record.snapshot.steps.some(isUnresolved)) throw new AgentError("unresolved_submission");
      record.snapshot.run.status = transitionRun(record.snapshot.run.status, status);
      this.event(record);
    }, signal);
  }

  async beginModelTurn(token: LeaseToken): Promise<ModelTurn> {
    return this.modelTurn(token, false);
  }

  async getOrBeginModelTurn(token: LeaseToken, signal?: AbortSignal): Promise<ModelTurn> {
    return this.modelTurn(token, true, signal);
  }

  async assertModelTurn(token: LeaseToken, turnId: string, planDigest: string, signal?: AbortSignal): Promise<void> {
    await this.worker(token, record => {
      const { run, turns } = record.snapshot;
      if (run.planDigest !== planDigest) throw new AgentError("plan_changed");
      if (run.status !== "running") throw new AgentError("run_not_running");
      const turn = turns.at(-1);
      if (!turn || turn.id !== turnId || turn.status !== "sampling") throw new AgentError("turn_conflict");
      if (turn.planDigest !== planDigest) throw new AgentError("plan_changed");
    }, signal);
  }

  private modelTurn(token: LeaseToken, reuseSampling: boolean, signal?: AbortSignal): Promise<ModelTurn> {
    return this.worker(token, record => {
      const { run, turns, steps } = record.snapshot;
      if (run.status !== "running") throw new AgentError("run_not_running");
      this.assertUnfinishedPlan(record);
      const previous = turns.at(-1);
      if (previous?.status === "saved" && previous.calls.some(c => !isResolved(steps.find(s => s.stepKey === c.stepKey)!))) {
        throw new AgentError("unfinished_turn");
      }
      // 已发生的持久请求必须可以在额度耗尽后恢复，且不能重复累计模型次数。
      if (reuseSampling && previous?.status === "sampling") return previous;
      if (run.modelCalls >= run.limits.maxModelCalls) throw new AgentError("model_limit");
      run.modelCalls++;
      // 崩溃发生在完整回合保存前：允许重取同一 turnId，但每次采样都计入上限。
      if (previous?.status === "sampling") return previous;
      const turn = { id: randomUUID(), index: turns.length, planDigest: run.planDigest,
        status: "sampling" as const, assistantText: "", calls: [] };
      turns.push(turn);
      return turn;
    }, signal);
  }

  async saveModelTurn(token: LeaseToken, turnId: string, reply: ModelReply, signal?: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    reply = structuredClone(reply);
    await this.worker(token, record => {
      const { run, turns, steps } = record.snapshot;
      if (run.status !== "running") throw new AgentError("run_not_running");
      const turn = turns.at(-1);
      if (!turn || turn.id !== turnId || turn.status !== "sampling" || turn.planDigest !== run.planDigest) throw new AgentError("turn_conflict");
      if (typeof reply.assistantText !== "string" || !Array.isArray(reply.toolCalls)
        || reply.toolCalls.length > 40 || (reply.finish && !["completed", "waiting_review"].includes(reply.finish))
        || (reply.toolCalls.length > 0 && reply.finish)) throw new AgentError("invalid_model_reply");
      validatePrivateJson(reply.assistantText);
      const callIds = new Set<string>();
      for (const call of reply.toolCalls) {
        if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(call.toolCallId) || callIds.has(call.toolCallId)) throw new AgentError("invalid_tool_call");
        callIds.add(call.toolCallId);
        validatePrivateJson(call.input);
        const action = run.plan.actions.find(a => a.actionKey === call.actionKey);
        if (!action || call.toolName !== action.toolName || digest(call.input) !== digest(action.input)) throw new AgentError("plan_changed");
        const existing = steps.find(s => s.stepKey === action.actionKey);
        if (existing && existing.planDigest !== run.planDigest) throw new AgentError("step_conflict");
        if (!existing) {
          const step: AgentStep = { runId: run.id, userId: run.userId, stepKey: action.actionKey,
            attemptId: randomUUID(), modelTurnId: turn.id, toolCallId: call.toolCallId, toolName: action.toolName,
            planDigest: run.planDigest, inputDigest: digest(action.input), quoteDigest: digest(action.quote),
            input: structuredClone(action.input), quote: structuredClone(action.quote), requiresApproval: action.requiresApproval,
            status: "planned", approvalId: null, approvalRevision: null, submissionFence: null, jobId: null, outcome: null, businessManaged: false };
          steps.push(step);
          this.event(record, step);
        }
        turn.calls.push({ ...structuredClone(call), stepKey: action.actionKey });
      }
      turn.status = "saved";
      turn.assistantText = reply.assistantText;
      if (reply.toolCalls.length === 0) {
        turn.finish = reply.finish ?? "completed";
        this.status(record, turn.finish);
      }
    }, signal);
  }

  async beginSubmission(token: LeaseToken, stepKey: string, quote: Budget, pricingVersion: string, signal?: AbortSignal): Promise<SubmissionDecision> {
    return this.worker(token, record => {
      const { run, approvals, reservations, steps } = record.snapshot;
      const step = this.step(record, stepKey);
      if (step.status !== "planned") return { kind: "existing", step };
      if (run.status !== "running") throw new AgentError("run_not_running");
      validateBudget(quote);
      assertStepPolicy(token.actor, run, step, quote, pricingVersion);
      const approval = step.requiresApproval ? approvals.filter(a => a.planDigest === run.planDigest).at(-1) : undefined;
      if (step.requiresApproval) {
        assertApproval(approval, run, step, record.now);
        assertCapacity(approval.limits, quote, steps.filter(s => s.approvalId === approval.id && s.status !== "planned").length,
          reservations.filter(r => r.approvalId === approval.id));
      }
      assertCapacity(run.limits, quote, run.toolCalls, reservations);
      step.approvalId = approval?.id ?? null;
      step.approvalRevision = approval?.revision ?? null;
      step.status = "submitting";
      step.submissionFence = token.fence;
      run.toolCalls++;
      for (const unit of budgetUnits) if (quote[unit] !== undefined) reservations.push({
        runId: run.id, userId: run.userId, approvalId: step.approvalId, attemptId: step.attemptId, unit,
        reservedAmount: quote[unit]!, settledAmount: null, releasedAmount: 0, status: "reserved", settlementBasis: null,
      });
      this.event(record, step);
      return { kind: "dispatch", step };
    }, signal);
  }

  async recordOutcome(token: LeaseToken, stepKey: string, attemptId: string, outcome: ToolOutcome): Promise<void> {
    await this.worker(token, record => {
      const step = this.step(record, stepKey);
      if (step.attemptId !== attemptId || step.status === "planned") throw new AgentError("attempt_conflict");
      if (isResolved(step)) {
        if (digest(step.outcome) !== digest(outcome)) throw new AgentError("outcome_conflict");
        return;
      }
      // 验证运行时 JSON，不让断言签名把含可选字段的领域联合类型重新收窄。
      validatePrivateJson(outcome as unknown);
      if (!outcome || typeof outcome !== "object" || !["succeeded", "pending", "unknown", "failed"].includes(outcome.kind)) throw new AgentError("invalid_outcome");
      const fields = { succeeded: ["kind", "output", "usage", "jobId"], pending: ["kind", "jobId", "nextCheckAt"],
        unknown: ["kind", "jobId"], failed: ["kind", "code", "disposition", "usage", "jobId", "noSubmissionEvidence"] };
      if (Object.keys(outcome).some(key => !fields[outcome.kind].includes(key))
        || (outcome.kind === "succeeded" && !Object.hasOwn(outcome, "output"))) throw new AgentError("invalid_outcome");
      if (outcome.kind === "pending" && (!outcome.jobId || !Number.isSafeInteger(outcome.nextCheckAt) || outcome.nextCheckAt < 0)) {
        throw new AgentError("invalid_outcome");
      }
      if (outcome.jobId !== undefined && (typeof outcome.jobId !== "string" || !outcome.jobId)) throw new AgentError("invalid_outcome");
      if (step.jobId && outcome.jobId && step.jobId !== outcome.jobId) throw new AgentError("job_conflict");
      if (outcome.kind === "failed" && (!/^[a-zA-Z0-9_-]{1,80}$/.test(outcome.code)
        || !["not_submitted", "charged"].includes(outcome.disposition))) throw new AgentError("invalid_outcome");
      if (outcome.kind === "failed" && outcome.disposition === "not_submitted") {
        const evidence = outcome.noSubmissionEvidence;
        if (step.jobId || outcome.jobId || !evidence || evidence.attemptId !== step.attemptId
          || typeof evidence.reference !== "string" || !evidence.reference
          || !["local_preflight", "authoritative_lookup"].includes(evidence.source)
          || (evidence.source === "local_preflight" && (step.status !== "submitting" || token.fence !== step.submissionFence))
          || (outcome.usage && budgetUnits.some(u => (outcome.usage![u] ?? 0) !== 0))) {
          throw new AgentError("invalid_submission_evidence");
        }
      }
      if ((outcome.kind === "succeeded" || outcome.kind === "failed") && outcome.usage) {
        validateBudget(outcome.usage);
        if (budgetUnits.some(u => (outcome.usage![u] ?? 0) > (step.quote[u] ?? 0))) throw new AgentError("usage_exceeds_reservation");
      }
      step.outcome = structuredClone(outcome);
      step.status = outcome.kind;
      step.jobId = outcome.jobId ?? step.jobId;
      for (const reservation of record.snapshot.reservations.filter(r => r.attemptId === attemptId)) {
        if (step.businessManaged) {
          if ((outcome.kind === "succeeded" || outcome.kind === "failed")
            && (reservationUnresolved(reservation) !== 0
              || (outcome.usage?.[reservation.unit] !== undefined && outcome.usage[reservation.unit] !== reservation.settledAmount))) {
            throw new AgentError("business_settlement_pending");
          }
          // 已绑定业务 job 的预算只读取事务内 slot 结算，不能再次按报价结算。
          continue;
        }
        if (outcome.kind === "unknown") reservation.status = "unknown";
        else if (outcome.kind === "pending") reservation.status = "reserved";
        else if (outcome.kind === "failed" && outcome.disposition === "not_submitted") {
          reservation.status = "released";
          reservation.settledAmount = 0;
          reservation.releasedAmount = reservation.reservedAmount;
          reservation.settlementBasis = "actual";
        } else {
          reservation.status = "settled";
          reservation.settledAmount = outcome.usage?.[reservation.unit] ?? reservation.reservedAmount;
          reservation.releasedAmount = reservation.reservedAmount - reservation.settledAmount;
          reservation.settlementBasis = outcome.usage?.[reservation.unit] === undefined ? "ceiling" : "actual";
        }
      }
      if (record.snapshot.run.status !== "cancel_requested") {
        if (outcome.kind === "unknown") this.status(record, "attention");
        else if (outcome.kind === "pending") this.status(record, "waiting_job");
        else if (["waiting_job", "attention"].includes(record.snapshot.run.status)) this.status(record, "running");
      }
      this.event(record, step);
    });
  }

  async finishCancellation(token: LeaseToken): Promise<boolean> {
    return this.worker(token, record => {
      if (record.snapshot.run.status !== "cancel_requested") throw new AgentError("invalid_transition");
      if (record.snapshot.steps.some(isUnresolved)) return false;
      this.status(record, "cancelled");
      return true;
    });
  }

  async assertDispatch(token: LeaseToken, stepKey: string, attemptId: string, signal?: AbortSignal): Promise<void> {
    await this.worker(token, record => {
      const step = this.step(record, stepKey);
      if (record.snapshot.run.status !== "running") throw new AgentError("run_not_running");
      if (step.attemptId !== attemptId || step.status !== "submitting" || step.submissionFence !== token.fence) throw new AgentError("submission_owned");
      assertStepPolicy(token.actor, record.snapshot.run, step, step.quote, record.snapshot.run.plan.pricingVersion);
      if (step.requiresApproval) assertApproval(record.snapshot.approvals.find(a => a.id === step.approvalId), record.snapshot.run, step, record.now);
    }, signal);
  }
}
