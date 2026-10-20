-- CreateEnum
CREATE TYPE "SceneKind" AS ENUM ('recommended', 'template', 'custom');

-- DropForeignKey
ALTER TABLE "GenerationJob" DROP CONSTRAINT "GenerationJob_template_id_fkey";

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "prompt_text" TEXT,
ADD COLUMN     "scene_kind" "SceneKind" NOT NULL DEFAULT 'template',
ALTER COLUMN "template_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;
