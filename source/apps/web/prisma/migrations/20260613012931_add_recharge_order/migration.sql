-- CreateEnum
CREATE TYPE "RechargeStatus" AS ENUM ('pending', 'paid', 'failed', 'expired');

-- CreateTable
CREATE TABLE "RechargeOrder" (
    "id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "pack" TEXT NOT NULL,
    "amount_yuan" DECIMAL(10,2) NOT NULL,
    "credits" INTEGER NOT NULL,
    "channel" TEXT,
    "status" "RechargeStatus" NOT NULL DEFAULT 'pending',
    "pay_url" TEXT,
    "xunhupay_trade_no" TEXT,
    "callback_raw" JSONB,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RechargeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RechargeOrder_order_no_key" ON "RechargeOrder"("order_no");

-- CreateIndex
CREATE INDEX "RechargeOrder_user_id_created_at_idx" ON "RechargeOrder"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "RechargeOrder_status_created_at_idx" ON "RechargeOrder"("status", "created_at");

-- AddForeignKey
ALTER TABLE "RechargeOrder" ADD CONSTRAINT "RechargeOrder_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
