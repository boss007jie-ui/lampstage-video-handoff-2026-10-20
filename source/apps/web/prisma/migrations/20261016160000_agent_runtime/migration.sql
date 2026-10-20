-- CreateTable
CREATE TABLE "AgentThread" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "creation_digest" TEXT NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "limits" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "fence" INTEGER NOT NULL DEFAULT 0,
    "lease_worker_id" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "model_calls" INTEGER NOT NULL DEFAULT 0,
    "tool_calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentModelTurn" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "turn_index" INTEGER NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "assistant_text" TEXT NOT NULL,
    "calls" JSONB NOT NULL,
    "finish" TEXT,

    CONSTRAINT "AgentModelTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApproval" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "approval_index" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "plan_digest" TEXT NOT NULL,
    "pricing_version" TEXT NOT NULL,
    "allowed_tools" JSONB NOT NULL,
    "limits" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStep" (
    "attempt_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "step_key" TEXT NOT NULL,
    "model_turn_id" TEXT NOT NULL,
    "tool_call_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "input_digest" TEXT NOT NULL,
    "quote_digest" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "quote" JSONB NOT NULL,
    "requires_approval" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "approval_id" TEXT,
    "approval_revision" INTEGER,
    "submission_fence" INTEGER,
    "job_id" TEXT,
    "business_managed" BOOLEAN NOT NULL DEFAULT false,
    "outcome" JSONB,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("attempt_id")
);

-- CreateTable
CREATE TABLE "AgentReservation" (
    "run_id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "approval_id" TEXT,
    "reserved_amount" BIGINT NOT NULL,
    "settled_amount" BIGINT,
    "released_amount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "settlement_basis" TEXT,

    CONSTRAINT "AgentReservation_pkey" PRIMARY KEY ("run_id","attempt_id","unit")
);

-- CreateTable
CREATE TABLE "AgentReservationSlot" (
    "run_id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "slot_attempt_id" TEXT NOT NULL,
    "allocated_amount" BIGINT NOT NULL,
    "settled_amount" BIGINT NOT NULL DEFAULT 0,
    "released_amount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "evidence_digest" TEXT,
    "evidence" JSONB,

    CONSTRAINT "AgentReservationSlot_pkey" PRIMARY KEY ("run_id","attempt_id","unit","slot_attempt_id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "run_status" TEXT NOT NULL,
    "step_number" INTEGER,
    "step_status" TEXT,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("run_id","event_seq")
);

-- CreateIndex
CREATE INDEX "AgentThread_user_id_created_at_idx" ON "AgentThread"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "AgentThread_id_user_id_key" ON "AgentThread"("id", "user_id");

-- CreateIndex
CREATE INDEX "AgentRun_status_lease_expires_at_idx" ON "AgentRun"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_user_id_thread_id_client_request_id_key" ON "AgentRun"("user_id", "thread_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_id_user_id_key" ON "AgentRun"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelTurn_run_id_turn_index_key" ON "AgentModelTurn"("run_id", "turn_index");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelTurn_id_run_id_key" ON "AgentModelTurn"("id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentApproval_run_id_approval_index_key" ON "AgentApproval"("run_id", "approval_index");

-- CreateIndex
CREATE UNIQUE INDEX "AgentApproval_id_run_id_user_id_key" ON "AgentApproval"("id", "run_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_run_id_step_key_key" ON "AgentStep"("run_id", "step_key");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_run_id_attempt_id_key" ON "AgentStep"("run_id", "attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_run_id_attempt_id_user_id_key" ON "AgentStep"("run_id", "attempt_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_run_id_step_index_key" ON "AgentStep"("run_id", "step_index");

-- CreateIndex
CREATE UNIQUE INDEX "AgentReservationSlot_slot_attempt_id_unit_key" ON "AgentReservationSlot"("slot_attempt_id", "unit");

-- AddForeignKey
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_thread_id_user_id_fkey" FOREIGN KEY ("thread_id", "user_id") REFERENCES "AgentThread"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentModelTurn" ADD CONSTRAINT "AgentModelTurn_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_run_id_user_id_fkey" FOREIGN KEY ("run_id", "user_id") REFERENCES "AgentRun"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_run_id_user_id_fkey" FOREIGN KEY ("run_id", "user_id") REFERENCES "AgentRun"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_model_turn_id_run_id_fkey" FOREIGN KEY ("model_turn_id", "run_id") REFERENCES "AgentModelTurn"("id", "run_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_approval_id_run_id_user_id_fkey" FOREIGN KEY ("approval_id", "run_id", "user_id") REFERENCES "AgentApproval"("id", "run_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentReservation" ADD CONSTRAINT "AgentReservation_run_id_attempt_id_user_id_fkey" FOREIGN KEY ("run_id", "attempt_id", "user_id") REFERENCES "AgentStep"("run_id", "attempt_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentReservation" ADD CONSTRAINT "AgentReservation_approval_id_run_id_user_id_fkey" FOREIGN KEY ("approval_id", "run_id", "user_id") REFERENCES "AgentApproval"("id", "run_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentReservationSlot" ADD CONSTRAINT "AgentReservationSlot_run_id_attempt_id_unit_fkey" FOREIGN KEY ("run_id", "attempt_id", "unit") REFERENCES "AgentReservation"("run_id", "attempt_id", "unit") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_run_id_user_id_fkey" FOREIGN KEY ("run_id", "user_id") REFERENCES "AgentRun"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integer accounting bounds apply to the original authorization and every child share.
ALTER TABLE "AgentReservation" ADD CONSTRAINT "AgentReservation_amount_bounds" CHECK (
  reserved_amount >= 0 AND reserved_amount <= 9007199254740991 AND released_amount >= 0
  AND (settled_amount IS NULL OR settled_amount >= 0)
  AND COALESCE(settled_amount, 0) + released_amount <= reserved_amount
);
ALTER TABLE "AgentReservationSlot" ADD CONSTRAINT "AgentReservationSlot_amount_bounds" CHECK (
  allocated_amount > 0 AND allocated_amount <= 9007199254740991
  AND settled_amount >= 0 AND released_amount >= 0
  AND settled_amount + released_amount <= allocated_amount
  AND (status <> 'final' OR settled_amount + released_amount = allocated_amount)
);
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_revision_positive" CHECK (revision >= 1);
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_counters_nonnegative" CHECK (
  revision >= 0 AND fence >= 0 AND model_calls >= 0 AND tool_calls >= 0
  AND ((lease_worker_id IS NULL) = (lease_expires_at IS NULL))
);

