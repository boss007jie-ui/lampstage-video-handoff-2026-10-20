import { submissionAction, type SingleCall } from "./contract";

export interface SingleCallIO {
  prepare(): Promise<void>;
  reserve(): Promise<void>;
  authorize(): Promise<void>;
  save(): Promise<void>;
  submit(before: () => Promise<void>, receipt: (id: string) => Promise<void>): Promise<string>;
  inspect(): Promise<{ state: "working" | "completed" | "failed" | "unknown"; taskId?: string }>;
  resume(): Promise<{ ready: boolean; taskId?: string }>;
  collect(): Promise<void>;
  release(): Promise<void>;
  unknown(): Promise<void>;
  refund(): Promise<void>;
  finish(status: "completed" | "failed" | "attention"): Promise<void>;
  wait(): Promise<void>;
  stopped(): boolean;
}
/** 有持久意图的调用只有查询路径；没有上游终态证据时绝不退占槽或重投。 */
export async function runSingleCall(call: SingleCall, io: SingleCallIO): Promise<"safe" | "needs_review"> {
  let terminal = false;
  try {
    // This evidence was saved before the refund transaction. A recovery must be
    // able to finish that transaction even when the provider is no longer reachable.
    if (call.terminal_failure) {
      terminal = true;
      await io.release();
      await io.refund();
      await io.finish("failed");
      return "safe";
    }
    const action = submissionAction(call);
    let resumePending = action === "inspect";
    if (action === "unknown") throw new Error("submission_unknown");
    if (action === "submit") {
      await io.prepare();
      await io.reserve();
      const buildId = await io.submit(async () => {
        if (io.stopped()) throw new Error("stopped");
        await io.authorize();
        call.submission_intent_at = new Date().toISOString();
        await io.save();
      }, async id => { call.build_id = id; await io.save(); });
      if (!call.build_id) { call.build_id = buildId; await io.save(); }
    }
    while (!io.stopped()) {
      const state = await io.inspect();
      if (state.taskId && state.taskId !== call.provider_task_id) { call.provider_task_id = state.taskId; await io.save(); }
      if (state.state === "unknown") throw new Error("submission_unknown");
      if (state.state === "failed") {
        terminal = true; call.terminal_failure = true;
        await io.save();
        await io.release();
        await io.refund();
        await io.finish("failed");
        return "safe";
      }
      if (state.state === "completed") {
        terminal = true;
        await io.release();
        await io.collect();
        await io.finish("completed");
        return "safe";
      }
      if (resumePending) {
        // 仅恢复已有 build；helper 必须确认持久供应商回执后才可唤醒原运行时。
        // 每次接管最多一次，不能把持续 working 当作重复启动或重投授权。
        resumePending = false;
        if (io.stopped()) throw new Error("interrupted");
        const resumed = await io.resume();
        if (!resumed.ready) throw new Error("submission_unknown");
        if (resumed.taskId && resumed.taskId !== call.provider_task_id) { call.provider_task_id = resumed.taskId; await io.save(); }
      }
      await io.wait();
    }
    throw new Error("interrupted");
  } catch {
    if (call.submission_intent_at || call.build_id) {
      if (!terminal) await io.unknown();
      await io.finish("attention");
      return "needs_review";
    }
    await io.release();
    await io.refund();
    await io.finish("failed");
    return "safe";
  }
}
