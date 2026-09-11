-- 技师 ID 关联化（批次3 T3）：新列 + 存量按姓名回填（无匹配留空，兼容未登记技师）。
-- HNSW 漂移误报 DROP 已剔除（老陷阱口径）。
ALTER TABLE "work_orders" ADD COLUMN     "technicianId" TEXT;

-- 存量回填：technician_name 精确匹配 technicians.name（唯一）
UPDATE "work_orders" w
SET "technicianId" = t.id
FROM "technicians" t
WHERE w."technician_name" = t.name AND w."technicianId" IS NULL;

-- 索引：按技师聚合统计口径
CREATE INDEX "work_orders_technician_id_idx" ON "work_orders"("technicianId");
