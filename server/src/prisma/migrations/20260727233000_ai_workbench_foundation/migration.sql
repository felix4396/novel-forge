CREATE TABLE "batch_jobs" (
    "id" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestedChapterCount" INTEGER NOT NULL DEFAULT 1,
    "startChapterOrder" INTEGER,
    "endChapterOrder" INTEGER,
    "completedChapterCount" INTEGER NOT NULL DEFAULT 0,
    "riskPauseRequired" BOOLEAN NOT NULL DEFAULT false,
    "riskSummaryJson" TEXT NOT NULL DEFAULT '[]',
    "activeSkillsJson" TEXT NOT NULL DEFAULT '[]',
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "currentStep" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "model_call_logs" (
    "id" TEXT NOT NULL,
    "novelId" TEXT,
    "agentRunId" TEXT,
    "agentStepId" TEXT,
    "taskType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "latencyMs" INTEGER,
    "requestDigest" TEXT,
    "responseDigest" TEXT,
    "error" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_call_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "review_gate_results" (
    "id" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    "chapterId" TEXT,
    "agentRunId" TEXT,
    "batchJobId" TEXT,
    "sourceType" TEXT NOT NULL,
    "pass" BOOLEAN NOT NULL DEFAULT false,
    "scoreJson" TEXT NOT NULL DEFAULT '{}',
    "risksJson" TEXT NOT NULL DEFAULT '[]',
    "requiredFixesJson" TEXT NOT NULL DEFAULT '[]',
    "statePatchesJson" TEXT NOT NULL DEFAULT '[]',
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "activeSkillsJson" TEXT NOT NULL DEFAULT '[]',
    "styleProfileId" TEXT,
    "needsHumanConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "recommendedAction" TEXT NOT NULL DEFAULT 'revise',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_gate_results_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "state_patches" (
    "id" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    "chapterId" TEXT,
    "agentRunId" TEXT,
    "batchJobId" TEXT,
    "reviewGateResultId" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "patchType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "riskLevel" TEXT NOT NULL DEFAULT 'low',
    "patchJson" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "appliedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "state_patches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'local',
    "defaultEnabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conflictKeysJson" TEXT NOT NULL DEFAULT '[]',
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "skill_versions" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "manifestJson" TEXT NOT NULL,
    "promptHooksJson" TEXT NOT NULL DEFAULT '{}',
    "reviewGateChecksJson" TEXT NOT NULL DEFAULT '[]',
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_skills" (
    "id" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "skillVersionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "conflictStatus" TEXT NOT NULL DEFAULT 'unchecked',
    "conflictJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_skills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batch_jobs_novelId_status_updatedAt_idx" ON "batch_jobs"("novelId", "status", "updatedAt");
CREATE INDEX "batch_jobs_agentRunId_idx" ON "batch_jobs"("agentRunId");
CREATE INDEX "batch_jobs_status_updatedAt_idx" ON "batch_jobs"("status", "updatedAt");

CREATE INDEX "model_call_logs_novelId_createdAt_idx" ON "model_call_logs"("novelId", "createdAt");
CREATE INDEX "model_call_logs_agentRunId_createdAt_idx" ON "model_call_logs"("agentRunId", "createdAt");
CREATE INDEX "model_call_logs_agentStepId_createdAt_idx" ON "model_call_logs"("agentStepId", "createdAt");
CREATE INDEX "model_call_logs_taskType_createdAt_idx" ON "model_call_logs"("taskType", "createdAt");
CREATE INDEX "model_call_logs_provider_model_createdAt_idx" ON "model_call_logs"("provider", "model", "createdAt");

CREATE INDEX "review_gate_results_novelId_createdAt_idx" ON "review_gate_results"("novelId", "createdAt");
CREATE INDEX "review_gate_results_novelId_chapterId_createdAt_idx" ON "review_gate_results"("novelId", "chapterId", "createdAt");
CREATE INDEX "review_gate_results_agentRunId_createdAt_idx" ON "review_gate_results"("agentRunId", "createdAt");
CREATE INDEX "review_gate_results_batchJobId_createdAt_idx" ON "review_gate_results"("batchJobId", "createdAt");
CREATE INDEX "review_gate_results_needsHumanConfirmation_createdAt_idx" ON "review_gate_results"("needsHumanConfirmation", "createdAt");

CREATE INDEX "state_patches_novelId_status_createdAt_idx" ON "state_patches"("novelId", "status", "createdAt");
CREATE INDEX "state_patches_novelId_chapterId_createdAt_idx" ON "state_patches"("novelId", "chapterId", "createdAt");
CREATE INDEX "state_patches_agentRunId_createdAt_idx" ON "state_patches"("agentRunId", "createdAt");
CREATE INDEX "state_patches_batchJobId_createdAt_idx" ON "state_patches"("batchJobId", "createdAt");
CREATE INDEX "state_patches_reviewGateResultId_idx" ON "state_patches"("reviewGateResultId");
CREATE INDEX "state_patches_targetType_targetId_idx" ON "state_patches"("targetType", "targetId");

CREATE UNIQUE INDEX "skills_slug_key" ON "skills"("slug");
CREATE INDEX "skills_category_priority_idx" ON "skills"("category", "priority");
CREATE INDEX "skills_sourceType_idx" ON "skills"("sourceType");

CREATE UNIQUE INDEX "skill_versions_skillId_version_key" ON "skill_versions"("skillId", "version");
CREATE INDEX "skill_versions_skillId_status_idx" ON "skill_versions"("skillId", "status");

CREATE UNIQUE INDEX "project_skills_novelId_skillId_key" ON "project_skills"("novelId", "skillId");
CREATE INDEX "project_skills_novelId_enabled_priority_idx" ON "project_skills"("novelId", "enabled", "priority");
CREATE INDEX "project_skills_skillId_idx" ON "project_skills"("skillId");
CREATE INDEX "project_skills_skillVersionId_idx" ON "project_skills"("skillVersionId");

ALTER TABLE "batch_jobs"
ADD CONSTRAINT "batch_jobs_novelId_fkey"
FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "batch_jobs"
ADD CONSTRAINT "batch_jobs_agentRunId_fkey"
FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "model_call_logs"
ADD CONSTRAINT "model_call_logs_novelId_fkey"
FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "model_call_logs"
ADD CONSTRAINT "model_call_logs_agentRunId_fkey"
FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "model_call_logs"
ADD CONSTRAINT "model_call_logs_agentStepId_fkey"
FOREIGN KEY ("agentStepId") REFERENCES "AgentStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_gate_results"
ADD CONSTRAINT "review_gate_results_novelId_fkey"
FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_gate_results"
ADD CONSTRAINT "review_gate_results_chapterId_fkey"
FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_gate_results"
ADD CONSTRAINT "review_gate_results_agentRunId_fkey"
FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_gate_results"
ADD CONSTRAINT "review_gate_results_batchJobId_fkey"
FOREIGN KEY ("batchJobId") REFERENCES "batch_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "state_patches"
ADD CONSTRAINT "state_patches_novelId_fkey"
FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "state_patches"
ADD CONSTRAINT "state_patches_chapterId_fkey"
FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "state_patches"
ADD CONSTRAINT "state_patches_agentRunId_fkey"
FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "state_patches"
ADD CONSTRAINT "state_patches_batchJobId_fkey"
FOREIGN KEY ("batchJobId") REFERENCES "batch_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "state_patches"
ADD CONSTRAINT "state_patches_reviewGateResultId_fkey"
FOREIGN KEY ("reviewGateResultId") REFERENCES "review_gate_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "skill_versions"
ADD CONSTRAINT "skill_versions_skillId_fkey"
FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_skills"
ADD CONSTRAINT "project_skills_novelId_fkey"
FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_skills"
ADD CONSTRAINT "project_skills_skillId_fkey"
FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_skills"
ADD CONSTRAINT "project_skills_skillVersionId_fkey"
FOREIGN KEY ("skillVersionId") REFERENCES "skill_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
