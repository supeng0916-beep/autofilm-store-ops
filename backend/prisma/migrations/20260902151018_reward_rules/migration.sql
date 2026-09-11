-- 奖惩规则表（批次3 T1）。HNSW 原生索引无法在 schema 声明被误判漂移的 DROP 已剔除（老陷阱口径）

-- CreateTable
CREATE TABLE "reward_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "comparator" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_rules_pkey" PRIMARY KEY ("id")
);

