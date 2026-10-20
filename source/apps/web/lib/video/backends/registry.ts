import type { VideoAttemptBinding, VideoBackendMode, VideoGenerationBackend } from "./contracts";

/** 此绑定需与 job 创建/attempt 创建同一事务持久化；内存对象本身不是持久层。 */
export interface VideoJobBackendBinding { readonly jobId: string; readonly backendId: string }
export type VideoBackendSelectionError = { ok: false; code: "backend_not_registered" | "backend_already_registered" | "backend_binding_mismatch" | "backend_capability_unverified" };

/** 不包含供应商优先级、自动 fallback 或既有任务迁移逻辑。 */
export class VideoBackendRegistry {
  private readonly backends = new Map<string, VideoGenerationBackend>();
  private defaultId?: string;

  constructor(backends: readonly VideoGenerationBackend[] = [], defaultId?: string) {
    for (const backend of backends) {
      const registered = this.register(backend);
      if (!registered.ok) throw new Error(registered.code);
    }
    if (defaultId !== undefined) {
      const selected = this.setDefault(defaultId);
      if (!selected.ok) throw new Error(selected.code);
    }
  }
  register(backend: VideoGenerationBackend): { ok: true } | VideoBackendSelectionError {
    if (!backend.backendId) return { ok: false, code: "backend_not_registered" };
    if (this.backends.has(backend.backendId)) return { ok: false, code: "backend_already_registered" };
    this.backends.set(backend.backendId, backend);
    return { ok: true };
  }
  setDefault(backendId: string): { ok: true } | VideoBackendSelectionError {
    if (!this.backends.has(backendId)) return { ok: false, code: "backend_not_registered" };
    this.defaultId = backendId;
    return { ok: true };
  }
  bindNewJob(jobId: string, mode: VideoBackendMode, requestedBackendId = this.defaultId): { ok: true; binding: VideoJobBackendBinding } | VideoBackendSelectionError {
    if (!jobId) return { ok: false, code: "backend_binding_mismatch" };
    const backend = requestedBackendId ? this.backends.get(requestedBackendId) : undefined;
    if (!backend) return { ok: false, code: "backend_not_registered" };
    if (!backend.capabilities.submit || !backend.capabilities.enabledModes.includes(mode)) return { ok: false, code: "backend_capability_unverified" };
    return { ok: true, binding: Object.freeze({ jobId, backendId: backend.backendId }) };
  }
  forAttempt(binding: VideoJobBackendBinding, attempt: VideoAttemptBinding): { ok: true; backend: VideoGenerationBackend } | VideoBackendSelectionError {
    if (!binding.backendId || binding.backendId !== attempt.backendId || binding.jobId !== attempt.jobId) return { ok: false, code: "backend_binding_mismatch" };
    const backend = this.backends.get(binding.backendId);
    if (!backend || backend.backendId !== binding.backendId) return { ok: false, code: "backend_not_registered" };
    return { ok: true, backend };
  }
}
