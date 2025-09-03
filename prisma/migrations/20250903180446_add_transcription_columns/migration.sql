-- DropForeignKey
ALTER TABLE "public"."journal_entries" DROP CONSTRAINT "journal_entries_user_id_fkey";

-- AlterTable
ALTER TABLE "public"."journal_entries" ADD COLUMN     "advice" TEXT,
ADD COLUMN     "cost_estimate_usd" DECIMAL(10,4),
ADD COLUMN     "duration_seconds" INTEGER,
ADD COLUMN     "model_analysis" TEXT,
ADD COLUMN     "model_asr" TEXT,
ADD COLUMN     "ms_elapsed" INTEGER,
ADD COLUMN     "project_id" TEXT,
ADD COLUMN     "tokens_input" INTEGER,
ADD COLUMN     "tokens_output" INTEGER,
ADD COLUMN     "transcript" TEXT,
ALTER COLUMN "user_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."journal_entries" ADD CONSTRAINT "journal_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
