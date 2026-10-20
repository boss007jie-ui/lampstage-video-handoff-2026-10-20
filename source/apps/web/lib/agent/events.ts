import type { AgentStep, PublicEvent, RunSnapshot } from "./contracts";

/** 刻意不接受任意 payload；新增公开字段必须单独审查，不能展开私有对象。 */
export function projectEvent(snapshot: RunSnapshot, seq: number, step?: AgentStep): PublicEvent {
  if (step) return { seq, type: "step_status", runStatus: snapshot.run.status,
    stepNumber: snapshot.steps.findIndex(s => s.stepKey === step.stepKey) + 1, stepStatus: step.status };
  return { seq, type: "run_status", runStatus: snapshot.run.status };
}
