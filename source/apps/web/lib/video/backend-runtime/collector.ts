import { createHash } from "node:crypto";

/** 收取与事务发布共用的最宽时长偏差；注入策略可以更严格。 */
export const MAX_CANDIDATE_DURATION_DRIFT_SECONDS = 0.5;

export interface CollectorIdentity {
  userId: string;
  jobId: string;
  segmentIndex: number;
  attempt: number;
  inputDigest: string;
  requestedDuration: number;
  width: number;
  height: number;
}

export interface CandidateReceipt {
  key: string;
  sha256: string;
  sizeBytes: number;
  duration: number;
  width: number;
  height: number;
  identityDigest: string;
}

export interface CandidateCollector {
  collect(identity: CollectorIdentity, downloadUrl: string): Promise<CandidateReceipt>;
  recover(identity: CollectorIdentity): Promise<CandidateReceipt | null>;
}

export type CollectorErrorCode =
  | "collector_invalid_identity" | "collector_url_rejected" | "collector_dns_rejected"
  | "collector_download_failed" | "collector_download_timeout" | "collector_download_too_large"
  | "collector_media_invalid" | "collector_storage_failed" | "collector_storage_conflict"
  | "collector_receipt_invalid";

/** 对外安全错误码，不包含供应商 URL 或传输/存储异常原文。 */
export class CollectorError extends Error {
  constructor(readonly code: CollectorErrorCode) { super(code); this.name = "CollectorError"; }
}

export interface DownloadResponse {
  status: number;
  body: AsyncIterable<Uint8Array>;
}

export interface CandidateDownloadTransport {
  /** 请求前即时解析，返回的所有地址都要通过策略检查。 */
  resolveAddresses(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  /** 必须连接已检查的 connectAddress，并保留原主机名用于 TLS SNI/Host；禁止自动跟随重定向。 */
  request(input: { url: URL; connectAddress: string; signal: AbortSignal }): Promise<DownloadResponse>;
}

export interface CandidateStorage {
  /** 原子只创建，已有 key 不能覆盖。 */
  putIfAbsent(key: string, object: StoredCandidate): Promise<"created" | "exists">;
  read(key: string): Promise<StoredCandidate | null>;
}

export interface StoredCandidate { bytes: Uint8Array; receipt: CandidateReceipt }
export interface CandidateMediaProbe {
  inspect(bytes: Uint8Array, signal: AbortSignal): Promise<{ duration: number; width: number; height: number }>;
}

export interface CandidateCollectorDependencies {
  transport: CandidateDownloadTransport;
  storage: CandidateStorage;
  media: CandidateMediaProbe;
  policy: {
    allowedHosts: readonly string[];
    allowAddress: (address: string) => boolean;
    maxBytes: number;
    timeoutMs: number;
    durationToleranceSeconds: number;
  };
}

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const identityFields = (identity: CollectorIdentity) => [identity.userId, identity.jobId, identity.segmentIndex, identity.attempt, identity.inputDigest] as const;
export const candidateKey = (identity: CollectorIdentity): string => `video-candidates/v1/${digest(JSON.stringify(identityFields(identity)))}.mp4`;
export const candidateIdentityDigest = (identity: CollectorIdentity): string => digest(JSON.stringify([...identityFields(identity), identity.requestedDuration, identity.width, identity.height]));

function validatedIdentity(identity: CollectorIdentity): void {
  if (!identity || [identity.userId, identity.jobId, identity.inputDigest].some(v => typeof v !== "string" || !v.trim() || v.length > 256)
    || !Number.isSafeInteger(identity.segmentIndex) || identity.segmentIndex < 0
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 0
    || !Number.isFinite(identity.requestedDuration) || identity.requestedDuration <= 0
    || !Number.isSafeInteger(identity.width) || identity.width <= 0
    || !Number.isSafeInteger(identity.height) || identity.height <= 0) throw new CollectorError("collector_invalid_identity");
}

function safeUrl(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CollectorError("collector_url_rejected"); }
  // 下载地址不接受内嵌凭据、额外端口或未列入策略的主机。
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHosts.some(host => host.toLowerCase() === url.hostname.toLowerCase()))
    throw new CollectorError("collector_url_rejected");
  return url;
}

function validatePolicy(policy: CandidateCollectorDependencies["policy"]): void {
  if (!policy.allowedHosts.length || !Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0
    || !Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0
    || !Number.isFinite(policy.durationToleranceSeconds) || policy.durationToleranceSeconds < 0
    || policy.durationToleranceSeconds > MAX_CANDIDATE_DURATION_DRIFT_SECONDS)
    throw new CollectorError("collector_url_rejected");
}

