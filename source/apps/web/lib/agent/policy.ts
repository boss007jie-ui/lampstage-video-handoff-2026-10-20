import { createHash } from "node:crypto";
import {
  AgentError, type ActorContext, type AgentRun, type AgentStep, type Approval,
  type Budget, type BudgetUnit, type JsonValue, type Limits, type Plan, type Reservation, type SessionInput, type SessionRequestV1, type ApprovalValidity,
} from "./contracts";
import { parseImageReferences } from "../image-reference-contract";

export const budgetUnits: readonly BudgetUnit[] = ["usd_micros", "image_credit", "video_second"];
const forbiddenKeys = new Set([
  "userid", "actor", "actorcontext", "approved", "approval", "approvalid", "authorization",
  "apikey", "token", "accesstoken", "refreshtoken", "cookie", "setcookie", "secret", "password", "credential", "credentials", "endpoint", "baseurl",
  "chainofthought", "reasoning", "thinking", "__proto__", "constructor", "prototype",
]);

/** 持久数据只接受 JSON/资产引用；不允许身份覆盖、凭据字段或临时签名 URL。 */
export function validatePrivateJson(value: unknown): asserts value is JsonValue {
  let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 10000 || depth > 32) throw new AgentError("unsafe_private_data");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item === "string") {
      if (item.length > 64000 || /(?:bearer\s+|[?&](?:x-amz-[^=]*|x-goog-[^=]*|signature|sig|token|access_token|key|credential|authorization|awsaccesskeyid|ossaccesskeyid|q-signature|q-sign-algorithm)=)/i.test(item)) {
        throw new AgentError("unsafe_private_data");
      }
      return;
    }
    if (typeof item !== "object" || !item) throw new AgentError("unsafe_private_data");
    if (Array.isArray(item)) { item.forEach(v => walk(v, depth + 1)); return; }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new AgentError("unsafe_private_data");
    }
    for (const [key, child] of Object.entries(item)) {
      if (forbiddenKeys.has(key.replace(/[-_]/g, "").toLowerCase()) || key === "__proto__") {
        throw new AgentError("unsafe_private_data");
      }
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new AgentError("invalid_digest_input");
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new AgentError("invalid_digest_input");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function normalizeSessionInput(value: unknown): SessionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentError("invalid_session_request");
  validatePrivateJson(value);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(k => !["brief", "reference_assets", "image_count"].includes(k)) || typeof body.brief !== "string"
    || !body.brief.trim() || body.brief.trim().length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.brief)
    || Buffer.byteLength(JSON.stringify(body), "utf8") > 32768) throw new AgentError("invalid_session_request");
  try {
    const refs = parseImageReferences({ reference_assets: body.reference_assets, custom_prompt: body.brief, image_count: body.image_count });
    if (!refs) throw new AgentError("invalid_session_request");
    return { brief: body.brief.trim(), reference_assets: refs, image_count: body.image_count as number };
  } catch { throw new AgentError("invalid_session_request"); }
}
export function sessionRequestDigest(request: SessionInput): string { return digest({ version: 1, ...normalizeSessionInput(request) }); }
export function makeSessionRequest(input: SessionInput, compilerVersion: string): SessionRequestV1 {
  const request = normalizeSessionInput(input);
  const metadata: SessionRequestV1 = { version: 1, request, requestDigest: sessionRequestDigest(request), compilerVersion };
  validateSessionRequest(metadata);
  return metadata;
}
export function validateSessionRequest(value: unknown): asserts value is SessionRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentError("invalid_session_request");
  validatePrivateJson(value);
  const m = value as Record<string, unknown>;
  if (Object.keys(m).some(k => !["version", "request", "requestDigest", "compilerVersion"].includes(k)) || m.version !== 1
    || typeof m.compilerVersion !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(m.compilerVersion)) throw new AgentError("invalid_session_request");
  const normalized = normalizeSessionInput(m.request);
  if (digest(m.request) !== digest(normalized) || m.requestDigest !== sessionRequestDigest(normalized)
    || Buffer.byteLength(JSON.stringify(m), "utf8") > 32768) throw new AgentError("invalid_session_request");
}
export function assertSessionKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new AgentError("invalid_idempotency_key");
}
export function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AgentError("invalid_revision");
}
export function assertEventPage(after: number, take: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentError("request_aborted");
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(take) || take < 1 || take > 100) throw new AgentError("invalid_event_page");
}
export function sessionApprovalValidity(approval: Approval, run: AgentRun, actor: ActorContext, now: number): ApprovalValidity {
  if (approval.revokedAt !== null) return "revoked";
  if (approval.expiresAt <= now) return "expired";
  if (approval.planDigest !== run.planDigest) return "plan_changed";
  if (["completed", "failed", "cancel_requested", "cancelled"].includes(run.status)) return "run_closed";
  if (approval.allowedTools.some(tool => !actor.permissions.includes(tool))) return "permission_missing";
  // 旧审批允许部分 scope；会话整份计划的有效性必须另行核对，不改写旧记录或提交规则。
  if (run.plan.actions.some(action => !approval.allowedTools.includes(action.toolName))
    || !Number.isSafeInteger(approval.limits.maxToolCalls) || approval.limits.maxToolCalls < run.plan.actions.length) return "scope_insufficient";
  for (const unit of budgetUnits) {
    let required = 0;
    for (const action of run.plan.actions) {
      const amount = action.quote[unit] ?? 0;
      if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(required + amount)) return "scope_insufficient";
      required += amount;
    }
    const approved = approval.limits.budget[unit] ?? 0;
    if (!Number.isSafeInteger(approved) || approved < required) return "scope_insufficient";
  }
  return "active";
}

