import type {
  ContinuationContextSnapshot,
  ContinuationContextRecallHit,
  ContinuationGenerationResult,
  ContinuationWorkbenchMode,
} from "@ai-novel/shared/types/aiWorkbench";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { createQualityReport } from "../novel/novelCoreReviewService";
import { ChapterRuntimeCoordinator } from "../novel/runtime/ChapterRuntimeCoordinator";
import type { PipelineRuntimeInput, PipelineRuntimeResult } from "../novel/runtime/chapterRuntimePipeline";
import { aiWorkbenchAgentRunLogger } from "./AiWorkbenchAgentRunLogger";
import { continuationWorkbenchService } from "./ContinuationWorkbenchService";
import {
  skillRuntimeContextService,
  summarizeActiveSkillsForAgentLog,
} from "./SkillRuntimeContextService";

const CONTINUATION_SOURCE_TYPES = ["continuation_source", "novel_import"];
const DEFAULT_TARGET_WORD_COUNT = 2200;
const MAX_IMPORTED_CHARACTER_SEEDS = 6;

export interface GenerateContinuationChapterInput {
  novelId: string;
  targetChapterOrder?: number | null;
  mode?: ContinuationWorkbenchMode | string | null;
  positionCorpusId?: string | null;
  positionChapterIndex?: number | null;
  positionParagraphIndex?: number | null;
  positionAnchorText?: string | null;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  targetWordCount?: number | null;
  maxRetries?: number;
  autoReview?: boolean;
  autoRepair?: boolean;
  qualityThreshold?: number;
  repairMode?: PipelineRuntimeInput["repairMode"];
  artifactSyncMode?: PipelineRuntimeInput["artifactSyncMode"];
}

function normalizeMode(value: GenerateContinuationChapterInput["mode"]): ContinuationWorkbenchMode {
  if (value === "position" || value === "outline" || value === "style") {
    return value;
  }
  return "direct";
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

function compactContinuationText(value: string | null | undefined, limit = 360): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function formatChapterLabel(hit: ContinuationContextRecallHit): string {
  if (typeof hit.chapterIndex !== "number") {
    return hit.chunkType;
  }
  return `${hit.chunkType} / 原文第 ${hit.chapterIndex + 1} 章`;
}

function summarizeContinuationRecallHits(recallHits: ContinuationContextRecallHit[], limit = 4) {
  return recallHits.slice(0, limit).map((hit) => ({
    id: hit.id,
    ownerType: "reference_corpus",
    ownerId: hit.corpusId,
    title: hit.title ?? hit.corpusTitle,
    source: hit.source ?? "structured",
    score: null,
    chunkOrder: hit.chunkOrder,
    snippet: compactContinuationText(hit.summary || hit.text, 180),
    contextPrefix: [
      hit.corpusTitle,
      formatChapterLabel(hit),
      hit.reason,
    ].filter(Boolean).join(" | "),
  }));
}

function buildContinuationRecallExpectationBlock(context?: ContinuationContextSnapshot): string {
  const hits = context?.recallHits.slice(0, 8) ?? [];
  if (hits.length === 0) {
    return "";
  }
  return [
    "【续写召回片段】以下片段必须作为本章连续性和风格参考；优先保持人物状态、地点、核心冲突、未解伏笔和叙事节奏，不得照抄原文。",
    ...hits.map((hit, index) => {
      const source = hit.source ?? "structured";
      const label = formatChapterLabel(hit);
      const body = compactContinuationText(hit.summary || hit.text, 420);
      return `[REF-${index + 1}] (${source}) ${hit.corpusTitle} | ${label} | ${hit.reason}\n${body}`;
    }),
  ].join("\n");
}

function appendContinuationRecallBlock(expectation: string, context?: ContinuationContextSnapshot): string {
  const recallBlock = buildContinuationRecallExpectationBlock(context);
  return [expectation, recallBlock].filter((item) => item.trim().length > 0).join("\n\n");
}

function compactAgentRagReference<T extends { snippet?: string; contextPrefix?: string | null }>(reference: T): T {
  return {
    ...reference,
    snippet: compactContinuationText(reference.snippet, 180),
    contextPrefix: reference.contextPrefix ? compactContinuationText(reference.contextPrefix, 180) : reference.contextPrefix,
  };
}

function normalizeImportedCharacterName(value: string): string | null {
  const normalized = value.replace(/[^\u4e00-\u9fa5·]/g, "").trim();
  if (normalized.length < 2 || normalized.length > 4) {
    return null;
  }
  const blocked = new Set([
    "档案室",
    "档案科",
    "卷宗",
    "铁柜",
    "脚步声",
    "门把手",
    "监控",
    "内网",
    "小楼",
  ]);
  const prefixBlocked = [
    "和",
    "与",
    "同",
    "向",
    "对",
    "被",
    "把",
    "听见",
    "看见",
    "发现",
    "知道",
    "转身",
    "抬头",
    "低头",
  ];
  const suffixBlocked = [
    "上",
    "下",
    "里",
    "中",
    "内",
    "外",
    "前",
    "后",
    "旁",
    "边",
    "时",
    "处",
    "室",
    "路",
    "街",
    "门",
    "号",
    "楼",
    "柜",
    "卡",
    "页",
    "线",
    "迹",
    "声",
    "孔",
  ];
  const containsBlocked = ["在", "把", "被", "将", "从", "到"];
  if (blocked.has(normalized)) {
    return null;
  }
  if (prefixBlocked.some((prefix) => normalized.startsWith(prefix))) {
    return null;
  }
  if (suffixBlocked.some((suffix) => normalized.endsWith(suffix))) {
    return null;
  }
  if (containsBlocked.some((token) => normalized.includes(token))) {
    return null;
  }
  return normalized;
}

function uniqueImportedCharacterNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const normalized = normalizeImportedCharacterName(name);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= MAX_IMPORTED_CHARACTER_SEEDS) {
      break;
    }
  }
  return result;
}

