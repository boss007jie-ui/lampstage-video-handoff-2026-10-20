/**
 * 视频专属运行开关（2026-10-14 引入）。
 *
 * 默认**全部关闭**（fail-closed），这是刻意的：
 *   - `VIDEO_WORKER_PAUSED`：只有显式写 `"false"` 才允许领取任务；缺失/空/拼错一律视为**已暂停**。
 *   - `VIDEO_PAID_GENERATION_ENABLED`：只有显式写 `"true"` 才允许**付费生成**；其余一律禁止。
 *
 * 这样新启动的进程、写错名字的配置、忘记写变量的部署，默认都不会花钱。
 *
 * ⚠️ 环境变量是**进程启动配置，不是远程停止按钮**：改 `.env.prod` 文件不会打断已经在跑的进程。
 * 运维暂停必须重建/停止对应 worker，并确认老进程确实退出。
 *
 * ⚠️ 暂停期间**不能**调用 `claimJob()` 来做"只读检查"——它有副作用：
 * 会把租约过期的任务批量置为 attention。暂停就该完全不碰队列。
 */

export function videoWorkerPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VIDEO_WORKER_PAUSED?.trim() !== "false";
}

export function videoPaidGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VIDEO_PAID_GENERATION_ENABLED?.trim() === "true";
}

export function assertVideoPaidGenerationEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!videoPaidGenerationEnabled(env)) {
    throw new Error("video_paid_generation_disabled");
  }
}

/** 视频付费调用被拦下时统一使用的错误文案（不泄漏内部开关名给终端用户）。 */
export function videoPaidGenerationDisabledMessage(): string {
  return "视频生成暂未开放，请联系管理员。";
}

/**
 * worker 是否可以领取任务。抽成纯函数是为了**可以被测试证明**：
 * "暂停时不 claim" 这条保证不能只写在脚本的循环里靠人肉审查。
 */
export function shouldClaimJobs(env: NodeJS.ProcessEnv = process.env): boolean {
  return !videoWorkerPaused(env) && videoPaidGenerationEnabled(env);
}

/** 付费边界复核所依据的数据库快照（读的是当前值，不是内存里的旧副本）。 */
export type LeaseSnapshot = { leaseOwner: string | null; leaseUntil: Date | null; revision: number } | null;

/**
 * 付费提交前的判定。返回 null 表示可以继续；否则给出具体原因。
 *
 * 为什么需要它：读参考帧、准备输入可能花很久，期间租约可能已失效或任务已被改动。
 * 只有把"当前数据库状态"与"本地预期"当场比对，才能保证不会用旧授权继续花钱。
 */
export function paidBoundaryProblem(
  snapshot: LeaseSnapshot,
  expected: { workerId: string; revision: number },
  now: Date = new Date(),
): "no_job" | "lease_lost" | "revision_changed" | null {
  if (!snapshot) return "no_job";
  if (snapshot.leaseOwner !== expected.workerId) return "lease_lost";
  if (!snapshot.leaseUntil || snapshot.leaseUntil.getTime() <= now.getTime()) return "lease_lost";
  if (snapshot.revision !== expected.revision) return "revision_changed";
  return null;
}

/**
 * 对外回报的维护态原因。返回 null 表示视频功能正常。
 * 注意：**不能**因为数据库和密钥存在就声称视频可用——那正是"假绿灯"。
 */
export function videoMaintenanceReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (videoWorkerPaused(env)) return "视频生成正在维护，暂时不接受新的准备或渲染请求。";
  if (!videoPaidGenerationEnabled(env)) return "视频生成暂未开放。";
  return null;
}
