ALTER TABLE "VideoAsset" ADD COLUMN "sha256" TEXT;
ALTER TABLE "VideoJob" ADD COLUMN "template_version_id" TEXT;
CREATE INDEX "VideoAsset_user_id_sha256_idx" ON "VideoAsset"("user_id", "sha256");
CREATE INDEX "VideoJob_template_version_id_idx" ON "VideoJob"("template_version_id");

CREATE TABLE "VideoTemplate" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "latest_version_id" TEXT,
    "version_count" INTEGER NOT NULL DEFAULT 0,
    "source_asset_id" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "source_duration" DOUBLE PRECISION NOT NULL,
    "structure_signature" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VideoTemplate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VideoTemplate_code_check" CHECK ("code" ~ '^T[0-9]{3,}$'),
    CONSTRAINT "VideoTemplate_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
    CONSTRAINT "VideoTemplate_category_check" CHECK (char_length("category") <= 40),
    CONSTRAINT "VideoTemplate_version_count_check" CHECK ("version_count" >= 0)
);
CREATE UNIQUE INDEX "VideoTemplate_user_id_code_key" ON "VideoTemplate"("user_id", "code");
CREATE INDEX "VideoTemplate_user_id_archived_created_at_id_idx" ON "VideoTemplate"("user_id", "archived", "created_at", "id");
CREATE INDEX "VideoTemplate_user_id_source_sha256_idx" ON "VideoTemplate"("user_id", "source_sha256");
ALTER TABLE "VideoTemplate" ADD CONSTRAINT "VideoTemplate_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VideoTemplateVersion" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source_job_id" TEXT NOT NULL,
    "source_asset_id" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "output_sha256" TEXT NOT NULL,
    "workflow_profile" TEXT NOT NULL,
    "recipe_schema_version" INTEGER NOT NULL,
    "create_payload" JSONB NOT NULL,
    "structure_signature" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoTemplateVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VideoTemplateVersion_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "VideoTemplateVersion_template_id_version_key" ON "VideoTemplateVersion"("template_id", "version");
CREATE UNIQUE INDEX "VideoTemplateVersion_source_job_id_output_sha256_key" ON "VideoTemplateVersion"("source_job_id", "output_sha256");
CREATE INDEX "VideoTemplateVersion_source_asset_id_idx" ON "VideoTemplateVersion"("source_asset_id");
ALTER TABLE "VideoTemplateVersion" ADD CONSTRAINT "VideoTemplateVersion_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "VideoTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoTemplateVersion" ADD CONSTRAINT "VideoTemplateVersion_source_job_id_fkey" FOREIGN KEY ("source_job_id") REFERENCES "VideoJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoTemplateVersion" ADD CONSTRAINT "VideoTemplateVersion_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "VideoAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "VideoTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "VideoJobFeedback" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "output_sha256" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "template_id" TEXT,
    "template_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VideoJobFeedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VideoJobFeedback_decision_check" CHECK ("decision" IN ('satisfied_save_template', 'satisfied', 'needs_changes')),
    CONSTRAINT "VideoJobFeedback_notes_check" CHECK (char_length("notes") <= 2000)
);
CREATE UNIQUE INDEX "VideoJobFeedback_job_id_output_sha256_key" ON "VideoJobFeedback"("job_id", "output_sha256");
CREATE INDEX "VideoJobFeedback_user_id_created_at_idx" ON "VideoJobFeedback"("user_id", "created_at");
ALTER TABLE "VideoJobFeedback" ADD CONSTRAINT "VideoJobFeedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoJobFeedback" ADD CONSTRAINT "VideoJobFeedback_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "VideoJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoJobFeedback" ADD CONSTRAINT "VideoJobFeedback_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "VideoTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VideoJobFeedback" ADD CONSTRAINT "VideoJobFeedback_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "VideoTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
