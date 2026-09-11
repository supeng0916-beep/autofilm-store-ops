-- 站内通知表（V2.2a）。diff 生成时因 P4 HNSW 原生索引无法在 schema 声明而被误判漂移，
-- 人工审查已剔除误生成的 DROP INDEX knowledge_embeddings_embedding_idx（教训同 p5_restore_hnsw）。
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "source_type" TEXT,
    "source_id" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");
