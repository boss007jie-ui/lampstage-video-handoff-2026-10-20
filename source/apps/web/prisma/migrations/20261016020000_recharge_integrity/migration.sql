ALTER TABLE "RechargeOrder"
  ADD COLUMN "request_key" TEXT,
  ADD COLUMN "request_hash" TEXT,
  ADD COLUMN "display_mode" TEXT,
  ADD COLUMN "provider_appid" TEXT,
  ADD COLUMN "provider_gateway" TEXT,
  ADD COLUMN "provider_order_id" TEXT,
  ADD COLUMN "provider_payment_key" TEXT,
  ADD COLUMN "qr_code_url" TEXT,
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "creation_state" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "provider_query_at" TIMESTAMP(3),
  ADD COLUMN "provider_query_status" TEXT,
  ADD COLUMN "credit_transaction_id" TEXT;

CREATE UNIQUE INDEX "RechargeOrder_user_id_request_key_key" ON "RechargeOrder"("user_id", "request_key");
CREATE UNIQUE INDEX "RechargeOrder_provider_payment_key_key" ON "RechargeOrder"("provider_payment_key");
CREATE UNIQUE INDEX "RechargeOrder_credit_transaction_id_key" ON "RechargeOrder"("credit_transaction_id");
ALTER TABLE "RechargeOrder" ADD CONSTRAINT "RechargeOrder_credit_transaction_id_fkey"
  FOREIGN KEY ("credit_transaction_id") REFERENCES "CreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
