-- AlterTable
-- 批次4 毛利估算：订单确认单加材料成本（分，选填）。
-- 手工迁移（仓库既有手法）：migrate dev 被并行会话在途迁移阻断，
-- 由 migrate diff --from-config-datasource --to-schema --script 生成后逐行审查，
-- 仅保留本任务一条 ADD COLUMN；diff 中夹带的 DROP INDEX（HNSW，他人会话漂移）已剔除。
ALTER TABLE "order_confirmations" ADD COLUMN "material_cost_fen" INTEGER;
