import { AgentError, type RunStatus } from "./contracts";

const edges: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancel_requested", "failed"],
  running: ["waiting_approval", "waiting_job", "waiting_review", "attention", "completed", "failed", "cancel_requested"],
  waiting_approval: ["running", "attention", "failed", "cancel_requested"],
  waiting_job: ["running", "attention", "failed", "cancel_requested"],
  waiting_review: ["running", "completed", "failed", "cancel_requested"],
  attention: ["running", "waiting_job", "failed", "cancel_requested"],
  cancel_requested: ["cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** 纯状态机：包括终态自迁移在内的非法边都明确拒绝。 */
export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!edges[from]?.includes(to)) throw new AgentError("invalid_transition");
  return to;
}
