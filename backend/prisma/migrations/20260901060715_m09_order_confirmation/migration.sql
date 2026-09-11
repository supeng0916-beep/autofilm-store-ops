-- M09 批次1 迁移：五张新表（回访/售后受理/质保登记/转介绍/订单确认）。
-- 人工审查定稿：已剔除 migrate diff 误判的 DROP INDEX knowledge_embeddings_embedding_idx
-- （HNSW 原生索引无法在 schema 声明，Prisma 视其为漂移；陷阱同 p5_delivery/p5_restore_hnsw、
-- v24_team、skill_matrix_asset_fields）。索引在库中已手工恢复，P4-02 口径不变。

-- CreateTable
CREATE TABLE "aftercare_visits" (
    "id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "plan" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "executed_by" TEXT,
    "executed_at" TIMESTAMP(3),
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aftercare_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT,
    "lead_id" TEXT,
    "work_order_id" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "handler_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "result" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_registrations" (
    "id" TEXT NOT NULL,
    "work_order_id" TEXT,
    "customer_id" TEXT,
    "product_model" TEXT,
    "registration_no" TEXT,
    "registered_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warranty_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_records" (
    "id" TEXT NOT NULL,
    "referrer_customer_id" TEXT NOT NULL,
    "referred_lead_id" TEXT,
    "referred_customer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_confirmations" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "appointment_id" TEXT,
    "products" TEXT NOT NULL,
    "quote_snapshot" TEXT NOT NULL,
    "discount_note" TEXT,
    "deposit_fen" INTEGER NOT NULL DEFAULT 0,
    "balance_fen" INTEGER NOT NULL DEFAULT 0,
    "pay_method" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "customer_confirmed_by" TEXT,
    "customer_confirmed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aftercare_visits_work_order_id_idx" ON "aftercare_visits"("work_order_id");

-- CreateIndex
CREATE INDEX "aftercare_visits_status_due_at_idx" ON "aftercare_visits"("status", "due_at");

-- CreateIndex
CREATE INDEX "service_requests_status_idx" ON "service_requests"("status");

-- CreateIndex
CREATE INDEX "service_requests_customer_id_idx" ON "service_requests"("customer_id");

-- CreateIndex
CREATE INDEX "warranty_registrations_work_order_id_idx" ON "warranty_registrations"("work_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_records_referred_lead_id_key" ON "referral_records"("referred_lead_id");

-- CreateIndex
CREATE INDEX "referral_records_referrer_customer_id_idx" ON "referral_records"("referrer_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_confirmations_lead_id_key" ON "order_confirmations"("lead_id");
