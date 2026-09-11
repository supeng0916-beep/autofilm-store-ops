-- CreateTable
CREATE TABLE "roleplay_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "persona" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "score" INTEGER,
    "review" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "roleplay_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roleplay_turns" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roleplay_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roleplay_sessions_user_id_idx" ON "roleplay_sessions"("user_id");

-- CreateIndex
CREATE INDEX "roleplay_turns_session_id_idx" ON "roleplay_turns"("session_id");

-- AddForeignKey
ALTER TABLE "roleplay_turns" ADD CONSTRAINT "roleplay_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "roleplay_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
