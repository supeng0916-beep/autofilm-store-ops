-- 同行内容数据表（批次4）。HNSW 漂移误报 DROP 已剔除（老陷阱口径）
-- CreateTable
CREATE TABLE "competitor_posts" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "likes_count" INTEGER,
    "comments_count" INTEGER,
    "shares_count" INTEGER,
    "activity_type" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "crawled_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitor_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competitor_posts_account_idx" ON "competitor_posts"("account");

-- RenameIndex
ALTER INDEX "work_orders_technician_id_idx" RENAME TO "work_orders_technicianId_idx";

