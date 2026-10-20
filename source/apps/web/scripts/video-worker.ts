import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";

loadEnvConfig(process.cwd());

async function main() {
  const [{ prisma }, { claimJob }, { processVideoJob }, { runnerReadiness, sixRefRunner }, { mediaReadiness }, { shouldClaimJobs, videoMaintenanceReason, videoWorkerPaused }, { runWorkerCycle, paidWorkerReady }, { sweepExpiredDrafts }, { createDraftExpiryLoop }] = await Promise.all([
    import("../lib/db"), import("../lib/video/repository"), import("../lib/video/processor"), import("../lib/video/hypit-runner"), import("../lib/video/media"), import("../lib/video/control"), import("../lib/video/worker-loop"), import("../lib/video/job-quota"), import("../lib/video/draft-expiry-loop"),
  ]);
  const id = `video-single-call-v1-${randomUUID()}`;
  let stopping = false;
  // 付费结果不明（已写 intent / 已产生 imageCalls 而进入 attention）时必须停手等人工核对，
  // 不能接着领下一个任务继续花钱。保留心跳，让外部能看到"worker 还在但已停领"。
  let halted = false;
  let beatPending: Promise<void> | null = null;
  // SIGTERM/SIGINT 不只是置一个"等任务结束才读"的布尔值：同时 abort 进行中的可取消 I/O。
  // 但容器被终止仍可能在上游留下未知状态，所以这不等于"可以安全重试"。
  const stopController = new AbortController();
  const requestStop = () => { stopping = true; stopController.abort(); };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  const beat = (): Promise<void> => {
    if (beatPending) return beatPending;
    beatPending = (async () => {
      await prisma.videoJob.count();
      const media = await mediaReadiness();
      const [runner, sixref] = await Promise.all([runnerReadiness(), sixRefRunner.runnerReadiness()]);
      const paused = !shouldClaimJobs();
      const image = Boolean(process.env.OPENLUX_API_KEY?.trim()) && media;
      const video = media && runner.ready;
      // 暂停期间照常心跳：这是"进程还活着、但按维护态不干活"的唯一证据。
      const detail = paused ? (videoMaintenanceReason() ?? "已暂停")
        : halted ? "有待人工核对的任务，已停止领取新任务"
        : media ? (runner.ready ? null : "account01 视频环境未就绪") : "FFmpeg 未就绪";
      const ready = (runtimeReady: boolean) => paidWorkerReady({ runtimeReady, paused, halted, stopping });
      const fields = { heartbeat_at: new Date(), image_ready: ready(image), video_ready: ready(video), sixref_ready: ready(media && sixref.ready), detail };
      await prisma.videoWorker.upsert({ where: { id }, create: { id, ...fields }, update: fields });
    })().finally(() => { beatPending = null; });
    return beatPending;
  };
  await beat();
  console.info("Video worker started; paid work requires a queued job and persisted consent.");
  let announcedPause = !shouldClaimJobs();
  if (announcedPause) console.info("Video worker paused; will not claim jobs.", videoMaintenanceReason());
  const timer = setInterval(() => { void beat().catch(() => console.error("Video worker heartbeat failed.")); }, 20_000);
  // Free lifecycle work has its own timer, so a long render or halted paid queue cannot starve expiry.
  // The maintenance pause still disables all worker mutations. Never call claimJob or clear permits here.
  const expiry = createDraftExpiryLoop({ paused: () => stopping || videoWorkerPaused(), sweep: input => sweepExpiredDrafts(input) });
  const sweep = async () => {
    try {
      const result = await expiry.run();
      if (result?.scanned) console.info("Video draft expiry sweep", { scanned: result.scanned, cancelled: result.cancelled, blocked: result.blocked, done: result.done });
    } catch { console.error("Video draft expiry sweep failed."); }
  };
  const expiryTimer = setInterval(() => { void sweep(); }, 60_000);
  try {
    await sweep();
    while (!stopping) {
      try {
        // 暂停时**完全不碰队列**：claimJob 有副作用（会把租约过期的任务批量置为 attention），
        // 不能拿它当"只读检查"。免费预检走独立 CLI，不靠放开领取开关运行。
        if (videoWorkerPaused()) {
          if (!announcedPause) { console.info("Video worker paused; will not claim jobs.", videoMaintenanceReason()); announcedPause = true; }
          await new Promise(resolve => setTimeout(resolve, 5_000));
          continue;
        }
        announcedPause = false;
        // 单步决策抽在 runWorkerCycle 里：结果不明（租约丢失/终态保存失败/处理抛错）就 halt，
        // 不再领下一个任务。这样"B 的领取次数为 0"可以被测试证明，而不是靠人肉审查循环。
        const cycle = await runWorkerCycle<Exclude<Awaited<ReturnType<typeof claimJob>>, null>>({
          shouldClaim: () => !videoWorkerPaused(),
          claim: () => claimJob(id, prisma, { recoveryOnly: halted || !shouldClaimJobs() }),
          process: job => processVideoJob(job, id, { signal: stopController.signal }),
          log: (message, detail) => console.error(`[worker] ${message}`, detail ?? ""),
        });
        if (cycle.halted) {
          halted = true;
          // Wait out any heartbeat that captured the pre-halt state, then revoke
          // admission immediately. Later heartbeats retain liveness but no readiness.
          await Promise.resolve(beatPending).catch(() => undefined);
          await prisma.videoWorker.updateMany({ where: { id }, data: {
            image_ready: false, video_ready: false, sixref_ready: false, detail: "有待人工核对的任务，已停止领取新任务",
          } });
        }
        if (!cycle.claimed) await new Promise(resolve => setTimeout(resolve, 2_000));
      } catch { console.error("Video worker queue check failed."); await new Promise(resolve => setTimeout(resolve, 5_000)); }
    }
  } finally {
    clearInterval(timer);
    clearInterval(expiryTimer);
    await expiry.stop();
    await prisma.videoWorker.deleteMany({ where: { id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

void main().catch(() => { console.error("Video worker could not start. Check database and runtime configuration."); process.exitCode = 1; });
