-- 人工审查已剔除误生成的 DROP INDEX knowledge_embeddings_embedding_idx（第 8 次冒头，
-- 教训同 p5_restore_hnsw / 20260819115045 先例注释：schema 无法声明 HNSW 原生索引，
-- migrate diff 视其为漂移）。test_b 库上被误删的索引已人工重建（同 p5_restore_hnsw 语句）。

-- CreateTable
CREATE TABLE "video_inspirations" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hook_text" TEXT NOT NULL,
    "structure" TEXT NOT NULL,
    "rhythm" TEXT,
    "metrics" TEXT,
    "tags" TEXT[],
    "is_peer" BOOLEAN NOT NULL DEFAULT false,
    "source_url" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_inspirations_pkey" PRIMARY KEY ("id")
);
