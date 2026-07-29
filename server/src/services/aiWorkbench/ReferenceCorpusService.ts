import type {
  ReferenceCorpusIndexJob,
  ReferenceCorpusIndexJobProgress,
  ReferenceCorpus,
  ReferenceCorpusDetail,
  ReferenceCorpusExtraction,
  ReferenceCorpusRecallResult,
  ReferenceCorpusStyleProfileResult,
  ReferenceCorpusSourceType,
  ReferenceStyleLearningDimension,
  ReferenceChunk,
  ReferenceChunkType,
} from "@ai-novel/shared/types/referenceCorpus";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { RagIndexJob } from "@prisma/client";
import type {
  StyleExtractionDraft,
  StyleExtractionFeatureGroup,
  StyleExtractionPreset,
  StyleFeatureDecision,
} from "@ai-novel/shared/types/styleEngine";
import { prisma } from "../../db/prisma";
import { ragServices } from "../rag";
import { StyleBindingService } from "../styleEngine/StyleBindingService";
import { StyleProfileService } from "../styleEngine/StyleProfileService";
import { computeChunkHash, normalizeRagText } from "../rag/utils";
import type { RetrievedChunk } from "../rag/types";
import {
  CHAPTER_HEADING_REGEX,
  MIN_CHAPTER_DETECTION_COUNT,
  MIN_SEGMENT_BODY_LENGTH,
} from "../bookAnalysis/shared/bookAnalysis.constants";

interface ChapterDraft {
  chapterIndex: number;
  title: string;
  startOffset: number;
  endOffset: number;
  splitter: "rule" | "single";
}

interface ChunkDraft {
  chunkType: ReferenceChunkType;
  chapterIndex?: number | null;
  paragraphIndex?: number | null;
  chunkOrder: number;
  title?: string | null;
  text: string;
  summary?: string | null;
  startOffset: number;
  endOffset: number;
  metadataJson?: string;
  extractionJson?: string;
}

const STYLE_SOURCE_MAX_CHARS = 60000;
const DEFAULT_STYLE_LEARNING_DIMENSIONS: ReferenceStyleLearningDimension[] = [
  "language",
  "chapter_structure",
  "pacing_payoff",
  "characterization",
  "dialogue",
  "worldbuilding",
  "emotion_curve",
  "commercial_packaging",
  "anti_ai",
];

const STYLE_DIMENSION_FEATURE_GROUPS: Record<ReferenceStyleLearningDimension, StyleExtractionFeatureGroup[]> = {
  language: ["language"],
  chapter_structure: ["narrative", "rhythm"],
  pacing_payoff: ["rhythm", "narrative"],
  characterization: ["narrative", "dialogue"],
  dialogue: ["dialogue"],
  worldbuilding: ["narrative"],
  emotion_curve: ["rhythm", "narrative"],
  commercial_packaging: ["narrative"],
  anti_ai: ["fingerprint"],
};

const STYLE_DIMENSION_LABELS: Record<ReferenceStyleLearningDimension, string> = {
  language: "文风语言",
  chapter_structure: "章节结构",
  pacing_payoff: "节奏爽点",
  characterization: "人物塑造",
  dialogue: "对话方式",
  worldbuilding: "世界观套路",
  emotion_curve: "情绪曲线",
  commercial_packaging: "商业包装",
  anti_ai: "去 AI 味",
};

function normalizeContent(content: string): string {
  const normalized = normalizeRagText(content);
  if (!normalized) {
    throw new Error("Reference corpus content cannot be empty.");
  }
  return normalized;
}

function normalizeTitle(input: { title?: string | null; fileName?: string | null }): string {
  const raw = input.title?.trim() || input.fileName?.trim() || "未命名参考语料";
  const withoutExtension = raw.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Reference corpus title cannot be empty.");
  }
  return normalized.slice(0, 120);
}

function buildRepresentativeStyleSource(content: string, maxChars = STYLE_SOURCE_MAX_CHARS): string {
  const normalized = normalizeRagText(content);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const sliceLength = Math.floor(maxChars / 3);
  const middleStart = Math.max(0, Math.floor(normalized.length / 2) - Math.floor(sliceLength / 2));
  return [
    normalized.slice(0, sliceLength),
    normalized.slice(middleStart, middleStart + sliceLength),
    normalized.slice(Math.max(0, normalized.length - sliceLength)),
  ].join("\n\n[...]\n\n");
}

