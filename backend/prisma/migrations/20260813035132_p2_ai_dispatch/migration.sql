-- AlterTable
ALTER TABLE "ai_tasks" ADD COLUMN     "callback_at" TIMESTAMP(3),
ADD COLUMN     "cost_estimate_fen" INTEGER,
ADD COLUMN     "deadline_at" TIMESTAMP(3),
ADD COLUMN     "dispatched_at" TIMESTAMP(3),
ADD COLUMN     "error_message" TEXT,
ADD COLUMN     "finished_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ai_task_events" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_task_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_task_events_task_id_idx" ON "ai_task_events"("task_id");

-- CreateIndex
CREATE INDEX "ai_tasks_status_deadline_at_idx" ON "ai_tasks"("status", "deadline_at");
