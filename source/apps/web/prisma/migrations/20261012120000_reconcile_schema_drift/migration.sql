-- AlterTable
ALTER TABLE "UploadedAsset" ADD COLUMN     "cord_or_chain_drop_cm" INTEGER,
ADD COLUMN     "fixture_height_cm" INTEGER,
ADD COLUMN     "material_keywords" TEXT,
ADD COLUMN     "planned_at" TIMESTAMP(3),
ADD COLUMN     "planned_shots" JSONB,
ADD COLUMN     "scale_band" TEXT,
ADD COLUMN     "shade_diameter_cm" INTEGER,
ADD COLUMN     "space_fit" TEXT;

-- CreateTable
CREATE TABLE "SceneSeed" (
    "id" TEXT NOT NULL,
    "scene_type" TEXT NOT NULL,
    "target_audience" TEXT NOT NULL,
    "time_of_day" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "quality_score" INTEGER NOT NULL DEFAULT 0,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "is_qualified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "SceneSeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCallLog" (
    "id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "model" TEXT,
    "job_id" TEXT,
    "asset_id" TEXT,
    "status" TEXT NOT NULL,
    "http_status" INTEGER,
    "duration_ms" INTEGER,
    "error" TEXT,
    "result_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SceneSeed_scene_type_target_audience_time_of_day_quality_sc_idx" ON "SceneSeed"("scene_type", "target_audience", "time_of_day", "quality_score");

-- CreateIndex
CREATE INDEX "SceneSeed_is_qualified_usage_count_idx" ON "SceneSeed"("is_qualified", "usage_count");

-- CreateIndex
CREATE INDEX "ToolCallLog_created_at_idx" ON "ToolCallLog"("created_at");

-- CreateIndex
CREATE INDEX "ToolCallLog_tool_created_at_idx" ON "ToolCallLog"("tool", "created_at");

-- CreateIndex
CREATE INDEX "ToolCallLog_status_created_at_idx" ON "ToolCallLog"("status", "created_at");

