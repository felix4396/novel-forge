import type { Prisma } from "@prisma/client";
import type {
  BatchJob,
  FromZeroOpenBookResult,
  ModelCallLog,
  ModelCallUsageScope,
  ModelCallUsageSummary,
  ProductionChainSnapshot,
  ProjectSkill,
  ReviewGateRecommendedAction,
  ReviewGateResult,
  Skill,
  SkillVersion,
  StatePatch,
  StatePatchRiskLevel,
  StatePatchStatus,
  StyleLabDetectionResult,
  StyleLabTestWriteResult,
  WorkbenchCheckpoint,
} from "@ai-novel/shared/types/aiWorkbench";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { NovelWorkflowService } from "../novel/workflow/NovelWorkflowService";
import { StyleDetectionService } from "../styleEngine/StyleDetectionService";
import { StyleGenerationService } from "../styleEngine/StyleGenerationService";
import { NovelWorkflowTaskAdapter } from "../task/adapters/NovelWorkflowTaskAdapter";
import { aiWorkbenchAgentRunLogger } from "./AiWorkbenchAgentRunLogger";
import { localSkillRegistryService } from "./LocalSkillRegistryService";

const CHAPTER_GENERATION_STATES = ["planned", "drafted", "reviewed", "repaired", "approved", "published"] as const;
const CHAPTER_STATUSES = ["unplanned", "pending_generation", "generating", "pending_review", "needs_repair", "completed"] as const;

type ChapterGenerationStateValue = typeof CHAPTER_GENERATION_STATES[number];
type ChapterStatusValue = typeof CHAPTER_STATUSES[number];
type ChapterLifecyclePatch = {
  generationState?: ChapterGenerationStateValue;
  chapterStatus?: ChapterStatusValue;
};

type StatePatchRow = Parameters<typeof toStatePatch>[0];

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function jsonOrDefault(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
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

function compactJsonText(value: string | null | undefined, limit = 6000): string | null {
  if (!value?.trim()) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  try {
    const parsed = JSON.parse(normalized);
    const compacted = JSON.stringify(compactJsonValue(parsed));
    if (compacted.length <= limit) {
      return compacted;
    }
    const aggressive = JSON.stringify(compactJsonValue(parsed, 0, true));
    if (aggressive.length <= limit) {
      return aggressive;
    }
    return JSON.stringify(summarizeOversizedJson(parsed, normalized.length));
  } catch {
    return JSON.stringify({
      truncated: true,
      originalLength: normalized.length,
      preview: normalized.slice(0, Math.max(0, limit - 160)),
    });
  }
}

function compactJsonValue(value: unknown, depth = 0, aggressive = false): unknown {
  if (typeof value === "string") {
    const stringLimit = aggressive ? 120 : 240;
    return value.length > stringLimit ? `${value.slice(0, stringLimit)}...` : value;
  }
  if (Array.isArray(value)) {
    const maxItems = aggressive
      ? depth >= 1 ? 2 : 4
      : depth >= 2 ? 3 : 6;
    const items = value.slice(0, maxItems).map((item) => compactJsonValue(item, depth + 1, aggressive));
    return value.length > maxItems
      ? [...items, { truncatedItems: value.length - maxItems }]
      : items;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const maxEntries = aggressive
      ? depth >= 2 ? 8 : 14
      : depth >= 2 ? 10 : 20;
    const compacted: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, maxEntries)) {
      compacted[key] = compactJsonValue(item, depth + 1, aggressive);
    }
    if (entries.length > maxEntries) {
      compacted.truncatedKeys = entries.length - maxEntries;
    }
    return compacted;
  }
  return value;
}

function summarizeOversizedJson(value: unknown, originalLength: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      truncated: true,
      originalLength,
      preview: compactJsonValue(value, 0, true),
    };
  }
  const summary: Record<string, unknown> = {
    truncated: true,
    originalLength,
  };
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item == null || ["string", "number", "boolean"].includes(typeof item)) {
      summary[key] = compactJsonValue(item, 0, true);
      continue;
    }
    if (Array.isArray(item)) {
      const lowerKey = key.toLowerCase();
      summary[key] = {
        count: item.length,
        sample: compactJsonValue(
          lowerKey.includes("reference") || lowerKey.includes("risk") || lowerKey.includes("fix")
            ? item.slice(0, 4)
            : item.slice(0, 2),
          1,
          true,
        ),
      };
      continue;
    }
    summary[key] = compactJsonValue(item, 1, true);
  }
  return summary;
}

function parseStringArrayJson(value: string | null | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
  } catch {
    return [];
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function readStateSchemaFields(value: unknown): string[] {
  const schema = parseJsonRecord(JSON.stringify(value ?? {}));
  const properties = parseJsonRecord(JSON.stringify(schema.properties ?? {}));
  return Object.keys(properties).filter((key) => key.trim().length > 0);
}

function normalizeSkillStateField(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, "");
}

function intersectStrings(left: string[], right: string[]): string[] {
  const normalizedRight = new Set(right.map((item) => item.trim()).filter(Boolean));
  return left.filter((item) => normalizedRight.has(item));
}

function readSkillStateRequirements(row: {
  skill?: { metadataJson: string } | null;
  skillVersion?: { manifestJson: string } | null;
}): string[] {
  const metadata = parseJsonRecord(row.skill?.metadataJson);
  const manifest = parseJsonRecord(row.skillVersion?.manifestJson);
  return Array.from(new Set([
    ...readStringArray(metadata.stateRequirements),
    ...readStateSchemaFields(metadata.stateSchema),
    ...readStringArray(manifest.stateRequirements),
    ...readStateSchemaFields(manifest.stateSchema),
  ]));
}

function normalizeChapterLifecyclePatch(value: string): ChapterLifecyclePatch {
  const raw = parseJsonRecord(value);
  const patch: ChapterLifecyclePatch = {};
  if (
    typeof raw.generationState === "string"
    && (CHAPTER_GENERATION_STATES as readonly string[]).includes(raw.generationState)
  ) {
    patch.generationState = raw.generationState as ChapterGenerationStateValue;
  }
  if (
    typeof raw.chapterStatus === "string"
    && (CHAPTER_STATUSES as readonly string[]).includes(raw.chapterStatus)
  ) {
    patch.chapterStatus = raw.chapterStatus as ChapterStatusValue;
  }
  if (!patch.generationState && !patch.chapterStatus) {
    throw new AppError("StatePatch 缺少可应用的章节生命周期字段。", 400, { patchType: "chapter_review_lifecycle" });
  }
  return patch;
}