export function validateBudget(value: unknown): asserts value is Budget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentError("invalid_budget");
  for (const [unit, amount] of Object.entries(value)) {
    if (!budgetUnits.includes(unit as BudgetUnit) || !Number.isSafeInteger(amount) || amount < 0) {
      throw new AgentError("invalid_budget");
    }
  }
}

export function validateLimits(limits: Limits): void {
  if (!Number.isSafeInteger(limits.maxToolCalls) || limits.maxToolCalls < 0) throw new AgentError("invalid_limits");
  validateBudget(limits.budget);
}

export function validatePlan(plan: Plan): void {
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1 || !plan.pricingVersion || !Array.isArray(plan.actions)) {
    throw new AgentError("invalid_plan");
  }
  const keys = new Set<string>();
  if (plan.sessionRequest !== undefined) validateSessionRequest(plan.sessionRequest);
  for (const action of plan.actions) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(action.actionKey) || keys.has(action.actionKey)
      || !/^[a-zA-Z0-9_.-]{1,80}$/.test(action.toolName) || typeof action.requiresApproval !== "boolean"
      || !action.input || Array.isArray(action.input) || typeof action.input !== "object") throw new AgentError("invalid_plan");
    keys.add(action.actionKey);
    validatePrivateJson(action.input);
    validateBudget(action.quote);
    if (!action.requiresApproval && budgetUnits.some(u => (action.quote[u] ?? 0) > 0)) throw new AgentError("approval_required");
  }
}

export function assertActor(actor: ActorContext, run: AgentRun): void {
  if (!actor?.userId || actor.userId !== run.userId || !["session", "api_key", "worker"].includes(actor.source)
    || !Array.isArray(actor.permissions)) throw new AgentError("not_found");
}

export function assertStepPolicy(actor: ActorContext, run: AgentRun, step: AgentStep, quote: Budget, pricingVersion: string): void {
  assertActor(actor, run);
  if (!actor.permissions.includes(step.toolName)) throw new AgentError("tool_forbidden");
  if (step.planDigest !== run.planDigest || digest(step.input) !== step.inputDigest) throw new AgentError("plan_changed");
  if (pricingVersion !== run.plan.pricingVersion || digest(quote) !== step.quoteDigest) throw new AgentError("quote_changed");
}

export function assertApproval(approval: Approval | undefined, run: AgentRun, step: AgentStep, now: number): asserts approval is Approval {
  if (!approval) throw new AgentError("approval_required");
  if (approval.userId !== run.userId || approval.runId !== run.id || approval.planDigest !== run.planDigest
    || approval.pricingVersion !== run.plan.pricingVersion) throw new AgentError("approval_changed");
  if (approval.revokedAt !== null) throw new AgentError("approval_revoked");
  if (approval.expiresAt <= now) throw new AgentError("approval_expired");
  if (!approval.allowedTools.includes(step.toolName)) throw new AgentError("tool_forbidden");
}

export function reservationHeld(reservation: Reservation): number {
  return reservation.reservedAmount - reservation.releasedAmount;
}

export function reservationUnresolved(reservation: Reservation): number {
  return reservation.reservedAmount - (reservation.settledAmount ?? 0) - reservation.releasedAmount;
}

/** 必须在 repository 的同一原子临界区内与预留一起调用。 */
export function assertCapacity(limits: Limits, quote: Budget, attempts: number, reservations: readonly Reservation[]): void {
  if (attempts >= limits.maxToolCalls) throw new AgentError("tool_limit");
  for (const unit of budgetUnits) {
    const used = reservations.filter(r => r.unit === unit).reduce((sum, r) => sum + reservationHeld(r), 0);
    const amount = quote[unit] ?? 0;
    if (!Number.isSafeInteger(used + amount) || used + amount > (limits.budget[unit] ?? 0)) throw new AgentError("budget_exhausted");
  }
}
