import type { BatchJob } from "@ai-novel/shared/types/aiWorkbench";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { createQualityReport } from "../novel/novelCoreReviewService";
import { ChapterRuntimeCoordinator } from "../novel/runtime/ChapterRuntimeCoordinator";
import type { PipelineRuntimeInput } from "../novel/runtime/chapterRuntimePipeline";
import { aiWorkbenchAgentRunLogger } from "./AiWorkbenchAgentRunLogger";
import {
  skillRuntimeContextService,
  summarizeActiveSkillsForAgentLog,
} from "./SkillRuntimeContextService";

interface BatchRunConfig {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  maxRetries?: number;
  autoReview?: boolean;
  autoRepair?: boolean;
  qualityThreshold?: number;
  repairMode?: PipelineRuntimeInput["repairMode"];
  artifactSyncMode?: "adaptive" | "deferred" | "strict";
}

function parseConfig(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBoolean(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

function serializeConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config);
}

function parseActiveSkillsJson(value: string | null | undefined) {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clampChapterCount(value: number): number {
  return Math.max(1, Math.min(value, 5));
}

function toBatchRunConfig(config: Record<string, unknown>): BatchRunConfig {
  const repairMode = readString(config, "repairMode") as BatchRunConfig["repairMode"];
  const artifactSyncMode = readString(config, "artifactSyncMode") as BatchRunConfig["artifactSyncMode"];
  return {
    provider: readString(config, "provider") as LLMProvider | undefined,
    model: readString(config, "model"),
    temperature: readNumber(config, "temperature"),
    maxRetries: readNumber(config, "maxRetries"),
    autoReview: readBoolean(config, "autoReview"),
    autoRepair: readBoolean(config, "autoRepair"),
    qualityThreshold: readNumber(config, "qualityThreshold"),
    repairMode,
    artifactSyncMode,
  };
}

function isRiskGate(row: {
  pass: boolean;
  needsHumanConfirmation: boolean;
  recommendedAction: string;
  risksJson: string;
}): boolean {
  if (row.needsHumanConfirmation || row.recommendedAction === "ask_user" || row.recommendedAction === "stop_batch") {
    return true;
  }
  if (!row.pass) {
    return true;
  }
  try {
    const risks = JSON.parse(row.risksJson);
    return Array.isArray(risks) && risks.some((risk) => {
      return risk && typeof risk === "object" && ["high", "critical", "blocking"].includes(String((risk as { severity?: unknown }).severity));
    });
  } catch {
    return false;
  }
}

export class AiWorkbenchBatchRunnerService {
  private static readonly activeJobIds = new Set<string>();
  private readonly coordinator = new ChapterRuntimeCoordinator();

  async startBatchJob(id: string): Promise<BatchJob> {
    const prepared = await this.prepareRunnableBatchJob(id, "start");
    this.scheduleRun(prepared.id);
    return this.getBatchJobOrThrow(prepared.id);
  }

  async resumeBatchJob(id: string): Promise<BatchJob> {
    const job = await this.getRawBatchJobOrThrow(id);
    if (!["waiting_approval", "paused", "failed"].includes(job.status)) {
      throw new AppError("只有等待确认、暂停或失败的批量任务可以继续。", 400, { id, status: job.status });
    }
    if (job.status === "waiting_approval" || job.riskPauseRequired) {
      await this.assertNoPendingHighRiskStatePatches(id);
    }
    const now = new Date();
    await prisma.batchJob.update({
      where: { id },
      data: {
        status: "queued",
        riskPauseRequired: false,
        currentStep: "等待恢复批量生成",
        error: null,
        pausedAt: null,
        finishedAt: null,
      },
    });
    await this.closeOpenCheckpoints(id, "resolved", now);
    this.scheduleRun(id);
    return this.getBatchJobOrThrow(id);
  }

  private async assertNoPendingHighRiskStatePatches(batchJobId: string): Promise<void> {
    const pendingPatches = await prisma.statePatch.findMany({
      where: {
        batchJobId,
        status: { in: ["proposed", "needs_confirmation"] },
        riskLevel: "high",
      },
      select: {
        id: true,
        chapterId: true,
        targetType: true,
        patchType: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 20,
    });
    if (pendingPatches.length === 0) {
      return;
    }
    throw new AppError("仍有未确认的高风险 StatePatch，请先接受或拒绝后再继续批量任务。", 400, {
      batchJobId,
      pendingPatchCount: pendingPatches.length,
      pendingPatches: pendingPatches.map((patch) => ({
        ...patch,
        updatedAt: patch.updatedAt.toISOString(),
      })),
    });
  }

  async cancelBatchJob(id: string): Promise<BatchJob> {
    await this.getRawBatchJobOrThrow(id);
    const row = await prisma.batchJob.update({
      where: { id },
      data: {
        status: "cancelled",
        currentStep: "批量生成已取消",
        riskPauseRequired: false,
        finishedAt: new Date(),
      },
    });
    await this.closeOpenCheckpoints(id, "cancelled");
    return this.toBatchJob(row);
  }

  private async prepareRunnableBatchJob(id: string, action: "start" | "resume") {
    const job = await this.getRawBatchJobOrThrow(id);
    if (AiWorkbenchBatchRunnerService.activeJobIds.has(job.id)) {
      return job;
    }
    if (action === "start" && job.status !== "queued") {
      throw new AppError("只有 queued 状态的批量任务可以启动。", 400, { id, status: job.status });
    }
    const { startOrder, endOrder } = await this.resolveChapterRange(job);
    const requestedChapterCount = endOrder - startOrder + 1;
    if (requestedChapterCount > 5) {
      throw new AppError("批量生成一次最多允许 5 章。", 400, { requestedChapterCount });
    }
    const activeSkillsJson = await this.buildActiveSkillsJson(job.novelId);
    return prisma.batchJob.update({
      where: { id },
      data: {
        status: "queued",
        requestedChapterCount,
        startChapterOrder: startOrder,
        endChapterOrder: endOrder,
        activeSkillsJson,
        error: null,
        currentStep: `准备生成第 ${startOrder}-${endOrder} 章`,
        finishedAt: null,
      },
    });
  }

  private scheduleRun(batchJobId: string): void {
    if (AiWorkbenchBatchRunnerService.activeJobIds.has(batchJobId)) {
      return;
    }
    AiWorkbenchBatchRunnerService.activeJobIds.add(batchJobId);
    void this.runBatchJob(batchJobId)
      .catch((error) => this.markFailed(batchJobId, error))
      .finally(() => {
        AiWorkbenchBatchRunnerService.activeJobIds.delete(batchJobId);
      });
  }

  private async runBatchJob(batchJobId: string): Promise<void> {
    const job = await this.getRawBatchJobOrThrow(batchJobId);
    const { startOrder, endOrder } = await this.resolveChapterRange(job);
    const config = parseConfig(job.configJson);
    const runConfig = toBatchRunConfig(config);
    const activeSkills = await skillRuntimeContextService.getActiveSkills(job.novelId).catch(() => parseActiveSkillsJson(job.activeSkillsJson));
    const activeSkillSummary = summarizeActiveSkillsForAgentLog(activeSkills);
    const chapters = await prisma.chapter.findMany({
      where: {
        novelId: job.novelId,
        order: { gte: startOrder, lte: endOrder },
      },
      orderBy: { order: "asc" },
    });
    if (chapters.length === 0) {
      throw new AppError("指定区间内没有章节，无法启动批量生成。", 400, { batchJobId, startOrder, endOrder });
    }
    if (chapters.length > 5) {
      throw new AppError("批量生成一次最多允许 5 章。", 400, { batchJobId, chapterCount: chapters.length });
    }

    const agentRunId = job.agentRunId ?? await aiWorkbenchAgentRunLogger.startRun({
      novelId: job.novelId,
      sessionId: `ai-workbench:batch:${batchJobId}`,
      goal: `批量生成第 ${startOrder}-${endOrder} 章`,
      metadata: {
        batchJobId,
        jobType: job.jobType,
        startOrder,
        endOrder,
        requestedChapterCount: chapters.length,
      },
    });
    const now = new Date();
    await prisma.batchJob.update({
      where: { id: batchJobId },
      data: {
        agentRunId,
        status: "running",
        startedAt: job.startedAt ?? now,
        currentStep: `批量生成运行中：第 ${startOrder}-${endOrder} 章`,
        requestedChapterCount: chapters.length,
        riskPauseRequired: false,
        pausedAt: null,
        finishedAt: null,
      },
    });

    const alreadyCompleted = Math.max(0, Math.min(job.completedChapterCount, chapters.length));
    for (let index = alreadyCompleted; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      await this.ensureNotCancelled(batchJobId);
      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "Planner",
        input: { chapterOrder: chapter.order, chapterTitle: chapter.title },
        output: { batchJobId, range: `${startOrder}-${endOrder}` },
        provider: runConfig.provider,
        model: runConfig.model,
      });
      await prisma.batchJob.update({
        where: { id: batchJobId },
        data: {
          status: "running",
          currentStep: `正在生成第 ${chapter.order} 章：${chapter.title}`,
          configJson: serializeConfig({
            ...config,
            currentChapterId: chapter.id,
            currentChapterOrder: chapter.order,
          }),
        },
      });

      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "ContextBuilder",
        input: { novelId: job.novelId, chapterId: chapter.id },
        output: {
          activeSkills: activeSkillSummary,
          stateRequirementCount: activeSkills.reduce((sum, skill) => sum + skill.stateRequirements.length, 0),
          reviewGateCheckCount: activeSkills.reduce((sum, skill) => sum + skill.reviewGateChecks.length, 0),
          riskTriggerCount: activeSkills.reduce((sum, skill) => sum + skill.riskTriggers.length, 0),
        },
        provider: runConfig.provider,
        model: runConfig.model,
      });
      const result = await this.coordinator.runPipelineChapter(
        job.novelId,
        chapter.id,
        {
          provider: runConfig.provider,
          model: runConfig.model,
          temperature: runConfig.temperature,
          maxRetries: runConfig.maxRetries,
          autoReview: runConfig.autoReview ?? true,
          autoRepair: runConfig.autoRepair ?? true,
          qualityThreshold: runConfig.qualityThreshold ?? 75,
          repairMode: runConfig.repairMode ?? "light_repair",
          artifactSyncMode: runConfig.artifactSyncMode ?? "adaptive",
        },
        {
          onCheckCancelled: () => this.ensureNotCancelled(batchJobId),
          onStageChange: async (stage) => {
            await prisma.batchJob.update({
              where: { id: batchJobId },
              data: {
                currentStep: `第 ${chapter.order} 章：${stage}`,
              },
            });
          },
        },
      );
      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "Writer",
        input: { novelId: job.novelId, chapterId: chapter.id },
        output: {
          contentLength: result.runtimePackage?.draft.content.length ?? null,
          retryCountUsed: result.retryCountUsed,
          appliedSkillPromptHooks: summarizeActiveSkillsForAgentLog(result.runtimePackage?.context.activeSkills ?? activeSkills),
          ragReferenceCount: result.runtimePackage?.context.ragReferences.length ?? 0,
          ragReferences: result.runtimePackage?.context.ragReferences.slice(0, 8) ?? [],
        },
        provider: runConfig.provider,
        model: runConfig.model,
      });

      if (result.reviewExecuted) {
        await createQualityReport(job.novelId, chapter.id, result.score, result.issues, {
          sourceType: result.retryCountUsed > 0 ? "batch_repair_recheck" : "batch_pipeline_review",
          contentLength: result.runtimePackage?.draft.content.length ?? chapter.content?.length ?? 0,
          batchJobId,
          agentRunId,
        });
      }

      const gate = await prisma.reviewGateResult.findFirst({
        where: {
          novelId: job.novelId,
          chapterId: chapter.id,
          batchJobId,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const completedChapterCount = index + 1;
      await prisma.batchJob.update({
        where: { id: batchJobId },
        data: {
          completedChapterCount,
          currentStep: `第 ${chapter.order} 章生成完成，ReviewGate 已记录`,
          configJson: serializeConfig({
            ...config,
            currentChapterId: chapter.id,
            currentChapterOrder: chapter.order,
            lastReviewGateResultId: gate?.id ?? null,
          }),
        },
      });
      await this.recordCheckpoint({
        novelId: job.novelId,
        batchJobId,
        agentRunId,
        chapterId: chapter.id,
        checkpointType: "batch_progress",
        summary: `第 ${chapter.order} 章已完成，下一次可从第 ${chapter.order + 1} 章继续。`,
        resumeStep: "resume_batch_from_completed_count",
        resumePayload: {
          completedChapterCount,
          nextChapterOrder: chapter.order + 1,
          startOrder,
          endOrder,
          lastReviewGateResultId: gate?.id ?? null,
        },
        evidence: {
          chapterOrder: chapter.order,
          chapterTitle: chapter.title,
          reviewGateResultId: gate?.id ?? null,
          pass: gate?.pass ?? null,
          recommendedAction: gate?.recommendedAction ?? null,
        },
        closeTypes: ["batch_progress"],
      });
      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "Reviewer",
        input: { novelId: job.novelId, chapterId: chapter.id, reviewGateResultId: gate?.id ?? null },
        output: {
          reviewExecuted: result.reviewExecuted,
          pass: result.pass,
          needsHumanConfirmation: gate?.needsHumanConfirmation ?? null,
          recommendedAction: gate?.recommendedAction ?? null,
        },
        provider: runConfig.provider,
        model: runConfig.model,
      });

      if (gate && isRiskGate(gate)) {
        await aiWorkbenchAgentRunLogger.finishRun({ runId: agentRunId, status: "waiting_approval" });
        await this.pauseForRisk(batchJobId, chapter.order, gate.id);
        return;
      }
    }

    await prisma.batchJob.update({
      where: { id: batchJobId },
      data: {
        status: "succeeded",
        currentStep: "批量生成完成",
        riskPauseRequired: false,
        finishedAt: new Date(),
      },
    });
    await aiWorkbenchAgentRunLogger.finishRun({ runId: agentRunId, status: "succeeded" });
  }

  private async pauseForRisk(batchJobId: string, chapterOrder: number, reviewGateResultId: string): Promise<void> {
    const gate = await prisma.reviewGateResult.findUnique({ where: { id: reviewGateResultId } });
    const pendingPatch = await prisma.statePatch.findFirst({
      where: {
        batchJobId,
        reviewGateResultId,
        status: { in: ["proposed", "needs_confirmation"] },
      },
      orderBy: [{ riskLevel: "desc" }, { updatedAt: "desc" }],
      select: { id: true, riskLevel: true, patchType: true },
    });
    const riskSummary = gate
      ? [{
        chapterOrder,
        reviewGateResultId,
        recommendedAction: gate.recommendedAction,
        risks: parseConfigArray(gate.risksJson),
        requiredFixes: parseConfigArray(gate.requiredFixesJson),
        evidence: parseConfig(gate.evidenceJson),
      }]
      : [{ chapterOrder, reviewGateResultId }];
    await prisma.batchJob.update({
      where: { id: batchJobId },
      data: {
        status: "waiting_approval",
        riskPauseRequired: true,
        riskSummaryJson: JSON.stringify(riskSummary),
        currentStep: `第 ${chapterOrder} 章触发 ReviewGate 风险暂停`,
        pausedAt: new Date(),
      },
    });
    await this.recordCheckpoint({
      novelId: gate?.novelId ?? (await this.getRawBatchJobOrThrow(batchJobId)).novelId,
      batchJobId,
      agentRunId: gate?.agentRunId ?? null,
      chapterId: gate?.chapterId ?? null,
      reviewGateResultId,
      statePatchId: pendingPatch?.id ?? null,
      checkpointType: "risk_pause",
      summary: `第 ${chapterOrder} 章触发 ReviewGate 风险暂停，需人工处理后恢复。`,
      resumeStep: "resolve_pending_state_patch_then_resume_batch",
      resumePayload: {
        chapterOrder,
        reviewGateResultId,
        pendingStatePatchId: pendingPatch?.id ?? null,
        nextAction: gate?.recommendedAction ?? "ask_user",
      },
      evidence: {
        recommendedAction: gate?.recommendedAction ?? null,
        risks: gate ? parseConfigArray(gate.risksJson) : [],
        requiredFixes: gate ? parseConfigArray(gate.requiredFixesJson) : [],
        pendingPatch,
      },
      closeTypes: ["batch_progress", "risk_pause"],
    });
  }

  private async markFailed(batchJobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const job = await prisma.batchJob.findUnique({
      where: { id: batchJobId },
      select: { novelId: true, agentRunId: true, completedChapterCount: true, startChapterOrder: true, endChapterOrder: true },
    }).catch(() => null);
    if (job?.agentRunId) {
      await aiWorkbenchAgentRunLogger.finishRun({ runId: job.agentRunId, status: "failed", error: message }).catch(() => undefined);
    }
    await prisma.batchJob.update({
      where: { id: batchJobId },
      data: {
        status: "failed",
        error: message,
        currentStep: "批量生成失败",
        finishedAt: new Date(),
      },
    }).catch(() => undefined);
    if (job?.novelId) {
      await this.recordCheckpoint({
        novelId: job.novelId,
        batchJobId,
        agentRunId: job.agentRunId,
        checkpointType: "batch_error",
        summary: `批量生成失败：${message}`,
        resumeStep: "inspect_error_then_resume_or_cancel",
        resumePayload: {
          completedChapterCount: job.completedChapterCount,
          startChapterOrder: job.startChapterOrder,
          endChapterOrder: job.endChapterOrder,
        },
        evidence: { error: message },
        closeTypes: ["batch_progress", "batch_error"],
      }).catch(() => undefined);
    }
  }

  private async ensureNotCancelled(batchJobId: string): Promise<void> {
    const row = await prisma.batchJob.findUnique({
      where: { id: batchJobId },
      select: { status: true },
    });
    if (!row || row.status === "cancelled") {
      throw new Error("BATCH_JOB_CANCELLED");
    }
  }

  private async resolveChapterRange(job: {
    novelId: string;
    requestedChapterCount: number;
    startChapterOrder: number | null;
    endChapterOrder: number | null;
  }): Promise<{ startOrder: number; endOrder: number }> {
    const requestedCount = clampChapterCount(job.requestedChapterCount);
    let startOrder = job.startChapterOrder ?? null;
    if (startOrder == null) {
      const firstPendingChapter = await prisma.chapter.findFirst({
        where: {
          novelId: job.novelId,
          OR: [{ content: null }, { content: "" }],
        },
        orderBy: { order: "asc" },
        select: { order: true },
      });
      startOrder = firstPendingChapter?.order ?? null;
    }
    if (startOrder == null) {
      throw new AppError("批量任务缺少 startChapterOrder，且未找到待生成章节。", 400, { novelId: job.novelId });
    }
    const endOrder = job.endChapterOrder ?? (startOrder + requestedCount - 1);
    if (endOrder < startOrder) {
      throw new AppError("批量任务章节区间无效。", 400, { startOrder, endOrder });
    }
    if (endOrder - startOrder + 1 > 5) {
      throw new AppError("批量生成一次最多允许 5 章。", 400, { startOrder, endOrder });
    }
    return { startOrder, endOrder };
  }

  private async buildActiveSkillsJson(novelId: string): Promise<string> {
    return skillRuntimeContextService.serializeActiveSkills(novelId);
  }

  private async closeOpenCheckpoints(batchJobId: string, status: string, resolvedAt = new Date()): Promise<void> {
    await prisma.workbenchCheckpoint.updateMany({
      where: { batchJobId, status: "open" },
      data: { status, resolvedAt },
    });
  }

  private async recordCheckpoint(input: {
    novelId: string;
    batchJobId: string;
    agentRunId?: string | null;
    chapterId?: string | null;
    reviewGateResultId?: string | null;
    statePatchId?: string | null;
    checkpointType: string;
    summary: string;
    resumeStep: string;
    resumePayload: Record<string, unknown>;
    evidence: Record<string, unknown>;
    closeTypes?: string[];
  }): Promise<void> {
    if (input.closeTypes?.length) {
      await prisma.workbenchCheckpoint.updateMany({
        where: {
          batchJobId: input.batchJobId,
          checkpointType: { in: input.closeTypes },
          status: "open",
        },
        data: {
          status: "superseded",
          resolvedAt: new Date(),
        },
      });
    }
    await prisma.workbenchCheckpoint.create({
      data: {
        novelId: input.novelId,
        batchJobId: input.batchJobId,
        agentRunId: input.agentRunId ?? null,
        chapterId: input.chapterId ?? null,
        reviewGateResultId: input.reviewGateResultId ?? null,
        statePatchId: input.statePatchId ?? null,
        checkpointType: input.checkpointType,
        summary: input.summary,
        resumeStep: input.resumeStep,
        resumePayloadJson: JSON.stringify(input.resumePayload),
        evidenceJson: JSON.stringify(input.evidence),
      },
    });
  }

  private async getRawBatchJobOrThrow(id: string) {
    const row = await prisma.batchJob.findUnique({ where: { id } });
    if (!row) {
      throw new AppError("批量任务不存在。", 404, { id });
    }
    return row;
  }

  private async getBatchJobOrThrow(id: string): Promise<BatchJob> {
    const row = await this.getRawBatchJobOrThrow(id);
    return this.toBatchJob(row);
  }

  private toBatchJob(row: Awaited<ReturnType<typeof this.getRawBatchJobOrThrow>>): BatchJob {
    return {
      ...row,
      startedAt: row.startedAt?.toISOString() ?? null,
      pausedAt: row.pausedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function parseConfigArray(value: string | null | undefined): unknown[] {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const aiWorkbenchBatchRunnerService = new AiWorkbenchBatchRunnerService();