export class ContinuationGenerationService {
  private readonly coordinator = new ChapterRuntimeCoordinator();

  async generateChapter(input: GenerateContinuationChapterInput): Promise<ContinuationGenerationResult> {
    const novel = await prisma.novel.findUnique({
      where: { id: input.novelId },
      select: { id: true },
    });
    if (!novel) {
      throw new AppError("小说不存在。", 404, { novelId: input.novelId });
    }

    const mode = normalizeMode(input.mode);
    this.assertValidPositionInput({ mode, input });
    const targetOrder = await this.resolveTargetChapterOrder(input.novelId, input.targetChapterOrder);
    const contextBeforeRun = await continuationWorkbenchService.buildSnapshot({
      novelId: input.novelId,
      chapterOrder: targetOrder,
      mode,
      positionCorpusId: input.positionCorpusId,
      positionChapterIndex: input.positionChapterIndex,
      positionParagraphIndex: input.positionParagraphIndex,
      positionAnchorText: input.positionAnchorText,
    });
    const importedCharacterSeed = await this.seedImportedCharactersIfMissing(input.novelId);
    const activeSkills = await skillRuntimeContextService.getActiveSkills(input.novelId).catch(() => []);
    const activeSkillSummary = summarizeActiveSkillsForAgentLog(activeSkills);
    if (!contextBeforeRun.continuation.enabled) {
      throw new AppError("当前小说缺少可用续写源，请先导入 Reference Corpus 或绑定续写来源。", 400, {
        novelId: input.novelId,
        targetChapterOrder: targetOrder,
      });
    }

    const chapter = await this.ensureTargetChapter({
      novelId: input.novelId,
      targetOrder,
      targetWordCount: input.targetWordCount ?? DEFAULT_TARGET_WORD_COUNT,
      mode,
      continuationContext: contextBeforeRun,
    });
    const agentRunId = await aiWorkbenchAgentRunLogger.startRun({
      novelId: input.novelId,
      chapterId: chapter.id,
      sessionId: `ai-workbench:continuation:${input.novelId}:${chapter.id}:${Date.now()}`,
      goal: `续写第 ${targetOrder} 章`,
      metadata: {
        mode,
        targetChapterOrder: targetOrder,
        positionAnchor: contextBeforeRun.positionAnchor,
        outlineContext: contextBeforeRun.outlineContext,
        styleContext: contextBeforeRun.styleContext,
        referenceCorpusCount: contextBeforeRun.referenceCorpora.length,
        recallHitCount: contextBeforeRun.recallHits.length,
      },
    });

    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Planner",
      input: {
        mode,
        targetChapterOrder: targetOrder,
        positionCorpusId: input.positionCorpusId ?? null,
        positionChapterIndex: input.positionChapterIndex ?? null,
        positionParagraphIndex: input.positionParagraphIndex ?? null,
      },
      output: {
        chapterId: chapter.id,
        title: chapter.title,
        positionAnchor: contextBeforeRun.positionAnchor,
        styleContext: contextBeforeRun.styleContext,
      },
      provider: input.provider,
      model: input.model,
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "ContextBuilder",
      input: {
        novelId: input.novelId,
        chapterOrder: targetOrder,
        mode,
        positionAnchor: contextBeforeRun.positionAnchor,
        outlineContext: contextBeforeRun.outlineContext,
        styleContext: contextBeforeRun.styleContext,
      },
      output: {
        continuationEnabled: contextBeforeRun.continuation.enabled,
        referenceCorpusCount: contextBeforeRun.referenceCorpora.length,
        recallHitCount: contextBeforeRun.recallHits.length,
        activeSkills: activeSkillSummary,
        importedCharacterSeed,
        stateRequirementCount: activeSkills.reduce((sum, skill) => sum + skill.stateRequirements.length, 0),
        reviewGateCheckCount: activeSkills.reduce((sum, skill) => sum + skill.reviewGateChecks.length, 0),
        riskTriggerCount: activeSkills.reduce((sum, skill) => sum + skill.riskTriggers.length, 0),
      },
      provider: input.provider,
      model: input.model,
    });
    let result: PipelineRuntimeResult;
    try {
      result = await this.coordinator.runPipelineChapter(
        input.novelId,
        chapter.id,
        {
          provider: input.provider,
          model: input.model,
          temperature: input.temperature,
          maxRetries: input.maxRetries ?? 1,
          autoReview: input.autoReview ?? true,
          autoRepair: input.autoRepair ?? true,
          qualityThreshold: input.qualityThreshold ?? 75,
          repairMode: input.repairMode ?? "light_repair",
          artifactSyncMode: input.artifactSyncMode ?? "adaptive",
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await aiWorkbenchAgentRunLogger.addStep({
        runId: agentRunId,
        role: "Writer",
        status: "failed",
        input: { novelId: input.novelId, chapterId: chapter.id, mode },
        error: message,
        provider: input.provider,
        model: input.model,
      }).catch(() => undefined);
      await aiWorkbenchAgentRunLogger.finishRun({ runId: agentRunId, status: "failed", error: message }).catch(() => undefined);
      throw error;
    }
    const runtimeRagReferences = (result.runtimePackage?.context.ragReferences.slice(0, 4) ?? [])
      .map((reference) => compactAgentRagReference(reference));
    const workbenchRecallReferences = summarizeContinuationRecallHits(contextBeforeRun.recallHits, 4);
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Writer",
      input: { novelId: input.novelId, chapterId: chapter.id, mode },
      output: {
        contentLength: result.runtimePackage?.draft.content.length ?? null,
        retryCountUsed: result.retryCountUsed,
        appliedSkillPromptHooks: summarizeActiveSkillsForAgentLog(result.runtimePackage?.context.activeSkills ?? activeSkills),
        ragReferenceCount: (result.runtimePackage?.context.ragReferences.length ?? 0) + contextBeforeRun.recallHits.length,
        ragReferences: [
          ...runtimeRagReferences,
          ...workbenchRecallReferences,
        ].slice(0, 8),
        runtimeRagReferenceCount: result.runtimePackage?.context.ragReferences.length ?? 0,
        workbenchRecallCount: contextBeforeRun.recallHits.length,
        workbenchRecallReferences,
      },
      provider: input.provider,
      model: input.model,
    });

    const sourceType = result.retryCountUsed > 0
      ? "continuation_repair_recheck"
      : "continuation_pipeline_review";
    if (result.reviewExecuted) {
      await createQualityReport(input.novelId, chapter.id, result.score, result.issues, {
        sourceType,
        contentLength: result.runtimePackage?.draft.content.length ?? (chapter.content ?? "").length,
        agentRunId,
      });
    }

    const [updatedChapter, reviewGateResult] = await Promise.all([
      prisma.chapter.findFirst({
        where: { id: chapter.id, novelId: input.novelId },
        select: {
          id: true,
          novelId: true,
          order: true,
          title: true,
          generationState: true,
          chapterStatus: true,
          targetWordCount: true,
          content: true,
          updatedAt: true,
        },
      }),
      result.reviewExecuted
        ? prisma.reviewGateResult.findFirst({
          where: {
            novelId: input.novelId,
            chapterId: chapter.id,
            sourceType: { in: ["continuation_pipeline_review", "continuation_repair_recheck"] },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
        : Promise.resolve(null),
    ]);
    if (!updatedChapter) {
      await aiWorkbenchAgentRunLogger.finishRun({ runId: agentRunId, status: "failed", error: "续写章节生成后未找到章节记录。" }).catch(() => undefined);
      throw new AppError("续写章节生成后未找到章节记录。", 500, { novelId: input.novelId, chapterId: chapter.id });
    }
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Reviewer",
      input: { novelId: input.novelId, chapterId: chapter.id, reviewGateResultId: reviewGateResult?.id ?? null },
      output: {
        reviewExecuted: result.reviewExecuted,
        pass: result.pass,
        needsHumanConfirmation: reviewGateResult?.needsHumanConfirmation ?? null,
        recommendedAction: reviewGateResult?.recommendedAction ?? null,
      },
      provider: input.provider,
      model: input.model,
    });
    await aiWorkbenchAgentRunLogger.finishRun({
      runId: agentRunId,
      status: reviewGateResult?.needsHumanConfirmation ? "waiting_approval" : "succeeded",
    });

    const statePatches = reviewGateResult
      ? await prisma.statePatch.findMany({
        where: { reviewGateResultId: reviewGateResult.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
      })
      : [];
    const continuationContext = await continuationWorkbenchService.buildSnapshot({
      novelId: input.novelId,
      chapterOrder: updatedChapter.order,
      mode,
      positionCorpusId: input.positionCorpusId,
      positionChapterIndex: input.positionChapterIndex,
      positionParagraphIndex: input.positionParagraphIndex,
      positionAnchorText: input.positionAnchorText,
    });

    return {
      chapter: {
        id: updatedChapter.id,
        novelId: updatedChapter.novelId,
        order: updatedChapter.order,
        title: updatedChapter.title,
        generationState: updatedChapter.generationState,
        chapterStatus: updatedChapter.chapterStatus,
        targetWordCount: updatedChapter.targetWordCount,
        contentLength: (updatedChapter.content ?? "").length,
        updatedAt: updatedChapter.updatedAt.toISOString(),
      },
      runtime: {
        agentRunId,
        reviewExecuted: result.reviewExecuted,
        pass: result.pass,
        retryCountUsed: result.retryCountUsed,
        sourceType,
      },
      reviewGateResult: reviewGateResult
        ? {
          id: reviewGateResult.id,
          sourceType: reviewGateResult.sourceType,
          pass: reviewGateResult.pass,
          needsHumanConfirmation: reviewGateResult.needsHumanConfirmation,
          recommendedAction: reviewGateResult.recommendedAction,
          createdAt: reviewGateResult.createdAt.toISOString(),
          updatedAt: reviewGateResult.updatedAt.toISOString(),
        }
        : null,
      statePatches: statePatches.map((patch) => ({
        id: patch.id,
        targetType: patch.targetType,
        patchType: patch.patchType,
        status: patch.status,
        riskLevel: patch.riskLevel,
        createdAt: patch.createdAt.toISOString(),
        updatedAt: patch.updatedAt.toISOString(),
      })),
      continuationContext,
    };
  }

  private async seedImportedCharactersIfMissing(novelId: string): Promise<{
    createdCount: number;
    names: string[];
    source: string;
  }> {
    const existingCount = await prisma.character.count({ where: { novelId } });
    if (existingCount > 0) {
      return { createdCount: 0, names: [], source: "existing_characters" };
    }
    const corpora = await prisma.referenceCorpus.findMany({
      where: {
        novelId,
        status: "active",
        sourceType: { in: CONTINUATION_SOURCE_TYPES },
      },
      select: {
        title: true,
        extractionJson: true,
        chunks: {
          where: { chunkType: "entity_candidate" },
          select: { extractionJson: true },
          take: 5,
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 5,
    });
    const names = uniqueImportedCharacterNames(corpora.flatMap((corpus) => [
      ...readStringArray(parseJsonRecord(corpus.extractionJson).characters),
      ...corpus.chunks.flatMap((chunk) => readStringArray(parseJsonRecord(chunk.extractionJson).characters)),
    ]));
    if (names.length === 0) {
      return { createdCount: 0, names: [], source: "no_imported_character_candidates" };
    }
    await prisma.character.createMany({
      data: names.map((name, index) => ({
        novelId,
        name,
        role: index === 0 ? "protagonist" : "imported_character",
        gender: "unknown",
        storyFunction: index === 0 ? "从导入续写语料自动识别的核心视角角色。" : "从导入续写语料自动识别的相关角色。",
        currentState: "从导入续写语料识别，待后续章节生成和 ReviewGate 校准。",
        currentGoal: "保持与导入前文一致。",
        availability: "active",
        prohibitionsJson: JSON.stringify(["auto_seeded_from_reference_corpus", "requires_review_after_generation"]),
      })),
    });
    return { createdCount: names.length, names, source: "reference_corpus_entity_candidates" };
  }

  private async resolveTargetChapterOrder(novelId: string, explicitOrder?: number | null): Promise<number> {
    if (typeof explicitOrder === "number") {
      if (!Number.isInteger(explicitOrder) || explicitOrder < 1) {
        throw new AppError("目标章节号必须是正整数。", 400, { targetChapterOrder: explicitOrder });
      }
      return explicitOrder;
    }
    const [latestExistingChapter, latestReferenceChapter] = await Promise.all([
      prisma.chapter.findFirst({
        where: { novelId },
        orderBy: [{ order: "desc" }, { id: "desc" }],
        select: { order: true },
      }),
      prisma.referenceChunk.findFirst({
        where: {
          chunkType: "chapter",
          chapterIndex: { not: null },
          corpus: {
            novelId,
            status: "active",
            sourceType: { in: CONTINUATION_SOURCE_TYPES },
          },
        },
        orderBy: [{ chapterIndex: "desc" }, { chunkOrder: "desc" }],
        select: { chapterIndex: true },
      }),
    ]);
    const nextFromExisting = latestExistingChapter ? latestExistingChapter.order + 1 : 1;
    const nextFromReference = typeof latestReferenceChapter?.chapterIndex === "number"
      ? latestReferenceChapter.chapterIndex + 2
      : 1;
    return Math.max(nextFromExisting, nextFromReference, 1);
  }

  private assertValidPositionInput(input: {
    mode: ContinuationWorkbenchMode;
    input: GenerateContinuationChapterInput;
  }) {
    if (input.mode !== "position") {
      return;
    }
    const hasPosition =
      Boolean(input.input.positionCorpusId?.trim())
      || typeof input.input.positionChapterIndex === "number"
      || typeof input.input.positionParagraphIndex === "number"
      || Boolean(input.input.positionAnchorText?.trim());
    if (!hasPosition) {
      throw new AppError("指定位置续写需要提供语料、章节、段落或锚点文本。", 400);
    }
  }

  private async ensureTargetChapter(input: {
    novelId: string;
    targetOrder: number;
    targetWordCount: number;
    mode: ContinuationWorkbenchMode;
    continuationContext: ContinuationContextSnapshot;
  }) {
    const expectation = this.buildContinuationExpectation(input.mode, input.continuationContext);
    const existing = await prisma.chapter.findFirst({
      where: {
        novelId: input.novelId,
        order: input.targetOrder,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    if (existing) {
      const canRefreshExpectation = !(existing.content ?? "").trim();
      if ((existing.targetWordCount == null && input.targetWordCount) || canRefreshExpectation || !existing.expectation?.trim()) {
        return prisma.chapter.update({
          where: { id: existing.id },
          data: {
            targetWordCount: existing.targetWordCount ?? input.targetWordCount,
            expectation: canRefreshExpectation || !existing.expectation?.trim() ? expectation : existing.expectation,
          },
        });
      }
      return existing;
    }
    return prisma.chapter.create({
      data: {
        novelId: input.novelId,
        order: input.targetOrder,
        title: `第${input.targetOrder}章 续写`,
        content: "",
        expectation,
        chapterStatus: "pending_generation",
        generationState: "planned",
        targetWordCount: input.targetWordCount,
      },
    });
  }

  private buildContinuationExpectation(mode: ContinuationWorkbenchMode, continuationContext?: ContinuationContextSnapshot): string {
    if (mode === "position") {
      return appendContinuationRecallBlock(
        "基于导入语料的指定位置续写，优先保持人物状态、地点、冲突和未解决伏笔连续。",
        continuationContext,
      );
    }
    if (mode === "outline") {
      const outline = continuationContext?.outlineContext;
      const brief = outline
        ? [
          outline.nextChapterBrief.premise,
          ...outline.nextChapterBrief.requiredContinuity.map((item) => `连续性要求：${item}`),
          ...outline.nextChapterBrief.recommendedFocus.map((item) => `本章重点：${item}`),
          ...outline.unresolvedForeshadows.slice(0, 5).map((item) => `未解伏笔：${item.title} - ${item.evidence}`),
        ].join("\n")
        : "";
      return appendContinuationRecallBlock([
        "基于导入语料反推大纲后续写，优先推进主线并保留可控伏笔。",
        brief,
      ].filter(Boolean).join("\n"), continuationContext);
    }
    if (mode === "style") {
      const style = continuationContext?.styleContext;
      const brief = style
        ? [
          `风格强度：${style.writingConstraints.styleIntensity}`,
          ...style.activeStyleProfiles.map((profile) => `StyleProfile：${profile.name}${profile.languageSummary ? `；语言=${profile.languageSummary}` : ""}${profile.rhythmSummary ? `；节奏=${profile.rhythmSummary}` : ""}`),
          ...style.styleCandidates.slice(0, 4).map((candidate) => `语料风格：${candidate.corpusTitle} - ${candidate.summary}`),
          ...style.writingConstraints.requiredContinuity.map((item) => `风格要求：${item}`),
          ...style.writingConstraints.avoidPatterns.map((item) => `避免：${item}`),
        ].join("\n")
        : "";
      return appendContinuationRecallBlock([
        "基于导入语料进行风格续写，优先保持叙述节奏、语言密度和章末钩子方式。",
        brief,
      ].filter(Boolean).join("\n"), continuationContext);
    }
    return appendContinuationRecallBlock(
      "基于导入语料紧接续写，优先保证前后情节、人物状态和设定一致。",
      continuationContext,
    );
  }
}

export const continuationGenerationService = new ContinuationGenerationService();
