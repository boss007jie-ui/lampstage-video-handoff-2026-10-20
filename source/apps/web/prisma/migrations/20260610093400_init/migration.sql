-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "BackgroundType" AS ENUM ('transparent', 'white', 'simple', 'complex', 'unknown');

-- CreateEnum
CREATE TYPE "PlatformStyle" AS ENUM ('domestic_ecommerce', 'brand_site');

-- CreateEnum
CREATE TYPE "AspectRatio" AS ENUM ('ratio_1_1', 'ratio_4_5', 'ratio_16_9');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('created', 'uploading', 'generating', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "CreditTxType" AS ENUM ('grant', 'consume', 'refund', 'manual_adjustment');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "credit_balance" INTEGER NOT NULL DEFAULT 0,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedAsset" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "background_type" "BackgroundType" NOT NULL DEFAULT 'unknown',
    "detected_lamp_type" TEXT,
    "quality_warning" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "lamp_type" TEXT NOT NULL,
    "scene_space" TEXT NOT NULL,
    "preview_image_url" TEXT NOT NULL,
    "prompt_template" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "uploaded_asset_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "platform_style" "PlatformStyle" NOT NULL,
    "aspect_ratio" "AspectRatio" NOT NULL,
    "credit_cost" INTEGER NOT NULL DEFAULT 4,
    "status" "JobStatus" NOT NULL DEFAULT 'created',
    "failure_reason" TEXT,
    "provider_job_id" TEXT,
    "stage_hint" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutputImage" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "quality_score" DOUBLE PRECISION,
    "is_downloaded" BOOLEAN NOT NULL DEFAULT false,
    "downloaded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutputImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "CreditTxType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "related_job_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactLead" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "source" TEXT NOT NULL,
    "contact_type" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "wechat" TEXT,
    "email" TEXT,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationCode" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "Session_user_id_idx" ON "Session"("user_id");

-- CreateIndex
CREATE INDEX "Session_expires_at_idx" ON "Session"("expires_at");

-- CreateIndex
CREATE INDEX "UploadedAsset_user_id_created_at_idx" ON "UploadedAsset"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "Template_is_active_sort_order_idx" ON "Template"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "GenerationJob_user_id_created_at_idx" ON "GenerationJob"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "GenerationJob_status_created_at_idx" ON "GenerationJob"("status", "created_at");

-- CreateIndex
CREATE INDEX "OutputImage_job_id_idx" ON "OutputImage"("job_id");

-- CreateIndex
CREATE INDEX "CreditTransaction_user_id_created_at_idx" ON "CreditTransaction"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ContactLead_source_created_at_idx" ON "ContactLead"("source", "created_at");

-- CreateIndex
CREATE INDEX "ContactLead_contact_type_created_at_idx" ON "ContactLead"("contact_type", "created_at");

-- CreateIndex
CREATE INDEX "VerificationCode_identifier_type_created_at_idx" ON "VerificationCode"("identifier", "type", "created_at");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedAsset" ADD CONSTRAINT "UploadedAsset_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_uploaded_asset_id_fkey" FOREIGN KEY ("uploaded_asset_id") REFERENCES "UploadedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "Template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutputImage" ADD CONSTRAINT "OutputImage_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_related_job_id_fkey" FOREIGN KEY ("related_job_id") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactLead" ADD CONSTRAINT "ContactLead_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
