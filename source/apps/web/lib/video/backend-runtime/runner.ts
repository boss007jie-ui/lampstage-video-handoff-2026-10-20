import type { ActorContext, ToolOutcome } from "../../agent/contracts";
import type { VideoGenerationBackend, VideoSubmissionGate, VideoSubmissionResult } from "../backends/contracts";
import { CollectorError, type CandidateCollector } from "./collector";
import { collectorIdentity, fail, intentFor, parentOutcome, type RuntimeBinding, type VideoLease, VideoRuntimeError } from "./binding";
import type { RuntimeStore } from "./prisma-runtime";
import { authorized, checkLease, claimLease, finalize, gate, heartbeat, observeSubmission, publishReceipt, rejectPrepared, release } from "./transitions";

/** 必须解析持久化的准确历史配置/账户，不得改用当前默认配置。 */
export type HistoricalBackendResolver = (binding: Readonly<RuntimeBinding>, gate: VideoSubmissionGate) => VideoGenerationBackend | null;
export class VideoRuntime {
  constructor(readonly store: RuntimeStore, private readonly resolveBackend: HistoricalBackendResolver, private readonly collector: CandidateCollector) {}
  claim(actor: ActorContext, jobId: string, owner: string, ttlMs = 60000) { return this.store.atomic(actor, jobId, t => claimLease(t, owner, ttlMs)); }
  heartbeat(actor: ActorContext, token: VideoLease, ttlMs = 60000) { return this.store.atomic(actor, token.jobId, t => heartbeat(t, token, ttlMs)); }
  release(actor: ActorContext, token: VideoLease) { return this.store.atomic(actor, token.jobId, t => release(t, token)); }
  observe(actor: ActorContext, token: VideoLease) {
    return this.store.atomic(actor, token.jobId, t => { checkLease(t, token); return structuredClone(t.binding); });
  }
  /** 仅处理显式 job 的一个有界轮次；注入 IO 较慢时由调用方维持心跳。 */
  async run(actor: ActorContext, token: VideoLease): Promise<ToolOutcome> {
    let failure: unknown = null;
    try {
      let b = await this.observe(actor, token);
      for (const initial of b.segments) {
        b = await this.observe(actor, token);
        let s = b.segments.find(s => s.index === initial.index)!;
        if (["collected", "failed", "not_submitted"].includes(s.state)) continue;
        if (s.state === "provider_completed") {
          let recovered;
          try {
            recovered = await this.collector.recover(collectorIdentity(b, s));
          } catch (error) { if (fatalCollection(error)) throw error; continue; }
          if (recovered) { await this.store.atomic(actor, token.jobId, t => publishReceipt(t, token, s.index, recovered)); continue; }
        }
        let gateFailure: unknown = null, decision: string | null = null;
        const submissionGate: VideoSubmissionGate = { claim: async (intent, input) => {
          try { return decision = await this.store.atomic(actor, token.jobId, t => gate(t, token, intent, input)); }
          catch (error) { gateFailure = error; throw error; }
        } };
        let backend: VideoGenerationBackend | null;
        try { backend = this.resolveBackend(b, submissionGate); } catch { return fail("configuration_unavailable"); }
        if (!backend || backend.backendId !== b.backendId) fail("configuration_unavailable");
        if (s.state === "prepared") {
          const allowed = await this.store.atomic(actor, token.jobId, t => { checkLease(t, token); return authorized(t); });
          if (!allowed || !backend.capabilities.submit || !backend.capabilities.enabledModes.includes(b.preparation.mode)) {
            await this.store.atomic(actor, token.jobId, t => rejectPrepared(t, token, s.index)); continue;
          }
          let result: VideoSubmissionResult;
          try { result = await backend.submit({ intent: intentFor(b, s), values: s.input.values }); }
          catch { result = { kind: "submission_unknown", code: "submission_transport_unknown" }; }
          // W1 可能将 gate 异常转成 unknown；持久化失败仍必须向外传播。
          if (gateFailure) throw gateFailure;
          if (decision === "claimed") await this.store.atomic(actor, token.jobId, t => observeSubmission(t, token, s.index, result));
          else if (decision === null) fail("backend_gate_required");
          // not_authorized / already_claimed 不得修改另一领取者的证据。
          continue;
        }
        if (!s.providerTaskId || !backend.capabilities.status) continue;
        const task = { backendId: b.backendId, taskId: s.providerTaskId };
        if (s.state !== "provider_completed") {
          let status;
          try { status = await backend.status(task); } catch { continue; }
          if (status.kind === "failed") { await this.store.atomic(actor, token.jobId, t => finalize(t, token, s.index, "failed")); continue; }
          if (status.kind !== "completed") continue;
          await this.store.atomic(actor, token.jobId, t => finalize(t, token, s.index, "provider_completed"));
          b = await this.observe(actor, token); s = b.segments.find(v => v.index === s.index)!;
        }
        if (!backend.capabilities.results) continue;
        let results;
        try { results = await backend.results(task); } catch { continue; }
        if (results.kind !== "completed") continue;
        const output = results.outputs.find(o => o.mediaType === "video");
        if (!output) continue;
        let receipt;
        try { receipt = await this.collector.collect(collectorIdentity(b, s), output.downloadUrl); }
        catch (error) { if (fatalCollection(error)) throw error; continue; }
        await this.store.atomic(actor, token.jobId, t => publishReceipt(t, token, s.index, receipt));
      }
      return await this.store.atomic(actor, token.jobId, t => { checkLease(t, token); return parentOutcome(t.binding, t.now); });
    } catch (error) { failure = error; throw error; }
    finally {
      try { await this.release(actor, token); }
      catch (error) { if (!failure) throw error; }
    }
  }
}
function fatalCollection(error: unknown): boolean {
  return error instanceof VideoRuntimeError || (error instanceof CollectorError && ["collector_receipt_invalid", "collector_storage_conflict"].includes(error.code));
}