function getChapterLifecycleBeforeFromEvidence(evidenceJson: string): ChapterLifecyclePatch | null {
  const evidence = parseJsonRecord(evidenceJson);
  const application = evidence.application;
  if (!application || typeof application !== "object" || Array.isArray(application)) {
    return null;
  }
  const before = (application as Record<string, unknown>).before;
  if (!before || typeof before !== "object" || Array.isArray(before)) {
    return null;
  }
  const record = before as Record<string, unknown>;
  const patch: ChapterLifecyclePatch = {};
  if (
    typeof record.generationState === "string"
    && (CHAPTER_GENERATION_STATES as readonly string[]).includes(record.generationState)
  ) {
    patch.generationState = record.generationState as ChapterGenerationStateValue;
  }
  if (
    typeof record.chapterStatus === "string"
    && (CHAPTER_STATUSES as readonly string[]).includes(record.chapterStatus)
  ) {
    patch.chapterStatus = record.chapterStatus as ChapterStatusValue;
  }
  return patch.generationState || patch.chapterStatus ? patch : null;
}

function mergeStatePatchEvidence(
  evidenceJson: string,
  application: Record<string, unknown>,
): string {
  return JSON.stringify({
    ...parseJsonRecord(evidenceJson),
    application,
  });
}

const PENDING_STATE_PATCH_STATUSES = new Set(["proposed", "needs_confirmation"]);
const APPLIED_STATE_PATCH_STATUSES = new Set(["accepted", "applied", "auto_accepted"]);
const FAILED_MODEL_CALL_STATUSES = ["failed", "error", "cancelled"] as const;
const VALID_STATE_PATCH_STATUSES = new Set([
  "proposed",
  "auto_accepted",
  "needs_confirmation",
  "accepted",
  "rejected",
  "applied",
  "reverted",
]);

function assertStatePatchTransition(currentStatus: string, nextStatus: string): void {
  if (!VALID_STATE_PATCH_STATUSES.has(nextStatus)) {
    throw new AppError("StatePatch 状态无效。", 400, { currentStatus, nextStatus });
  }
  if (nextStatus === currentStatus && !APPLIED_STATE_PATCH_STATUSES.has(nextStatus)) {
    return;
  }
  if (nextStatus === "needs_confirmation" && currentStatus === "proposed") {
    return;
  }
  if (nextStatus === "rejected" && PENDING_STATE_PATCH_STATUSES.has(currentStatus)) {
    return;
  }
  if (APPLIED_STATE_PATCH_STATUSES.has(nextStatus) && PENDING_STATE_PATCH_STATUSES.has(currentStatus)) {
    return;
  }
  if (nextStatus === "reverted" && APPLIED_STATE_PATCH_STATUSES.has(currentStatus)) {
    return;
  }
  throw new AppError("StatePatch 状态转换不允许。", 400, { currentStatus, nextStatus });
}

