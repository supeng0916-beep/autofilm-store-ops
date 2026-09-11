-- AlterTable
ALTER TABLE "knowledge_items" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "key" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "tags" JSONB;

-- CreateIndex
CREATE INDEX "knowledge_items_key_idx" ON "knowledge_items"("key");

-- CreateIndex
CREATE INDEX "knowledge_items_kind_key_idx" ON "knowledge_items"("kind", "key");
