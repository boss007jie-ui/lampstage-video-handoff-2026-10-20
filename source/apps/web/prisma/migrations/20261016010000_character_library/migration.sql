-- AlterTable
ALTER TABLE "UploadedAsset" ADD COLUMN     "image_content_id" TEXT;

-- CreateTable
CREATE TABLE "ImageContent" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_url" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharacterProfile" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "latest_version_id" TEXT,
    "version_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CharacterProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharacterVersion" (
    "id" TEXT NOT NULL,
    "character_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "content_digest" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharacterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharacterVersionImage" (
    "version_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "asset_id" TEXT NOT NULL,
    "image_content_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "CharacterVersionImage_pkey" PRIMARY KEY ("version_id","position")
);

-- CreateTable
CREATE TABLE "CharacterSaveReceipt" (
    "user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "character_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharacterSaveReceipt_pkey" PRIMARY KEY ("user_id","idempotency_key")
);

-- CreateTable
CREATE TABLE "VideoJobCharacterBinding" (
    "job_id" TEXT NOT NULL,
    "segment_index" INTEGER NOT NULL,
    "reference_index" INTEGER NOT NULL,
    "character_version_id" TEXT NOT NULL,
    "image_index" INTEGER NOT NULL,

    CONSTRAINT "VideoJobCharacterBinding_pkey" PRIMARY KEY ("job_id","segment_index","reference_index")
);

-- CreateTable
CREATE TABLE "VideoTemplateCharacterBinding" (
    "template_version_id" TEXT NOT NULL,
    "segment_index" INTEGER NOT NULL,
    "reference_index" INTEGER NOT NULL,
    "character_version_id" TEXT NOT NULL,
    "image_index" INTEGER NOT NULL,

    CONSTRAINT "VideoTemplateCharacterBinding_pkey" PRIMARY KEY ("template_version_id","segment_index","reference_index")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageContent_user_id_sha256_key" ON "ImageContent"("user_id", "sha256");

-- CreateIndex
CREATE INDEX "CharacterProfile_user_id_archived_created_at_id_idx" ON "CharacterProfile"("user_id", "archived", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterProfile_user_id_code_key" ON "CharacterProfile"("user_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterVersion_character_id_version_key" ON "CharacterVersion"("character_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterVersion_character_id_content_digest_key" ON "CharacterVersion"("character_id", "content_digest");

-- CreateIndex
CREATE INDEX "UploadedAsset_image_content_id_idx" ON "UploadedAsset"("image_content_id");

-- AddForeignKey
ALTER TABLE "UploadedAsset" ADD CONSTRAINT "UploadedAsset_image_content_id_fkey" FOREIGN KEY ("image_content_id") REFERENCES "ImageContent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageContent" ADD CONSTRAINT "ImageContent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterProfile" ADD CONSTRAINT "CharacterProfile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterVersion" ADD CONSTRAINT "CharacterVersion_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "CharacterProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterVersionImage" ADD CONSTRAINT "CharacterVersionImage_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "CharacterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterVersionImage" ADD CONSTRAINT "CharacterVersionImage_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "UploadedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterVersionImage" ADD CONSTRAINT "CharacterVersionImage_image_content_id_fkey" FOREIGN KEY ("image_content_id") REFERENCES "ImageContent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterSaveReceipt" ADD CONSTRAINT "CharacterSaveReceipt_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterSaveReceipt" ADD CONSTRAINT "CharacterSaveReceipt_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "CharacterProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterSaveReceipt" ADD CONSTRAINT "CharacterSaveReceipt_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "CharacterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoJobCharacterBinding" ADD CONSTRAINT "VideoJobCharacterBinding_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "VideoJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoJobCharacterBinding" ADD CONSTRAINT "VideoJobCharacterBinding_character_version_id_fkey" FOREIGN KEY ("character_version_id") REFERENCES "CharacterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoTemplateCharacterBinding" ADD CONSTRAINT "VideoTemplateCharacterBinding_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "VideoTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoTemplateCharacterBinding" ADD CONSTRAINT "VideoTemplateCharacterBinding_character_version_id_fkey" FOREIGN KEY ("character_version_id") REFERENCES "CharacterVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
