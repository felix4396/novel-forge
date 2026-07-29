CREATE TABLE "checkpoints" (
    "id" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    "batchJobId" TEXT,
    "agentRunId" TEXT,
    "chapterId" TEXT,
    "reviewGateResultId" TEXT,
    "statePatchId" TEXT,
    "checkpointType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "summary" TEXT,
    "resumeStep" TEXT,
    "resumePayloadJson" TEXT NOT NULL DEFAULT '{}',
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "checkpoints_novelId_status_updatedAt_idx" ON "checkpoints"("novelId", "status", "updatedAt");
CREATE INDEX "checkpoints_batchJobId_status_updatedAt_idx" ON "checkpoints"("batchJobId", "status", "updatedAt");
CREATE INDEX "checkpoints_agentRunId_createdAt_idx" ON "checkpoints"("agentRunId", "createdAt");
CREATE INDEX "checkpoints_chapterId_createdAt_idx" ON "checkpoints"("chapterId", "createdAt");
CREATE INDEX "checkpoints_reviewGateResultId_idx" ON "checkpoints"("reviewGateResultId");
CREATE INDEX "checkpoints_statePatchId_idx" ON "checkpoints"("statePatchId");

ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_novelId_fkey"
FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_batchJobId_fkey"
FOREIGN KEY ("batchJobId") REFERENCES "batch_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_agentRunId_fkey"
FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_chapterId_fkey"
FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_reviewGateResultId_fkey"
FOREIGN KEY ("reviewGateResultId") REFERENCES "review_gate_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_statePatchId_fkey"
FOREIGN KEY ("statePatchId") REFERENCES "state_patches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
