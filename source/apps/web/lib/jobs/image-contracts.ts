import type { ImageModelId } from "../image-models";
import type { ImageAssetReference } from "../image-reference-contract";

/** 身份仅由服务端鉴权入口构造，工具参数不能覆盖。 */
export type ImageActor = { userId: string };
export type PinnedImageReference = ImageAssetReference & { sha256: string };
export type ImageInput = {
  imageModel: ImageModelId;
  providerModel: string;
  aspectRatio: "1_1";
  platformStyle: "domestic_ecommerce" | "brand_site";
  /** 已完成规划/品牌注入的最终提示词，每项对应一张输出。 */
  prompts: string[];
  references: PinnedImageReference[];
  brandVersion?: { slug: string; version: string };
};
export type ImageInputDraft = Omit<ImageInput, "imageModel" | "providerModel" | "aspectRatio"> & {
  imageModel?: string;
  aspectRatio: string;
};
/** 服务端组装的命令：run/step/approval 来自已持久化计划与审批，不是模型工具参数。 */
export type ImageCreateCommand = {
  runId: string;
  stepKey: string;
  idempotencyKey: string;
  approvalId: string;
  approvalRevision: number;
  input: ImageInputDraft;
};
/** 由既有计费规则注入；不允许使用模型参数作为报价。仅表示平台积分。 */
export type ImageQuote = { pricingVersion: string; outputCredits: number[] };
export interface ImagePricingPort { quote(input: ImageInput): Promise<ImageQuote> }
export type ImageCreateIntent = Omit<ImageCreateCommand, "input"> & {
  actor: ImageActor;
  input: ImageInput;
  inputDigest: string;
};
export type AtomicImageCreate = ImageCreateIntent & { quote: ImageQuote };
export type ImageArtifact = { artifactId: string; sha256: string };
/**
 * 与内核 noSubmissionEvidence 同语义，但本模块保持独立类型。
 * 仅可信 adapter 出具；reference 是私有可审计记录 ID，不能来自模型或裸 HTTP 404。
 * authoritative_lookup 必须证明原 attempt 未被受理，查询不可见/超时不构成证据。
 */
export type ImageSubmissionAbsenceEvidence = {
  source: "local_preflight" | "authoritative_lookup";
  attemptId: string;
  reference: string;
};
export type ImageObservation =
  | { kind: "succeeded"; output: ImageArtifact }
  /** 供应商已确定的终态失败；查询 404 或不可见不能映射为 failed。 */
  | { kind: "failed"; code: string }
  /** 已有提交意图时必须提供证据；已知 taskId 永远不能回退为未提交。 */
  | { kind: "not_submitted"; code: string; noSubmissionEvidence?: ImageSubmissionAbsenceEvidence }
  | { kind: "pending"; taskId: string }
  | { kind: "unknown"; code: string; taskId?: string };
export type ImageSlot = {
  index: number;
  attemptId: string;
  status: "queued" | "submitting" | "pending" | "unknown" | "succeeded" | "failed";
  submissionIntent?: { id: string; fencingToken: number; createdAt: number };
  providerTaskId?: string;
  output?: ImageArtifact;
  noSubmissionEvidence?: ImageSubmissionAbsenceEvidence;
  code?: string;
  quotedCredits: number;
  chargedCredits: number;
  refundedCredits: number;
};
export type ImageJob = {
  id: string;
  userId: string;
  runId: string;
  stepKey: string;
  /** 真实 core 准备器保存的父 attempt；旧独立内存任务没有该映射。 */
  coreAttemptId?: string;
  idempotencyKey: string;
  approvalId: string;
  approvalRevision: number;
  inputDigest: string;
  input: ImageInput;
  quote: ImageQuote;
  status: "queued" | "running" | "attention" | "completed" | "partial" | "failed";
  attentionCode?: string;
  slots: ImageSlot[];
  chargedCredits: number;
  refundedCredits: number;
  billingMode: "standard" | "internal_test";
  reservation: { unit: "platform_credits"; reserved: number; settled: number; released: number; outputCount: number };
  fencingToken: number;
  lease?: { workerId: string; expiresAt: number };
};
export type ImageLease = { actor: ImageActor; jobId: string; workerId: string; fencingToken: number };
export type ImageClaim = { lease: ImageLease; job: ImageJob };
export class ImageJobError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); this.name = "ImageJobError"; }
}

