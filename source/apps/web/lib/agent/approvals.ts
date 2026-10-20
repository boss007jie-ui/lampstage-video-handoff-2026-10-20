import { AgentError, type ActorContext, type AgentRun, type Approval, type ApprovalRequest } from "./contracts";
import { assertActor, validateLimits } from "./policy";

/** 只能由鉴权后的人工交互服务调用；模型与工具注册表没有审批写入端口。 */
export function createApprovalRecord(actor: ActorContext, run: AgentRun, input: ApprovalRequest, id: string, now: number): Approval {
  assertActor(actor, run);
  if (actor.source !== "session") throw new AgentError("human_approval_required");
  if (input.planDigest !== run.planDigest || input.pricingVersion !== run.plan.pricingVersion) throw new AgentError("approval_changed");
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) throw new AgentError("approval_expired");
  validateLimits(input.limits);
  if (!Array.isArray(input.allowedTools) || input.allowedTools.some(tool => !actor.permissions.includes(tool)
    || !run.plan.actions.some(a => a.toolName === tool))) throw new AgentError("tool_forbidden");
  return structuredClone({ ...input, id, userId: run.userId, revokedAt: null, revision: 1 });
}
