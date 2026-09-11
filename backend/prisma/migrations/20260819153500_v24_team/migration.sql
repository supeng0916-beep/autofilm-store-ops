-- 人机团队两表（V2.4）：technicians 技师档案 + staff_records 考勤奖惩记录。
-- diff 生成时因 P4 HNSW 原生索引无法在 schema 声明而被误判漂移，
-- 人工审查已剔除误生成的 DROP INDEX knowledge_embeddings_embedding_idx（教训同 p5_restore_hnsw / v23b_assets）。
CREATE TABLE "technicians" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "skills" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technicians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_records" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_records_subject_type_subject_id_idx" ON "staff_records"("subject_type", "subject_id");
