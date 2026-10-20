import { createHash } from "node:crypto";
import type { VideoJobData } from "./types";
import { assessCandidateTiming } from "./candidate-quality";
import { CandidateReviewError } from "./candidate-review-error";

export function candidateReviewToken(jobId: string, data: VideoJobData): string | null {
  if (data.generationMode !== "six_references" || !data.segments.some(s => s.candidateKey || s.terminalFailure)) return null;
  return createHash("sha256").update(JSON.stringify({ jobId, profile: data.workflowProfile,
    segments: data.segments.map(s => ({ index: s.index, attempt: s.attempt ?? 0, candidate: s.candidateKey, sha256: s.candidateSha256,
      tail: s.tailSha256, trimStart: s.candidateTrimStart ?? 0, accepted: Boolean(s.accepted), buildId: s.buildId, failed: Boolean(s.terminalFailure),
      start: s.start, sourceDuration: s.sourceWindowDuration, requestedDuration: s.duration, media: s.candidateMedia ?? null })) })).digest("hex");
}
export function applyCandidateReview(data: VideoJobData, decisions: unknown): VideoJobData {
  if (!Array.isArray(decisions) || !decisions.length || decisions.length > data.segments.length) throw new CandidateReviewError("invalid_decisions");
  const next = structuredClone(data);
  const indices = new Set<number>();
  for (const raw of decisions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Number.isInteger(raw.segment_index) || indices.has(raw.segment_index)) throw new CandidateReviewError("invalid_segment");
    indices.add(raw.segment_index);
    const s = next.segments[raw.segment_index];
    if (!s || s.index !== raw.segment_index || (!s.candidateKey && !s.terminalFailure) || raw.candidate_sha256 !== (s.candidateSha256 ?? (s.terminalFailure ? "failed" : null))) throw new CandidateReviewError("candidate_changed", raw.segment_index);
    if (raw.action === "accept") {
      if (!s.candidateKey || !s.tailKey || !s.tailSha256) throw new CandidateReviewError("candidate_incomplete", s.index);
      const trim = raw.trim_start === undefined ? s.candidateTrimStart ?? 0 : raw.trim_start;
      if (typeof trim !== "number" || !Number.isFinite(trim) || trim < 0) throw new CandidateReviewError("invalid_trim", s.index);
      const timing = assessCandidateTiming(next.segments, s.index, { trimStart: trim });
      if (timing.status !== "compatible") throw new CandidateReviewError(timing.reason === "duration_out_of_range" ? "duration_incompatible" :
        timing.reason === "actual_duration_unknown" ? "actual_duration_unknown" : timing.reason === "invalid_trim" ? "invalid_trim" : "invalid_source_window", s.index, timing);
      s.candidateTrimStart = trim;
      s.accepted = true;
    } else if (raw.action === "retry") {
      if (raw.trim_start !== undefined) throw new CandidateReviewError("retry_trim_conflict", s.index);
      if (typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 500) throw new CandidateReviewError("retry_reason_required", s.index);
      // A generated descendant was conditioned on this precise result; never silently invalidate it.
      const descendants = new Set([s.index]);
      for (const child of next.segments) if (child.startFromSegment !== undefined && descendants.has(child.startFromSegment)) {
        descendants.add(child.index);
        if (child.submissionIntentAt || child.buildId || child.candidateKey) throw new CandidateReviewError("dependent_result_exists", s.index);
      }
      s.history = [...(s.history ?? []), { attempt: s.attempt ?? 0, buildId: s.buildId, providerTaskId: s.providerTaskId,
        candidateKey: s.candidateKey, candidateSha256: s.candidateSha256, reason: raw.reason.trim() }];
      s.attempt = (s.attempt ?? 0) + 1;
      for (const key of ["candidateKey", "candidateSha256", "candidateMedia", "candidateTrimStart", "tailKey", "tailSha256", "accepted", "terminalFailure", "submissionIntentAt", "buildId", "providerTaskId", "error"] as const) delete s[key];
    } else throw new CandidateReviewError("invalid_action", s.index);
  }
  delete next.renderConsent;
  delete next.outputKey;
  delete next.outputSha256;
  delete next.outputMedia;
  return next;
}