/**
 * 数据库 adapter 必须将每个写方法实现为原子事务/CAS。事务内禁止网络、文件 IO。
 * createAtomic 同时验证账户/素材/run/approval、预留预算、创建 job、一次业务扣费与 step 映射。
 * beginSubmission 在真正 POST 前再次验证租约、审批、输入和唯一意图。不能在恢复时重建 attempt。
 * observe 同时保存输出/终态、预算结算和最多一次退款；过期执行权不能写入。
 */
export interface ImageRepositoryPort {
  /** 报价前只读重放查找；createAtomic 仍须重查唯一约束，不能依赖此前查找防并发。 */
  findCreated(command: ImageCreateIntent): Promise<ImageJob | null>;
  createAtomic(command: AtomicImageCreate): Promise<{ job: ImageJob; replayed: boolean }>;
  get(actor: ImageActor, jobId: string): Promise<ImageJob>;
  claim(actor: ImageActor, jobId: string, workerId: string, leaseMs: number, signal?: AbortSignal): Promise<ImageClaim | null>;
  /** 端口必须有事务时限并响应中止；处理器停止时等待已启动的真实续租完成。 */
  heartbeat(lease: ImageLease, leaseMs: number, signal?: AbortSignal): Promise<void>;
  /** 锁内核对 core 已明确取消，仅结束没有任何提交证据的 queued。 */
  cancelQueued(lease: ImageLease, signal?: AbortSignal): Promise<ImageJob>;
  beginSubmission(lease: ImageLease, index: number, signal?: AbortSignal): Promise<void>;
  observe(lease: ImageLease, index: number, observation: ImageObservation, signal?: AbortSignal): Promise<ImageJob>;
  failBeforeSubmission(lease: ImageLease, index: number, signal?: AbortSignal): Promise<ImageJob>;
  attention(lease: ImageLease, code: string, signal?: AbortSignal): Promise<ImageJob>;
  release(lease: ImageLease, signal?: AbortSignal): Promise<void>;
}
export type ImageProviderRequest = {
  /** processor 从已保存 job 注入；adapter 再以 owner 范围读取 job 验证，不取 input 内同名字段。 */
  userId: string;
  runId: string;
  stepKey: string;
  jobId: string;
  attemptId: string;
  inputDigest: string;
  outputIndex: number;
  input: ImageInput;
  /** 仅执行控制信号；中止不能证明供应商未受理。 */
  signal?: AbortSignal;
};
export interface ImageProviderPort {
  /**
   * adapter 必须在预处理结束、唯一一次不可逆 POST 紧前 await beforeSend()。
   * gate 失败必须终止发送；禁止内部重试、换模型、重复调用 gate 或一张任务多次 POST。
   * 不能确认未提交的异常必须返回 unknown。输出须已写入幂等对象存储后返回 artifactId。
   */
  submit(request: ImageProviderRequest, beforeSend: () => Promise<void>): Promise<ImageObservation>;
  /** 仅找回本方已原子保存并验证的产物；缺失绝不证明供应商未提交。优先于远端 query。 */
  recoverArtifact?(request: ImageProviderRequest): Promise<Extract<ImageObservation, { kind: "succeeded" | "unknown" }>>;
  /**
   * 仅查询原 attempt/taskId，绝不能隐式提交。无查询能力时省略。
   * 查不到任务/404/暂时不可见只能返回 unknown；not_submitted 需原 attempt 的权威未受理证据。
   */
  query?(request: ImageProviderRequest & { taskId?: string }): Promise<ImageObservation>;
}
