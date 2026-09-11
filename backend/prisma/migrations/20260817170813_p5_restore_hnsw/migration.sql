-- 恢复 HNSW 向量索引：p5_delivery 由 migrate diff 生成，因 schema 无法声明 HNSW 原生索引
-- 误含 DROP INDEX（Prisma 视 P4 原生索引为漂移）；本迁移原样恢复（P4-02 口径不变）。
-- 教训：diff 生成迁移后必须人工审查再应用；后续新增原生索引需同步追加恢复语句。
CREATE INDEX IF NOT EXISTS knowledge_embeddings_embedding_idx
ON knowledge_embeddings
USING hnsw (embedding vector_cosine_ops);
