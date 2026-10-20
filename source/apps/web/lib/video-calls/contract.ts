import { createHash } from "node:crypto";

export class VideoCallError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export interface CallInput {
  request_id?: string;
  motion_asset_id: string;
  reference_assets: { asset_id: string; role?: string; label?: string }[];
  prompt: string;
  duration: 4 | 5 | 6 | 8;
  max_credits?: number;
}
export interface FrozenAsset { asset_id: string; key: string; sha256: string; size_bytes: number; mime: string }
export interface SingleCall {
  version: 1;
  kind: "single_call";
  request_id: string;
  input_digest: string;
  input: CallInput;
  motion: FrozenAsset;
  references: (FrozenAsset & { role?: string; label?: string })[];
  quote_credits: number;
  max_credits: number;
  billing: { mode: "standard" | "internal_test"; charged_credits: number; refunded_credits: number; debit_id?: string; refund_id?: string };
  submission_intent_at?: string;
  build_id?: string;
  provider_task_id?: string;
  terminal_failure?: boolean;
  output?: FrozenAsset & { duration: number; width: number; height: number };
}
const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const safeKey = /^[A-Za-z0-9._:-]{1,128}$/;
export function isSingleCallJob(data: unknown): data is { singleCall: SingleCall } {
  return !!data && typeof data === "object" && "singleCall" in data;
}
export function parseCallInput(value: unknown, preview = false): CallInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoCallError("invalid_input");
  const b = value as Record<string, unknown>;
  const allowed = new Set(["motion_asset_id", "reference_assets", "prompt", "duration", ...(preview ? [] : ["request_id", "max_credits"])]);
  if (Object.keys(b).some(k => !allowed.has(k))) throw new VideoCallError("unknown_field");
  if (typeof b.motion_asset_id !== "string" || !safeId.test(b.motion_asset_id)) throw new VideoCallError("invalid_motion_asset_id");
  if (typeof b.prompt !== "string" || !b.prompt.trim() || b.prompt.length > 12000 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(b.prompt)) throw new VideoCallError("invalid_prompt");
  if (![4, 5, 6, 8].includes(b.duration as number)) throw new VideoCallError("invalid_duration");
  if (!Array.isArray(b.reference_assets) || b.reference_assets.length < 1 || b.reference_assets.length > 6) throw new VideoCallError("invalid_references");
  const refs = b.reference_assets.map((v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new VideoCallError("invalid_reference");
    const r = v as Record<string, unknown>;
    if (Object.keys(r).some(k => !["asset_id", "role", "label"].includes(k)) || typeof r.asset_id !== "string" || !safeId.test(r.asset_id)) throw new VideoCallError("invalid_reference");
    for (const k of ["role", "label"]) if (r[k] !== undefined && (typeof r[k] !== "string" || !(r[k] as string).trim() || (r[k] as string).length > 80 || /[\u0000-\u001f\u007f]/.test(r[k] as string))) throw new VideoCallError("invalid_reference_label");
    return { asset_id: r.asset_id, ...(r.role !== undefined ? { role: r.role as string } : {}), ...(r.label !== undefined ? { label: r.label as string } : {}) };
  });
  if (!preview && (typeof b.request_id !== "string" || !safeKey.test(b.request_id))) throw new VideoCallError("invalid_request_id");
  if (!preview && (!Number.isSafeInteger(b.max_credits) || (b.max_credits as number) < 0 || (b.max_credits as number) > 1_000_000)) throw new VideoCallError("invalid_max_credits");
  return { motion_asset_id: b.motion_asset_id, reference_assets: refs, prompt: b.prompt, duration: b.duration as CallInput["duration"],
    ...(!preview ? { request_id: b.request_id as string, max_credits: b.max_credits as number } : {}) };
}
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const callIdentity = (userId: string, requestId: string) => `vc_${sha256(JSON.stringify([userId, requestId]))}`;
export const inputDigest = (input: CallInput) => sha256(JSON.stringify(input));
export function callQuote(env: Partial<NodeJS.ProcessEnv> = process.env): number | null {
  const value = env.VIDEO_SINGLE_CALL_QUOTE_CREDITS;
  if (!value || !/^[1-9]\d{0,5}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= 100000 ? n : null;
}
/** 免扣资格只取服务端账户状态；平台零积分不代表供应商免费。 */
export function callBillingPolicy(creditsUnlimited: boolean, env: Partial<NodeJS.ProcessEnv> = process.env) {
  return creditsUnlimited ? { credits: 0, mode: "internal_test" as const } : { credits: callQuote(env), mode: "standard" as const };
}
export function callBillingAuthorized(call: Pick<SingleCall, "quote_credits" | "max_credits" | "billing">, creditsUnlimited: boolean, env: Partial<NodeJS.ProcessEnv> = process.env) {
  const policy = callBillingPolicy(creditsUnlimited, env);
  if (policy.credits === null || policy.mode !== call.billing.mode || policy.credits !== call.quote_credits || call.quote_credits > call.max_credits || call.billing.refunded_credits !== 0) return false;
  if (policy.mode === "internal_test") return call.billing.charged_credits === 0 && !call.billing.debit_id && !call.billing.refund_id;
  return call.billing.charged_credits === call.quote_credits;
}
export function submissionAction(call: { submission_intent_at?: string; build_id?: string }) {
  return call.build_id ? "inspect" : call.submission_intent_at ? "unknown" : "submit";
}