/** 同一超时覆盖 DNS、响应头、响应体和媒体探测。 */
async function withinDeadline<T>(operation: (signal: AbortSignal, guard: <R>(promise: Promise<R>) => Promise<R>) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new CollectorError("collector_download_timeout")); }, timeoutMs);
  });
  const guard = <R>(promise: Promise<R>): Promise<R> => Promise.race([promise, timeout]);
  try { return await guard(operation(controller.signal, guard)); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

function checkedMedia(info: { duration: number; width: number; height: number }, identity: CollectorIdentity, tolerance: number): void {
  if (!Number.isFinite(info.duration) || info.duration <= 0 || Math.abs(info.duration - identity.requestedDuration) > tolerance
    || info.width !== identity.width || info.height !== identity.height) throw new CollectorError("collector_media_invalid");
}

export function createCandidateCollector(deps: CandidateCollectorDependencies): CandidateCollector {
  validatePolicy(deps.policy);
  const { transport, storage, media, policy } = deps;

  const read = async (identity: CollectorIdentity): Promise<StoredCandidate | null> => {
    let object: StoredCandidate | null;
    try { object = await storage.read(candidateKey(identity)); }
    catch { throw new CollectorError("collector_storage_failed"); }
    if (!object) return null;
    const { receipt, bytes } = object;
    if (!receipt || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > policy.maxBytes
      || receipt.key !== candidateKey(identity) || receipt.identityDigest !== candidateIdentityDigest(identity)
      || receipt.sha256 !== digest(bytes) || receipt.sizeBytes !== bytes.length)
      throw new CollectorError("collector_receipt_invalid");
    let info: Awaited<ReturnType<CandidateMediaProbe["inspect"]>>;
    try { info = await withinDeadline((signal, guard) => guard(media.inspect(bytes, signal)), policy.timeoutMs); }
    catch { throw new CollectorError("collector_receipt_invalid"); }
    try { checkedMedia(info, identity, policy.durationToleranceSeconds); }
    catch { throw new CollectorError("collector_receipt_invalid"); }
    if (receipt.duration !== info.duration || receipt.width !== info.width || receipt.height !== info.height)
      throw new CollectorError("collector_receipt_invalid");
    return object;
  };

  const recover = async (identity: CollectorIdentity): Promise<CandidateReceipt | null> => {
    validatedIdentity(identity);
    return (await read(identity))?.receipt ?? null;
  };

  const collect = async (identity: CollectorIdentity, downloadUrl: string): Promise<CandidateReceipt> => {
    validatedIdentity(identity);
    const url = safeUrl(downloadUrl, policy.allowedHosts);
    let bytes: Uint8Array;
    let info: Awaited<ReturnType<CandidateMediaProbe["inspect"]>>;
    try {
      ({ bytes, info } = await withinDeadline(async (signal, guard) => {
        let addresses: readonly string[];
        try { addresses = await guard(transport.resolveAddresses(url.hostname, signal)); }
        catch (error) { if (error instanceof CollectorError) throw error; throw new CollectorError("collector_dns_rejected"); }
        if (!addresses.length || addresses.some(address => !policy.allowAddress(address))) throw new CollectorError("collector_dns_rejected");
        const response = await guard(transport.request({ url, connectAddress: addresses[0], signal }));
        // 拒绝重定向；注入的 transport 也不得在内部自动跟随。
        if (response.status !== 200) throw new CollectorError("collector_download_failed");
        const chunks: Uint8Array[] = [];
        let length = 0;
        const iterator = response.body[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await guard(iterator.next());
            if (next.done) break;
            if (!(next.value instanceof Uint8Array)) throw new CollectorError("collector_download_failed");
            length += next.value.length;
            if (length > policy.maxBytes) throw new CollectorError("collector_download_too_large");
            chunks.push(next.value);
          }
        } finally { await iterator.return?.(); }
        if (!length) throw new CollectorError("collector_media_invalid");
        const bytes = Buffer.concat(chunks, length);
        let info: Awaited<ReturnType<CandidateMediaProbe["inspect"]>>;
        try { info = await guard(media.inspect(bytes, signal)); }
        catch (error) { if (error instanceof CollectorError) throw error; throw new CollectorError("collector_media_invalid"); }
        checkedMedia(info, identity, policy.durationToleranceSeconds);
        return { bytes, info };
      }, policy.timeoutMs));
    } catch (error) {
      // 签名链接过期或响应丢失时，本方可能已有完整、可读的候选。
      const existing = await read(identity);
      if (existing) return existing.receipt;
      if (error instanceof CollectorError) throw error;
      throw new CollectorError("collector_download_failed");
    }

    const receipt: CandidateReceipt = { key: candidateKey(identity), sha256: digest(bytes), sizeBytes: bytes.length,
      duration: info.duration, width: info.width, height: info.height, identityDigest: candidateIdentityDigest(identity) };
    let writeFailed = false;
    try { await storage.putIfAbsent(receipt.key, { bytes, receipt }); }
    catch { writeFailed = true; }
    const stored = await read(identity);
    if (stored) {
      if (stored.receipt.sha256 !== receipt.sha256 || !Buffer.from(stored.bytes).equals(Buffer.from(bytes)))
        throw new CollectorError("collector_storage_conflict");
      return stored.receipt;
    }
    throw new CollectorError(writeFailed ? "collector_storage_failed" : "collector_receipt_invalid");
  };
  return { collect, recover };
}
