CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_items" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requester_id" TEXT NOT NULL,
    "approver_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "opinion" TEXT,
    "basis" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "approval_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "wechat" TEXT,
    "car_model" TEXT,
    "plate_no" TEXT,
    "address" TEXT,
    "contact_preference" TEXT,
    "stop_contact" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_ref_ids" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_ref_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT,
    "source_platform" TEXT NOT NULL,
    "content_id" TEXT,
    "owner_user_id" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "due_at" TIMESTAMP(3),
    "next_step" TEXT,
    "lost_reason" TEXT,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_events" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" JSONB,
    "operator_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "dup_count" INTEGER NOT NULL DEFAULT 0,
    "operator_id" TEXT NOT NULL,
    "summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT,
    "customer_id" TEXT,
    "owner_user_id" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "takeover" BOOLEAN NOT NULL DEFAULT false,
    "takeover_reason" TEXT,
    "car_model" TEXT,
    "competition_compare" TEXT,
    "visit_original_plan" TEXT,
    "visit_final_plan" TEXT,
    "upsell_reason" TEXT,
    "gross_margin_impact" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "total_price" DECIMAL(12,2),
    "discount_needs_approval" BOOLEAN NOT NULL DEFAULT false,
    "gross_margin_impact" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_items" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT,
    "licensed" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_embeddings" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "item_version" INTEGER NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tasks" (
    "id" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input_summary" TEXT NOT NULL,
    "model" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "output" JSONB,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_task_feedback" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_task_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "opportunity_id" TEXT,
    "workbench" TEXT,
    "technician_name" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3),
    "promise" TEXT,
    "manager_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "appointment_id" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'pending',
    "photos" JSONB,
    "abnormal" JSONB,
    "rework" BOOLEAN NOT NULL DEFAULT false,
    "self_check" JSONB,
    "recheck" JSONB,
    "delivered_at" TIMESTAMP(3),
    "recorder_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");

-- CreateIndex
CREATE INDEX "audit_logs_object_type_object_id_idx" ON "audit_logs"("object_type", "object_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "approval_items_status_idx" ON "approval_items"("status");

-- CreateIndex
CREATE INDEX "approval_items_type_idx" ON "approval_items"("type");

-- CreateIndex
CREATE UNIQUE INDEX "customer_ref_ids_customer_id_key" ON "customer_ref_ids"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_ref_ids_ref_id_key" ON "customer_ref_ids"("ref_id");

-- CreateIndex
CREATE INDEX "leads_stage_idx" ON "leads"("stage");

-- CreateIndex
CREATE INDEX "leads_owner_user_id_idx" ON "leads"("owner_user_id");

-- CreateIndex
CREATE INDEX "leads_customer_id_idx" ON "leads"("customer_id");

-- CreateIndex
CREATE INDEX "lead_events_lead_id_idx" ON "lead_events"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_lead_id_key" ON "opportunities"("lead_id");

-- CreateIndex
CREATE INDEX "opportunities_stage_idx" ON "opportunities"("stage");

-- CreateIndex
CREATE INDEX "opportunities_owner_user_id_idx" ON "opportunities"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_opportunity_id_version_key" ON "quotes"("opportunity_id", "version");

-- CreateIndex
CREATE INDEX "knowledge_items_kind_idx" ON "knowledge_items"("kind");

-- CreateIndex
CREATE INDEX "knowledge_items_status_idx" ON "knowledge_items"("status");

-- CreateIndex
CREATE INDEX "knowledge_embeddings_item_id_idx" ON "knowledge_embeddings"("item_id");

-- CreateIndex
CREATE INDEX "ai_tasks_status_idx" ON "ai_tasks"("status");

-- CreateIndex
CREATE INDEX "ai_tasks_task_type_idx" ON "ai_tasks"("task_type");

-- CreateIndex
CREATE INDEX "ai_task_feedback_task_id_idx" ON "ai_task_feedback"("task_id");

-- CreateIndex
CREATE INDEX "appointments_customer_id_idx" ON "appointments"("customer_id");

-- CreateIndex
CREATE INDEX "appointments_start_at_idx" ON "appointments"("start_at");

-- CreateIndex
CREATE INDEX "work_orders_stage_idx" ON "work_orders"("stage");

-- CreateIndex
CREATE INDEX "work_orders_appointment_id_idx" ON "work_orders"("appointment_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ref_ids" ADD CONSTRAINT "customer_ref_ids_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
