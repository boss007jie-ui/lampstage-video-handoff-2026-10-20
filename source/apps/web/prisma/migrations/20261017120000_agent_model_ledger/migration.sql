-- CreateTable
CREATE TABLE "AgentModelAuthorization" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "expected_run_revision" INTEGER NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "max_requests" INTEGER NOT NULL,
    "max_input_tokens" BIGINT NOT NULL,
    "max_output_tokens" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentModelAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentModelAttempt" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "authorization_revision" INTEGER NOT NULL,
    "attempt_index" INTEGER NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "request_version" TEXT NOT NULL,
    "identity_digest" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "action_identities" JSONB NOT NULL,
    "reserved_input_tokens" BIGINT NOT NULL,
    "reserved_output_tokens" BIGINT NOT NULL,
    "accounted_input_tokens" BIGINT NOT NULL,
    "accounted_output_tokens" BIGINT NOT NULL,
    "released_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "released_output_tokens" BIGINT NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'prepared',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "submission_id" TEXT,
    "submission_worker_id" TEXT,
    "submission_fence" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "finalized_at" TIMESTAMP(3),
    "usage_state" TEXT NOT NULL DEFAULT 'none',
    "evidence_digest" TEXT,
    "evidence" JSONB,
    "overage" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentModelAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelAuthorization_run_id_key" ON "AgentModelAuthorization"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelAuthorization_run_id_user_id_key" ON "AgentModelAuthorization"("run_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelAuthorization_id_run_id_user_id_key" ON "AgentModelAuthorization"("id", "run_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelAuthorization_user_id_client_request_id_key" ON "AgentModelAuthorization"("user_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelAttempt_turn_id_key" ON "AgentModelAttempt"("turn_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelAttempt_submission_id_key" ON "AgentModelAttempt"("submission_id");

-- CreateIndex
CREATE INDEX "AgentModelAttempt_run_id_id_idx" ON "AgentModelAttempt"("run_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelAttempt_turn_id_run_id_key" ON "AgentModelAttempt"("turn_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelAttempt_authorization_id_attempt_index_key" ON "AgentModelAttempt"("authorization_id", "attempt_index");

-- AddForeignKey
ALTER TABLE "AgentModelAuthorization" ADD CONSTRAINT "AgentModelAuthorization_run_id_user_id_fkey" FOREIGN KEY ("run_id", "user_id") REFERENCES "AgentRun"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentModelAttempt" ADD CONSTRAINT "AgentModelAttempt_run_id_user_id_fkey" FOREIGN KEY ("run_id", "user_id") REFERENCES "AgentRun"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentModelAttempt" ADD CONSTRAINT "AgentModelAttempt_turn_id_run_id_fkey" FOREIGN KEY ("turn_id", "run_id") REFERENCES "AgentModelTurn"("id", "run_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentModelAttempt" ADD CONSTRAINT "AgentModelAttempt_authorization_id_run_id_user_id_fkey" FOREIGN KEY ("authorization_id", "run_id", "user_id") REFERENCES "AgentModelAuthorization"("id", "run_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only the two new tables gain checks. No old table semantics change.
ALTER TABLE "AgentModelAuthorization" ADD CONSTRAINT "AgentModelAuthorization_bounds_check" CHECK (
  "max_requests" BETWEEN 1 AND 1000 AND "max_input_tokens" BETWEEN 1 AND 1000000000000 AND "max_output_tokens" BETWEEN 1 AND 1000000000000
  AND "expected_run_revision" >= 0 AND "expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '7 days'
  AND (("revision" = 1 AND "revoked_at" IS NULL) OR ("revision" = 2 AND "revoked_at" IS NOT NULL))
);
ALTER TABLE "AgentModelAuthorization" ADD CONSTRAINT "AgentModelAuthorization_scope_check" CHECK (
  "provider" = 'deepseek' AND "model" IN ('deepseek-flash', 'deepseek-v4-pro')
  AND "policy_version" ~ '^[A-Za-z0-9_.:-]{1,128}$' AND "client_request_id" ~ '^[A-Za-z0-9_.:-]{1,128}$'
  AND "request_digest" ~ '^[a-f0-9]{64}$' AND "plan_digest" ~ '^[a-f0-9]{64}$'
);
ALTER TABLE "AgentModelAttempt" ADD CONSTRAINT "AgentModelAttempt_bounds_check" CHECK (
  "attempt_index" BETWEEN 0 AND 999 AND "authorization_revision" BETWEEN 1 AND 2 AND "revision" BETWEEN 1 AND 4
  AND "reserved_input_tokens" BETWEEN 0 AND 1000000000000 AND "reserved_output_tokens" BETWEEN 0 AND 1000000000000
  AND "accounted_input_tokens" BETWEEN 0 AND 9007199254740991 AND "accounted_output_tokens" BETWEEN 0 AND 9007199254740991
  AND "released_input_tokens" BETWEEN 0 AND "reserved_input_tokens" AND "released_output_tokens" BETWEEN 0 AND "reserved_output_tokens"
  AND jsonb_typeof("action_identities") = 'array' AND jsonb_array_length("action_identities") <= 40
  AND octet_length("action_identities"::text) <= 16384
);
ALTER TABLE "AgentModelAttempt" ADD CONSTRAINT "AgentModelAttempt_scope_check" CHECK (
  "provider" = 'deepseek' AND "model" IN ('deepseek-flash', 'deepseek-v4-pro')
  AND "policy_version" ~ '^[A-Za-z0-9_.:-]{1,128}$' AND "request_version" ~ '^[A-Za-z0-9_.:-]{1,128}$'
  AND "request_digest" ~ '^[a-f0-9]{64}$' AND "plan_digest" ~ '^[a-f0-9]{64}$' AND "identity_digest" ~ '^[a-f0-9]{64}$'
  AND "state" IN ('prepared', 'submitting', 'unknown', 'not_submitted', 'response_received', 'abandoned')
  AND "usage_state" IN ('none', 'missing', 'invalid', 'complete')
);
ALTER TABLE "AgentModelAttempt" ADD CONSTRAINT "AgentModelAttempt_submission_check" CHECK ((
  (("state" IN ('prepared', 'abandoned') AND "submission_id" IS NULL AND "submission_worker_id" IS NULL AND "submission_fence" IS NULL AND "submitted_at" IS NULL)
    OR ("state" IN ('submitting', 'unknown', 'not_submitted', 'response_received') AND "submission_id" IS NOT NULL AND "submission_worker_id" IS NOT NULL AND "submission_fence" > 0 AND "submitted_at" IS NOT NULL))
  AND (("state" IN ('abandoned', 'not_submitted', 'response_received') AND "finalized_at" IS NOT NULL)
    OR ("state" IN ('prepared', 'submitting', 'unknown') AND "finalized_at" IS NULL))
  AND (("state" = 'prepared' AND "revision" = 1) OR ("state" IN ('submitting', 'abandoned') AND "revision" = 2)
    OR ("state" = 'unknown' AND "revision" = 3) OR ("state" IN ('not_submitted', 'response_received') AND "revision" IN (3, 4)))
) IS TRUE);
ALTER TABLE "AgentModelAttempt" ADD CONSTRAINT "AgentModelAttempt_evidence_check" CHECK ((
  (("state" IN ('prepared', 'submitting', 'abandoned') AND "evidence" IS NULL AND "evidence_digest" IS NULL)
    OR ("state" IN ('unknown', 'not_submitted', 'response_received') AND "evidence" IS NOT NULL AND "evidence_digest" ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof("evidence") = 'object' AND "evidence"->>'kind' = "state" AND "evidence"->>'requestDigest' = "request_digest"))
  AND (("state" = 'response_received' AND "usage_state" IN ('missing', 'invalid', 'complete')) OR ("state" <> 'response_received' AND "usage_state" = 'none'))
) IS TRUE);
ALTER TABLE "AgentModelAttempt" ADD CONSTRAINT "AgentModelAttempt_accounting_check" CHECK (
  ("state" IN ('prepared', 'submitting', 'unknown') AND "accounted_input_tokens" = "reserved_input_tokens" AND "accounted_output_tokens" = "reserved_output_tokens"
    AND "released_input_tokens" = 0 AND "released_output_tokens" = 0 AND NOT "overage")
  OR ("state" IN ('abandoned', 'not_submitted') AND "accounted_input_tokens" = 0 AND "accounted_output_tokens" = 0
    AND "released_input_tokens" = "reserved_input_tokens" AND "released_output_tokens" = "reserved_output_tokens" AND NOT "overage")
  OR ("state" = 'response_received' AND "usage_state" IN ('missing', 'invalid') AND "accounted_input_tokens" = "reserved_input_tokens" AND "accounted_output_tokens" = "reserved_output_tokens"
    AND "released_input_tokens" = 0 AND "released_output_tokens" = 0 AND NOT "overage")
  OR ("state" = 'response_received' AND "usage_state" = 'complete'
    AND "released_input_tokens" = GREATEST("reserved_input_tokens" - "accounted_input_tokens", 0)
    AND "released_output_tokens" = GREATEST("reserved_output_tokens" - "accounted_output_tokens", 0)
    AND "overage" = ("accounted_input_tokens" > "reserved_input_tokens" OR "accounted_output_tokens" > "reserved_output_tokens"))
);

