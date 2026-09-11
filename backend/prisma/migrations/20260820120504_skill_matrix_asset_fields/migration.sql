-- v1.5 对齐合并迁移：技师技能数组 + 预约/工单业务类型 + 素材管线字段。
-- migrate diff（shadow 库复放）生成后人工审查定稿：
--   1. 已剔除 diff 误判的 DROP INDEX knowledge_embeddings_embedding_idx
--      （HNSW 原生索引无法在 schema 声明；陷阱同 p5_restore_hnsw / v24_team，索引完好不动）。
--   2. technicians.skills 类型转换改用 USING 保留存量逗号分隔文本（替换 diff 生成的 DROP+ADD）。
--   3. skills SET NOT NULL 后补 DEFAULT ARRAY[]::TEXT[]（schema @default([])）：
--      Prisma 7 create 省略标量列表字段时不落值，无默认会使建档/种子写入违例（实测 P2011）。
--   4. 存量 assets 按扩展名回填 media_type（.pdf → document），新增行走 image 默认值。

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "business_type" TEXT;

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "duration" INTEGER,
ADD COLUMN     "file_hash" TEXT,
ADD COLUMN     "media_type" TEXT NOT NULL DEFAULT 'image',
ADD COLUMN     "tags" TEXT[],
ADD COLUMN     "thumb_path" TEXT;

-- AlterTable：skills 自由文本 → 工种数组（NULL/空串 → 空数组；存量逗号分隔按逗号切分）
ALTER TABLE "technicians" ALTER COLUMN "skills" SET DATA TYPE TEXT[]
  USING CASE WHEN "skills" IS NULL OR "skills" = '' THEN '{}' ELSE string_to_array("skills", ',') END;
ALTER TABLE "technicians" ALTER COLUMN "skills" SET NOT NULL;
ALTER TABLE "technicians" ALTER COLUMN "skills" SET DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "business_type" TEXT;

-- Backfill：存量素材 media_type 按扩展名回填
UPDATE "assets" SET "media_type" = 'document' WHERE "file_path" LIKE '%.pdf';

-- CreateIndex
CREATE UNIQUE INDEX "assets_file_hash_key" ON "assets"("file_hash");
