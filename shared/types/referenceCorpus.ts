import type { KnowledgeIndexStatus } from "./knowledge";
import type { StyleBinding, StyleProfile } from "./styleEngine";

export type ReferenceCorpusSourceType =
  | "text_import"
  | "novel_import"
  | "sample_chapter"
  | "style_sample"
  | "continuation_source"
  | "reference_material";

export type ReferenceCorpusStatus = "active" | "archived";

export const REFERENCE_STYLE_LEARNING_DIMENSIONS = [
  "language",
  "chapter_structure",
  "pacing_payoff",
  "characterization",
  "dialogue",
  "worldbuilding",
  "emotion_curve",
  "commercial_packaging",
  "anti_ai",
] as const;

export type ReferenceStyleLearningDimension = typeof REFERENCE_STYLE_LEARNING_DIMENSIONS[number];

export const REFERENCE_STYLE_LEARNING_DIMENSION_LABELS: Record<ReferenceStyleLearningDimension, string> = {
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

export type ReferenceChunkType =
  | "chapter"
  | "paragraph"
  | "summary"
  | "entity_candidate"
  | "timeline_candidate"
  | "foreshadow_candidate"
  | "style_candidate";

export interface ReferenceCorpusExtraction {
  characters: string[];
  locations: string[];
  factions: string[];
  items: string[];
  timelineCandidates: Array<{
    chapterIndex?: number | null;
    title: string;
    summary: string;
    evidence: string;
  }>;
  foreshadowCandidates: Array<{
    chapterIndex?: number | null;
    title: string;
    evidence: string;
    reason: string;
  }>;
  styleCandidate: {
    avgSentenceLength: number;
    dialogueRatio: number;
    paragraphCount: number;
    chapterCount: number;
    dominantPunctuation: string[];
    sampleSentences: string[];
  };
}

export interface ReferenceCorpusIndexJobProgress {
  stage: string;
  label: string;
  detail?: string;
  current?: number;
  total?: number;
  percent: number;
  documents?: number;
  chunks?: number;
  updatedAt: string;
}

export interface ReferenceCorpusIndexJob {
  id: string;
  jobType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lastError?: string | null;
  progress?: ReferenceCorpusIndexJobProgress | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceCorpus {
  id: string;
  novelId?: string | null;
  title: string;
  sourceType: ReferenceCorpusSourceType | string;
  status: ReferenceCorpusStatus | string;
  fileName?: string | null;
  contentHash: string;
  charCount: number;
  summary?: string | null;
  extractionJson: string;
  metadataJson: string;
  latestIndexStatus: KnowledgeIndexStatus | string;
  latestIndexJob?: ReferenceCorpusIndexJob | null;
  lastIndexedAt?: string | null;
  chunkCount: number;
  chapterChunkCount: number;
  paragraphChunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceChunk {
  id: string;
  corpusId: string;
  chunkType: ReferenceChunkType | string;
  chapterIndex?: number | null;
  paragraphIndex?: number | null;
  chunkOrder: number;
  title?: string | null;
  text: string;
  summary?: string | null;
  startOffset: number;
  endOffset: number;
  charCount: number;
  metadataJson: string;
  extractionJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceCorpusDetail extends ReferenceCorpus {
  content: string;
  chunks: ReferenceChunk[];
}

export interface ReferenceCorpusRecallHit {
  id: string;
  corpusId: string;
  score: number;
  source: "vector" | "keyword" | "reranked";
  title?: string;
  chunkText: string;
  chunkOrder: number;
  metadataJson?: string | null;
}

export interface ReferenceCorpusRecallResult {
  corpusId: string;
  query: string;
  hits: ReferenceCorpusRecallHit[];
  latestIndexStatus?: KnowledgeIndexStatus | string;
  semanticAvailable: boolean;
  semanticHitCount: number;
  keywordFallbackUsed: boolean;
  notice?: string | null;
}

export interface ReferenceCorpusStyleProfileResult {
  corpusId: string;
  styleProfile: StyleProfile;
  styleBinding?: StyleBinding | null;
}
