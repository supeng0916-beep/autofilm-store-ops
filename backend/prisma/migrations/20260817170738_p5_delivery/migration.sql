-- DropIndex
DROP INDEX "knowledge_embeddings_embedding_idx";

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "est_hours" DOUBLE PRECISION,
ADD COLUMN     "lead_id" TEXT,
ADD COLUMN     "manager_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "manager_confirmed_by" TEXT,
ADD COLUMN     "service_item" TEXT,
ADD COLUMN     "technician_designated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "backfill_for_at" TIMESTAMP(3),
ADD COLUMN     "backfilled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "care_notes" JSONB,
ADD COLUMN     "case_request" JSONB,
ADD COLUMN     "customer_id" TEXT,
ADD COLUMN     "delivered_by" TEXT,
ADD COLUMN     "lead_id" TEXT,
ADD COLUMN     "opportunity_id" TEXT,
ADD COLUMN     "order_no" TEXT NOT NULL,
ADD COLUMN     "rework_records" JSONB,
ADD COLUMN     "service_item" TEXT,
ADD COLUMN     "technician_name" TEXT,
ADD COLUMN     "warranty_ref" TEXT,
ADD COLUMN     "workbench" TEXT;

-- CreateTable
CREATE TABLE "appointment_technician_changes" (
    "id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "from_name" TEXT NOT NULL,
    "to_name" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirm_method" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_technician_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointment_technician_changes_appointment_id_idx" ON "appointment_technician_changes"("appointment_id");

-- CreateIndex
CREATE INDEX "appointments_workbench_start_at_idx" ON "appointments"("workbench", "start_at");

-- CreateIndex
CREATE INDEX "appointments_technician_name_start_at_idx" ON "appointments"("technician_name", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_order_no_key" ON "work_orders"("order_no");

-- CreateIndex
CREATE INDEX "work_orders_customer_id_idx" ON "work_orders"("customer_id");

-- AddForeignKey
ALTER TABLE "appointment_technician_changes" ADD CONSTRAINT "appointment_technician_changes_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

