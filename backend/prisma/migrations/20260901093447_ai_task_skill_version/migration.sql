-- 技能版本留痕列（V1.5 批次5）。
-- 注意：本迁移生成时曾误带 DROP INDEX knowledge_embeddings_embedding_idx（HNSW 原生索引
-- 无法在 schema 声明被误判漂移——项目第 6 次冒头的老陷阱，见 20260819115045 先例注释），
-- 已剔除；已应用过 DROP 的库用 20260817071457 的 CREATE INDEX 语句恢复。
ALTER TABLE "ai_tasks" ADD COLUMN     "skill_version" INTEGER;
