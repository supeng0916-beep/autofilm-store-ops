-- 素材库表（V2.3b）。diff 生成时因 P4 HNSW 原生索引无法在 schema 声明而被误判漂移，
-- 人工审查已剔除误生成的 DROP INDEX knowledge_embeddings_embedding_idx（教训同 p5_restore_hnsw / v22a_notifications）。
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "car_model" TEXT,
    "product_model" TEXT,
    "stage" TEXT,
    "technician_name" TEXT,
    "source" TEXT,
    "licensed" BOOLEAN NOT NULL DEFAULT false,
    "work_order_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assets_kind_idx" ON "assets"("kind");

-- CreateIndex
CREATE INDEX "assets_work_order_id_idx" ON "assets"("work_order_id");
