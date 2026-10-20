-- Additive video beta migration. Existing image/account tables are unchanged.
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "VideoJob" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_asset_id" TEXT NOT NULL,
    "product_asset_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "preserve_audio" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "phase" TEXT NOT NULL DEFAULT 'prepare',
    "stage" TEXT NOT NULL DEFAULT '等待准备参考图',
    "data" JSONB NOT NULL,
    "error" TEXT,
    "lease_owner" TEXT,
    "lease_until" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "VideoWorker" (
    "id" TEXT NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "image_ready" BOOLEAN NOT NULL DEFAULT false,
    "video_ready" BOOLEAN NOT NULL DEFAULT false,
    "detail" TEXT,
    CONSTRAINT "VideoWorker_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VideoAsset_storage_key_key" ON "VideoAsset"("storage_key");
CREATE INDEX "VideoAsset_user_id_created_at_idx" ON "VideoAsset"("user_id", "created_at");
CREATE INDEX "VideoJob_user_id_created_at_idx" ON "VideoJob"("user_id", "created_at");
CREATE INDEX "VideoJob_status_created_at_idx" ON "VideoJob"("status", "created_at");
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "VideoAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