function toBatchJob(row: {
  id: string;
  novelId: string;
  agentRunId: string | null;
  jobType: string;
  status: string;
  requestedChapterCount: number;
  startChapterOrder: number | null;
  endChapterOrder: number | null;
  completedChapterCount: number;
  riskPauseRequired: boolean;
  riskSummaryJson: string;
  activeSkillsJson: string;
  configJson: string;
  currentStep: string | null;
  error: string | null;
  startedAt: Date | null;
  pausedAt: Date | null;
  finishedAt: Date | null;
  checkpoints?: Parameters<typeof toWorkbenchCheckpoint>[0][];
  createdAt: Date;
  updatedAt: Date;
}): BatchJob {
  const { checkpoints: _checkpoints, ...batchJob } = row;
  return {
    ...batchJob,
    latestCheckpoint: row.checkpoints?.[0] ? toWorkbenchCheckpoint(row.checkpoints[0]) : null,
    startedAt: toIso(row.startedAt),
    pausedAt: toIso(row.pausedAt),
    finishedAt: toIso(row.finishedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWorkbenchCheckpoint(row: {
  id: string;
  novelId: string;
  batchJobId: string | null;
  agentRunId: string | null;
  chapterId: string | null;
  reviewGateResultId: string | null;
  statePatchId: string | null;
  checkpointType: string;
  status: string;
  summary: string | null;
  resumeStep: string | null;
  resumePayloadJson: string;
  evidenceJson: string;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WorkbenchCheckpoint {
  return {
    ...row,
    resolvedAt: toIso(row.resolvedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toModelCallLog(row: {
  id: string;
  novelId: string | null;
  agentRunId: string | null;
  agentStepId: string | null;
  taskType: string;
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  requestDigest: string | null;
  responseDigest: string | null;
  error: string | null;
  metadataJson: string;
  createdAt: Date;
}): ModelCallLog {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

function createEmptyModelUsageSummary(
  scope: ModelCallUsageScope,
  label: string,
  available = true,
): ModelCallUsageSummary {
  return {
    scope,
    label,
    available,
    callCount: 0,
    failedCallCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    averageLatencyMs: null,
  };
}

function summarizeModelCallLogs(
  scope: ModelCallUsageScope,
  label: string,
  rows: ModelCallLog[],
): ModelCallUsageSummary {
  const latencyRows = rows.filter((row) => typeof row.latencyMs === "number");
  return {
    scope,
    label,
    available: true,
    callCount: rows.length,
    failedCallCount: rows.filter((row) => FAILED_MODEL_CALL_STATUSES.includes(row.status as typeof FAILED_MODEL_CALL_STATUSES[number])).length,
    promptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0),
    completionTokens: rows.reduce((sum, row) => sum + row.completionTokens, 0),
    totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
    costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    averageLatencyMs: latencyRows.length > 0
      ? Math.round(latencyRows.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0) / latencyRows.length)
      : null,
  };
}

function toReviewGateResult(row: {
  id: string;
  novelId: string;
  chapterId: string | null;
  agentRunId: string | null;
  batchJobId: string | null;
  sourceType: string;
  pass: boolean;
  scoreJson: string;
  risksJson: string;
  requiredFixesJson: string;
  statePatchesJson: string;
  evidenceJson: string;
  activeSkillsJson: string;
  styleProfileId: string | null;
  needsHumanConfirmation: boolean;
  recommendedAction: string;
  createdAt: Date;
  updatedAt: Date;
}): ReviewGateResult {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toStatePatch(row: {
  id: string;
  novelId: string;
  chapterId: string | null;
  agentRunId: string | null;
  batchJobId: string | null;
  reviewGateResultId: string | null;
  targetType: string;
  targetId: string | null;
  patchType: string;
  status: string;
  riskLevel: string;
  patchJson: string;
  evidenceJson: string;
  appliedAt: Date | null;
  revertedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}): StatePatch {
  return {
    ...row,
    appliedAt: toIso(row.appliedAt),
    revertedAt: toIso(row.revertedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSkill(row: {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string | null;
  sourceType: string;
  defaultEnabled: boolean;
  priority: number;
  conflictKeysJson: string;
  metadataJson: string;
  createdAt: Date;
  updatedAt: Date;
  versions?: Parameters<typeof toSkillVersion>[0][];
}): Skill {
  const { versions, ...skill } = row;
  return {
    ...skill,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    latestVersion: versions?.[0] ? toSkillVersion(versions[0]) : undefined,
  };
}

function toSkillVersion(row: {
  id: string;
  skillId: string;
  version: string;
  status: string;
  manifestJson: string;
  promptHooksJson: string;
  reviewGateChecksJson: string;
  checksum: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SkillVersion {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toProjectSkill(row: {
  id: string;
  novelId: string;
  skillId: string;
  skillVersionId: string | null;
  enabled: boolean;
  priority: number;
  configJson: string;
  conflictStatus: string;
  conflictJson: string;
  createdAt: Date;
  updatedAt: Date;
  skill?: Parameters<typeof toSkill>[0];
  skillVersion?: Parameters<typeof toSkillVersion>[0] | null;
}): ProjectSkill {
  return {
    id: row.id,
    novelId: row.novelId,
    skillId: row.skillId,
    skillVersionId: row.skillVersionId,
    enabled: row.enabled,
    priority: row.priority,
    configJson: row.configJson,
    conflictStatus: row.conflictStatus,
    conflictJson: row.conflictJson,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    skill: row.skill ? toSkill(row.skill) : undefined,
    skillVersion: row.skillVersion ? toSkillVersion(row.skillVersion) : null,
  };
}

export class AiWorkbenchService {
  private readonly workflowService = new NovelWorkflowService();
  private readonly workflowAdapter = new NovelWorkflowTaskAdapter();
  private readonly styleDetectionService = new StyleDetectionService();
  private readonly styleGenerationService = new StyleGenerationService();

  async createFromZeroOpenBookTask(input: {
    idea: string;
    title?: string | null;
    basicForm?: Record<string, unknown> | null;
    styleTone?: string | null;
    firstChapterCount?: number;
    defaultChapterLength?: number;
    provider?: string | null;
    model?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
  }): Promise<FromZeroOpenBookResult> {
    const idea = input.idea.trim();
    if (!idea) {
      throw new AppError("Idea is required.", 400);
    }
    const targetFirstChapterCount = Math.max(1, Math.min(input.firstChapterCount ?? 3, 5));
    const targetOutlineChapterCount = 20;
    const title = input.title?.trim() || undefined;
    const provider = input.provider?.trim() || undefined;
    const model = input.model?.trim() || undefined;
    const basicFormInput = input.basicForm ?? {};
    const autoExecutionPlan = {
      mode: "chapter_range",
      startOrder: 1,
      endOrder: targetFirstChapterCount,
      autoReview: true,
      autoRepair: true,
    };
    const basicForm = {
      ...basicFormInput,
      title: title ?? (typeof basicFormInput.title === "string" ? basicFormInput.title : ""),
      description: idea,
      styleTone: input.styleTone?.trim() || (typeof basicFormInput.styleTone === "string" ? basicFormInput.styleTone : ""),
      defaultChapterLength: input.defaultChapterLength ?? basicFormInput.defaultChapterLength ?? 2800,
      estimatedChapterCount: basicFormInput.estimatedChapterCount ?? 80,
      writingMode: basicFormInput.writingMode ?? "original",
      projectMode: basicFormInput.projectMode ?? "ai_led",
      projectStatus: basicFormInput.projectStatus ?? "in_progress",
      storylineStatus: basicFormInput.storylineStatus ?? "not_started",
      outlineStatus: basicFormInput.outlineStatus ?? "not_started",
      resourceReadyScore: basicFormInput.resourceReadyScore ?? 0,
    };

    const workflowRow = await this.workflowService.bootstrapTask({
      lane: "auto_director",
      title,
      seedPayload: {
        basicForm,
        idea,
        runMode: "auto_to_execution",
        worldSetupMode: "auto_generate",
        autoExecutionPlan,
        aiWorkbenchSource: "from_zero_open_book",
        targetFirstChapterCount,
        targetOutlineChapterCount,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        temperature: input.temperature ?? undefined,
        maxTokens: input.maxTokens ?? undefined,
      },
    });

    const agentRunId = await aiWorkbenchAgentRunLogger.startRun({
      novelId: workflowRow.novelId ?? null,
      sessionId: `ai-workbench:from-zero:${workflowRow.id}`,
      goal: "从零开书：灵感 -> 书设/角色/世界观/前 20 章大纲/前 3 章正文",
      metadata: {
        source: "from_zero_open_book",
        autoDirectorTaskId: workflowRow.id,
        targetFirstChapterCount,
        targetOutlineChapterCount,
        delegatedWorkflow: "auto_director",
      },
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Planner",
      stepType: "planning",
      status: "succeeded",
      input: {
        idea,
        title: title ?? null,
        targetFirstChapterCount,
        targetOutlineChapterCount,
      },
      output: {
        autoDirectorTaskId: workflowRow.id,
        runMode: "auto_to_execution",
        autoExecutionPlan,
        nextHumanCheckpoint: "candidate_selection_required",
      },
      provider,
      model,
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "ContextBuilder",
      stepType: "reasoning",
      status: "pending",
      input: { source: "Postgres + Skills + StyleProfile + AutoDirector state" },
      output: { delegatedTo: "AutoDirector 后续候选确认后组装上下文" },
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Writer",
      stepType: "write",
      status: "pending",
      input: { chapterRange: [1, targetFirstChapterCount] },
      output: { delegatedTo: "AutoDirector 章节执行" },
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Reviewer",
      stepType: "approval",
      status: "pending",
      input: { reviewGate: "统一 ReviewGate" },
      output: {
        expectedChecks: ["taskFit", "continuity", "style", "readability", "statePatchSafety"],
      },
    });
    await aiWorkbenchAgentRunLogger.finishRun({ runId: agentRunId, status: "waiting_approval" });

    const task = await this.workflowAdapter.detail(workflowRow.id);
    return {
      task,
      agentRunId,
      autoDirectorTaskId: workflowRow.id,
      targetFirstChapterCount,
      targetOutlineChapterCount,
    };
  }

  async detectStyleLabDeviation(input: {
    content: string;
    styleProfileId?: string | null;
    novelId?: string | null;
    volumeId?: string | null;
    chapterId?: string | null;
    taskStyleProfileId?: string | null;
    previewAntiAiRuleIds?: string[];
    provider?: LLMProvider | string | null;
    model?: string | null;
    temperature?: number | null;
  }): Promise<StyleLabDetectionResult> {
    const content = input.content.trim();
    if (!content) {
      throw new AppError("Style Lab detection content is required.", 400);
    }
    const novelId = input.novelId?.trim() || null;
    const styleProfileId = input.styleProfileId?.trim() || null;
    const provider = input.provider?.trim() || "openai";
    const model = input.model?.trim() || undefined;
    const agentRunId = await aiWorkbenchAgentRunLogger.startRun({
      novelId,
      chapterId: input.chapterId?.trim() || null,
      sessionId: `ai-workbench:style-lab:${styleProfileId ?? "unbound"}:${Date.now()}`,
      goal: "风格学习：Reviewer 检测试写文本风格偏离点",
      metadata: {
        source: "style_lab_detection",
        styleProfileId,
        volumeId: input.volumeId?.trim() || null,
        taskStyleProfileId: input.taskStyleProfileId?.trim() || null,
      },
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Planner",
      stepType: "planning",
      input: {
        contentLength: content.length,
        styleProfileId,
        novelId,
      },
      output: {
        detectionTarget: "style_deviation",
        acceptanceItem: "Reviewer 是否指出偏离点",
      },
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "ContextBuilder",
      stepType: "reasoning",
      input: {
        styleProfileId,
        novelId,
        volumeId: input.volumeId?.trim() || null,
        chapterId: input.chapterId?.trim() || null,
        taskStyleProfileId: input.taskStyleProfileId?.trim() || null,
        previewAntiAiRuleIds: input.previewAntiAiRuleIds ?? [],
      },
      output: {
        source: "StyleRuntimeResolver + AntiAi rules",
      },
    });
    const report = await this.styleDetectionService.check({
      content,
      styleProfileId: styleProfileId ?? undefined,
      novelId: novelId ?? undefined,
      volumeId: input.volumeId?.trim() || undefined,
      chapterId: input.chapterId?.trim() || undefined,
      taskStyleProfileId: input.taskStyleProfileId?.trim() || undefined,
      previewAntiAiRuleIds: input.previewAntiAiRuleIds,
      provider: provider as LLMProvider | undefined,
      model,
      temperature: input.temperature ?? undefined,
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Reviewer",
      stepType: "approval",
      input: {
        contentLength: content.length,
        styleProfileId,
      },
      output: {
        riskScore: report.riskScore,
        summary: report.summary,
        violationCount: report.violations.length,
        canAutoRewrite: report.canAutoRewrite,
        appliedRuleIds: report.appliedRuleIds,
        violations: report.violations.slice(0, 8),
      },
      provider,
      model,
    });
    await aiWorkbenchAgentRunLogger.finishRun({ runId: agentRunId, status: "succeeded" });
    return { report, agentRunId };
  }

  async testWriteWithStyleProfile(input: {
    styleProfileId: string;
    mode: "generate" | "rewrite";
    topic?: string | null;
    sourceText?: string | null;
    targetLength?: number | null;
    novelId?: string | null;
    volumeId?: string | null;
    chapterId?: string | null;
    provider?: LLMProvider | string | null;
    model?: string | null;
    temperature?: number | null;
    styleIntensity?: number | null;
  }): Promise<StyleLabTestWriteResult> {
    const styleProfileId = input.styleProfileId.trim();
    if (!styleProfileId) {
      throw new AppError("StyleProfile is required.", 400);
    }
    if (input.mode === "generate" && !input.topic?.trim()) {
      throw new AppError("Style Lab topic is required.", 400);
    }
    if (input.mode === "rewrite" && !input.sourceText?.trim()) {
      throw new AppError("Style Lab source text is required.", 400);
    }

    const novelId = input.novelId?.trim() || null;
    const volumeId = input.volumeId?.trim() || null;
    const chapterId = input.chapterId?.trim() || null;
    const provider = input.provider?.trim() || "openai";
    const model = input.model?.trim() || undefined;
    const targetLength = input.targetLength ?? null;
    const agentRunId = await aiWorkbenchAgentRunLogger.startRun({
      novelId,
      chapterId,
      sessionId: `ai-workbench:style-lab-test-write:${styleProfileId}:${Date.now()}`,
      goal: "风格学习：Writer 按 StyleProfile 试写同一剧情",
      metadata: {
        source: "style_lab_test_write",
        styleProfileId,
        mode: input.mode,
        volumeId,
        targetLength,
        styleIntensity: input.styleIntensity ?? null,
      },
    });

    try {
      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "Planner",
        stepType: "planning",
        input: {
          mode: input.mode,
          styleProfileId,
          novelId,
          targetLength,
        },
        output: {
          writingTarget: input.mode === "rewrite" ? "style_rewrite" : "same_plot_test_write",
          acceptanceItem: "Writer 是否按 StyleProfile 生成文本",
        },
      });
      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "ContextBuilder",
        stepType: "reasoning",
        input: {
          styleProfileId,
          novelId,
          volumeId,
          chapterId,
          styleIntensity: input.styleIntensity ?? null,
        },
        output: {
          source: "StyleRuntimeResolver compiled StyleProfile blocks",
        },
      });

      const result = await this.styleGenerationService.testWrite({
        styleProfileId,
        mode: input.mode,
        topic: input.mode === "generate" ? input.topic?.trim() : undefined,
        sourceText: input.mode === "rewrite" ? input.sourceText?.trim() : undefined,
        targetLength: targetLength ?? undefined,
        provider: provider as LLMProvider | undefined,
        model,
        temperature: input.temperature ?? undefined,
        styleIntensity: input.styleIntensity ?? undefined,
      });

      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "Writer",
        stepType: "write",
        input: {
          mode: input.mode,
          targetLength,
          styleProfileId,
        },
        output: {
          outputLength: result.output.length,
          appliedRuleCount: result.compiledBlocks.appliedRuleIds.length,
          maturity: result.compiledBlocks.contract.meta.maturity,
        },
        provider,
        model,
      });
      const detectionReport = await this.styleDetectionService.check({
        content: result.output,
        styleProfileId,
        novelId: novelId ?? undefined,
        volumeId: volumeId ?? undefined,
        chapterId: chapterId ?? undefined,
        provider: provider as LLMProvider | undefined,
        model,
        temperature: 0.2,
      });
      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "Reviewer",
        stepType: "approval",
        input: {
          contentLength: result.output.length,
          styleProfileId,
        },
        output: {
          riskScore: detectionReport.riskScore,
          summary: detectionReport.summary,
          violationCount: detectionReport.violations.length,
          canAutoRewrite: detectionReport.canAutoRewrite,
          appliedRuleIds: detectionReport.appliedRuleIds,
          violations: detectionReport.violations.slice(0, 8),
        },
        provider,
        model,
      });
      await aiWorkbenchAgentRunLogger.finishRun({ runId: agentRunId, status: "succeeded" });

      return {
        ...result,
        detectionReport,
        agentRunId,
        styleProfileId,
        mode: input.mode,
        outputLength: result.output.length,
        targetLength,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Style Lab test write failed.";
      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "Writer",
        stepType: "write",
        status: "failed",
        input: {
          mode: input.mode,
          targetLength,
          styleProfileId,
        },
        error: message,
        provider,
        model,
      });
      await aiWorkbenchAgentRunLogger.finishRun({ runId: agentRunId, status: "failed", error: message });
      throw error;
    }
  }

  async createBatchJob(input: {
    novelId: string;
    agentRunId?: string | null;
    jobType: string;
    requestedChapterCount?: number;
    startChapterOrder?: number | null;
    endChapterOrder?: number | null;
    activeSkillsJson?: string;
    configJson?: string;
  }): Promise<BatchJob> {
    const row = await prisma.batchJob.create({
      data: {
        novelId: input.novelId,
        agentRunId: input.agentRunId ?? null,
        jobType: input.jobType,
        requestedChapterCount: input.requestedChapterCount ?? 1,
        startChapterOrder: input.startChapterOrder ?? null,
        endChapterOrder: input.endChapterOrder ?? null,
        activeSkillsJson: jsonOrDefault(input.activeSkillsJson, "[]"),
        configJson: jsonOrDefault(input.configJson, "{}"),
      },
    });
    return toBatchJob(row);
  }

  async listBatchJobs(filters: {
    novelId?: string;
    status?: string;
    limit?: number;
  }): Promise<BatchJob[]> {
    const rows = await prisma.batchJob.findMany({
      where: {
        ...(filters.novelId ? { novelId: filters.novelId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        checkpoints: {
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(filters.limit ?? 50, 100)),
    });
    return rows.map(toBatchJob);
  }

  async updateBatchJob(id: string, patch: {
    status?: string;
    completedChapterCount?: number;
    riskPauseRequired?: boolean;
    riskSummaryJson?: string;
    currentStep?: string | null;
    error?: string | null;
    startedAt?: Date | null;
    pausedAt?: Date | null;
    finishedAt?: Date | null;
  }): Promise<BatchJob> {
    const row = await prisma.batchJob.update({
      where: { id },
      data: patch,
    });
    return toBatchJob(row);
  }

  async listCheckpoints(filters: {
    novelId?: string;
    batchJobId?: string;
    status?: string;
    limit?: number;
  }): Promise<WorkbenchCheckpoint[]> {
    const rows = await prisma.workbenchCheckpoint.findMany({
      where: {
        ...(filters.novelId ? { novelId: filters.novelId } : {}),
        ...(filters.batchJobId ? { batchJobId: filters.batchJobId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(filters.limit ?? 50, 100)),
    });
    return rows.map(toWorkbenchCheckpoint);
  }

  async recordModelCall(input: {
    novelId?: string | null;
    agentRunId?: string | null;
    agentStepId?: string | null;
    taskType: string;
    provider: string;
    model: string;
    status?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number | null;
    latencyMs?: number | null;
    requestDigest?: string | null;
    responseDigest?: string | null;
    error?: string | null;
    metadataJson?: string;
  }): Promise<ModelCallLog> {
    const promptTokens = input.promptTokens ?? 0;
    const completionTokens = input.completionTokens ?? 0;
    const row = await prisma.modelCallLog.create({
      data: {
        novelId: input.novelId ?? null,
        agentRunId: input.agentRunId ?? null,
        agentStepId: input.agentStepId ?? null,
        taskType: input.taskType,
        provider: input.provider,
        model: input.model,
        status: input.status ?? "recorded",
        promptTokens,
        completionTokens,
        totalTokens: input.totalTokens ?? promptTokens + completionTokens,
        costUsd: input.costUsd ?? null,
        latencyMs: input.latencyMs ?? null,
        requestDigest: input.requestDigest ?? null,
        responseDigest: input.responseDigest ?? null,
        error: input.error ?? null,
        metadataJson: jsonOrDefault(input.metadataJson, "{}"),
      },
    });
    return toModelCallLog(row);
  }

  async listModelCallLogs(filters: {
    novelId?: string;
    agentRunId?: string;
    taskType?: string;
    limit?: number;
  }): Promise<ModelCallLog[]> {
    const rows = await prisma.modelCallLog.findMany({
      where: {
        ...(filters.novelId ? { novelId: filters.novelId } : {}),
        ...(filters.agentRunId ? { agentRunId: filters.agentRunId } : {}),
        ...(filters.taskType ? { taskType: filters.taskType } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(filters.limit ?? 50, 100)),
    });
    return rows.map(toModelCallLog);
  }

  private async summarizeModelCallWhere(
    scope: ModelCallUsageScope,
    label: string,
    where: Prisma.ModelCallLogWhereInput,
  ): Promise<ModelCallUsageSummary> {
    const [aggregate, failedCallCount] = await Promise.all([
      prisma.modelCallLog.aggregate({
        where,
        _count: { _all: true },
        _sum: {
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          costUsd: true,
        },
        _avg: {
          latencyMs: true,
        },
      }),
      prisma.modelCallLog.count({
        where: {
          ...where,
          status: { in: [...FAILED_MODEL_CALL_STATUSES] },
        },
      }),
    ]);

    return {
      scope,
      label,
      available: true,
      callCount: aggregate._count._all,
      failedCallCount,
      promptTokens: aggregate._sum.promptTokens ?? 0,
      completionTokens: aggregate._sum.completionTokens ?? 0,
      totalTokens: aggregate._sum.totalTokens ?? 0,
      costUsd: aggregate._sum.costUsd ?? 0,
      averageLatencyMs: typeof aggregate._avg.latencyMs === "number" ? Math.round(aggregate._avg.latencyMs) : null,
    };
  }

  async createReviewGateResult(input: {
    novelId: string;
    chapterId?: string | null;
    agentRunId?: string | null;
    batchJobId?: string | null;
    sourceType: string;
    pass: boolean;
    scoreJson?: string;
    risksJson?: string;
    requiredFixesJson?: string;
    statePatchesJson?: string;
    evidenceJson?: string;
    activeSkillsJson?: string;
    styleProfileId?: string | null;
    needsHumanConfirmation?: boolean;
    recommendedAction?: ReviewGateRecommendedAction | string;
  }): Promise<ReviewGateResult> {
    const row = await prisma.reviewGateResult.create({
      data: {
        novelId: input.novelId,
        chapterId: input.chapterId ?? null,
        agentRunId: input.agentRunId ?? null,
        batchJobId: input.batchJobId ?? null,
        sourceType: input.sourceType,
        pass: input.pass,
        scoreJson: jsonOrDefault(input.scoreJson, "{}"),
        risksJson: jsonOrDefault(input.risksJson, "[]"),
        requiredFixesJson: jsonOrDefault(input.requiredFixesJson, "[]"),
        statePatchesJson: jsonOrDefault(input.statePatchesJson, "[]"),
        evidenceJson: jsonOrDefault(input.evidenceJson, "{}"),
        activeSkillsJson: jsonOrDefault(input.activeSkillsJson, "[]"),
        styleProfileId: input.styleProfileId ?? null,
        needsHumanConfirmation: input.needsHumanConfirmation ?? false,
        recommendedAction: input.recommendedAction ?? (input.pass ? "accept" : "revise"),
      },
    });
    return toReviewGateResult(row);
  }

  async listReviewGateResults(filters: {
    novelId?: string;
    chapterId?: string;
    agentRunId?: string;
    batchJobId?: string;
    needsHumanConfirmation?: boolean;
    limit?: number;
  }): Promise<ReviewGateResult[]> {
    const rows = await prisma.reviewGateResult.findMany({
      where: {
        ...(filters.novelId ? { novelId: filters.novelId } : {}),
        ...(filters.chapterId ? { chapterId: filters.chapterId } : {}),
        ...(filters.agentRunId ? { agentRunId: filters.agentRunId } : {}),
        ...(filters.batchJobId ? { batchJobId: filters.batchJobId } : {}),
        ...(typeof filters.needsHumanConfirmation === "boolean"
          ? { needsHumanConfirmation: filters.needsHumanConfirmation }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(filters.limit ?? 50, 100)),
    });
    return rows.map(toReviewGateResult);
  }

  async createStatePatch(input: {
    novelId: string;
    chapterId?: string | null;
    agentRunId?: string | null;
    batchJobId?: string | null;
    reviewGateResultId?: string | null;
    targetType: string;
    targetId?: string | null;
    patchType: string;
    status?: StatePatchStatus | string;
    riskLevel?: StatePatchRiskLevel | string;
    patchJson: string;
    evidenceJson?: string;
    decisionNote?: string | null;
  }): Promise<StatePatch> {
    const status = input.status ?? "proposed";
    const now = new Date();
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.statePatch.create({
        data: {
          novelId: input.novelId,
          chapterId: input.chapterId ?? null,
          agentRunId: input.agentRunId ?? null,
          batchJobId: input.batchJobId ?? null,
          reviewGateResultId: input.reviewGateResultId ?? null,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          patchType: input.patchType,
          status,
          riskLevel: input.riskLevel ?? "low",
          patchJson: input.patchJson,
          evidenceJson: jsonOrDefault(input.evidenceJson, "{}"),
          ...(status === "reverted" ? { revertedAt: now } : {}),
          decisionNote: input.decisionNote ?? null,
        },
      });
      if (status === "applied" || status === "auto_accepted") {
        const evidenceJson = await this.applyStatePatch(tx, created, now);
        return tx.statePatch.update({
          where: { id: created.id },
          data: {
            appliedAt: now,
            evidenceJson,
            decisionNote: input.decisionNote ?? (status === "auto_accepted" ? "state_patch_auto_accepted" : "state_patch_applied"),
          },
        });
      }
      return created;
    });
    return toStatePatch(row);
  }

  async listStatePatches(filters: {
    novelId?: string;
    chapterId?: string;
    status?: string;
    reviewGateResultId?: string;
    limit?: number;
  }): Promise<StatePatch[]> {
    const rows = await prisma.statePatch.findMany({
      where: {
        ...(filters.novelId ? { novelId: filters.novelId } : {}),
        ...(filters.chapterId ? { chapterId: filters.chapterId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.reviewGateResultId ? { reviewGateResultId: filters.reviewGateResultId } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(filters.limit ?? 50, 100)),
    });
    return rows.map(toStatePatch);
  }

  async updateStatePatch(id: string, patch: {
    status: StatePatchStatus | string;
    decisionNote?: string | null;
  }): Promise<StatePatch> {
    const now = new Date();
    const row = await prisma.$transaction(async (tx) => {
      const current = await tx.statePatch.findUnique({ where: { id } });
      if (!current) {
        throw new AppError("StatePatch 不存在。", 404, { id });
      }
      assertStatePatchTransition(current.status, patch.status);

      if (patch.status === "accepted" || patch.status === "applied" || patch.status === "auto_accepted") {
        const evidenceJson = await this.applyStatePatch(tx, current, now);
        const updated = await tx.statePatch.update({
          where: { id },
          data: {
            status: patch.status,
            appliedAt: now,
            revertedAt: null,
            evidenceJson,
            decisionNote: patch.decisionNote ?? (patch.status === "auto_accepted" ? "state_patch_auto_accepted" : "state_patch_applied"),
          },
        });
        await this.closeStatePatchCheckpoints(tx, current, `state_patch_${patch.status}`, now);
        return updated;
      }

      if (patch.status === "reverted") {
        const evidenceJson = await this.revertStatePatch(tx, current, now);
        const updated = await tx.statePatch.update({
          where: { id },
          data: {
            status: "reverted",
            revertedAt: now,
            evidenceJson,
            decisionNote: patch.decisionNote ?? "state_patch_reverted",
          },
        });
        await this.closeStatePatchCheckpoints(tx, current, "state_patch_reverted", now);
        return updated;
      }

      const updated = await tx.statePatch.update({
        where: { id },
        data: {
          status: patch.status,
          decisionNote: patch.decisionNote ?? null,
        },
      });
      if (patch.status === "rejected") {
        await this.closeStatePatchCheckpoints(tx, current, "state_patch_rejected", now);
      }
      return updated;
    });
    return toStatePatch(row);
  }

  private async closeStatePatchCheckpoints(
    tx: Prisma.TransactionClient,
    row: StatePatchRow,
    status: string,
    resolvedAt: Date,
  ): Promise<void> {
    await tx.workbenchCheckpoint.updateMany({
      where: {
        status: "open",
        OR: [
          { statePatchId: row.id },
          ...(row.reviewGateResultId ? [{ reviewGateResultId: row.reviewGateResultId }] : []),
        ],
      },
      data: {
        status,
        resolvedAt,
      },
    });
  }

  private async applyStatePatch(
    tx: Prisma.TransactionClient,
    row: StatePatchRow,
    now: Date,
  ): Promise<string> {
    if (row.targetType !== "chapter" || row.patchType !== "chapter_review_lifecycle") {
      throw new AppError("当前只支持应用章节生命周期 StatePatch。", 400, {
        targetType: row.targetType,
        patchType: row.patchType,
      });
    }
    const chapterId = row.targetId ?? row.chapterId;
    if (!chapterId) {
      throw new AppError("章节生命周期 StatePatch 缺少 targetId/chapterId。", 400, { statePatchId: row.id });
    }
    const targetPatch = normalizeChapterLifecyclePatch(row.patchJson);
    const chapter = await tx.chapter.findFirst({
      where: { id: chapterId, novelId: row.novelId },
      select: { id: true, generationState: true, chapterStatus: true },
    });
    if (!chapter) {
      throw new AppError("StatePatch 目标章节不存在。", 404, { statePatchId: row.id, chapterId });
    }

    await tx.chapter.update({
      where: { id: chapter.id },
      data: targetPatch,
    });

    return mergeStatePatchEvidence(row.evidenceJson, {
      status: "applied",
      appliedAt: now.toISOString(),
      targetType: "chapter",
      targetId: chapter.id,
      before: {
        generationState: chapter.generationState,
        chapterStatus: chapter.chapterStatus,
      },
      after: targetPatch,
    });
  }

  private async revertStatePatch(
    tx: Prisma.TransactionClient,
    row: StatePatchRow,
    now: Date,
  ): Promise<string> {
    if (row.targetType !== "chapter" || row.patchType !== "chapter_review_lifecycle") {
      throw new AppError("当前只支持撤销章节生命周期 StatePatch。", 400, {
        targetType: row.targetType,
        patchType: row.patchType,
      });
    }
    const before = getChapterLifecycleBeforeFromEvidence(row.evidenceJson);
    if (!before) {
      throw new AppError("StatePatch 缺少可撤销的旧章节状态。", 400, { statePatchId: row.id });
    }
    const chapterId = row.targetId ?? row.chapterId;
    if (!chapterId) {
      throw new AppError("章节生命周期 StatePatch 缺少 targetId/chapterId。", 400, { statePatchId: row.id });
    }
    const chapter = await tx.chapter.findFirst({
      where: { id: chapterId, novelId: row.novelId },
      select: { id: true },
    });
    if (!chapter) {
      throw new AppError("StatePatch 目标章节不存在，无法撤销。", 404, { statePatchId: row.id, chapterId });
    }

    await tx.chapter.update({
      where: { id: chapter.id },
      data: before,
    });

    const evidence = parseJsonRecord(row.evidenceJson);
    const application = parseJsonRecord(JSON.stringify(evidence.application ?? {}));
    return JSON.stringify({
      ...evidence,
      application: {
        ...application,
        status: "reverted",
        revertedAt: now.toISOString(),
        restored: before,
      },
    });
  }

  async registerSkill(input: {
    slug: string;
    name: string;
    category: string;
    description?: string | null;
    sourceType?: string;
    defaultEnabled?: boolean;
    priority?: number;
    conflictKeysJson?: string;
    metadataJson?: string;
    version: string;
    manifestJson: string;
    promptHooksJson?: string;
    reviewGateChecksJson?: string;
    checksum?: string | null;
  }): Promise<{ skill: Skill; version: SkillVersion }> {
    const result = await prisma.$transaction(async (tx) => {
      const skill = await tx.skill.upsert({
        where: { slug: input.slug },
        create: {
          slug: input.slug,
          name: input.name,
          category: input.category,
          description: input.description ?? null,
          sourceType: input.sourceType ?? "local",
          defaultEnabled: input.defaultEnabled ?? false,
          priority: input.priority ?? 100,
          conflictKeysJson: jsonOrDefault(input.conflictKeysJson, "[]"),
          metadataJson: jsonOrDefault(input.metadataJson, "{}"),
        },
        update: {
          name: input.name,
          category: input.category,
          description: input.description ?? null,
          sourceType: input.sourceType ?? "local",
          defaultEnabled: input.defaultEnabled ?? false,
          priority: input.priority ?? 100,
          conflictKeysJson: jsonOrDefault(input.conflictKeysJson, "[]"),
          metadataJson: jsonOrDefault(input.metadataJson, "{}"),
        },
      });
      const version = await tx.skillVersion.upsert({
        where: {
          skillId_version: {
            skillId: skill.id,
            version: input.version,
          },
        },
        create: {
          skillId: skill.id,
          version: input.version,
          manifestJson: input.manifestJson,
          promptHooksJson: jsonOrDefault(input.promptHooksJson, "{}"),
          reviewGateChecksJson: jsonOrDefault(input.reviewGateChecksJson, "[]"),
          checksum: input.checksum ?? null,
        },
        update: {
          status: "active",
          manifestJson: input.manifestJson,
          promptHooksJson: jsonOrDefault(input.promptHooksJson, "{}"),
          reviewGateChecksJson: jsonOrDefault(input.reviewGateChecksJson, "[]"),
          checksum: input.checksum ?? null,
        },
      });
      return { skill, version };
    });
    return {
      skill: toSkill(result.skill),
      version: toSkillVersion(result.version),
    };
  }

  async listSkills(filters: { category?: string; sourceType?: string; limit?: number }): Promise<Skill[]> {
    await localSkillRegistryService.syncLocalSkills();
    const rows = await prisma.skill.findMany({
      where: {
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
      },
      include: {
        versions: {
          where: { status: "active" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      take: Math.max(1, Math.min(filters.limit ?? 100, 200)),
    });
    return rows.map(toSkill);
  }

  async listProjectSkills(novelId: string): Promise<ProjectSkill[]> {
    await localSkillRegistryService.syncLocalSkills();
    const rows = await prisma.projectSkill.findMany({
      where: { novelId },
      include: {
        skill: true,
        skillVersion: true,
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(toProjectSkill);
  }

  async setProjectSkill(input: {
    novelId: string;
    skillId: string;
    skillVersionId?: string | null;
    enabled?: boolean;
    priority?: number;
    configJson?: string;
    conflictStatus?: string;
    conflictJson?: string;
  }): Promise<ProjectSkill> {
    await localSkillRegistryService.syncLocalSkills();
    const enabled = input.enabled ?? true;
    const skill = await prisma.skill.findUnique({ where: { id: input.skillId } });
    await prisma.projectSkill.upsert({
      where: {
        novelId_skillId: {
          novelId: input.novelId,
          skillId: input.skillId,
        },
      },
      create: {
        novelId: input.novelId,
        skillId: input.skillId,
        skillVersionId: input.skillVersionId ?? null,
        enabled,
        priority: input.priority ?? skill?.priority ?? 100,
        configJson: jsonOrDefault(input.configJson, "{}"),
        conflictStatus: input.conflictStatus ?? (enabled ? "ok" : "disabled"),
        conflictJson: input.conflictJson !== undefined ? jsonOrDefault(input.conflictJson, "[]") : "[]",
      },
      update: {
        ...(input.skillVersionId !== undefined ? { skillVersionId: input.skillVersionId } : {}),
        enabled,
        ...(typeof input.priority === "number" ? { priority: input.priority } : {}),
        ...(input.configJson !== undefined ? { configJson: jsonOrDefault(input.configJson, "{}") } : {}),
        conflictStatus: input.conflictStatus ?? (enabled ? "ok" : "disabled"),
        conflictJson: input.conflictJson !== undefined ? jsonOrDefault(input.conflictJson, "[]") : "[]",
      },
    });

    if (input.conflictStatus === undefined && input.conflictJson === undefined) {
      await this.recalculateProjectSkillConflicts(input.novelId);
    }

    const row = await prisma.projectSkill.findUnique({
      where: {
        novelId_skillId: {
          novelId: input.novelId,
          skillId: input.skillId,
        },
      },
      include: {
        skill: true,
        skillVersion: true,
      },
    });
    if (!row) {
      throw new AppError("项目 Skill 更新后未找到记录。", 500, { novelId: input.novelId, skillId: input.skillId });
    }
    return toProjectSkill(row);
  }

  private async recalculateProjectSkillConflicts(novelId: string): Promise<void> {
    const rows = await prisma.projectSkill.findMany({
      where: { novelId },
      include: {
        skill: true,
        skillVersion: true,
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
    const activeRows = rows.filter((row) => row.enabled);
    const conflictsByProjectSkillId = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      conflictsByProjectSkillId.set(row.id, []);
    }

    for (let leftIndex = 0; leftIndex < activeRows.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < activeRows.length; rightIndex += 1) {
        const left = activeRows[leftIndex];
        const right = activeRows[rightIndex];
        const conflictKeyOverlap = intersectStrings(
          parseStringArrayJson(left.skill?.conflictKeysJson),
          parseStringArrayJson(right.skill?.conflictKeysJson),
        );
        if (conflictKeyOverlap.length > 0) {
          conflictsByProjectSkillId.get(left.id)?.push({
            type: "conflict_key_overlap",
            severity: "warning",
            skillId: right.skillId,
            skillName: right.skill?.name ?? right.skillId,
            conflictKeys: conflictKeyOverlap,
          });
          conflictsByProjectSkillId.get(right.id)?.push({
            type: "conflict_key_overlap",
            severity: "warning",
            skillId: left.skillId,
            skillName: left.skill?.name ?? left.skillId,
            conflictKeys: conflictKeyOverlap,
          });
        }

        const leftStateFields = readSkillStateRequirements(left);
        const rightStateFieldByNormalized = new Map(
          readSkillStateRequirements(right).map((field) => [normalizeSkillStateField(field), field]),
        );
        const stateFieldOverlap = leftStateFields
          .map((field) => rightStateFieldByNormalized.get(normalizeSkillStateField(field)) ? field : null)
          .filter((field): field is string => Boolean(field));
        if (stateFieldOverlap.length > 0) {
          conflictsByProjectSkillId.get(left.id)?.push({
            type: "state_schema_field_overlap",
            severity: "warning",
            skillId: right.skillId,
            skillName: right.skill?.name ?? right.skillId,
            stateFields: stateFieldOverlap,
            recommendation: "确认这些状态字段由哪个 Skill 主导，或在配置中明确合并语义。",
          });
          conflictsByProjectSkillId.get(right.id)?.push({
            type: "state_schema_field_overlap",
            severity: "warning",
            skillId: left.skillId,
            skillName: left.skill?.name ?? left.skillId,
            stateFields: stateFieldOverlap,
            recommendation: "确认这些状态字段由哪个 Skill 主导，或在配置中明确合并语义。",
          });
        }
      }
    }

    await prisma.$transaction(rows.map((row) => {
      const conflicts = conflictsByProjectSkillId.get(row.id) ?? [];
      return prisma.projectSkill.update({
        where: { id: row.id },
        data: {
          conflictStatus: row.enabled ? conflicts.length > 0 ? "warning" : "ok" : "disabled",
          conflictJson: JSON.stringify(conflicts),
        },
      });
    }));
  }

  async getProductionChainSnapshot(filters: {
    novelId?: string;
    chapterId?: string;
    limit?: number;
  }): Promise<ProductionChainSnapshot> {
    const limit = Math.max(1, Math.min(filters.limit ?? 25, 100));
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [agentRuns, batchJobs, checkpoints, modelCallLogs, reviewGateResults, statePatches] = await Promise.all([
      prisma.agentRun.findMany({
        where: {
          ...(filters.novelId ? { novelId: filters.novelId } : {}),
          ...(filters.chapterId ? { chapterId: filters.chapterId } : {}),
        },
        include: {
          steps: {
            select: {
              id: true,
              seq: true,
              agentName: true,
              stepType: true,
              status: true,
              inputJson: true,
              outputJson: true,
              error: true,
              provider: true,
              model: true,
              createdAt: true,
            },
            orderBy: { seq: "asc" },
            take: 12,
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      this.listBatchJobs({ novelId: filters.novelId, limit }),
      this.listCheckpoints({ novelId: filters.novelId, limit }),
      this.listModelCallLogs({ novelId: filters.novelId, limit }),
      this.listReviewGateResults({ novelId: filters.novelId, chapterId: filters.chapterId, limit }),
      this.listStatePatches({ novelId: filters.novelId, chapterId: filters.chapterId, limit }),
    ]);
    const [todayModelUsage, projectTotalModelUsage] = await Promise.all([
      this.summarizeModelCallWhere(
        "today",
        filters.novelId ? "今日用量（当前项目）" : "今日用量",
        {
          ...(filters.novelId ? { novelId: filters.novelId } : {}),
          createdAt: { gte: todayStart },
        },
      ),
      filters.novelId
        ? this.summarizeModelCallWhere(
          "project_total",
          "当前项目总计",
          { novelId: filters.novelId },
        )
        : Promise.resolve(createEmptyModelUsageSummary("project_total", "当前项目总计", false)),
    ]);
    return {
      agentRuns: agentRuns.map((run) => ({
        id: run.id,
        novelId: run.novelId,
        chapterId: run.chapterId,
        status: run.status,
        goal: run.goal,
        entryAgent: run.entryAgent,
        currentStep: run.currentStep,
        currentAgent: run.currentAgent,
        roleCoverage: Array.from(new Set(run.steps.map((step) => step.agentName))),
        steps: run.steps.map((step) => ({
          id: step.id,
          seq: step.seq,
          agentName: step.agentName,
          stepType: step.stepType,
          status: step.status,
          inputJson: compactJsonText(step.inputJson),
          outputJson: compactJsonText(step.outputJson),
          error: step.error,
          provider: step.provider,
          model: step.model,
          createdAt: step.createdAt.toISOString(),
        })),
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      })),
      batchJobs,
      checkpoints,
      modelCallLogs,
      modelUsageSummary: {
        currentFilter: summarizeModelCallLogs("current_filter", "当前列表", modelCallLogs),
        today: todayModelUsage,
        projectTotal: projectTotalModelUsage,
      },
      reviewGateResults,
      statePatches,
    };
  }
}

export const aiWorkbenchService = new AiWorkbenchService();
