-- 住宅膜勘测字段（批次3 T2）。HNSW 漂移误报 DROP 已剔除（老陷阱口径）
-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "homeSurvey" JSONB;

