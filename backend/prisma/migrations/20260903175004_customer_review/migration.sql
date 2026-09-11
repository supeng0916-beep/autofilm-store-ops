-- 客户评价表（缺口补齐批次 Task 2，M09 第五资源，append-only）。
-- 手工迁移（migrate dev 因他人在途迁移不可用，回退 migrate diff --from-config-datasource 生成）。
-- diff 生成时因 P4 HNSW 原生索引无法在 schema 声明而被误判漂移，
-- 人工审查已剔除误生成的 DROP INDEX knowledge_embeddings_embedding_idx（第 7 次冒头，见 20260819115045 先例注释）。

-- CreateTable
CREATE TABLE "customer_reviews" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT,
    "lead_id" TEXT,
    "work_order_id" TEXT,
    "score" INTEGER NOT NULL,
    "content" TEXT,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_reviews_work_order_id_idx" ON "customer_reviews"("work_order_id");
