# Video backend runtime, Wave 2

This directory is an unregistered, explicitly injected runtime for isolated test jobs. Production routes, the old worker, queue dispatch, schemas and W1 backends do not import it. RunningHub `enabledModes` remains empty. No provider mode, material-upload protocol, real storage adapter or production dispatch is certified by this work.

## Entry points

- `prepareVideoBusinessJob` is a core `BusinessPreparer` registered as `video.generate`. `createVideoBusinessPreparer(storageConfig)` permits an explicitly injected image storage public base. Both use only the supplied transaction and bind an existing same-user `VideoJob`; they create no replacement job. Input is exactly `{ jobId, reviewDigest }`.
- `PrismaVideoRuntimeStore(client, fault?)` owns transactions using an explicitly supplied Prisma client. `fault` is an injected failure hook for transaction verification.
- `VideoRuntime(store, historicalBackendResolver, candidateCollector)` provides explicit-job `claim`, `heartbeat`, `observe`, `release`, and one bounded `run`. The caller schedules heartbeats during slow IO; an expired token cannot commit observations or receipts. Every claim creates a new monotonic video fence, independent of the core lease.
- `createCandidateCollector` accepts a DNS/download transport, create-only storage, media probe and policy. It exposes `collect` and `recover`. Transport implementations must pin the selected checked address while preserving TLS hostname and must never follow redirects. There is no default network or storage implementation.
- `preparedJobDigest`, `reviewDigest`, `parseBinding`, `collectorIdentity` and `parentOutcome` provide versioned private validation and a safe parent outcome. Only the parent outcome is suitable for core result recording; never publish the binding, prepared values or provider output URLs.

## Persisted preparation and identity

A trusted server preparation service supplies `data.videoPreparation` and `data.videoConsent`, both version 1. The existing job must use the real `status=review` preparation-complete state, with `phase=prepare`, `prepare_references` or `prepare_sixref` matching its mode. It must have valid prepared clips, windows and reference snapshots, no lease or permit, and no legacy intent/build/task/candidate/terminal/history evidence. Direct/legacy windows use the existing `segmentTimeline`; six-reference windows and start-state roles use existing validation. Unused six-reference top-level defaults need no snapshot. Selected dependent segments remain unsupported until a separate reviewed-predecessor workflow exists.

Materials have explicit table identities: the source is a same-user ready `VideoAsset` with pinned SHA256/storage key; product and reference images are real same-user `UploadedAsset` rows linked to same-user `ImageContent` with pinned content ID/SHA256. Both the asset and canonical content locations are independently checked and frozen; deduplicated content may legitimately use different owned paths. There is no fabricated product `VideoAsset` row. The frozen preparation digest also covers current job instructions/audio choice and the existing prepared segment/reference snapshot; new runtime attempt numbers do not alter that digest.

The consent digest covers the complete preparation: user/job, material table identities/locations/hashes, existing preparation digest, selected segment indices, source windows, requested duration/dimensions, maxCoins, pricing basis and quote version, backend/account/configuration identity and prepared input values. A consent from an older backend-agnostic flow cannot satisfy this digest. Only trusted services may write these records; this module does not expose an endpoint for model-generated preparation or consent.

The preparer persists `data.videoRuntime.version=1` with the original core run/step/attempt, approval revision and frozen preparation. Each segment has attempt 1 and these immutable mappings:

```
childHash = SHA256(canonical({ jobId, coreAttemptId, index, attempt: 1 }))
core slot = video.<childHash>
permit    = <jobId>:<index>:1
intent    = vi.<childHash>
input     = SHA256(canonical({ reviewDigest, segment }))
```

The colon-free slot ID satisfies core's slot grammar. Restart uses these IDs; it never generates a new child attempt. A resolver receives the frozen binding and must return its exact historical backend/account/configuration. A missing historical configuration stops the pass. A collected local artifact can be recovered before backend resolution.

## Transactions and recovery

Lock order is User → core Run/Approval/Step/Reservation/Slot → VideoPermitAccount → current VideoJob → account permits. Routing hints are initially read without locks and verified again under locks. The account lock is shared with old permit code. A scan can quarantine another job's permit, but it does not lock or settle that job's core state.

Gate validation and the sole `submitting` intent/permit write commit together. A previously committed intent returns `already_claimed` before later approval expiry/revocation/cancellation checks. Before that commit, cancelled or invalid authorization cannot send. After it, the network may have sent even if cancellation has just committed; this window is retained conservatively. No automatic replacement submit is permitted.

At most three active permits are allowed per account, and any unknown permit blocks new submits. Valid leases are mirrored to `VideoJob.lease_owner/lease_until`, `generating/render` and top-level segment attempts for the old orphan predicate. A release or expired lease quarantines unresolved permits as unknown without dropping task IDs. Reclaim does not reactivate them. A known task is queried only from the persisted binding. A 404/read error or a timeout without a task ID remains unresolved.

Confirmed provider completion/failure settles its child slot and releases its permit in one transaction with the binding update. Completion may release the provider concurrency slot before media collection; the parent remains pending until the receipt is published. Definite unsubmitted work releases requested seconds; accepted terminal work consumes the approved requested duration. `video_second` is a requested-duration allowance, not a measured bill. maxCoins remains in independent consent/permit fields; this code reports no actual RH coin usage or refund.

`run()` releases its video lease after a bounded pass and propagates persistence failures even when a backend translates a gate exception into an unknown response. If the pass and cleanup both fail, the original failure is preserved; a later claim quarantines any expired active permit. Core parent outcome recording is a separate normal core repository operation after child settlement. A known job never yields core `not_submitted`.

All collected candidates project the job to `review/render`; mixed failures project to `attention/render`. They do not mean a stitched video has been delivered. Existing workers must not be allowed to claim these jobs before a separate dispatcher-isolation integration.

## Candidate receipts

The immutable object key hashes user/job/segment/attempt/inputDigest. Downloads require HTTPS, an allowed host, checked resolved addresses, no redirects, a byte ceiling and a deadline. A media probe verifies actual duration and dimensions. The collector policy must use a tolerance from 0 through the shared `MAX_CANDIDATE_DURATION_DRIFT_SECONDS=0.5`; the runtime receipt boundary uses the same maximum. Production probes must validate real media, as the test FFprobe implementation does.

Storage must atomically create without overwriting. Complete readback, SHA256, byte count, media and identity validation precede receipt publication. Equal bytes replay the same receipt; different bytes or corrupt receipt/ownership data fail closed. A lost put response may recover through readback. A published receipt is immutable. Download failures/expired links retain a recoverable job; corruption and content conflicts surface safe operator codes. Supplier URLs are used only by the private collector and are absent from parent output/events.

The focused tests cover pure state transitions, real local valid/damaged videos, and a full-migration isolated PostgreSQL database with two Prisma clients. Exact commands and results are recorded in `tasks/LAMP-AGENT-VIDEO-W2.md`.
