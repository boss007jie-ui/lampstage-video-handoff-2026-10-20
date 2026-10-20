-- CreateTable
CREATE TABLE "AgentImageJob" (
    "job_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "step_key" TEXT NOT NULL,
    "core_attempt_id" TEXT NOT NULL,
    "reservation_unit" TEXT NOT NULL DEFAULT 'image_credit',
    "approval_id" TEXT NOT NULL,
    "approval_revision" INTEGER NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "core_input_digest" TEXT NOT NULL,
    "core_quote_digest" TEXT NOT NULL,
    "input_digest" TEXT NOT NULL,
    "quote_digest" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "quote" JSONB NOT NULL,
    "reference_locations" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attention_code" TEXT,
    "charged_credits" INTEGER NOT NULL,
    "refunded_credits" INTEGER NOT NULL DEFAULT 0,
    "billing_mode" TEXT NOT NULL,
    "fence" INTEGER NOT NULL DEFAULT 0,
    "lease_worker_id" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentImageJob_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "AgentImageIdempotency" (
    "user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,

    CONSTRAINT "AgentImageIdempotency_pkey" PRIMARY KEY ("user_id","idempotency_key")
);

-- CreateTable
CREATE TABLE "AgentImageSlot" (
    "attempt_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "core_attempt_id" TEXT NOT NULL,
    "reservation_unit" TEXT NOT NULL DEFAULT 'image_credit',
    "output_index" INTEGER NOT NULL,
    "quoted_credits" INTEGER NOT NULL,
    "charged_credits" INTEGER NOT NULL,
    "refunded_credits" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "submission_fence" INTEGER,
    "submission_at" TIMESTAMP(3),
    "provider_task_id" TEXT,
    "code" TEXT,
    "absence_evidence" JSONB,
    "settlement_reference" TEXT,
    "output_id" TEXT,
    "usage" JSONB,

    CONSTRAINT "AgentImageSlot_pkey" PRIMARY KEY ("attempt_id")
);

-- CreateTable
CREATE TABLE "AgentImageArtifact" (
    "id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "output_index" INTEGER NOT NULL,
    "scope" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentImageArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageJob_core_attempt_id_key" ON "AgentImageJob"("core_attempt_id");

-- CreateIndex
CREATE INDEX "AgentImageJob_status_lease_expires_at_idx" ON "AgentImageJob"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageJob_run_id_step_key_key" ON "AgentImageJob"("run_id", "step_key");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageJob_job_id_user_id_key" ON "AgentImageJob"("job_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageJob_job_id_run_id_core_attempt_id_user_id_key" ON "AgentImageJob"("job_id", "run_id", "core_attempt_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageJob_run_id_core_attempt_id_user_id_key" ON "AgentImageJob"("run_id", "core_attempt_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageSlot_settlement_reference_key" ON "AgentImageSlot"("settlement_reference");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageSlot_output_id_key" ON "AgentImageSlot"("output_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageSlot_job_id_output_index_key" ON "AgentImageSlot"("job_id", "output_index");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageSlot_attempt_id_job_id_user_id_output_index_key" ON "AgentImageSlot"("attempt_id", "job_id", "user_id", "output_index");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageSlot_run_id_core_attempt_id_reservation_unit_atte_key" ON "AgentImageSlot"("run_id", "core_attempt_id", "reservation_unit", "attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageSlot_output_id_job_id_key" ON "AgentImageSlot"("output_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageArtifact_attempt_id_key" ON "AgentImageArtifact"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageArtifact_storage_key_key" ON "AgentImageArtifact"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageArtifact_job_id_output_index_key" ON "AgentImageArtifact"("job_id", "output_index");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImageArtifact_attempt_id_job_id_user_id_output_index_key" ON "AgentImageArtifact"("attempt_id", "job_id", "user_id", "output_index");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationJob_id_user_id_key" ON "GenerationJob"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "OutputImage_id_job_id_key" ON "OutputImage"("id", "job_id");

-- AddForeignKey
ALTER TABLE "AgentImageJob" ADD CONSTRAINT "AgentImageJob_job_id_user_id_fkey" FOREIGN KEY ("job_id", "user_id") REFERENCES "GenerationJob"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImageJob" ADD CONSTRAINT "AgentImageJob_run_id_core_attempt_id_user_id_fkey" FOREIGN KEY ("run_id", "core_attempt_id", "user_id") REFERENCES "AgentStep"("run_id", "attempt_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImageJob" ADD CONSTRAINT "AgentImageJob_approval_id_run_id_user_id_fkey" FOREIGN KEY ("approval_id", "run_id", "user_id") REFERENCES "AgentApproval"("id", "run_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImageJob" ADD CONSTRAINT "AgentImageJob_run_id_core_attempt_id_reservation_unit_fkey" FOREIGN KEY ("run_id", "core_attempt_id", "reservation_unit") REFERENCES "AgentReservation"("run_id", "attempt_id", "unit") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImageIdempotency" ADD CONSTRAINT "AgentImageIdempotency_job_id_user_id_fkey" FOREIGN KEY ("job_id", "user_id") REFERENCES "AgentImageJob"("job_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImageSlot" ADD CONSTRAINT "AgentImageSlot_job_id_run_id_core_attempt_id_user_id_fkey" FOREIGN KEY ("job_id", "run_id", "core_attempt_id", "user_id") REFERENCES "AgentImageJob"("job_id", "run_id", "core_attempt_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImageSlot" ADD CONSTRAINT "AgentImageSlot_run_id_core_attempt_id_reservation_unit_att_fkey" FOREIGN KEY ("run_id", "core_attempt_id", "reservation_unit", "attempt_id") REFERENCES "AgentReservationSlot"("run_id", "attempt_id", "unit", "slot_attempt_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImageSlot" ADD CONSTRAINT "AgentImageSlot_output_id_job_id_fkey" FOREIGN KEY ("output_id", "job_id") REFERENCES "OutputImage"("id", "job_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImageArtifact" ADD CONSTRAINT "AgentImageArtifact_attempt_id_job_id_user_id_output_index_fkey" FOREIGN KEY ("attempt_id", "job_id", "user_id", "output_index") REFERENCES "AgentImageSlot"("attempt_id", "job_id", "user_id", "output_index") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 授权份额与实际扣退分离；所有约束仅作用于新 sidecar。
ALTER TABLE "AgentImageJob" ADD CONSTRAINT "AgentImageJob_values_check" CHECK (
  reservation_unit = 'image_credit' AND approval_revision > 0 AND fence >= 0
  AND charged_credits >= 0 AND refunded_credits BETWEEN 0 AND charged_credits
  AND billing_mode IN ('standard','internal_test')
  AND status IN ('queued','running','attention','completed','partial','failed')
  AND ((lease_worker_id IS NULL) = (lease_expires_at IS NULL))
  AND jsonb_typeof(input->'prompts') = 'array' AND jsonb_array_length(input->'prompts') BETWEEN 1 AND 4
  AND jsonb_typeof(quote->'outputCredits') = 'array'
  AND jsonb_array_length(quote->'outputCredits') = jsonb_array_length(input->'prompts')
);
ALTER TABLE "AgentImageSlot" ADD CONSTRAINT "AgentImageSlot_values_check" CHECK (
  reservation_unit = 'image_credit' AND output_index BETWEEN 0 AND 3 AND quoted_credits > 0
  AND charged_credits BETWEEN 0 AND quoted_credits AND refunded_credits BETWEEN 0 AND charged_credits
  AND status IN ('queued','submitting','pending','unknown','succeeded','failed')
  AND ((submission_fence IS NULL) = (submission_at IS NULL))
  AND (submission_fence IS NULL OR submission_fence > 0)
  AND (status NOT IN ('submitting','pending','unknown','succeeded') OR submission_fence IS NOT NULL)
  AND ((status = 'succeeded') = (output_id IS NOT NULL))
  AND ((status IN ('succeeded','failed')) = (settlement_reference IS NOT NULL))
);
ALTER TABLE "AgentImageArtifact" ADD CONSTRAINT "AgentImageArtifact_values_check" CHECK (
  output_index BETWEEN 0 AND 3 AND sha256 ~ '^[a-f0-9]{64}$'
  AND mime IN ('image/png','image/jpeg','image/webp') AND size_bytes BETWEEN 1 AND 33554432
  AND id ~ '^image-[a-f0-9]{64}$'
  AND storage_key ~ '^generated/agent-images/image-[a-f0-9]{64}\.(png|jpeg|webp)$'
);

