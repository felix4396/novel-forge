import type {
  ContinuationContextRecallHit,
  ContinuationOutlineContext,
  ContinuationContextSnapshot,
  ContinuationPositionAnchor,
  ContinuationStyleContext,
  ContinuationWorkbenchMode,
} from "@ai-novel/shared/types/aiWorkbench";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { ragServices } from "../rag";
import type { RetrievedChunk } from "../rag/types";
import { NovelContinuationService } from "../novel/NovelContinuationService";

const CONTINUATION_SOURCE_TYPES = ["continuation_source", "novel_import"];

interface ContinuationPositionAnchorInput {
  positionCorpusId?: string | null;
  positionChapterIndex?: number | null;
  positionParagraphIndex?: number | null;
  positionAnchorText?: string | null;
}

function compactText(value: string | null | undefined, limit = 260): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeMode(value: string | null | undefined): ContinuationWorkbenchMode {
  if (value === "position" || value === "outline" || value === "style") {
    return value;
  }
  return "direct";
}

function reasonForChunk(input: {
  mode: ContinuationWorkbenchMode;
  chunkType: string;
  chapterIndex: number | null;
  paragraphIndex?: number | null;
  targetChapterOrder?: number | null;
  isPositionAnchor?: boolean;
}): string {
  if (input.isPositionAnchor) {
    const chapterLabel = typeof input.chapterIndex === "number" ? `第 ${input.chapterIndex + 1} 章` : "指定章节";
    const paragraphLabel = typeof input.paragraphIndex === "number" ? `第 ${input.paragraphIndex + 1} 段` : "指定段落";
    return `指定位置锚点：${chapterLabel}${paragraphLabel}之后续写，优先保持锚点前人物、地点、冲突和语气连续。`;
  }
  if (input.chunkType === "foreshadow_candidate") {
    return "未解决伏笔/冲突候选，续写时优先检查是否需要推进或保留。";
  }
  if (input.chunkType === "entity_candidate") {
    return "角色、地点、势力和物品候选，用于校准续写实体状态。";
  }
  if (input.chunkType === "timeline_candidate") {
    return "时间线候选，用于校准剧情顺序、最近事件和续写时间位置。";
  }
  if (input.chunkType === "style_candidate") {
    return "风格候选片段，用于辅助风格续写和 StyleProfile 校准。";
  }
  if (input.chunkType === "summary") {
    return "导入语料摘要，用于压缩承接前文主线。";
  }
  if (input.mode === "position" && typeof input.chapterIndex === "number") {
    return `指定位置续写参考：导入语料第 ${input.chapterIndex + 1} 章附近内容。`;
  }
  if (input.mode === "outline") {
    return "大纲续写参考：用于反推后续主线、冲突和未完线索。";
  }
  if (input.mode === "style") {
    return "风格续写参考：用于保留语言节奏、叙述密度和章末钩子方式。";
  }
  if (typeof input.targetChapterOrder === "number" && typeof input.chapterIndex === "number") {
    return input.chapterIndex + 1 >= input.targetChapterOrder - 2
      ? "紧接续写参考：接近目标章节的最近原文。"
      : "旧章节背景参考：用于避免角色状态和设定断裂。";
  }
  return "续写上下文参考片段。";
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

function parseJsonArrayRecord(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readRuleSummary(value: string | null | undefined): string | null {
  const parsed = parseJsonRecord(value);
  const summary = parsed.summary;
  return typeof summary === "string" && summary.trim().length > 0 ? summary.trim() : null;
}

function countJsonStringArray(value: string | null | undefined): number {
  if (!value?.trim()) {
    return 0;
  }
  try {
    const parsed = JSON.parse(value);
    return readStringArray(parsed).length;
  } catch {
    return 0;
  }
}

function buildSemanticRecallQuery(input: {
  mode: ContinuationWorkbenchMode;
  targetChapterOrder?: number | null;
  humanBlock?: string | null;
  positionAnchor?: ContinuationPositionAnchor | null;
  outlineContext?: ContinuationOutlineContext | null;
  styleContext?: ContinuationStyleContext | null;
}): string {
  const modeHint: Record<ContinuationWorkbenchMode, string> = {
    direct: "紧接续写：上一章结尾、主角状态、地点、核心冲突、未解决伏笔",
    position: "指定位置续写：续写点附近原文、人物状态、地点和冲突",
    outline: "大纲续写：主线推进、旧案线索、未解决冲突、伏笔回收",
    style: "风格续写：语言节奏、叙事密度、对话方式、章末钩子",
  };
  return [
    modeHint[input.mode],
    typeof input.targetChapterOrder === "number" ? `目标章节：第 ${input.targetChapterOrder} 章` : null,
    input.positionAnchor?.beforeText ? `指定位置前文：${compactText(input.positionAnchor.beforeText, 900)}` : null,
    input.positionAnchor?.anchorText ? `指定位置锚点：${compactText(input.positionAnchor.anchorText, 500)}` : null,
    input.outlineContext?.nextChapterBrief.premise ? `反推大纲：${compactText(input.outlineContext.nextChapterBrief.premise, 900)}` : null,
    input.outlineContext?.unresolvedForeshadows.length
      ? `未解伏笔：${input.outlineContext.unresolvedForeshadows.slice(0, 6).map((item) => item.title).join("、")}`
      : null,
    input.styleContext?.activeStyleProfiles.length
      ? `StyleProfile：${input.styleContext.activeStyleProfiles.map((item) => item.name).join("、")}`
      : null,
    input.styleContext?.styleCandidates.length
      ? `语料风格候选：${input.styleContext.styleCandidates.slice(0, 3).map((item) => item.summary).join("；")}`
      : null,
    compactText(input.humanBlock, 900),
  ].filter(Boolean).join("\n");
}

function recallHitFromRetrievedChunk(input: {
  row: RetrievedChunk;
  corpusTitleById: Map<string, string>;
  mode: ContinuationWorkbenchMode;
  targetChapterOrder?: number | null;
}): ContinuationContextRecallHit {
  const metadata = parseJsonRecord(input.row.metadataJson);
  const corpusId = typeof metadata.corpusId === "string" ? metadata.corpusId : input.row.ownerId;
  const referenceChunkId = typeof metadata.chunkId === "string" ? metadata.chunkId : input.row.id;
  const chunkType = typeof metadata.chunkType === "string" ? metadata.chunkType : "rag_chunk";
  const chapterIndex = typeof metadata.chapterIndex === "number" ? metadata.chapterIndex : null;
  const summary = typeof metadata.summary === "string" ? metadata.summary : undefined;
  return {
    id: referenceChunkId,
    corpusId,
    corpusTitle: input.corpusTitleById.get(corpusId) ?? input.row.title ?? "Reference Corpus",
    source: input.row.source,
    chunkType,
    chunkOrder: input.row.chunkOrder,
    chapterIndex,
    title: input.row.title,
    text: compactText([input.row.contextPrefix, input.row.chunkText].filter(Boolean).join("\n\n"), 520),
    summary,
    reason: `RAG ${input.row.source} 召回：${reasonForChunk({
      mode: input.mode,
      chunkType,
      chapterIndex,
      targetChapterOrder: input.targetChapterOrder,
    })}`,
  };
}

export class ContinuationWorkbenchService {
  private readonly continuationService = new NovelContinuationService();

  async buildSnapshot(input: {
    novelId: string;
    chapterOrder?: number | null;
    mode?: string | null;
    positionCorpusId?: string | null;
    positionChapterIndex?: number | null;
    positionParagraphIndex?: number | null;
    positionAnchorText?: string | null;
  }): Promise<ContinuationContextSnapshot> {
    const novel = await prisma.novel.findUnique({
      where: { id: input.novelId },
      select: { id: true },
    });
    if (!novel) {
      throw new AppError("小说不存在。", 404, { novelId: input.novelId });
    }

    const mode = normalizeMode(input.mode);
    const positionInput = this.normalizePositionInput(input);
    const [continuationPack, corpora, styleBindings] = await Promise.all([
      this.continuationService.buildChapterContextPack(input.novelId),
      prisma.referenceCorpus.findMany({
        where: {
          novelId: input.novelId,
          status: "active",
          OR: [
            { sourceType: { in: CONTINUATION_SOURCE_TYPES } },
            ...(positionInput.positionCorpusId ? [{ id: positionInput.positionCorpusId }] : []),
          ],
        },
        include: {
          _count: { select: { chunks: true } },
          chunks: {
            where: { chunkType: { in: ["chapter", "paragraph", "summary", "entity_candidate", "timeline_candidate", "foreshadow_candidate", "style_candidate"] } },
            orderBy: [{ chunkOrder: "asc" }],
            take: 800,
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 20,
      }),
      prisma.styleBinding.findMany({
        where: {
          enabled: true,
          targetType: "novel",
          targetId: input.novelId,
        },
        include: { styleProfile: true },
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        take: 10,
      }),
    ]);
    const positionAnchor = mode === "position"
      ? await this.resolvePositionAnchor({
        novelId: input.novelId,
        corpora,
        ...positionInput,
      })
      : null;
    const outlineContext = mode === "outline"
      ? this.buildOutlineContext({
        corpora,
        targetChapterOrder: input.chapterOrder ?? null,
      })
      : null;
    const styleContext = mode === "style"
      ? this.buildStyleContext({
        corpora,
        styleBindings,
      })
      : null;

    const structuredRecallHits = corpora.flatMap((corpus) => {
      const chapterChunks = corpus.chunks.filter((chunk) => chunk.chunkType === "chapter");
      const paragraphChunks = corpus.chunks.filter((chunk) => chunk.chunkType === "paragraph");
      const utilityChunks = corpus.chunks.filter((chunk) =>
        chunk.chunkType === "summary"
        || chunk.chunkType === "entity_candidate"
        || chunk.chunkType === "timeline_candidate"
        || chunk.chunkType === "foreshadow_candidate"
        || chunk.chunkType === "style_candidate");
      const targetChapterOrder = input.chapterOrder ?? null;
      const positionChunks = this.selectPositionAnchorChunks({
        mode,
        corpusId: corpus.id,
        chunks: corpus.chunks,
        positionAnchor,
      });
      const nearbyChapters = typeof targetChapterOrder === "number"
        ? chapterChunks.filter((chunk) =>
          typeof chunk.chapterIndex === "number"
          && chunk.chapterIndex + 1 <= targetChapterOrder - 1)
        : chapterChunks;
      const selected = [
        ...positionChunks,
        ...nearbyChapters.slice(-4),
        ...paragraphChunks.slice(-4),
        ...utilityChunks.slice(0, 8),
      ];
      const seen = new Set<string>();
      return selected
        .filter((chunk) => {
          if (seen.has(chunk.id)) {
            return false;
          }
          seen.add(chunk.id);
          return true;
        })
        .map((chunk): ContinuationContextRecallHit => ({
          id: chunk.id,
          corpusId: corpus.id,
          corpusTitle: corpus.title,
          source: "structured",
          chunkType: chunk.chunkType,
          chunkOrder: chunk.chunkOrder,
          chapterIndex: chunk.chapterIndex,
          title: chunk.title,
          text: compactText(chunk.text, 520),
          summary: chunk.summary,
          reason: reasonForChunk({
            mode,
            chunkType: chunk.chunkType,
            chapterIndex: chunk.chapterIndex,
            paragraphIndex: chunk.paragraphIndex,
            targetChapterOrder,
            isPositionAnchor: mode === "position" && positionChunks.some((item) => item.id === chunk.id),
          }),
        }));
    });
    const semanticRecallHits = await this.retrieveSemanticRecallHits({
      novelId: input.novelId,
      mode,
      targetChapterOrder: input.chapterOrder ?? null,
      humanBlock: continuationPack.humanBlock,
      positionAnchor,
      outlineContext,
      styleContext,
      corpusIds: corpora
        .filter((corpus) => corpus.latestIndexStatus === "succeeded")
        .map((corpus) => corpus.id),
      corpusTitleById: new Map(corpora.map((corpus) => [corpus.id, corpus.title])),
    });
    const seenRecallHitIds = new Set<string>();
    const recallHits = [...semanticRecallHits, ...structuredRecallHits]
      .filter((hit) => {
        const key = `${hit.corpusId}:${hit.id}`;
        if (seenRecallHitIds.has(key)) {
          return false;
        }
        seenRecallHitIds.add(key);
        return true;
      })
      .slice(0, 20);

    return {
      novelId: input.novelId,
      mode,
      targetChapterOrder: input.chapterOrder ?? null,
      positionAnchor,
      outlineContext,
      styleContext,
      generatedAt: new Date().toISOString(),
      continuation: {
        enabled: continuationPack.enabled,
        sourceType: continuationPack.sourceType,
        sourceId: continuationPack.sourceId,
        sourceTitle: continuationPack.sourceTitle,
        systemRule: continuationPack.systemRule,
        humanBlock: continuationPack.humanBlock,
        antiCopyCorpusPreview: continuationPack.antiCopyCorpus.slice(0, 8),
      },
      referenceCorpora: corpora.map((corpus) => ({
        id: corpus.id,
        title: corpus.title,
        sourceType: corpus.sourceType,
        summary: corpus.summary,
        chapterChunkCount: corpus.chunks.filter((chunk) => chunk.chunkType === "chapter").length,
        paragraphChunkCount: corpus.chunks.filter((chunk) => chunk.chunkType === "paragraph").length,
        latestIndexStatus: corpus.latestIndexStatus,
        updatedAt: corpus.updatedAt.toISOString(),
      })),
      recallHits,
    };
  }

  private async retrieveSemanticRecallHits(input: {
    novelId: string;
    mode: ContinuationWorkbenchMode;
    targetChapterOrder?: number | null;
    humanBlock?: string | null;
    positionAnchor?: ContinuationPositionAnchor | null;
    outlineContext?: ContinuationOutlineContext | null;
    styleContext?: ContinuationStyleContext | null;
    corpusIds: string[];
    corpusTitleById: Map<string, string>;
  }): Promise<ContinuationContextRecallHit[]> {
    if (input.corpusIds.length === 0) {
      return [];
    }
    const query = buildSemanticRecallQuery({
      mode: input.mode,
      targetChapterOrder: input.targetChapterOrder,
      humanBlock: input.humanBlock,
      positionAnchor: input.positionAnchor,
      outlineContext: input.outlineContext,
      styleContext: input.styleContext,
    });
    const rows = await ragServices.hybridRetrievalService.retrieve(query, {
      novelId: input.novelId,
      ownerTypes: ["reference_corpus"],
      ownerIds: input.corpusIds,
      currentChapterOrder: input.targetChapterOrder ?? undefined,
      finalTopK: 12,
      rerankerEnabled: false,
    }).catch(() => []);
    return rows.map((row) => recallHitFromRetrievedChunk({
      row,
      corpusTitleById: input.corpusTitleById,
      mode: input.mode,
      targetChapterOrder: input.targetChapterOrder,
    }));
  }

  private normalizePositionInput(input: ContinuationPositionAnchorInput): Required<ContinuationPositionAnchorInput> {
    return {
      positionCorpusId: input.positionCorpusId?.trim() || null,
      positionChapterIndex: typeof input.positionChapterIndex === "number" && Number.isInteger(input.positionChapterIndex) && input.positionChapterIndex >= 0
        ? input.positionChapterIndex
        : null,
      positionParagraphIndex: typeof input.positionParagraphIndex === "number" && Number.isInteger(input.positionParagraphIndex) && input.positionParagraphIndex >= 0
        ? input.positionParagraphIndex
        : null,
      positionAnchorText: input.positionAnchorText?.trim() || null,
    };
  }

  private selectPositionAnchorChunks(input: {
    mode: ContinuationWorkbenchMode;
    corpusId: string;
    chunks: Array<{
      id: string;
      chunkType: string;
      chapterIndex: number | null;
      paragraphIndex: number | null;
      chunkOrder: number;
      title: string | null;
      text: string;
      summary: string | null;
    }>;
    positionAnchor?: ContinuationPositionAnchor | null;
  }) {
    if (input.mode !== "position" || !input.positionAnchor || input.positionAnchor.corpusId !== input.corpusId) {
      return [];
    }
    const chapterIndex = input.positionAnchor.resolvedChapterIndex ?? input.positionAnchor.chapterIndex;
    const paragraphIndex = input.positionAnchor.resolvedParagraphIndex ?? input.positionAnchor.paragraphIndex;
    if (typeof chapterIndex !== "number") {
      return [];
    }
    const chapterContext = input.chunks.filter((chunk) =>
      chunk.chunkType === "chapter"
      && chunk.chapterIndex === chapterIndex);
    if (typeof paragraphIndex !== "number") {
      return chapterContext.slice(0, 1);
    }
    const paragraphContext = input.chunks.filter((chunk) =>
      chunk.chunkType === "paragraph"
      && chunk.chapterIndex === chapterIndex
      && typeof chunk.paragraphIndex === "number"
      && chunk.paragraphIndex <= paragraphIndex
      && chunk.paragraphIndex >= Math.max(0, paragraphIndex - 3));
    return [...paragraphContext, ...chapterContext].sort((left, right) => left.chunkOrder - right.chunkOrder);
  }

  private async resolvePositionAnchor(input: {
    novelId: string;
    corpora: Array<{
      id: string;
      title: string;
      chunks: Array<{
        id: string;
        chunkType: string;
        chapterIndex: number | null;
        paragraphIndex: number | null;
        title: string | null;
        text: string;
        summary: string | null;
        chunkOrder: number;
      }>;
    }>;
  } & Required<ContinuationPositionAnchorInput>): Promise<ContinuationPositionAnchor> {
    const matchingCorpora = input.positionCorpusId
      ? input.corpora.filter((corpus) => corpus.id === input.positionCorpusId)
      : input.corpora;
    const candidateChunks = matchingCorpora
      .flatMap((corpus) => corpus.chunks.map((chunk) => ({ corpus, chunk })))
      .filter(({ chunk }) => {
        if (typeof input.positionChapterIndex === "number" && chunk.chapterIndex !== input.positionChapterIndex) {
          return false;
        }
        if (typeof input.positionParagraphIndex === "number" && chunk.paragraphIndex !== input.positionParagraphIndex) {
          return false;
        }
        if (input.positionAnchorText && !chunk.text.includes(input.positionAnchorText)) {
          return false;
        }
        return chunk.chunkType === "paragraph" || chunk.chunkType === "chapter";
      })
      .sort((left, right) => {
        if (left.corpus.id !== right.corpus.id) {
          return left.corpus.id.localeCompare(right.corpus.id);
        }
        return left.chunk.chunkOrder - right.chunk.chunkOrder;
      });

    const resolved = candidateChunks[0];
    const resolvedCorpusId = resolved?.corpus.id ?? input.positionCorpusId;
    const resolvedCorpusTitle = resolved?.corpus.title ?? (
      input.positionCorpusId
        ? input.corpora.find((corpus) => corpus.id === input.positionCorpusId)?.title
        : undefined
    );
    const resolvedChapterIndex = resolved?.chunk.chapterIndex ?? input.positionChapterIndex;
    const resolvedParagraphIndex = resolved?.chunk.paragraphIndex ?? input.positionParagraphIndex;
    const beforeText = resolved
      ? compactText(this.buildAnchorBeforeText({
        corpus: resolved.corpus,
        chunkOrder: resolved.chunk.chunkOrder,
        chapterIndex: resolvedChapterIndex,
        paragraphIndex: resolvedParagraphIndex,
      }), 1400)
      : null;
    const afterText = resolved
      ? compactText(this.buildAnchorAfterText({
        corpus: resolved.corpus,
        chunkOrder: resolved.chunk.chunkOrder,
        chapterIndex: resolvedChapterIndex,
        paragraphIndex: resolvedParagraphIndex,
      }), 700)
      : null;

    return {
      corpusId: resolvedCorpusId,
      corpusTitle: resolvedCorpusTitle ?? null,
      chapterIndex: input.positionChapterIndex,
      paragraphIndex: input.positionParagraphIndex,
      anchorText: input.positionAnchorText ?? (resolved ? compactText(resolved.chunk.text, 520) : null),
      resolvedChunkId: resolved?.chunk.id ?? null,
      resolvedChapterIndex,
      resolvedParagraphIndex,
      resolvedTitle: resolved?.chunk.title ?? null,
      beforeText,
      afterText,
    };
  }

  private buildOutlineContext(input: {
    corpora: Array<{
      id: string;
      title: string;
      summary: string | null;
      extractionJson: string;
      chunks: Array<{
        id: string;
        chunkType: string;
        chapterIndex: number | null;
        paragraphIndex: number | null;
        title: string | null;
        text: string;
        summary: string | null;
        chunkOrder: number;
        extractionJson: string;
      }>;
    }>;
    targetChapterOrder?: number | null;
  }): ContinuationOutlineContext {
    const chapterSummaries = input.corpora
      .flatMap((corpus) => corpus.chunks
        .filter((chunk) => chunk.chunkType === "chapter")
        .sort((left, right) => left.chunkOrder - right.chunkOrder)
        .map((chunk) => ({
          corpusId: corpus.id,
          corpusTitle: corpus.title,
          chapterIndex: chunk.chapterIndex,
          title: chunk.title,
          summary: chunk.summary ?? compactText(chunk.text, 220),
        })))
      .filter((item) => item.summary.trim().length > 0)
      .slice(-10);

    const unresolvedForeshadows = input.corpora
      .flatMap((corpus) => {
        const corpusExtraction = parseJsonRecord(corpus.extractionJson);
        const chunkExtractions = corpus.chunks
          .filter((chunk) => chunk.chunkType === "foreshadow_candidate")
          .map((chunk) => parseJsonRecord(chunk.extractionJson));
        return [corpusExtraction, ...chunkExtractions]
          .flatMap((record) => parseJsonArrayRecord(record.foreshadowCandidates))
          .map((item) => ({
            corpusId: corpus.id,
            corpusTitle: corpus.title,
            chapterIndex: typeof item.chapterIndex === "number" ? item.chapterIndex : null,
            title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : "未命名伏笔",
            evidence: typeof item.evidence === "string" ? compactText(item.evidence, 220) : "",
            reason: typeof item.reason === "string" ? item.reason : "导入语料中识别出的未解冲突或疑点。",
          }));
      })
      .filter((item) => item.evidence.length > 0)
      .slice(0, 12);

    const importedChapterCount = input.corpora.reduce(
      (sum, corpus) => sum + corpus.chunks.filter((chunk) => chunk.chunkType === "chapter").length,
      0,
    );
    const latestSummaries = chapterSummaries.slice(-3).map((item) =>
      `${typeof item.chapterIndex === "number" ? `第 ${item.chapterIndex + 1} 章` : "章节"}${item.title ? `《${item.title}》` : ""}：${item.summary}`);
    const premise = latestSummaries.length > 0
      ? `承接导入语料最近剧情：${latestSummaries.join(" / ")}`
      : input.corpora.map((corpus) => corpus.summary).filter(Boolean).join(" / ") || "导入语料不足，先承接已知主线并避免新增重大设定。";

    return {
      sourceCorpusIds: input.corpora.map((corpus) => corpus.id),
      importedChapterCount,
      chapterSummaries,
      unresolvedForeshadows,
      nextChapterBrief: {
        targetChapterOrder: input.targetChapterOrder ?? null,
        premise,
        requiredContinuity: [
          "不得推翻导入语料中已出现的人物状态、地点和核心设定。",
          "优先承接最近 3 章结尾处的行动目标、冲突压力和章末钩子。",
          "未确认为回收的伏笔只能推进或强化，不能直接改写为无效线索。",
        ],
        recommendedFocus: [
          "延续上一章未完成动作并给出新的场景目标。",
          "选择 1-2 个未解伏笔作为本章推进对象。",
          "在章末保留一个清晰但可控的新钩子。",
        ],
      },
    };
  }

  private buildStyleContext(input: {
    corpora: Array<{
      id: string;
      title: string;
      chunks: Array<{
        chunkType: string;
        text: string;
        summary: string | null;
        extractionJson: string;
      }>;
    }>;
    styleBindings: Array<{
      targetType: string;
      weight: number;
      styleProfile: {
        id: string;
        name: string;
        category: string | null;
        selectedExtractionPresetKey: string | null;
        extractionAntiAiRuleKeysJson: string | null;
        narrativeRulesJson: string | null;
        characterRulesJson: string | null;
        languageRulesJson: string | null;
        rhythmRulesJson: string | null;
      };
    }>;
  }): ContinuationStyleContext {
    const styleCandidates = input.corpora
      .flatMap((corpus) => corpus.chunks
        .filter((chunk) => chunk.chunkType === "style_candidate")
        .map((chunk) => {
          const extractionRecord = parseJsonRecord(chunk.extractionJson);
          const styleCandidateRecord = extractionRecord.styleCandidate && typeof extractionRecord.styleCandidate === "object" && !Array.isArray(extractionRecord.styleCandidate)
            ? extractionRecord.styleCandidate as Record<string, unknown>
            : parseJsonRecord(chunk.text);
          const avgSentenceLength = readNumber(styleCandidateRecord.avgSentenceLength);
          const dialogueRatio = readNumber(styleCandidateRecord.dialogueRatio);
          const paragraphCount = readNumber(styleCandidateRecord.paragraphCount);
          const chapterCount = readNumber(styleCandidateRecord.chapterCount);
          const dominantPunctuation = readStringArray(styleCandidateRecord.dominantPunctuation);
          const sampleSentences = readStringArray(styleCandidateRecord.sampleSentences).slice(0, 5);
          return {
            corpusId: corpus.id,
            corpusTitle: corpus.title,
            avgSentenceLength,
            dialogueRatio,
            paragraphCount,
            chapterCount,
            dominantPunctuation,
            sampleSentences,
            summary: chunk.summary ?? [
              avgSentenceLength != null ? `均句长 ${avgSentenceLength}` : null,
              dialogueRatio != null ? `对话占比 ${dialogueRatio}` : null,
              dominantPunctuation.length > 0 ? `标点 ${dominantPunctuation.join(" ")}` : null,
            ].filter(Boolean).join("；"),
          };
        }))
      .filter((item) => item.summary.trim().length > 0 || item.sampleSentences.length > 0)
      .slice(0, 8);

    const activeStyleProfiles = input.styleBindings.map((binding) => ({
      id: binding.styleProfile.id,
      name: binding.styleProfile.name,
      category: binding.styleProfile.category,
      bindingTargetType: binding.targetType,
      bindingWeight: binding.weight,
      selectedExtractionPresetKey: binding.styleProfile.selectedExtractionPresetKey,
      narrativeSummary: readRuleSummary(binding.styleProfile.narrativeRulesJson),
      characterSummary: readRuleSummary(binding.styleProfile.characterRulesJson),
      languageSummary: readRuleSummary(binding.styleProfile.languageRulesJson),
      rhythmSummary: readRuleSummary(binding.styleProfile.rhythmRulesJson),
      antiAiRuleCount: countJsonStringArray(binding.styleProfile.extractionAntiAiRuleKeysJson),
    }));
    const styleIntensity = activeStyleProfiles.length > 0
      ? Math.max(...activeStyleProfiles.map((profile) => profile.bindingWeight))
      : 0.8;
    const profileRules = activeStyleProfiles.flatMap((profile) => [
      profile.narrativeSummary,
      profile.characterSummary,
      profile.languageSummary,
      profile.rhythmSummary,
    ]).filter((item): item is string => Boolean(item?.trim())).slice(0, 8);
    const examples = styleCandidates.flatMap((candidate) => candidate.sampleSentences).slice(0, 6);

    return {
      sourceCorpusIds: input.corpora.map((corpus) => corpus.id),
      styleCandidates,
      activeStyleProfiles,
      writingConstraints: {
        styleIntensity,
        requiredContinuity: [
          "保留导入语料的叙述视角、句长密度、对话比例和段落节奏。",
          "优先迁移写法特征，不照搬来源文本的具体句子、桥段和专有表达。",
          ...profileRules,
        ].slice(0, 12),
        avoidPatterns: [
          "避免直接复用样章原句或高识别度表达。",
          "避免为了贴近风格而牺牲当前剧情连续性。",
          "避免空泛总结、解释过度和模板化 AI 腔。",
        ],
        referenceExamples: examples,
      },
    };
  }

  private buildAnchorBeforeText(input: {
    corpus: { chunks: Array<{ chunkType: string; chapterIndex: number | null; paragraphIndex: number | null; chunkOrder: number; text: string }> };
    chunkOrder: number;
    chapterIndex?: number | null;
    paragraphIndex?: number | null;
  }): string {
    const sameChapterParagraphs = typeof input.chapterIndex === "number"
      ? input.corpus.chunks.filter((chunk) =>
        chunk.chunkType === "paragraph"
        && chunk.chapterIndex === input.chapterIndex
        && chunk.chunkOrder <= input.chunkOrder
        && (typeof input.paragraphIndex !== "number" || (typeof chunk.paragraphIndex === "number" && chunk.paragraphIndex <= input.paragraphIndex)))
      : [];
    const selected = sameChapterParagraphs.length > 0
      ? sameChapterParagraphs.slice(-5)
      : input.corpus.chunks.filter((chunk) => chunk.chunkOrder <= input.chunkOrder).slice(-3);
    return selected.map((chunk) => chunk.text).join("\n\n");
  }

  private buildAnchorAfterText(input: {
    corpus: { chunks: Array<{ chunkType: string; chapterIndex: number | null; paragraphIndex: number | null; chunkOrder: number; text: string }> };
    chunkOrder: number;
    chapterIndex?: number | null;
    paragraphIndex?: number | null;
  }): string {
    const sameChapterParagraphs = typeof input.chapterIndex === "number"
      ? input.corpus.chunks.filter((chunk) =>
        chunk.chunkType === "paragraph"
        && chunk.chapterIndex === input.chapterIndex
        && chunk.chunkOrder > input.chunkOrder
        && (typeof input.paragraphIndex !== "number" || (typeof chunk.paragraphIndex === "number" && chunk.paragraphIndex > input.paragraphIndex)))
      : [];
    return sameChapterParagraphs.slice(0, 3).map((chunk) => chunk.text).join("\n\n");
  }
}

export const continuationWorkbenchService = new ContinuationWorkbenchService();
