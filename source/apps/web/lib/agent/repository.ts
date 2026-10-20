import type {
  ActorContext, AgentRun, AgentStep, Approval, ApprovalRequest, Budget, LeaseToken,
  ModelReply, ModelTurn, Plan, PublicEvent, RunLimits, RunSnapshot, RunStatus, ToolOutcome, AgentThread, SessionApprovalRequest, SessionApprovalResult,
} from "./contracts";

export interface CreateRunRequest { threadId: string; clientRequestId: string; plan: Plan; limits: RunLimits }
export type SubmissionDecision = { kind: "dispatch" | "existing"; step: AgentStep };
export interface CancelRunResult { changed: boolean }

/**
 * 每个写方法都是单个原子操作，失败不得留下部分写入。实现不可将检查与修改拆成调用方事务。
 * DB adapter 必须在 beginSubmission 同一事务复用预算占用并创建业务 job、一次扣费及 step-job 映射。
 * Reservation 是授权上界占用，不是业务账本；禁止 image/video adapter 再预留一份相同预算。
 * 所有 token 写入都检查当前 fence 和未过期 lease；外部调用始终在事务之外。
 */
export interface AgentRepository {
  createRun(actor: ActorContext, input: CreateRunRequest): Promise<AgentRun>;
  load(actor: ActorContext, runId: string): Promise<RunSnapshot>;
  publicEvents(actor: ActorContext, runId: string, afterSeq?: number): Promise<PublicEvent[]>;
  grantApproval(actor: ActorContext, input: ApprovalRequest): Promise<Approval>;
  revokeApproval(actor: ActorContext, runId: string, approvalId: string): Promise<void>;
  replacePlan(actor: ActorContext, runId: string, expectedRevision: number, plan: Plan): Promise<void>;
  cancelRun(actor: ActorContext, runId: string): Promise<void>;
  cancelRun(actor: ActorContext, runId: string, expectedRevision: number): Promise<CancelRunResult>;
  cancelRun(actor: ActorContext, runId: string, expectedRevision?: number): Promise<void | CancelRunResult>;
  /** 人工解除 review/attention；旧计划的未完成回合必须拒绝，不重置意图、结果、额度或次数。 */
  resumeRun(actor: ActorContext, runId: string, expectedRevision: number): Promise<void>;
  claimLease(actor: ActorContext, runId: string, workerId: string, ttlMs: number, signal?: AbortSignal): Promise<LeaseToken | null>;
  releaseLease(token: LeaseToken): Promise<void>;
  setStatus(token: LeaseToken, status: RunStatus, signal?: AbortSignal): Promise<void>;
  /** 先拒绝摘要过期的未完成回合，再累计采样次数；拒绝不得消耗模型预算。 */
  beginModelTurn(token: LeaseToken): Promise<ModelTurn>;
  /** 持久执行只在新建回合时计数；同一 sampling 回合恢复不再消耗模型次数。 */
  getOrBeginModelTurn(token: LeaseToken, signal?: AbortSignal): Promise<ModelTurn>;
  /** 只核验当前 sampling 回合和有效租约，不创建回合或消耗模型次数。 */
  assertModelTurn(token: LeaseToken, turnId: string, planDigest: string, signal?: AbortSignal): Promise<void>;
  saveModelTurn(token: LeaseToken, turnId: string, reply: ModelReply, signal?: AbortSignal): Promise<void>;
  /** 提交开始的线性化点：成功返回 dispatch 即视为可能已发送，后续取消不可回滚此窗口。 */
  beginSubmission(token: LeaseToken, stepKey: string, quote: Budget, pricingVersion: string, signal?: AbortSignal): Promise<SubmissionDecision>;
  /** 二次检查提交权，不授予新的提交意图；调用后立即进入注入工具，不能在两者间等待其他 IO。 */
  assertDispatch(token: LeaseToken, stepKey: string, attemptId: string, signal?: AbortSignal): Promise<void>;
  recordOutcome(token: LeaseToken, stepKey: string, attemptId: string, outcome: ToolOutcome): Promise<void>;
  finishCancellation(token: LeaseToken): Promise<boolean>;
}

export interface AgentThreadRepository {
  createThread(actor: ActorContext): Promise<AgentThread>;
  loadThread(actor: ActorContext, threadId: string): Promise<AgentThread>;
}
/** 会话专用兼容增量；旧 runner 仍只依赖 AgentRepository。 */
export interface AgentSessionRepository extends AgentRepository, AgentThreadRepository {
  findRunByClientRequestId(actor: ActorContext, threadId: string, clientRequestId: string): Promise<AgentRun | null>;
  grantSessionApproval(actor: ActorContext, input: SessionApprovalRequest): Promise<SessionApprovalResult>;
  publicEventPage(actor: ActorContext, runId: string, after: number, take: number, signal?: AbortSignal): Promise<PublicEvent[]>;
}