function normalizeStyleLearningDimensions(
  input?: ReferenceStyleLearningDimension[],
): ReferenceStyleLearningDimension[] {
  if (!input || input.length === 0) {
    return DEFAULT_STYLE_LEARNING_DIMENSIONS;
  }
  const allowed = new Set(DEFAULT_STYLE_LEARNING_DIMENSIONS);
  const normalized = input.filter((item, index) => allowed.has(item) && input.indexOf(item) === index);
  return normalized.length > 0 ? normalized : DEFAULT_STYLE_LEARNING_DIMENSIONS;
}

function buildDimensionAwareStyleDecisions(
  draft: StyleExtractionDraft,
  preset: StyleExtractionPreset | undefined,
  selectedDimensions: ReferenceStyleLearningDimension[],
): Array<{ featureId: string; decision: StyleFeatureDecision }> {
  const selectedFeatureGroups = new Set(
    selectedDimensions.flatMap((dimension) => STYLE_DIMENSION_FEATURE_GROUPS[dimension]),
  );
  return draft.features.map((feature) => {
    const presetDecision = preset?.decisions.find((item) => item.featureId === feature.id)?.decision ?? "keep";
    return {
      featureId: feature.id,
      decision: selectedFeatureGroups.has(feature.group) ? presetDecision : "remove",
    };
  });
}

function appendStyleDimensionSummary(
  draft: StyleExtractionDraft,
  selectedDimensions: ReferenceStyleLearningDimension[],
): StyleExtractionDraft {
  const dimensionLine = `选择学习维度：${selectedDimensions.map((item) => STYLE_DIMENSION_LABELS[item]).join("、")}`;
  return {
    ...draft,
    summary: [draft.summary, dimensionLine].filter(Boolean).join("\n"),
    analysisMarkdown: draft.analysisMarkdown
      ? `${draft.analysisMarkdown}\n\n${dimensionLine}`
      : draft.analysisMarkdown,
  };
}

function buildLineStarts(content: string): Array<{ text: string; startOffset: number }> {
  const lines = content.split("\n");
  let offset = 0;
  return lines.map((text) => {
    const row = { text, startOffset: offset };
    offset += text.length + 1;
    return row;
  });
}

function splitChaptersByRules(content: string): ChapterDraft[] {
  const headings: Array<{ title: string; startOffset: number }> = [];
  for (const line of buildLineStarts(content)) {
    const title = line.text.trim();
    if (!title || title.length > 80) {
      continue;
    }
    if (CHAPTER_HEADING_REGEX.test(title)) {
      headings.push({ title, startOffset: line.startOffset });
    }
  }
  if (headings.length < MIN_CHAPTER_DETECTION_COUNT) {
    return [];
  }
  return headings.flatMap((heading, index) => {
    const endOffset = index + 1 < headings.length ? headings[index + 1].startOffset : content.length;
    const body = content.slice(heading.startOffset, endOffset).trim();
    if (body.length < MIN_SEGMENT_BODY_LENGTH) {
      return [];
    }
    return [{
      chapterIndex: index,
      title: heading.title,
      startOffset: heading.startOffset,
      endOffset,
      splitter: "rule" as const,
    }];
  }).map((chapter, index) => ({ ...chapter, chapterIndex: index }));
}

function splitChapters(content: string): ChapterDraft[] {
  const ruleChapters = splitChaptersByRules(content);
  if (ruleChapters.length > 0) {
    return ruleChapters;
  }
  return [{
    chapterIndex: 0,
    title: "全文",
    startOffset: 0,
    endOffset: content.length,
    splitter: "single",
  }];
}

function splitParagraphs(chapterText: string, baseOffset: number): Array<{ text: string; startOffset: number; endOffset: number }> {
  const paragraphs: Array<{ text: string; startOffset: number; endOffset: number }> = [];
  const parts = chapterText.split(/\n{2,}/g);
  let cursor = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    const localStart = chapterText.indexOf(part, cursor);
    cursor = localStart >= 0 ? localStart + part.length : cursor + part.length;
    if (trimmed.length < 40) {
      continue;
    }
    const textStart = localStart + part.indexOf(trimmed);
    paragraphs.push({
      text: trimmed,
      startOffset: baseOffset + Math.max(0, textStart),
      endOffset: baseOffset + Math.max(0, textStart) + trimmed.length,
    });
  }
  if (paragraphs.length > 0) {
    return paragraphs;
  }
  const sentenceParts = chapterText.match(/[^。！？!?]{40,}[。！？!?]?/g) ?? [];
  let sentenceCursor = 0;
  return sentenceParts.slice(0, 80).map((text) => {
    const localStart = chapterText.indexOf(text, sentenceCursor);
    sentenceCursor = localStart >= 0 ? localStart + text.length : sentenceCursor + text.length;
    return {
      text: text.trim(),
      startOffset: baseOffset + Math.max(0, localStart),
      endOffset: baseOffset + Math.max(0, localStart) + text.trim().length,
    };
  }).filter((item) => item.text.length >= 40);
}

