-- HNSW 向量索引（P4-02）：余弦距离检索，支持知识库语义搜索
CREATE INDEX IF NOT EXISTS knowledge_embeddings_embedding_idx
ON knowledge_embeddings
USING hnsw (embedding vector_cosine_ops);