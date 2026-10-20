/**
 * worker 领取循环的单步决策。
 *
 * 抽出来的唯一理由：**"结果不明时停止领取后续任务"必须能被测试证明**。
 * 写在脚本的 while 里就只能靠人肉审查，而这条恰恰涉及"会不会接着花钱"。
 *
 * 判定规则（任一条成立即 halt）：
 *   - processor 返回 needs_review（租约丢失 / 终态保存失败 / 付费结果不明）
 *   - processor 自己抛错（异常本身就是"结果不明"）
 */
import type { VideoJobOutcome } from "./processor";

export function paidWorkerReady(state: { runtimeReady: boolean; halted: boolean; paused: boolean; stopping: boolean }): boolean {
  return state.runtimeReady && !state.halted && !state.paused && !state.stopping;
}

export type CycleResult = {
  /** 本轮是否真的领到了任务。 */
  claimed: boolean;
  /** 本轮是否完整走了一遍处理。 */
  processed: boolean;
  /** 是否必须停止领取后续任务。 */
  halted: boolean;
  /** 是否因为开关关闭而跳过领取。 */
  paused: boolean;
};

export async function runWorkerCycle<T>(deps: {
  shouldClaim: () => boolean;
  claim: () => Promise<T | null>;
  process: (job: T) => Promise<VideoJobOutcome>;
  log?: (message: string, detail?: unknown) => void;
}): Promise<CycleResult> {
  if (!deps.shouldClaim()) return { claimed: false, processed: false, halted: false, paused: true };
  const job = await deps.claim();
  if (job === null) return { claimed: false, processed: false, halted: false, paused: false };
  let outcome: VideoJobOutcome;
  try {
    outcome = await deps.process(job);
  } catch (error) {
    // 处理过程抛错 ⇒ 无法确认安全结束 ⇒ 停手等人工核对，绝不接着领下一个。
    deps.log?.("processing threw; halting until reviewed", error instanceof Error ? error.name : "UnknownError");
    outcome = "needs_review";
  }
  const halted = outcome !== "safe";
  if (halted) deps.log?.("job needs review; will not claim further jobs", outcome);
  return { claimed: true, processed: true, halted, paused: false };
}
