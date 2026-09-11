-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "age_band" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "industry" TEXT,
ADD COLUMN     "purchase_dealer" TEXT;

-- CreateTable
CREATE TABLE "finance_entries" (
    "id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "occurred_on" TIMESTAMP(3) NOT NULL,
    "remark" TEXT,
    "lead_id" TEXT,
    "order_confirmation_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_records" (
    "id" TEXT NOT NULL,
    "content_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "platform" TEXT,
    "published_at" TIMESTAMP(3),
    "cost_fen" INTEGER NOT NULL DEFAULT 0,
    "views_count" INTEGER,
    "likes_count" INTEGER,
    "comments_count" INTEGER,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finance_entries_direction_occurred_on_idx" ON "finance_entries"("direction", "occurred_on");

-- CreateIndex
CREATE UNIQUE INDEX "content_records_content_key_key" ON "content_records"("content_key");