function summarizeText(text: string, limit = 180): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function uniqueStrings(items: Array<string | null | undefined>, limit = 30): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const item of items) {
    const normalized = item?.replace(/\s+/g, "").trim();
    if (!normalized || normalized.length < 2 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function extractRegex(text: string, regex: RegExp, limit = 30): string[] {
  return uniqueStrings(Array.from(text.matchAll(regex)).map((match) => match[1] ?? match[0]), limit);
}

const CHARACTER_NAME_BLOCKLIST = new Set([
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

const CHARACTER_NAME_PREFIX_BLOCKLIST = [
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

const CHARACTER_NAME_SUFFIX_BLOCKLIST = [
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

const CHARACTER_NAME_CONTAINS_BLOCKLIST = ["在", "把", "被", "将", "从", "到"];

function normalizeCharacterCandidateName(value: string): string | null {
  const normalized = value.replace(/[^\u4e00-\u9fa5·]/g, "").trim();
  if (normalized.length < 2 || normalized.length > 4) {
    return null;
  }
  if (CHARACTER_NAME_BLOCKLIST.has(normalized)) {
    return null;
  }
  if (CHARACTER_NAME_PREFIX_BLOCKLIST.some((prefix) => normalized.startsWith(prefix))) {
    return null;
  }
  if (CHARACTER_NAME_SUFFIX_BLOCKLIST.some((suffix) => normalized.endsWith(suffix))) {
    return null;
  }
  if (CHARACTER_NAME_CONTAINS_BLOCKLIST.some((token) => normalized.includes(token))) {
    return null;
  }
  return normalized;
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

function splitSentences(text: string, limit = 80): string[] {
  return (text.match(/[^。！？!?]{8,120}[。！？!?]?/g) ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function buildExtraction(content: string, chapters: ChapterDraft[]): ReferenceCorpusExtraction {
  const sentences = splitSentences(content, 160);
  const characterCandidates = uniqueStrings([
    ...extractRegex(content, /(?:主角|搭档|同事|队友|侦探|警员|警官|记者|医生|老师|少女|少年|男人|女人|老人|老板|队长|师兄|师姐|父亲|母亲|哥哥|姐姐|妹妹|弟弟|嫌疑人)[叫名为是：:「“\s]*([\u4e00-\u9fa5]{2,4})/g, 24),
    ...extractRegex(content, /(?:^|[。！？!?\n，,；;])([\u4e00-\u9fa5]{2,3})(?:回到|查到|去过|赶回|进入|来到|离开|打开|发现|找到|看见|听见|知道|没有|再次|翻到|合上|拿起|放下|停住|压低|提醒|留下|失踪)/g, 24),
  ].map((name) => normalizeCharacterCandidateName(name)), 24);
  const locations = extractRegex(content, /(?:在|到|回到|进入|来到|离开)([\u4e00-\u9fa5]{2,10}(?:市|城|村|镇|山|宗|门|楼|街|巷|院|校|馆|厅|局|公司|医院|车站|码头))/g, 24);
  const factions = extractRegex(content, /([\u4e00-\u9fa5]{2,12}(?:宗|门|派|会|盟|局|队|公司|集团|家族|学院|帮|军))/g, 24);
  const items = extractRegex(content, /(?:拿着|握着|发现|找到|交出|递来|打开|藏着)([\u4e00-\u9fa5]{2,12}(?:刀|剑|枪|信|书|钥匙|玉佩|戒指|手机|文件|盒子|卷轴|丹药|法器))/g, 24);
  const timelineCandidates = chapters.slice(0, 30).map((chapter) => {
    const text = content.slice(chapter.startOffset, chapter.endOffset);
    return {
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      summary: summarizeText(text, 140),
      evidence: splitSentences(text, 1)[0] ?? summarizeText(text, 120),
    };
  });
  const foreshadowCandidates = sentences
    .filter((sentence) => /(秘密|真相|线索|失踪|死亡|案件|未解|奇怪|诡异|却|然而|但是|为什么|不对劲|疑点)/.test(sentence))
    .slice(0, 24)
    .map((sentence) => {
      const chapter = chapters.find((item) => {
        const offset = content.indexOf(sentence);
        return offset >= item.startOffset && offset < item.endOffset;
      });
      return {
        chapterIndex: chapter?.chapterIndex ?? null,
        title: chapter?.title ?? "未知章节",
        evidence: sentence,
        reason: "包含未解疑点、反转或冲突信号。",
      };
    });
  const dialogueLines = content.split("\n").filter((line) => /[“”「」：:]/.test(line));
  const punctuationCounts = Array.from("，。！？；：、“”").map((mark) => ({
    mark,
    count: (content.match(new RegExp(mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length,
  })).sort((left, right) => right.count - left.count);
  const sentenceLengths = sentences.map((sentence) => sentence.length);
  const avgSentenceLength = sentenceLengths.length > 0
    ? Math.round(sentenceLengths.reduce((sum, len) => sum + len, 0) / sentenceLengths.length)
    : 0;
  return {
    characters: characterCandidates,
    locations,
    factions,
    items,
    timelineCandidates,
    foreshadowCandidates,
    styleCandidate: {
      avgSentenceLength,
      dialogueRatio: content.length > 0 ? Number((dialogueLines.join("\n").length / content.length).toFixed(3)) : 0,
      paragraphCount: content.split(/\n{2,}/g).filter((item) => item.trim().length > 0).length,
      chapterCount: chapters.length,
      dominantPunctuation: punctuationCounts.filter((item) => item.count > 0).slice(0, 5).map((item) => item.mark),
      sampleSentences: sentences.slice(0, 5),
    },
  };
}

function buildChunks(content: string, chapters: ChapterDraft[], extraction: ReferenceCorpusExtraction): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  const push = (draft: Omit<ChunkDraft, "chunkOrder">) => {
    chunks.push({ ...draft, chunkOrder: chunks.length });
  };
  chapters.forEach((chapter) => {
    const chapterText = content.slice(chapter.startOffset, chapter.endOffset).trim();
    push({
      chunkType: "chapter",
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      text: chapterText,
      summary: summarizeText(chapterText, 180),
      startOffset: chapter.startOffset,
      endOffset: chapter.endOffset,
      metadataJson: JSON.stringify({ splitter: chapter.splitter }),
    });
    splitParagraphs(chapterText, chapter.startOffset).slice(0, 120).forEach((paragraph, paragraphIndex) => {
      push({
        chunkType: "paragraph",
        chapterIndex: chapter.chapterIndex,
        paragraphIndex,
        title: chapter.title,
        text: paragraph.text,
        summary: summarizeText(paragraph.text, 120),
        startOffset: paragraph.startOffset,
        endOffset: paragraph.endOffset,
        metadataJson: JSON.stringify({ splitter: chapter.splitter }),
      });
    });
  });
  push({
    chunkType: "summary",
    title: "Reference Corpus Summary",
    text: summarizeText(content, 600),
    summary: summarizeText(content, 200),
    startOffset: 0,
    endOffset: Math.min(content.length, 600),
    extractionJson: JSON.stringify({ timelineCandidates: extraction.timelineCandidates.slice(0, 8) }),
  });
  if (extraction.timelineCandidates.length > 0) {
    push({
      chunkType: "timeline_candidate",
      title: "Timeline Candidates",
      text: extraction.timelineCandidates.map((item) => `${item.title}: ${item.summary}`).join("\n"),
      summary: `识别到 ${extraction.timelineCandidates.length} 个时间线候选。`,
      startOffset: 0,
      endOffset: 0,
      extractionJson: JSON.stringify({ timelineCandidates: extraction.timelineCandidates }),
    });
  }
  const entityLines = [
    extraction.characters.length > 0 ? `角色：${extraction.characters.join("、")}` : null,
    extraction.locations.length > 0 ? `地点：${extraction.locations.join("、")}` : null,
    extraction.factions.length > 0 ? `势力：${extraction.factions.join("、")}` : null,
    extraction.items.length > 0 ? `物品：${extraction.items.join("、")}` : null,
  ].filter((item): item is string => Boolean(item));
  if (entityLines.length > 0) {
    push({
      chunkType: "entity_candidate",
      title: "Entity Candidates",
      text: entityLines.join("\n"),
      summary: `识别到角色 ${extraction.characters.length}、地点 ${extraction.locations.length}、势力 ${extraction.factions.length}、物品 ${extraction.items.length} 个候选。`,
      startOffset: 0,
      endOffset: 0,
      extractionJson: JSON.stringify({
        characters: extraction.characters,
        locations: extraction.locations,
        factions: extraction.factions,
        items: extraction.items,
      }),
    });
  }
  if (extraction.foreshadowCandidates.length > 0) {
    push({
      chunkType: "foreshadow_candidate",
      title: "Foreshadow Candidates",
      text: extraction.foreshadowCandidates.map((item) => `${item.title}: ${item.evidence}`).join("\n"),
      summary: `识别到 ${extraction.foreshadowCandidates.length} 个伏笔/未解冲突候选。`,
      startOffset: 0,
      endOffset: 0,
      extractionJson: JSON.stringify({ foreshadowCandidates: extraction.foreshadowCandidates }),
    });
  }
  push({
    chunkType: "style_candidate",
    title: "Style Candidate",
    text: JSON.stringify(extraction.styleCandidate),
    summary: `句长=${extraction.styleCandidate.avgSentenceLength}; 对话占比=${extraction.styleCandidate.dialogueRatio}`,
    startOffset: 0,
    endOffset: 0,
    extractionJson: JSON.stringify({ styleCandidate: extraction.styleCandidate }),
  });
  return chunks;
}

function parseIndexJobProgress(payloadJson: string | null): ReferenceCorpusIndexJobProgress | null {
  const payload = parseJsonRecord(payloadJson);
  const progress = payload.progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
    return null;
  }
  const record = progress as Record<string, unknown>;
  const stage = typeof record.stage === "string" ? record.stage : "unknown";
  const label = typeof record.label === "string" ? record.label : stage;
  const percent = typeof record.percent === "number" && Number.isFinite(record.percent)
    ? Math.min(1, Math.max(0, record.percent))
    : 0;
  return {
    stage,
    label,
    detail: typeof record.detail === "string" ? record.detail : undefined,
    current: typeof record.current === "number" ? record.current : undefined,
    total: typeof record.total === "number" ? record.total : undefined,
    percent,
    documents: typeof record.documents === "number" ? record.documents : undefined,
    chunks: typeof record.chunks === "number" ? record.chunks : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
  };
}

function serializeIndexJob(job: RagIndexJob | null | undefined): ReferenceCorpusIndexJob | null {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAfter: job.runAfter.toISOString(),
    lastError: job.lastError,
    progress: parseIndexJobProgress(job.payloadJson),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function serializeCorpus(row: {
  id: string;
  novelId: string | null;
  title: string;
  sourceType: string;
  status: string;
  fileName: string | null;
  contentHash: string;
  charCount: number;
  summary: string | null;
  extractionJson: string;
  metadataJson: string;
  latestIndexStatus: string;
  lastIndexedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { chunks: number };
  chunks?: Array<{ chunkType: string }>;
}, latestIndexJob?: RagIndexJob | null): ReferenceCorpus {
  const chunkCount = row._count?.chunks ?? row.chunks?.length ?? 0;
  return {
    id: row.id,
    novelId: row.novelId,
    title: row.title,
    sourceType: row.sourceType,
    status: row.status,
    fileName: row.fileName,
    contentHash: row.contentHash,
    charCount: row.charCount,
    summary: row.summary,
    extractionJson: row.extractionJson,
    metadataJson: row.metadataJson,
    latestIndexStatus: row.latestIndexStatus,
    latestIndexJob: serializeIndexJob(latestIndexJob),
    lastIndexedAt: row.lastIndexedAt?.toISOString() ?? null,
    chunkCount,
    chapterChunkCount: row.chunks?.filter((chunk) => chunk.chunkType === "chapter").length ?? 0,
    paragraphChunkCount: row.chunks?.filter((chunk) => chunk.chunkType === "paragraph").length ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeChunk(row: {
  id: string;
  corpusId: string;
  chunkType: string;
  chapterIndex: number | null;
  paragraphIndex: number | null;
  chunkOrder: number;
  title: string | null;
  text: string;
  summary: string | null;
  startOffset: number;
  endOffset: number;
  charCount: number;
  metadataJson: string;
  extractionJson: string;
  createdAt: Date;
  updatedAt: Date;
}): ReferenceChunk {
  return {
    id: row.id,
    corpusId: row.corpusId,
    chunkType: row.chunkType,
    chapterIndex: row.chapterIndex,
    paragraphIndex: row.paragraphIndex,
    chunkOrder: row.chunkOrder,
    title: row.title,
    text: row.text,
    summary: row.summary,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    charCount: row.charCount,
    metadataJson: row.metadataJson,
    extractionJson: row.extractionJson,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function recallHitFromRetrievedChunk(row: RetrievedChunk, corpusId: string) {
  const metadata = parseJsonRecord(row.metadataJson);
  const referenceChunkId = typeof metadata.chunkId === "string" ? metadata.chunkId : row.id;
  return {
    id: referenceChunkId,
    corpusId,
    score: row.score,
    source: row.source,
    title: row.title,
    chunkText: [row.contextPrefix, row.chunkText].filter(Boolean).join("\n\n"),
    chunkOrder: row.chunkOrder,
    metadataJson: row.metadataJson,
  };
}

async function loadLatestReferenceCorpusIndexJobs(corpusIds: string[]): Promise<Map<string, RagIndexJob>> {
  const uniqueIds = Array.from(new Set(corpusIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return new Map();
  }
  const jobs = await prisma.ragIndexJob.findMany({
    where: {
      ownerType: "reference_corpus",
      ownerId: { in: uniqueIds },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: Math.min(uniqueIds.length * 5, 500),
  });
  const map = new Map<string, RagIndexJob>();
  for (const job of jobs) {
    if (!map.has(job.ownerId)) {
      map.set(job.ownerId, job);
    }
  }
  return map;
}

export class ReferenceCorpusService {
  private readonly styleProfileService = new StyleProfileService();
  private readonly styleBindingService = new StyleBindingService();

  async importText(input: {
    novelId?: string | null;
    title?: string | null;
    fileName?: string | null;
    sourceType?: ReferenceCorpusSourceType | string;
    content: string;
    metadataJson?: string;
    enqueueIndex?: boolean;
  }): Promise<ReferenceCorpusDetail> {
    const content = normalizeContent(input.content);
    const title = normalizeTitle({ title: input.title, fileName: input.fileName });
    const contentHash = computeChunkHash(content);
    const chapters = splitChapters(content);
    const extraction = buildExtraction(content, chapters);
    const chunks = buildChunks(content, chapters, extraction);
    const summary = summarizeText(content, 320);
    const corpus = await prisma.$transaction(async (tx) => {
      const created = await tx.referenceCorpus.create({
        data: {
          novelId: input.novelId?.trim() || null,
          title,
          sourceType: input.sourceType?.trim() || "text_import",
          status: "active",
          fileName: input.fileName?.trim() || null,
          content,
          contentHash,
          charCount: content.length,
          summary,
          extractionJson: JSON.stringify(extraction),
          metadataJson: input.metadataJson?.trim() || "{}",
          latestIndexStatus: input.enqueueIndex === false ? "idle" : "queued",
          chunks: {
            create: chunks.map((chunk) => ({
              chunkType: chunk.chunkType,
              chapterIndex: chunk.chapterIndex ?? null,
              paragraphIndex: chunk.paragraphIndex ?? null,
              chunkOrder: chunk.chunkOrder,
              title: chunk.title ?? null,
              text: chunk.text,
              summary: chunk.summary ?? null,
              startOffset: chunk.startOffset,
              endOffset: chunk.endOffset,
              charCount: chunk.text.length,
              metadataJson: chunk.metadataJson ?? "{}",
              extractionJson: chunk.extractionJson ?? "{}",
            })),
          },
        },
        include: { chunks: { orderBy: [{ chunkOrder: "asc" }] } },
      });
      return created;
    });
    if (input.enqueueIndex !== false) {
      await ragServices.ragIndexService.enqueueOwnerJob("rebuild", "reference_corpus", corpus.id).catch(() => null);
    }
    const latestJobs = await loadLatestReferenceCorpusIndexJobs([corpus.id]);
    return {
      ...serializeCorpus(corpus, latestJobs.get(corpus.id)),
      content: corpus.content,
      chunks: corpus.chunks.map(serializeChunk),
    };
  }

  async list(filters: {
    novelId?: string;
    sourceType?: string;
    status?: string;
    limit?: number;
  }): Promise<ReferenceCorpus[]> {
    const rows = await prisma.referenceCorpus.findMany({
      where: {
        ...(filters.novelId ? { novelId: filters.novelId } : {}),
        ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
        ...(filters.status ? { status: filters.status } : { status: "active" }),
      },
      include: {
        _count: { select: { chunks: true } },
        chunks: { select: { chunkType: true }, take: 500 },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(filters.limit ?? 20, 100)),
    });
    const latestJobs = await loadLatestReferenceCorpusIndexJobs(rows.map((row) => row.id));
    return rows.map((row) => serializeCorpus(row, latestJobs.get(row.id)));
  }

  async get(id: string): Promise<ReferenceCorpusDetail | null> {
    const row = await prisma.referenceCorpus.findUnique({
      where: { id },
      include: {
        chunks: {
          orderBy: [{ chunkOrder: "asc" }],
          take: 300,
        },
      },
    });
    if (!row) {
      return null;
    }
    const latestJobs = await loadLatestReferenceCorpusIndexJobs([row.id]);
    return {
      ...serializeCorpus(row, latestJobs.get(row.id)),
      content: row.content,
      chunks: row.chunks.map(serializeChunk),
    };
  }

  async archive(id: string): Promise<ReferenceCorpus> {
    const row = await prisma.referenceCorpus.update({
      where: { id },
      data: { status: "archived", latestIndexStatus: "idle" },
      include: {
        _count: { select: { chunks: true } },
        chunks: { select: { chunkType: true }, take: 500 },
      },
    });
    await ragServices.ragIndexService.enqueueOwnerJob("delete", "reference_corpus", id).catch(() => null);
    const latestJobs = await loadLatestReferenceCorpusIndexJobs([row.id]);
    return serializeCorpus(row, latestJobs.get(row.id));
  }

  async reindex(id: string): Promise<ReferenceCorpus> {
    const row = await prisma.referenceCorpus.update({
      where: { id },
      data: { latestIndexStatus: "queued" },
      include: {
        _count: { select: { chunks: true } },
        chunks: { select: { chunkType: true }, take: 500 },
      },
    });
    await ragServices.ragIndexService.enqueueOwnerJob("rebuild", "reference_corpus", id);
    const latestJobs = await loadLatestReferenceCorpusIndexJobs([row.id]);
    return serializeCorpus(row, latestJobs.get(row.id));
  }

  async recall(id: string, query: string, limit = 8): Promise<ReferenceCorpusRecallResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("Recall query cannot be empty.");
    }
    const normalizedLimit = Math.max(1, Math.min(limit, 20));
    const corpus = await prisma.referenceCorpus.findUnique({
      where: { id },
      select: { id: true, novelId: true, latestIndexStatus: true },
    });
    if (!corpus) {
      return {
        corpusId: id,
        query: normalizedQuery,
        hits: [],
        latestIndexStatus: "missing",
        semanticAvailable: false,
        semanticHitCount: 0,
        keywordFallbackUsed: false,
        notice: "Reference Corpus 不存在，无法执行召回。",
      };
    }
    let semanticError: string | null = null;
    const semanticHits = corpus.latestIndexStatus === "succeeded"
      ? await ragServices.hybridRetrievalService.retrieve(normalizedQuery, {
        novelId: corpus.novelId ?? undefined,
        ownerTypes: ["reference_corpus"],
        ownerIds: [id],
        finalTopK: normalizedLimit,
        rerankerEnabled: false,
      }).catch((error) => {
        semanticError = error instanceof Error ? error.message : "Qdrant 语义召回失败。";
        return [];
      })
      : [];
    if (semanticHits.length > 0) {
      return {
        corpusId: id,
        query: normalizedQuery,
        hits: semanticHits.map((hit) => recallHitFromRetrievedChunk(hit, id)),
        latestIndexStatus: corpus.latestIndexStatus,
        semanticAvailable: true,
        semanticHitCount: semanticHits.length,
        keywordFallbackUsed: false,
        notice: null,
      };
    }
    const terms = Array.from(new Set(normalizedQuery.split(/\s+/g).filter(Boolean)));
    const chunks = await prisma.referenceChunk.findMany({
      where: {
        corpusId: id,
        OR: [
          { text: { contains: normalizedQuery } },
          { summary: { contains: normalizedQuery } },
          ...terms.slice(0, 6).flatMap((term) => [
            { text: { contains: term } },
            { summary: { contains: term } },
          ]),
        ],
      },
      orderBy: [{ chunkType: "asc" }, { chunkOrder: "asc" }],
      take: normalizedLimit,
    });
    const keywordFallbackUsed = chunks.length > 0;
    const notice = corpus.latestIndexStatus !== "succeeded"
      ? `语义索引状态为 ${corpus.latestIndexStatus}，本次未访问 Qdrant，结果来自 Postgres 关键词召回。`
      : semanticError
        ? `Qdrant 语义召回失败，已回退到 Postgres 关键词召回：${semanticError}`
        : "Qdrant 语义召回未命中，已回退到 Postgres 关键词召回。";
    return {
      corpusId: id,
      query: normalizedQuery,
      hits: chunks.map((chunk) => ({
        id: chunk.id,
        corpusId: id,
        score: chunk.text.includes(normalizedQuery) ? 1 : 0.5,
        source: "keyword",
        title: chunk.title ?? undefined,
        chunkText: chunk.text,
        chunkOrder: chunk.chunkOrder,
        metadataJson: chunk.metadataJson,
      })),
      latestIndexStatus: corpus.latestIndexStatus,
      semanticAvailable: corpus.latestIndexStatus === "succeeded",
      semanticHitCount: 0,
      keywordFallbackUsed,
      notice,
    };
  }

  async createStyleProfile(input: {
    corpusId: string;
    name?: string | null;
    category?: string | null;
    provider?: LLMProvider;
    model?: string;
    temperature?: number;
    presetKey?: StyleExtractionPreset["key"];
    selectedDimensions?: ReferenceStyleLearningDimension[];
    bindToNovel?: boolean;
  }): Promise<ReferenceCorpusStyleProfileResult> {
    const corpus = await prisma.referenceCorpus.findUnique({
      where: { id: input.corpusId },
    });
    if (!corpus || corpus.status === "archived") {
      throw new Error("Reference Corpus 不存在或已归档。");
    }
    const sourceText = buildRepresentativeStyleSource(corpus.content);
    const profileName = input.name?.trim() || `${corpus.title} 风格画像`;
    const draft = await this.styleProfileService.extractFromText({
      name: profileName,
      sourceText,
      category: input.category?.trim() || "Reference Corpus",
      provider: input.provider ?? "openai",
      model: input.model?.trim() || undefined,
      temperature: input.temperature ?? 0.4,
    });
    const presetKey = input.presetKey ?? "balanced";
    const selectedPreset = draft.presets.find((item) => item.key === presetKey)
      ?? draft.presets.find((item) => item.key === "balanced")
      ?? draft.presets[0];
    const selectedDimensions = normalizeStyleLearningDimensions(input.selectedDimensions);
    const dimensionAwareDraft = appendStyleDimensionSummary(draft, selectedDimensions);
    const decisions = buildDimensionAwareStyleDecisions(dimensionAwareDraft, selectedPreset, selectedDimensions);
    const styleProfile = await this.styleProfileService.createProfileFromExtraction({
      name: profileName,
      sourceText,
      category: input.category?.trim() || dimensionAwareDraft.category || "Reference Corpus",
      draft: dimensionAwareDraft,
      presetKey,
      sourceType: "from_text",
      sourceRefId: `reference_corpus:${corpus.id}`,
      decisions,
    });

    const shouldBindToNovel = input.bindToNovel ?? true;
    if (!shouldBindToNovel || !corpus.novelId) {
      return { corpusId: corpus.id, styleProfile, styleBinding: null };
    }

    const existingBindings = await this.styleBindingService.listBindings({
      targetType: "novel",
      targetId: corpus.novelId,
    });
    const existingBinding = existingBindings.find((binding) => binding.styleProfileId === styleProfile.id);
    if (existingBinding) {
      return { corpusId: corpus.id, styleProfile, styleBinding: existingBinding };
    }
    const nextPriority = existingBindings.length > 0
      ? Math.max(...existingBindings.map((binding) => binding.priority)) + 1
      : 1;
    const styleBinding = await this.styleBindingService.createBinding({
      styleProfileId: styleProfile.id,
      targetType: "novel",
      targetId: corpus.novelId,
      priority: nextPriority,
      weight: 1,
      enabled: true,
    });
    return { corpusId: corpus.id, styleProfile, styleBinding };
  }
}

export const referenceCorpusService = new ReferenceCorpusService();
