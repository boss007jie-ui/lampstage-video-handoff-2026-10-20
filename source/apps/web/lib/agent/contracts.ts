import type { ImageAssetReference } from "../image-reference-contract";

/** 仅服务端认证边界可构造；不能将 HTTP body 或模型输出强转为此上下文。 */
export interface ActorContext {
  userId: string;
  source: "session" | "api_key" | "worker";
  permissions: readonly string[];
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type BudgetUnit = "usd_micros" | "image_credit" | "video_second";
/** 金额使用整数微美元；次数单列 maxToolCalls，不能与金额/秒数相加。 */
export type Budget = Partial<Record<BudgetUnit, number>>;
export interface Limits { maxToolCalls: number; budget: Budget }
export interface RunLimits extends Limits { maxModelCalls: number }

export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_job"
  | "waiting_review" | "attention" | "completed" | "failed" | "cancel_requested" | "cancelled";
export interface PlanAction {
  actionKey: string;
  toolName: string;
  input: JsonObject;
  quote: Budget;
  requiresApproval: boolean;
}
/** 由可信规划服务冻结；动作键由服务端分配，重试需显式新动作与授权。 */
export interface SessionInput { brief: string; reference_assets: ImageAssetReference[]; image_count: number }
/** 私有原始需求身份，只有可信服务可生成；换计划仍保留首次完整 metadata。 */
export interface SessionRequestV1 { version: 1; request: SessionInput; requestDigest: string; compilerVersion: string }
export interface Plan { revision: number; pricingVersion: string; actions: PlanAction[]; sessionRequest?: SessionRequestV1 }
export interface Lease { workerId: string; fence: number; expiresAt: number }
export interface LeaseToken { runId: string; actor: ActorContext; workerId: string; fence: number }
export interface AgentRun {
  id: string;
  userId: string;
  threadId: string;
  clientRequestId: string;
  creationDigest: string;
  plan: Plan;
  planDigest: string;
  limits: RunLimits;
  status: RunStatus;
  revision: number;
  fence: number;
  lease: Lease | null;
  modelCalls: number;
  toolCalls: number;
}
export interface Approval {
  id: string;
  runId: string;
  userId: string;
  planDigest: string;
  pricingVersion: string;
  allowedTools: string[];
  limits: Limits;
  expiresAt: number;
  revokedAt: number | null;
  revision: number;
}
export interface ApprovalRequest extends Omit<Approval, "id" | "userId" | "revokedAt" | "revision"> {}
export interface SessionApprovalRequest { runId: string; clientRequestId: string; expectedRevision: number; planDigest: string }
export type ApprovalValidity = "active" | "expired" | "revoked" | "plan_changed" | "run_closed" | "permission_missing" | "scope_insufficient";
export interface SessionApprovalResult { approval: Approval; created: boolean; validity: ApprovalValidity }

export interface AgentThread { id: string; userId: string; createdAt: number }

/** 由可信工具 adapter 出具，reference 指向可审计的本地校验/权威查询记录，不能来自模型。 */
export interface SubmissionAbsenceEvidence {
  source: "local_preflight" | "authoritative_lookup";
  attemptId: string;
  reference: string;
}
export type ToolOutcome =
  | { kind: "succeeded"; output: JsonValue; usage?: Budget; jobId?: string }
  | { kind: "pending"; jobId: string; nextCheckAt: number }
  | { kind: "unknown"; jobId?: string }
  | { kind: "failed"; code: string; disposition: "not_submitted" | "charged"; usage?: Budget; jobId?: string;
      /** not_submitted 必须提供证据；已知 job 不得回退为未提交。 */
      noSubmissionEvidence?: SubmissionAbsenceEvidence };
export type StepStatus = "planned" | "submitting" | "pending" | "unknown" | "succeeded" | "failed";
export interface AgentStep {
  runId: string;
  userId: string;
  stepKey: string;
  attemptId: string;
  modelTurnId: string;
  toolCallId: string;
  toolName: string;
  planDigest: string;
  inputDigest: string;
  quoteDigest: string;
  input: JsonObject;
  quote: Budget;
  requiresApproval: boolean;
  status: StepStatus;
  approvalId: string | null;
  approvalRevision: number | null;
  submissionFence: number | null;
  jobId: string | null;
  outcome: ToolOutcome | null;
  /** true 时预算只能由事务内业务 slot 结算操作修改。 */
  businessManaged: boolean;
}
export interface Reservation {
  runId: string;
  userId: string;
  approvalId: string | null;
  attemptId: string;
  unit: BudgetUnit;
  reservedAmount: number;
  settledAmount: number | null;
  releasedAmount: number;
  status: "reserved" | "unknown" | "settled" | "released";
  /** ceiling 表示保守占用上界，不是供应商实际账单。 */
  settlementBasis: "actual" | "ceiling" | null;
}
export interface ReservationRef { runId: string; attemptId: string; unit: BudgetUnit }
export interface ReservationSlot extends ReservationRef {
  slotAttemptId: string;
  allocatedAmount: number;
  settledAmount: number;
  releasedAmount: number;
  status: "pending" | "unknown" | "final";
  evidenceDigest: string | null;
  evidence: SlotEvidence | null;
}
export type SlotEvidence = { slotAttemptId: string; reference: string } & (
  { kind: "unknown" } | { kind: "final"; settledAmount: number; releasedAmount: number }
);
export interface ModelToolCall { toolCallId: string; actionKey: string; toolName: string; input: JsonObject }
/** 只有最终 assistant 文本/完整调用，不接收思维链或凭据。 */
export interface ModelReply {
  assistantText: string;
  toolCalls: ModelToolCall[];
  finish?: "completed" | "waiting_review";
}
export interface StoredCall extends ModelToolCall { stepKey: string }
export interface ModelTurn {
  id: string;
  index: number;
  planDigest: string;
  status: "sampling" | "saved";
  assistantText: string;
  calls: StoredCall[];
  finish?: "completed" | "waiting_review";
}
/** 完整私有恢复快照；仅 Worker/同账户服务端可读，绝不能直接用于 SSE。 */
export interface RunSnapshot {
  run: AgentRun;
  turns: ModelTurn[];
  steps: AgentStep[];
  approvals: Approval[];
  reservations: Reservation[];
}
/** 只投影枚举和序号；没有工具参数、结果、模型文本、URL 或错误原文。 */
export interface PublicEvent {
  seq: number;
  type: "run_status" | "step_status";
  runStatus: RunStatus;
  stepNumber?: number;
  stepStatus?: StepStatus;
}
export interface ToolContext {
  actor: ActorContext;
  runId: string;
  stepKey: string;
  inputDigest: string;
  attemptId: string;
  fence: number;
  /** DB adapter 若已原子建立业务 job，此处传回原映射；工具必须复用。 */
  jobId: string | null;
}
export interface ToolDefinition {
  name: string;
  requiresApproval: boolean;
  validateInput(input: JsonObject): boolean;
  quote(input: JsonObject): { pricingVersion: string; budget: Budget };
  execute(context: ToolContext, input: JsonObject): Promise<ToolOutcome>;
  /** 只查询原 attempt/job，禁止创建、重新提交或自行重试。 */
  recover?(context: ToolContext, step: AgentStep): Promise<ToolOutcome>;
}

export class AgentError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "AgentError"; }
}
