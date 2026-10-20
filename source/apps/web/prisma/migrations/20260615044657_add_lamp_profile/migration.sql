-- AlterTable
ALTER TABLE "UploadedAsset" ADD COLUMN     "ai_inferred_at" TIMESTAMP(3),
ADD COLUMN     "color_temp" TEXT,
ADD COLUMN     "size_class" TEXT,
ADD COLUMN     "size_hint_cm" INTEGER,
ADD COLUMN     "target_audience" TEXT;
