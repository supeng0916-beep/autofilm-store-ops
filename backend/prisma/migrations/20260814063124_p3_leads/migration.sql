/*
  Warnings:

  - A unique constraint covering the columns `[lead_no]` on the table `leads` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `lead_no` to the `leads` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source_category` to the `leads` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "source_referral_owner_id" TEXT;

-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'csv';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "acquisition_method" TEXT,
ADD COLUMN     "ad_plan_text" TEXT,
ADD COLUMN     "assigned_at" TIMESTAMP(3),
ADD COLUMN     "batch_id" TEXT,
ADD COLUMN     "business_type" TEXT NOT NULL DEFAULT 'auto_film',
ADD COLUMN     "chat_link" TEXT,
ADD COLUMN     "close_reason" TEXT,
ADD COLUMN     "closed_amount_fen" INTEGER,
ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "customer_name" TEXT,
ADD COLUMN     "dispatch_parser_version" INTEGER,
ADD COLUMN     "dispatch_raw_text" TEXT,
ADD COLUMN     "dup_of_lead_id" TEXT,
ADD COLUMN     "final_status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "first_contact_attempt_at" TIMESTAMP(3),
ADD COLUMN     "first_customer_reply_at" TIMESTAMP(3),
ADD COLUMN     "hq_feedback_status" TEXT,
ADD COLUMN     "intent_confirmed_by" TEXT,
ADD COLUMN     "intent_evidence" JSONB,
ADD COLUMN     "intent_level" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "last_follow_up_at" TIMESTAMP(3),
ADD COLUMN     "last_follow_up_result" TEXT,
ADD COLUMN     "lead_no" TEXT NOT NULL,
ADD COLUMN     "next_follow_up_at" TIMESTAMP(3),
ADD COLUMN     "operator_entity" TEXT,
ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "product_need" TEXT,
ADD COLUMN     "quote_approval_status" TEXT NOT NULL DEFAULT 'not_triggered',
ADD COLUMN     "quote_version_ref" TEXT,
ADD COLUMN     "raw_need" TEXT,
ADD COLUMN     "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "remark" TEXT,
ADD COLUMN     "silence_stage" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "source_category" TEXT NOT NULL,
ADD COLUMN     "target" TEXT,
ADD COLUMN     "upstream_dispatch_at" TIMESTAMP(3),
ADD COLUMN     "upstream_dispatch_no" TEXT,
ADD COLUMN     "visit_appt_at" TIMESTAMP(3),
ADD COLUMN     "wechat" TEXT,
ADD COLUMN     "wechat_type" TEXT NOT NULL DEFAULT 'unknown';

-- CreateIndex
CREATE UNIQUE INDEX "leads_lead_no_key" ON "leads"("lead_no");

-- CreateIndex
CREATE INDEX "leads_final_status_idx" ON "leads"("final_status");

-- CreateIndex
CREATE INDEX "leads_received_at_idx" ON "leads"("received_at");
