import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import type {
  BatchJob,
  ContinuationContextSnapshot,
  ContinuationGenerationResult,
  ContinuationWorkbenchMode,
  FromZeroGenerationResult,
  ModelCallLog,
  ModelCallUsageSummary,
  ProjectSkill,
  ReviewGateScore,
  ReviewGateResult,
  Skill,
  StatePatch,
  StatePatchStatus,
  StoryStateRuntimeSnapshot,
  WorkbenchCheckpoint,
} from "@ai-novel/shared/types/aiWorkbench";
import type {
  ReferenceCorpus,
  ReferenceCorpusExtraction,
  ReferenceCorpusIndexJob,
  ReferenceCorpusRecallResult,
  ReferenceStyleLearningDimension,
} from "@ai-novel/shared/types/referenceCorpus";
import {
  REFERENCE_STYLE_LEARNING_DIMENSION_LABELS,
  REFERENCE_STYLE_LEARNING_DIMENSIONS,
} from "@ai-novel/shared/types/referenceCorpus";
import type {
  CompiledStylePromptBlocks,
  StyleDetectionReport,
  StyleProfile,
  StyleBinding,
} from "@ai-novel/shared/types/styleEngine";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  GitBranch,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import {
  archiveReferenceCorpus,
  cancelBatchJob,
  createBatchJob,
  createFromZeroOpenBook,
  createReferenceCorpus,
  createReferenceCorpusStyleProfile,
  detectStyleLabDeviation,
  generateContinuationChapter,
  generateFromZeroBook,
  getContinuationContextSnapshot,
  getProductionChainSnapshot,
  getStoryStateRuntimeSnapshot,
  listReferenceCorpora,
  recallReferenceCorpus,
  reindexReferenceCorpus,
  listProjectSkills,
  listSkills,
  resumeBatchJob,
  setProjectSkill,
  startBatchJob,
  testWriteWithStyleProfileInWorkbench,
  updateStatePatch,
} from "@/api/aiWorkbench";
import {
  createStyleBinding,
  getStyleProfiles,
  updateStyleProfile,
} from "@/api/styleEngine";
import {
  getModelRoutes,
  getStructuredFallbackConfig,
  type ModelRoutesResponse,
  type StructuredFallbackSettings,
} from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useLLMStore } from "@/store/llmStore";
import { createDefaultNovelBasicFormState } from "../novels/novelBasicInfo.shared";
import { MODEL_ROUTE_LABELS } from "../settings/modelRouteLabels";

type JsonRecord = Record<string, unknown>;
interface WorkbenchRagReferencePreview {
  id: string;
  ownerType: string;
  ownerId: string;
  title?: string | null;
  source?: string | null;
  score?: number | null;
  chunkOrder?: number | null;
  snippet: string;
  contextPrefix?: string | null;
}

interface WorkbenchRagReferencesSummary {
  references: WorkbenchRagReferencePreview[];
  ragReferenceCount?: number | null;
  runtimeRagReferenceCount?: number | null;
  workbenchRecallCount?: number | null;
}

interface SkillReviewGateCheckPreview {
  skillId: string;
  slug: string;
  name: string;
  check: string;
  status: string;
  matchedSignalCount: number;
  highestSeverity?: string | null;
  evidence: string[];
}

interface RiskPauseSummaryItem {
  chapterOrder?: number | null;
  reviewGateResultId?: string | null;
  recommendedAction?: string | null;
  riskCount: number;
  requiredFixCount: number;
  risks: Array<{
    source?: string | null;
    severity?: string | null;
    category?: string | null;
    evidence?: string | null;
    fixSuggestion?: string | null;
  }>;
  requiredFixes: Array<{
    source?: string | null;
    severity?: string | null;
    evidence?: string | null;
    fixSuggestion?: string | null;
  }>;
}

interface StyleLabComparisonRun {
  id: string;
  sourceKey: string;
  mode: "generate" | "rewrite";
  profileId: string;
  profileName: string;
  profileCategory?: string | null;
  intensity: number;
  targetLength?: number | null;
  output: string;
  outputLength: number;
  riskScore?: number | null;
  violationCount?: number | null;
  appliedRuleCount: number;
  canAutoRewrite?: boolean | null;
  agentRunId?: string | null;
  createdAt: string;
}

const ACTIVE_BATCH_STATUSES = new Set(["queued", "running", "waiting_approval", "paused"]);
const WORKBENCH_MODEL_ROUTE_TASKS = [
  "planner",
  "writer",
  "review",
  "critical_review",
  "fact_extraction",
  "summary",
  "chat",
] as const;
const CONTINUATION_MODE_LABELS: Record<ContinuationWorkbenchMode, string> = {
  direct: "紧接续写",
  position: "指定位置",
  outline: "大纲续写",
  style: "风格续写",
};
const STYLE_LAB_MODE_LABELS: Record<"generate" | "rewrite", string> = {
  generate: "同剧情试写",
  rewrite: "原文改写",
};
const STYLE_BINDING_TARGET_LABELS: Record<string, string> = {
  novel: "当前小说",
  volume: "当前卷",
  chapter: "当前章节",
  task: "任务级",
  available: "可用画像",
};
const STYLE_COMPILED_BLOCK_LABELS: Array<[keyof Pick<CompiledStylePromptBlocks, "context" | "style" | "character" | "antiAi" | "selfCheck" | "output">, string]> = [
  ["context", "上下文块"],
  ["style", "风格块"],
  ["character", "人物块"],
  ["antiAi", "反 AI 块"],
  ["selfCheck", "自检块"],
  ["output", "输出约束"],
];
const STYLE_DETECTION_RULE_TYPE_LABELS: Record<string, string> = {
  style: "风格规则",
  character: "人物规则",
  forbidden: "反 AI 禁止",
  risk: "反 AI 风险",
  encourage: "正向建议",
};
const STYLE_DETECTION_SOURCE_LABELS: Record<string, string> = {
  global_anti_ai: "全局反 AI",
  style_anti_ai: "画像反 AI",
  style_contract: "StyleProfile 契约",
};
const STYLE_DETECTION_ISSUE_CATEGORY_LABELS: Record<string, string> = {
  style_expression: "语言表达",
  story_structure: "故事结构",
};
const STYLE_DETECTION_SEVERITY_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
};
const REFERENCE_STYLE_PRESET_OPTIONS: Array<{
  value: "imitate" | "balanced" | "transfer";
  label: string;
  summary: string;
}> = [
  { value: "balanced", label: "均衡迁移", summary: "保留写法骨架，弱化高指纹特征。" },
  { value: "imitate", label: "强风格学习", summary: "尽量贴近样章，适合内部临摹试写。" },
  { value: "transfer", label: "安全写法迁移", summary: "优先迁移通用技法，剥离高风险指纹。" },
];
const DEFAULT_REFERENCE_STYLE_DIMENSIONS = [...REFERENCE_STYLE_LEARNING_DIMENSIONS];
const REVIEW_GATE_SCORE_LABELS: Array<[keyof Pick<ReviewGateScore, "taskFit" | "continuity" | "style" | "readability" | "statePatchSafety">, string]> = [
  ["taskFit", "任务符合"],
  ["continuity", "连续性"],
  ["style", "风格"],
  ["readability", "可读性"],
  ["statePatchSafety", "状态安全"],
];
const QUALITY_DEBT_SOURCE_LABELS: Record<string, string> = {
  review_gate: "ReviewGate",
  state_patch: "StatePatch",
  deterministic_check: "确定性检查",
  style_skill_conflict: "Skill × StyleProfile",
};
const QUALITY_DEBT_ACTION_LABELS: Record<string, string> = {
  ask_user: "人工确认",
  stop_batch: "停止批量",
  revise: "修订章节",
  accept: "接受",
  human_decision: "接受或拒绝 Patch",
  review_before_generation: "生成前复核",
  monitor: "持续观察",
};
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value?: string | null): string {
  if (!value) {
    return "无";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function normalizeStyleLabComparisonText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function createStyleLabComparisonKey(mode: "generate" | "rewrite", topic: string, sourceText: string): string {
  const source = mode === "rewrite" ? sourceText : topic;
  return `${mode}:${normalizeStyleLabComparisonText(source)}`;
}

function formatQualityDebtSource(source: string): string {
  return QUALITY_DEBT_SOURCE_LABELS[source] ?? source;
}

function formatQualityDebtAction(action?: string | null): string | null {
  if (!action) {
    return null;
  }
  return QUALITY_DEBT_ACTION_LABELS[action] ?? action;
}

function parseJsonValue(raw: string | null | undefined): unknown {
  if (!raw?.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  const parsed = parseJsonValue(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function parseStringArray(raw: string | null | undefined): string[] {
  return readStringArray(parseJsonValue(raw));
}

function readJsonString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readJsonNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapRagReferences(value: unknown): WorkbenchRagReferencePreview[] {
  const candidates = Array.isArray(value) ? value : [];
  return candidates
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const id = readJsonString(item, "id") ?? `${readJsonString(item, "ownerType") ?? "rag"}:${readJsonString(item, "ownerId") ?? "unknown"}:${readJsonNumber(item, "chunkOrder") ?? 0}`;
      const snippet = readJsonString(item, "snippet") ?? readJsonString(item, "chunkText") ?? "";
      return {
        id,
        ownerType: readJsonString(item, "ownerType") ?? "unknown",
        ownerId: readJsonString(item, "ownerId") ?? "unknown",
        title: readJsonString(item, "title"),
        source: readJsonString(item, "source"),
        score: readJsonNumber(item, "score"),
        chunkOrder: readJsonNumber(item, "chunkOrder"),
        snippet,
        contextPrefix: readJsonString(item, "contextPrefix"),
      };
    })
    .filter((item) => item.snippet.trim().length > 0)
    .slice(0, 8);
}

function readRagReferencesFromJson(raw: string | null | undefined): WorkbenchRagReferencesSummary {
  const record = parseJsonRecord(raw);
  const runtimeReferences = mapRagReferences(Array.isArray(record.ragReferences)
    ? record.ragReferences
    : record.appliedRagReferences);
  const workbenchRecallReferences = mapRagReferences(record.workbenchRecallReferences);
  const seen = new Set<string>();
  const references = [...runtimeReferences, ...workbenchRecallReferences].filter((item) => {
    const key = `${item.ownerType}:${item.ownerId}:${item.id}:${item.source ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 8);
  return {
    references,
    ragReferenceCount: readJsonNumber(record, "ragReferenceCount"),
    runtimeRagReferenceCount: readJsonNumber(record, "runtimeRagReferenceCount"),
    workbenchRecallCount: readJsonNumber(record, "workbenchRecallCount"),
  };
}

function readSkillReviewGateChecksFromJson(raw: string | null | undefined): SkillReviewGateCheckPreview[] {
  const evidence = parseJsonRecord(raw);
  const skillReviewGate = evidence.skillReviewGate;
  if (!skillReviewGate || typeof skillReviewGate !== "object" || Array.isArray(skillReviewGate)) {
    return [];
  }
  const executedChecks = (skillReviewGate as JsonRecord).executedChecks;
  if (!Array.isArray(executedChecks)) {
    return [];
  }
  return executedChecks
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      skillId: readJsonString(item, "skillId") ?? "unknown",
      slug: readJsonString(item, "slug") ?? "unknown",
      name: readJsonString(item, "name") ?? "未知 Skill",
      check: readJsonString(item, "check") ?? "unknown_check",
      status: readJsonString(item, "status") ?? "checked",
      matchedSignalCount: readJsonNumber(item, "matchedSignalCount") ?? 0,
      highestSeverity: readJsonString(item, "highestSeverity"),
      evidence: readStringArray(item.evidence),
    }))
    .slice(0, 24);
}

function readRiskPauseSummaries(raw: string | null | undefined): RiskPauseSummaryItem[] {
  return parseJsonArray(raw)
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const risks = Array.isArray(item.risks)
        ? item.risks.filter((risk): risk is JsonRecord => Boolean(risk) && typeof risk === "object" && !Array.isArray(risk))
        : [];
      const requiredFixes = Array.isArray(item.requiredFixes)
        ? item.requiredFixes.filter((fix): fix is JsonRecord => Boolean(fix) && typeof fix === "object" && !Array.isArray(fix))
        : [];
      return {
        chapterOrder: readJsonNumber(item, "chapterOrder"),
        reviewGateResultId: readJsonString(item, "reviewGateResultId"),
        recommendedAction: readJsonString(item, "recommendedAction"),
        riskCount: risks.length,
        requiredFixCount: requiredFixes.length,
        risks: risks.slice(0, 6).map((risk) => ({
          source: readJsonString(risk, "source"),
          severity: readJsonString(risk, "severity"),
          category: readJsonString(risk, "category"),
          evidence: readJsonString(risk, "evidence"),
          fixSuggestion: readJsonString(risk, "fixSuggestion"),
        })),
        requiredFixes: requiredFixes.slice(0, 4).map((fix) => ({
          source: readJsonString(fix, "source"),
          severity: readJsonString(fix, "severity"),
          evidence: readJsonString(fix, "evidence"),
          fixSuggestion: readJsonString(fix, "fixSuggestion"),
        })),
      };
    })
    .slice(0, 5);
}

function readReviewGateEvidenceSummary(row: ReviewGateResult): RiskPauseSummaryItem {
  const risks = parseJsonArray(row.risksJson)
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((risk) => ({
      source: readJsonString(risk, "source"),
      severity: readJsonString(risk, "severity"),
      category: readJsonString(risk, "category"),
      evidence: readJsonString(risk, "evidence"),
      fixSuggestion: readJsonString(risk, "fixSuggestion"),
    }));
  const requiredFixes = parseJsonArray(row.requiredFixesJson)
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((fix) => ({
      source: readJsonString(fix, "source"),
      severity: readJsonString(fix, "severity"),
      evidence: readJsonString(fix, "evidence"),
      fixSuggestion: readJsonString(fix, "fixSuggestion"),
    }));
  const evidence = parseJsonRecord(row.evidenceJson);
  return {
    chapterOrder: readJsonNumber(evidence, "chapterOrder"),
    reviewGateResultId: row.id,
    recommendedAction: row.recommendedAction,
    riskCount: risks.length,
    requiredFixCount: requiredFixes.length,
    risks: risks.slice(0, 6),
    requiredFixes: requiredFixes.slice(0, 4),
  };
}

function parseJsonRecord(raw: string | null | undefined): JsonRecord {
  const parsed = parseJsonValue(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
}

function readJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function parseReviewGateScore(raw: string | null | undefined): ReviewGateScore | null {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as JsonRecord;
  const score: Partial<ReviewGateScore> = {};
  for (const [key] of REVIEW_GATE_SCORE_LABELS) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    score[key] = value;
  }
  return score as ReviewGateScore;
}

function formatJsonPreview(raw: string | null | undefined): string {
  const parsed = parseJsonValue(raw);
  if (parsed == null) {
    return "无";
  }
  if (typeof parsed === "string") {
    return parsed;
  }
  return JSON.stringify(parsed, null, 2);
}

function readRuleSummary(rules: { summary?: string | null } | null | undefined): string {
  return typeof rules?.summary === "string" ? rules.summary : "";
}

function parseReferenceCorpusExtraction(raw: string | null | undefined): ReferenceCorpusExtraction | null {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as JsonRecord;
  const styleCandidate = record.styleCandidate && typeof record.styleCandidate === "object" && !Array.isArray(record.styleCandidate)
    ? record.styleCandidate as JsonRecord
    : {};
  return {
    characters: readStringArray(record.characters),
    locations: readStringArray(record.locations),
    factions: readStringArray(record.factions),
    items: readStringArray(record.items),
    timelineCandidates: Array.isArray(record.timelineCandidates)
      ? record.timelineCandidates.filter((item): item is ReferenceCorpusExtraction["timelineCandidates"][number] =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [],
    foreshadowCandidates: Array.isArray(record.foreshadowCandidates)
      ? record.foreshadowCandidates.filter((item): item is ReferenceCorpusExtraction["foreshadowCandidates"][number] =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [],
    styleCandidate: {
      avgSentenceLength: readJsonNumber(styleCandidate, "avgSentenceLength") ?? 0,
      dialogueRatio: readJsonNumber(styleCandidate, "dialogueRatio") ?? 0,
      paragraphCount: readJsonNumber(styleCandidate, "paragraphCount") ?? 0,
      chapterCount: readJsonNumber(styleCandidate, "chapterCount") ?? 0,
      dominantPunctuation: readStringArray(styleCandidate.dominantPunctuation),
      sampleSentences: readStringArray(styleCandidate.sampleSentences),
    },
  };
}

function hasJsonContent(raw: string | null | undefined): boolean {
  const parsed = parseJsonValue(raw);
  if (parsed == null) {
    return false;
  }
  if (typeof parsed === "string") {
    return parsed.trim().length > 0;
  }
  if (Array.isArray(parsed)) {
    return parsed.length > 0;
  }
  if (typeof parsed === "object") {
    return Object.keys(parsed as JsonRecord).length > 0;
  }
  return true;
}

function statePatchCanRevert(row: StatePatch): boolean {
  if (
    row.patchType !== "chapter_review_lifecycle"
    || !["accepted", "applied", "auto_accepted"].includes(row.status)
  ) {
    return false;
  }
  const parsed = parseJsonValue(row.evidenceJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const application = (parsed as JsonRecord).application;
  if (!application || typeof application !== "object" || Array.isArray(application)) {
    return false;
  }
  const before = (application as JsonRecord).before;
  return Boolean(before && typeof before === "object" && !Array.isArray(before));
}

function parseOptionalPositiveInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const value = Number.parseInt(trimmed, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseStyleIntensity(raw: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return 0.8;
  }
  return Math.max(0.3, Math.min(value, 1));
}

function JsonPreview({ label, raw }: { label: string; raw?: string | null }) {
  if (!hasJsonContent(raw)) {
    return null;
  }
  return (
    <div className="min-w-0 rounded-md bg-muted/40 p-3">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">{label}</div>
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {formatJsonPreview(raw)}
      </pre>
    </div>
  );
}

function RagReferencesPreview({ raw }: { raw?: string | null }) {
  const summary = readRagReferencesFromJson(raw);
  const references = summary.references;
  if (references.length === 0) {
    return null;
  }
  const totalCount = summary.ragReferenceCount ?? references.length;
  return (
    <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">检索引用</span>
        <Badge variant="outline" className="border-emerald-200 bg-white text-emerald-700">展示 {references.length}</Badge>
        <Badge variant="outline" className="border-emerald-200 bg-white text-emerald-700">总计 {totalCount}</Badge>
        {summary.runtimeRagReferenceCount != null ? <span className="text-emerald-700">Runtime RAG {summary.runtimeRagReferenceCount}</span> : null}
        {summary.workbenchRecallCount != null ? <span className="text-emerald-700">Reference Corpus {summary.workbenchRecallCount}</span> : null}
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        {references.map((item) => (
          <div key={item.id} className="rounded-md border border-emerald-200 bg-white/80 p-2">
            <div className="flex flex-wrap items-center gap-2">
              {item.source ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{item.source}</Badge> : null}
              {item.ownerType ? <Badge variant="outline" className="border-emerald-200 bg-white text-emerald-700">{item.ownerType}</Badge> : null}
              <span className="font-medium">{item.title ?? `${item.ownerType}:${item.ownerId}`}</span>
              <span className="text-emerald-700">#{item.chunkOrder ?? "?"}</span>
              {typeof item.score === "number" ? <span className="text-emerald-700">score {item.score.toFixed(3)}</span> : null}
            </div>
            {item.contextPrefix ? <p className="mt-1 line-clamp-1 text-emerald-700">{item.contextPrefix}</p> : null}
            <p className="mt-1 line-clamp-3 text-emerald-800">{item.snippet}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillReviewGateChecksPreview({ checks }: { checks: SkillReviewGateCheckPreview[] }) {
  if (checks.length === 0) {
    return null;
  }
  return (
    <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Skill ReviewGate 检查</span>
        <Badge variant="outline" className="border-sky-200 bg-white text-sky-700">{checks.length}</Badge>
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        {checks.map((item) => (
          <div key={`${item.skillId}-${item.check}`} className="rounded-md border border-sky-200 bg-white/80 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={item.status} />
              <span className="font-medium">{item.name}</span>
              <span className="text-sky-700">{item.check}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-sky-700">
              <span>命中 {item.matchedSignalCount}</span>
              {item.highestSeverity ? <span>最高 {item.highestSeverity}</span> : null}
              <span>{item.slug}</span>
            </div>
            {item.evidence.length > 0 ? (
              <p className="mt-1 line-clamp-2 text-sky-800">{item.evidence[0]}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewGateScoreStrip({ score }: { score: ReviewGateScore | null }) {
  if (!score) {
    return null;
  }
  return (
    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-5">
      {REVIEW_GATE_SCORE_LABELS.map(([key, label]) => (
        <div key={key} className="rounded-md border bg-muted/30 px-2 py-2">
          <div className="text-[11px] text-muted-foreground">{label}</div>
          <div className="mt-1 font-semibold tabular-nums text-foreground">{score[key]}</div>
        </div>
      ))}
    </div>
  );
}

function statusBadgeClass(status: string): string {
  if (["succeeded", "completed", "accepted", "applied", "auto_accepted", "active", "pass", "passed", "ready", "paid", "resolved", "recorded", "low"].includes(status)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (["failed", "rejected", "reverted", "cancelled", "blocked", "error", "blocking", "high", "critical"].includes(status)) {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (["waiting_approval", "paused", "proposed", "needs_confirmation", "warning", "partial", "pending", "setup", "medium"].includes(status)) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (["not_enough_data", "candidate"].includes(status)) {
    return "border-slate-200 bg-slate-50 text-slate-500";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function SummaryCard(props: {
  label: string;
  value: string | number;
  description: string;
  icon: typeof Activity;
  tone?: "default" | "warning" | "success";
}) {
  const Icon = props.icon;
  return (
    <Card className="rounded-lg shadow-none">
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{props.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{props.value}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{props.description}</p>
        </div>
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-md border",
            props.tone === "warning" && "border-amber-200 bg-amber-50 text-amber-700",
            props.tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-700",
            !props.tone && "border-slate-200 bg-slate-50 text-slate-600",
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function FromZeroOpenBookPanel(props: {
  idea: string;
  title: string;
  styleTone: string;
  firstChapterCount: string;
  defaultChapterLength: string;
  provider: string;
  model: string;
  createdTaskId?: string | null;
  generationResult?: FromZeroGenerationResult | null;
  isCreating: boolean;
  isGenerating: boolean;
  onIdeaChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onStyleToneChange: (value: string) => void;
  onFirstChapterCountChange: (value: string) => void;
  onDefaultChapterLengthChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCreate: () => void;
  onGenerate: () => void;
}) {
  const taskLink = props.createdTaskId
    ? `/novels/auto-director?taskId=${encodeURIComponent(props.createdTaskId)}`
    : "/novels/auto-director";
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background p-4">
        <div className="mb-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">自动导演</Badge>
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">前 3 章验收默认</Badge>
          </div>
          <div>
            <h3 className="text-base font-semibold">从一句灵感启动新书</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              自动导演路径保留人工确认；直接生成路径会落库书设、角色、前 20 章大纲、前 3 章正文和 ReviewGate。
            </p>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <label className="text-xs font-medium text-muted-foreground">一句灵感</label>
            <textarea
              value={props.idea}
              onChange={(event) => props.onIdeaChange(event.target.value)}
              placeholder="例如：一个失败的底层修真者，靠能读取灵物记忆的能力重写宗门秩序。"
              className="mt-1 min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">暂定书名</label>
              <Input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} placeholder="可选" className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">风格关键词</label>
              <Input value={props.styleTone} onChange={(event) => props.onStyleToneChange(event.target.value)} placeholder="克制 / 爽感 / 悬疑" className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">首批章节</label>
              <Input
                value={props.firstChapterCount}
                onChange={(event) => props.onFirstChapterCountChange(event.target.value)}
                placeholder="3"
                inputMode="numeric"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">单章字数</label>
              <Input
                value={props.defaultChapterLength}
                onChange={(event) => props.onDefaultChapterLengthChange(event.target.value)}
                placeholder="2800"
                inputMode="numeric"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Provider</label>
              <Input value={props.provider} onChange={(event) => props.onProviderChange(event.target.value)} placeholder="留空走模型路由" className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Model</label>
              <Input value={props.model} onChange={(event) => props.onModelChange(event.target.value)} placeholder="留空走任务模型" className="mt-1" />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              留空时使用模型路由中的 planner / writer 配置；填写后只覆盖本次开书。
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" disabled={props.isCreating || !props.idea.trim()} onClick={props.onCreate}>
            {props.isCreating ? "创建中" : "创建任务并打开自动导演"}
          </Button>
          <Button type="button" variant="secondary" disabled={props.isGenerating || !props.idea.trim()} onClick={props.onGenerate}>
            {props.isGenerating ? "生成中" : "直接生成验收样本"}
          </Button>
          <Button type="button" variant="outline" asChild>
            <Link to="/novels/auto-director">打开空白自动导演</Link>
          </Button>
          {props.createdTaskId ? (
            <Button type="button" variant="outline" asChild>
              <Link to={taskLink}>继续上次开书任务</Link>
            </Button>
          ) : null}
        </div>
        {props.generationResult ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50/70 p-3 text-sm text-emerald-900">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">已生成：《{props.generationResult.novel.title}》</span>
              <Badge variant="outline" className="border-emerald-300 bg-white text-emerald-700">
                novelId {props.generationResult.novel.id}
              </Badge>
              <Badge variant="outline" className="border-emerald-300 bg-white text-emerald-700">
                AgentRun {props.generationResult.agentRunId}
              </Badge>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <div>大纲：{props.generationResult.checks.outlineChapterCount} 章</div>
              <div>正文：{props.generationResult.checks.firstChapterCount} 章</div>
              <div>ReviewGate：{props.generationResult.checks.reviewGateCount} 条</div>
              <div>StatePatch：{props.generationResult.checks.statePatchCount} 条</div>
              <div>角色：{props.generationResult.novel.characterCount} 个</div>
              <div>关系：{props.generationResult.checks.characterRelationCount ?? 0} 条</div>
              <div>StyleProfile：{props.generationResult.checks.styleProfileCount ?? 0} 个</div>
              <div>启用 Skills：{props.generationResult.checks.activeSkillCount ?? 0} 个</div>
              <div>钩子：{props.generationResult.checks.everyChapterHasHook ? "齐全" : "需检查"}</div>
            </div>
            <div className="mt-2 space-y-1">
              {props.generationResult.chapters.map((chapter) => (
                <div key={chapter.id} className="truncate">
                  第 {chapter.order} 章 {chapter.title} · {chapter.contentLength} 字符 · {chapter.hook}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {[
          ["Planner", "生成书级候选，人工确认方向。"],
          ["ContextBuilder", "汇集类型 Skill、风格规则和项目状态。"],
          ["Writer", `按执行计划生成前 ${props.firstChapterCount || "3"} 章。`],
          ["Reviewer", "ReviewGate 审核，一致性风险暂停。"],
        ].map(([label, description]) => (
          <div key={label} className="rounded-lg border bg-background p-4">
            <div className="text-sm font-medium">{label}</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("shrink-0", statusBadgeClass(status))}>
      {status}
    </Badge>
  );
}

function BatchCheckpointSummary({ row }: { row: BatchJob }) {
  const checkpoint = row.latestCheckpoint ?? null;
  const config = parseJsonRecord(row.configJson);
  const currentChapterOrder = readJsonNumber(config, "currentChapterOrder");
  const currentChapterId = readJsonString(config, "currentChapterId");
  const lastReviewGateResultId = readJsonString(config, "lastReviewGateResultId");
  const resumeIndex = Math.min(row.completedChapterCount + 1, row.requestedChapterCount);
  const hasCheckpoint = Boolean(checkpoint) || currentChapterOrder != null || currentChapterId || lastReviewGateResultId || row.completedChapterCount > 0;
  if (!hasCheckpoint) {
    return null;
  }
  return (
    <div className="mt-3 grid gap-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground sm:grid-cols-4">
      <span>恢复进度：{row.completedChapterCount}/{row.requestedChapterCount}，下一项 {resumeIndex}</span>
      <span>检查点：{checkpoint?.checkpointType ?? (currentChapterOrder != null ? `第 ${currentChapterOrder} 章` : currentChapterId ?? "未记录")}</span>
      <span>状态：{checkpoint?.status ?? row.status}</span>
      <span className="min-w-0 truncate">ReviewGate：{checkpoint?.reviewGateResultId ?? lastReviewGateResultId ?? "无"}</span>
      {checkpoint?.summary ? <span className="min-w-0 truncate sm:col-span-4">{checkpoint.summary}</span> : null}
    </div>
  );
}

function formatCost(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "无";
}

function formatLatency(value: number | null | undefined): string {
  if (typeof value !== "number") {
    return "无";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function formatOptionalTokens(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "默认";
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "无";
}

function AgentRunsPanel({ rows }: { rows: Array<{
  id: string;
  novelId?: string | null;
  chapterId?: string | null;
  status: string;
  goal: string;
  entryAgent: string;
  currentStep?: string | null;
  currentAgent?: string | null;
  roleCoverage: string[];
  steps: Array<{
    id: string;
    seq: number;
    agentName: string;
    stepType: string;
    status: string;
    inputJson?: string | null;
    outputJson?: string | null;
    error?: string | null;
    provider?: string | null;
    model?: string | null;
    createdAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}> }) {
  if (rows.length === 0) {
    return <EmptyState label="暂无 AgentRun 记录。" />;
  }
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.id} className="rounded-lg border bg-background p-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={row.status} />
            <span className="text-sm font-medium">{row.entryAgent}</span>
            <span className="text-xs text-muted-foreground">更新 {formatDate(row.updatedAt)}</span>
          </div>
          <p className="mt-2 line-clamp-2 text-sm">{row.goal}</p>
          <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <span>当前角色：{row.currentAgent ?? "无"}</span>
            <span>当前步骤：{row.currentStep ?? "无"}</span>
            <span>小说：{row.novelId ?? "未绑定"}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {["Planner", "ContextBuilder", "Writer", "Reviewer"].map((role) => (
              <Badge
                key={`${row.id}-${role}`}
                variant="outline"
                className={row.roleCoverage.includes(role)
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-slate-200 bg-slate-50 text-slate-500"}
              >
                {role}
              </Badge>
            ))}
          </div>
          {row.steps.length > 0 ? (
            <div className="mt-3 space-y-2">
              {row.steps.map((step) => (
                <div key={step.id} className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">#{step.seq}</Badge>
                    <Badge variant="outline" className={statusBadgeClass(step.status)}>{step.agentName}</Badge>
                    <span className="text-muted-foreground">{step.stepType}</span>
                    {step.provider || step.model ? <span className="text-muted-foreground">{[step.provider, step.model].filter(Boolean).join(" / ")}</span> : null}
                  </div>
                  {step.inputJson ? <JsonPreview label="输入" raw={step.inputJson} /> : null}
                  {step.outputJson ? <RagReferencesPreview raw={step.outputJson} /> : null}
                  {step.outputJson ? <JsonPreview label="输出" raw={step.outputJson} /> : null}
                  {step.error ? <p className="mt-2 text-destructive">{step.error}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function BatchJobsPanel({ rows, onAction, pendingActionId }: {
  rows: BatchJob[];
  onAction: (input: { id: string; action: "start" | "resume" | "cancel" }) => void;
  pendingActionId?: string | null;
}) {
  if (rows.length === 0) {
    return <EmptyState label="暂无批量任务。" />;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-cols-[1.1fr_0.55fr_0.6fr_0.7fr_0.8fr] gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
        <span>任务</span>
        <span>章节</span>
        <span>状态</span>
        <span>更新时间</span>
        <span>操作</span>
      </div>
      {rows.map((row) => {
        const isPending = pendingActionId === row.id;
        const canStart = row.status === "queued";
        const canResume = ["waiting_approval", "paused", "failed"].includes(row.status);
        const canCancel = ACTIVE_BATCH_STATUSES.has(row.status);
        const showRiskSummary = row.riskPauseRequired || hasJsonContent(row.riskSummaryJson);
        const riskSummaries = readRiskPauseSummaries(row.riskSummaryJson);
        return (
          <div key={row.id} className="border-b px-4 py-3 text-sm last:border-b-0">
            <div className="grid grid-cols-[1.1fr_0.55fr_0.6fr_0.7fr_0.8fr] gap-3">
              <div className="min-w-0">
                <div className="truncate">{row.jobType}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{row.currentStep ?? row.id}</div>
              </div>
              <span className="tabular-nums">{row.completedChapterCount}/{row.requestedChapterCount}</span>
              <StatusBadge status={row.status} />
              <span className="text-muted-foreground">{formatDate(row.updatedAt)}</span>
              <div className="flex flex-wrap gap-2">
                {canStart ? (
                  <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => onAction({ id: row.id, action: "start" })}>
                    启动
                  </Button>
                ) : null}
                {canResume ? (
                  <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => onAction({ id: row.id, action: "resume" })}>
                    继续
                  </Button>
                ) : null}
                {canCancel ? (
                  <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => onAction({ id: row.id, action: "cancel" })}>
                    取消
                  </Button>
                ) : null}
              </div>
            </div>
            {showRiskSummary ? (
              <div className="mt-3 space-y-3">
                <RiskPauseSummaryPreview
                  rows={riskSummaries}
                  checkpoint={row.latestCheckpoint}
                />
                <JsonPreview label="风险暂停证据" raw={row.riskSummaryJson} />
              </div>
            ) : null}
            <BatchCheckpointSummary row={row} />
          </div>
        );
      })}
    </div>
  );
}

function RiskPauseSummaryPreview({ rows, checkpoint }: {
  rows: RiskPauseSummaryItem[];
  checkpoint?: WorkbenchCheckpoint | null;
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">风险暂停</span>
        {checkpoint?.statePatchId ? (
          <Badge variant="outline" className="border-amber-200 bg-white text-amber-700">
            StatePatch {checkpoint.statePatchId}
          </Badge>
        ) : null}
        {checkpoint?.resumeStep ? (
          <Badge variant="outline" className="border-amber-200 bg-white text-amber-700">
            {checkpoint.resumeStep}
          </Badge>
        ) : null}
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        {rows.map((item, index) => (
          <div key={`${item.reviewGateResultId ?? "risk"}-${index}`} className="rounded-md border border-amber-200 bg-white/80 p-2">
            <div className="flex flex-wrap items-center gap-2">
              {typeof item.chapterOrder === "number" ? <span className="font-medium">第 {item.chapterOrder} 章</span> : null}
              {item.recommendedAction ? <StatusBadge status={item.recommendedAction} /> : null}
              <span className="text-amber-700">风险 {item.riskCount}</span>
              <span className="text-amber-700">必修 {item.requiredFixCount}</span>
            </div>
            {item.reviewGateResultId ? (
              <div className="mt-1 truncate text-amber-700">ReviewGate：{item.reviewGateResultId}</div>
            ) : null}
            <div className="mt-2 space-y-2">
              {item.risks.map((risk, riskIndex) => (
                <div key={`${risk.source ?? "risk"}-${riskIndex}`} className="rounded-md bg-amber-100/60 px-2 py-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {risk.severity ? <StatusBadge status={risk.severity} /> : null}
                    {risk.source ? <span>{risk.source}</span> : null}
                    {risk.category ? <span className="text-amber-700">{risk.category}</span> : null}
                  </div>
                  {risk.evidence ? <p className="mt-1 line-clamp-2 text-amber-800">{risk.evidence}</p> : null}
                  {risk.fixSuggestion ? <p className="mt-1 line-clamp-2 text-amber-700">{risk.fixSuggestion}</p> : null}
                </div>
              ))}
              {item.requiredFixes.length > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1">
                  <div className="font-medium">必修项</div>
                  {item.requiredFixes.map((fix, fixIndex) => (
                    <p key={`${fix.source ?? "fix"}-${fixIndex}`} className="mt-1 line-clamp-2 text-amber-800">
                      {[fix.severity, fix.source, fix.evidence, fix.fixSuggestion].filter(Boolean).join(" · ")}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CheckpointsPanel({ rows }: { rows: WorkbenchCheckpoint[] }) {
  if (rows.length === 0) {
    return <EmptyState label="暂无 Checkpoint。批量任务完成章节、风险暂停或失败时会自动记录恢复点。" />;
  }
  return (
    <div className="space-y-3">
      {rows.slice(0, 20).map((row) => (
        <div key={row.id} className="rounded-lg border bg-background p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={row.status} />
            <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{row.checkpointType}</Badge>
            <span className="text-xs text-muted-foreground">更新 {formatDate(row.updatedAt)}</span>
            {row.resolvedAt ? <span className="text-xs text-muted-foreground">关闭 {formatDate(row.resolvedAt)}</span> : null}
          </div>
          <p className="mt-2 text-sm">{row.summary ?? "无摘要"}</p>
          <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
            <span>批次：{row.batchJobId ?? "无"}</span>
            <span>章节：{row.chapterId ?? "无"}</span>
            <span>AgentRun：{row.agentRunId ?? "无"}</span>
            <span>恢复步骤：{row.resumeStep ?? "无"}</span>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <JsonPreview label="恢复载荷" raw={row.resumePayloadJson} />
            <JsonPreview label="证据" raw={row.evidenceJson} />
          </div>
        </div>
      ))}
    </div>
  );
}

function BatchJobCreatePanel(props: {
  novelId: string;
  startOrder: string;
  chapterCount: string;
  provider: string;
  model: string;
  isPending: boolean;
  onStartOrderChange: (value: string) => void;
  onChapterCountChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex flex-col gap-1">
        <h3 className="text-sm font-medium">批量生成入口</h3>
        <p className="text-xs text-muted-foreground">按方案限制一次 1-5 章；触发 ReviewGate 高风险时自动暂停。</p>
      </div>
      <div className="grid gap-2 md:grid-cols-[1fr_0.7fr_0.7fr_0.9fr_0.9fr_auto]">
        <Input value={props.novelId} disabled placeholder="先在顶部应用 novelId" />
        <Input
          value={props.startOrder}
          onChange={(event) => props.onStartOrderChange(event.target.value)}
          placeholder="起始章"
          inputMode="numeric"
        />
        <Input
          value={props.chapterCount}
          onChange={(event) => props.onChapterCountChange(event.target.value)}
          placeholder="章数 1-5"
          inputMode="numeric"
        />
        <Input
          value={props.provider}
          onChange={(event) => props.onProviderChange(event.target.value)}
          placeholder="provider，可选"
        />
        <Input
          value={props.model}
          onChange={(event) => props.onModelChange(event.target.value)}
          placeholder="model，可选"
        />
        <Button type="button" variant="outline" disabled={!props.novelId || props.isPending} onClick={props.onCreate}>
          创建并启动
        </Button>
      </div>
    </div>
  );
}

function ModelConfigurationPanel(props: {
  provider: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  modelRoutes?: ModelRoutesResponse | null;
  structuredFallback?: StructuredFallbackSettings | null;
}) {
  const routeMap = new Map((props.modelRoutes?.routes ?? []).map((route) => [route.taskType, route]));
  const configuredRouteCount = props.modelRoutes?.routes.length ?? 0;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_0.6fr_0.7fr_auto] lg:items-center">
        <div className="rounded-lg border bg-background p-4">
          <div className="text-xs text-muted-foreground">默认 Provider</div>
          <div className="mt-1 truncate text-sm font-medium">{props.provider || "未选择"}</div>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <div className="text-xs text-muted-foreground">默认 Model</div>
          <div className="mt-1 truncate text-sm font-medium">{props.model || "未选择"}</div>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <div className="text-xs text-muted-foreground">Temperature</div>
          <div className="mt-1 text-sm font-medium tabular-nums">{props.temperature}</div>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <div className="text-xs text-muted-foreground">Token 上限</div>
          <div className="mt-1 text-sm font-medium tabular-nums">{props.maxTokens ?? "默认"}</div>
        </div>
        <Button type="button" variant="outline" asChild>
          <Link to="/settings/model-routes">模型路由</Link>
        </Button>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">任务级模型路由</div>
            <div className="mt-1 text-xs text-muted-foreground">已配置 {configuredRouteCount}/{props.modelRoutes?.taskTypes.length ?? 0} 个任务，完整编辑在模型路由页面。</div>
          </div>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
            JSON 策略按任务生效
          </Badge>
        </div>
        <div className="mt-3 grid gap-2 xl:grid-cols-2">
          {WORKBENCH_MODEL_ROUTE_TASKS.map((taskType) => {
            const route = routeMap.get(taskType);
            const label = MODEL_ROUTE_LABELS[taskType];
            return (
              <div key={taskType} className="rounded-md border bg-muted/20 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{label?.title ?? taskType}</span>
                  <Badge variant="outline" className={route ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                    {route ? "configured" : "default"}
                  </Badge>
                  <span className="text-muted-foreground">{taskType}</span>
                </div>
                <div className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
                  <span className="min-w-0 truncate">模型：{route ? `${route.provider} / ${route.model}` : "系统默认路由"}</span>
                  <span>Temperature：<span className="tabular-nums">{route?.temperature ?? "默认"}</span></span>
                  <span>Token：<span className="tabular-nums">{formatOptionalTokens(route?.maxTokens)}</span></span>
                  <span>JSON：{route?.structuredResponseFormat ?? "auto"} / {route?.requestProtocol ?? "auto"}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">结构化备用模型</span>
            <Badge variant="outline" className={props.structuredFallback?.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-700"}>
              {props.structuredFallback?.enabled ? "enabled" : "disabled"}
            </Badge>
            <span>{props.structuredFallback?.enabled ? `${props.structuredFallback.provider} / ${props.structuredFallback.model}` : "未启用"}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-3">
            <span>Temperature：<span className="tabular-nums">{props.structuredFallback?.temperature ?? "默认"}</span></span>
            <span>Token：<span className="tabular-nums">{formatOptionalTokens(props.structuredFallback?.maxTokens)}</span></span>
            <span>JSON 修复重试：<span className="tabular-nums">{props.structuredFallback?.maxRepairAttempts ?? 1}</span></span>
            <span>用途：结构化 JSON 失败后的统一回退</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelUsageSummaryCard({ summary }: { summary: ModelCallUsageSummary }) {
  return (
    <div className={cn("rounded-lg border bg-background p-4", !summary.available && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{summary.label}</div>
        {!summary.available ? <Badge variant="outline">未选择项目</Badge> : null}
      </div>
      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <span>调用 <strong className="font-medium text-foreground tabular-nums">{summary.callCount}</strong></span>
        <span>失败 <strong className="font-medium text-foreground tabular-nums">{summary.failedCallCount}</strong></span>
        <span>Token <strong className="font-medium text-foreground tabular-nums">{summary.totalTokens}</strong></span>
        <span>成本 <strong className="font-medium text-foreground tabular-nums">{formatCost(summary.costUsd)}</strong></span>
        <span>Prompt <strong className="font-medium text-foreground tabular-nums">{summary.promptTokens}</strong></span>
        <span>Completion <strong className="font-medium text-foreground tabular-nums">{summary.completionTokens}</strong></span>
        <span className="sm:col-span-2">平均耗时 <strong className="font-medium text-foreground tabular-nums">{formatLatency(summary.averageLatencyMs)}</strong></span>
      </div>
    </div>
  );
}

function ModelCallsPanel({
  rows,
  summary,
}: {
  rows: ModelCallLog[];
  summary?: {
    currentFilter: ModelCallUsageSummary;
    today: ModelCallUsageSummary;
    projectTotal: ModelCallUsageSummary;
  };
}) {
  return (
    <div className="space-y-3">
      {summary ? (
        <div className="grid gap-3 xl:grid-cols-3">
          <ModelUsageSummaryCard summary={summary.currentFilter} />
          <ModelUsageSummaryCard summary={summary.today} />
          <ModelUsageSummaryCard summary={summary.projectTotal} />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState label="暂无模型调用日志。已接入的 AgentStep token 记录会自动进入这里。" />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="grid grid-cols-[1fr_1fr_0.9fr_0.7fr_0.7fr_0.6fr_0.8fr] gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>任务</span>
            <span>模型</span>
            <span>Token</span>
            <span>成本</span>
            <span>耗时</span>
            <span>状态</span>
            <span>时间</span>
          </div>
          {rows.map((row) => (
            <div key={row.id} className="border-b px-4 py-3 text-sm last:border-b-0">
              <div className="grid grid-cols-[1fr_1fr_0.9fr_0.7fr_0.7fr_0.6fr_0.8fr] gap-3">
                <span className="min-w-0 truncate">{row.taskType}</span>
                <span className="min-w-0 truncate">{row.provider} / {row.model}</span>
                <span className="tabular-nums">{row.promptTokens}/{row.completionTokens}/{row.totalTokens}</span>
                <span className="tabular-nums">{formatCost(row.costUsd)}</span>
                <span className="tabular-nums text-muted-foreground">{formatLatency(row.latencyMs)}</span>
                <StatusBadge status={row.status} />
                <span className="text-muted-foreground">{formatDate(row.createdAt)}</span>
              </div>
              {row.error ? <p className="mt-2 line-clamp-2 text-xs text-red-600">{row.error}</p> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewGatePanel({ rows }: { rows: ReviewGateResult[] }) {
  if (rows.length === 0) {
    return <EmptyState label="暂无 ReviewGate 结果。章节审校完成后会自动写入。" />;
  }
  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const risks = parseJsonArray(row.risksJson);
        const fixes = parseJsonArray(row.requiredFixesJson);
        const hasEvidence = hasJsonContent(row.evidenceJson);
        const reviewGateScore = parseReviewGateScore(row.scoreJson);
        const skillChecks = readSkillReviewGateChecksFromJson(row.evidenceJson);
        return (
          <div key={row.id} className="rounded-lg border bg-background p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={row.pass ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}>
                {row.pass ? "pass" : "blocked"}
              </Badge>
              <StatusBadge status={row.recommendedAction} />
              {row.needsHumanConfirmation ? (
                <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">需要确认</Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">{row.sourceType} · {formatDate(row.createdAt)}</span>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              <span>章节：{row.chapterId ?? "未绑定"}</span>
              <span>风险：{risks.length}</span>
              <span>必修项：{fixes.length}</span>
            </div>
            <ReviewGateScoreStrip score={reviewGateScore} />
            <div className="mt-3">
              <SkillReviewGateChecksPreview checks={skillChecks} />
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <JsonPreview label="评分" raw={row.scoreJson} />
              {risks.length > 0 ? <JsonPreview label="风险" raw={row.risksJson} /> : null}
              {fixes.length > 0 ? <JsonPreview label="必修项" raw={row.requiredFixesJson} /> : null}
              {hasEvidence ? <JsonPreview label="证据" raw={row.evidenceJson} /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatePatchesPanel({ rows, reviewGateResults, onDecision, pendingPatchId }: {
  rows: StatePatch[];
  reviewGateResults: ReviewGateResult[];
  onDecision: (input: { id: string; status: Extract<StatePatchStatus, "accepted" | "rejected" | "reverted"> }) => void;
  pendingPatchId?: string | null;
}) {
  if (rows.length === 0) {
    return <EmptyState label="暂无 StatePatch。章节审校和状态回灌后会显示在这里。" />;
  }
  const reviewGateById = new Map(reviewGateResults.map((row) => [row.id, row]));
  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const isProposed = row.status === "proposed" || row.status === "needs_confirmation";
        const canRevert = statePatchCanRevert(row);
        const isPending = pendingPatchId === row.id;
        const evidence = parseJsonRecord(row.evidenceJson);
        const reviewGateResultId = row.reviewGateResultId ?? readJsonString(evidence, "reviewGateResultId");
        const sourceType = readJsonString(evidence, "sourceType");
        const pass = evidence.pass;
        const reviewGateResult = reviewGateResultId ? reviewGateById.get(reviewGateResultId) : undefined;
        const gateSummary = reviewGateResult ? readReviewGateEvidenceSummary(reviewGateResult) : null;
        const hasGateSignals = gateSummary ? gateSummary.risks.length > 0 || gateSummary.requiredFixes.length > 0 : false;
        return (
          <div key={row.id} className="rounded-lg border bg-background p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <StatusBadge status={row.status} />
                <Badge variant="outline" className={statusBadgeClass(row.riskLevel)}>
                  {row.riskLevel}
                </Badge>
                <span className="text-sm font-medium">{row.patchType}</span>
                <span className="text-xs text-muted-foreground">{formatDate(row.updatedAt)}</span>
              </div>
              {isProposed || canRevert ? (
                <div className="flex shrink-0 flex-wrap gap-2">
                  {isProposed ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                        onClick={() => onDecision({ id: row.id, status: "accepted" })}
                      >
                        接受并应用
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                        onClick={() => onDecision({ id: row.id, status: "rejected" })}
                      >
                        拒绝
                      </Button>
                    </>
                  ) : null}
                  {canRevert ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => onDecision({ id: row.id, status: "reverted" })}
                    >
                      撤销
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              <span>目标：{row.targetType}</span>
              <span>章节：{row.chapterId ?? "未绑定"}</span>
              <span>批次：{row.batchJobId ?? "未绑定"}</span>
              <span>应用：{formatDate(row.appliedAt)}</span>
            </div>
            <div className="mt-2 grid gap-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground sm:grid-cols-3">
              <span className="min-w-0 truncate">ReviewGate：{reviewGateResultId ?? "未绑定"}</span>
              <span>来源：{sourceType ?? "无"}</span>
              <span>门禁通过：{typeof pass === "boolean" ? (pass ? "是" : "否") : "未知"}</span>
            </div>
            {row.decisionNote ? (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                决策备注：{row.decisionNote}
              </div>
            ) : null}
            {reviewGateResult ? (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">人工确认依据</span>
                  <StatusBadge status={reviewGateResult.recommendedAction} />
                  {reviewGateResult.needsHumanConfirmation ? (
                    <Badge variant="outline" className="border-amber-300 bg-amber-100 text-amber-800">需要确认</Badge>
                  ) : null}
                  <span className="text-amber-700">
                    风险 {gateSummary?.riskCount ?? 0} / 必修项 {gateSummary?.requiredFixCount ?? 0}
                  </span>
                </div>
                {hasGateSignals ? (
                  <div className="mt-2 grid gap-2 lg:grid-cols-2">
                    {gateSummary?.risks.slice(0, 3).map((risk, index) => (
                      <div key={`risk-${row.id}-${index}`} className="rounded-md border border-amber-200 bg-white/70 p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {risk.severity ? <Badge variant="outline" className={statusBadgeClass(risk.severity)}>{risk.severity}</Badge> : null}
                          <span className="font-medium">{risk.source ?? risk.category ?? "风险证据"}</span>
                        </div>
                        {risk.evidence ? <p className="mt-1 line-clamp-2 text-amber-800">证据：{risk.evidence}</p> : null}
                        {risk.fixSuggestion ? <p className="mt-1 line-clamp-2 text-amber-700">建议：{risk.fixSuggestion}</p> : null}
                      </div>
                    ))}
                    {gateSummary?.requiredFixes.slice(0, 3).map((fix, index) => (
                      <div key={`fix-${row.id}-${index}`} className="rounded-md border border-red-200 bg-white/70 p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {fix.severity ? <Badge variant="outline" className={statusBadgeClass(fix.severity)}>{fix.severity}</Badge> : null}
                          <span className="font-medium">必修项：{fix.source ?? "ReviewGate"}</span>
                        </div>
                        {fix.evidence ? <p className="mt-1 line-clamp-2 text-red-800">证据：{fix.evidence}</p> : null}
                        {fix.fixSuggestion ? <p className="mt-1 line-clamp-2 text-red-700">处理：{fix.fixSuggestion}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-amber-700">ReviewGate 要求人工确认；若接受，将立即应用该 Patch，若拒绝，则保留当前主事实源状态。</p>
                )}
              </div>
            ) : null}
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <JsonPreview label="Patch" raw={row.patchJson} />
              <JsonPreview label="证据" raw={row.evidenceJson} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CompactStringList({ label, values, empty = "无" }: { label: string; values: string[]; empty?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 p-2">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {values.length === 0 ? (
          <span className="text-xs text-muted-foreground">{empty}</span>
        ) : values.slice(0, 8).map((value) => (
          <Badge key={`${label}-${value}`} variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
            {value}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function SkillsPanel({ rows, projectSkills, novelId, pendingSkillId, onToggle }: {
  rows: Skill[];
  projectSkills: ProjectSkill[];
  novelId: string;
  pendingSkillId?: string | null;
  onToggle: (input: { skillId: string; enabled: boolean; priority: number }) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState label="暂无已注册 Skill。" />;
  }
  const projectSkillBySkillId = new Map(projectSkills.map((item) => [item.skillId, item]));
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {rows.map((row) => {
        const projectSkill = projectSkillBySkillId.get(row.id);
        const enabled = projectSkill?.enabled ?? false;
        const conflictKeys = parseStringArray(row.conflictKeysJson);
        const metadata = parseJsonRecord(row.metadataJson);
        const version = projectSkill?.skillVersion ?? row.latestVersion ?? null;
        const skillTypes = readStringArray(metadata.type);
        const stateRequirements = readStringArray(metadata.stateRequirements);
        const stateSchema = readJsonRecord(metadata.stateSchema);
        const stateSchemaProperties = readJsonRecord(stateSchema.properties);
        const stateFields = Array.from(new Set([...stateRequirements, ...Object.keys(stateSchemaProperties)]));
        const riskTriggers = readStringArray(metadata.riskTriggers);
        const visualFocus = readStringArray(metadata.visualFocus);
        const rules = readJsonRecord(metadata.rules);
        const examples = readJsonRecord(metadata.examples);
        const directoryAssets = [
          typeof metadata.readme === "string" && metadata.readme.trim().length > 0 ? "README" : "",
          Object.keys(stateSchemaProperties).length > 0 ? `state.schema ${Object.keys(stateSchemaProperties).length}` : "",
          Object.keys(rules).length > 0 ? `rules ${Object.keys(rules).length}` : "",
          Object.keys(examples).length > 0 ? `examples ${Object.keys(examples).length}` : "",
        ].filter(Boolean);
        const promptHooks = parseJsonRecord(version?.promptHooksJson);
        const reviewGateChecks = parseStringArray(version?.reviewGateChecksJson);
        const conflictJson = parseJsonArray(projectSkill?.conflictJson);
        const isPending = pendingSkillId === row.id;
        return (
          <div key={row.id} className="rounded-lg border bg-background p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{row.name}</span>
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{row.category}</Badge>
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{row.sourceType}</Badge>
                  <StatusBadge status={enabled ? "active" : "disabled"} />
                </div>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <span>slug：{row.slug}</span>
                  <span>优先级：{projectSkill?.priority ?? row.priority}</span>
                  <span>默认启用：{row.defaultEnabled ? "是" : "否"}</span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!novelId || isPending}
                onClick={() => onToggle({ skillId: row.id, enabled: !enabled, priority: projectSkill?.priority ?? row.priority })}
              >
                {enabled ? "禁用" : "启用"}
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>冲突键：{conflictKeys.length > 0 ? conflictKeys.join(", ") : "无"}</span>
              {projectSkill ? <StatusBadge status={projectSkill.conflictStatus} /> : null}
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <CompactStringList label="Skill 类型" values={skillTypes.length > 0 ? skillTypes : [row.category]} />
              <CompactStringList label="状态字段" values={stateFields} />
              <CompactStringList label="ReviewGate 检查项" values={reviewGateChecks} />
              <CompactStringList label="风险暂停条件" values={riskTriggers} />
              <CompactStringList label="可视化重点" values={visualFocus} />
              <CompactStringList label="目录包资产" values={directoryAssets} />
              <div className="min-w-0 rounded-md bg-muted/40 p-2">
                <div className="text-[11px] font-medium text-muted-foreground">Prompt Hooks</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.keys(promptHooks).length === 0 ? (
                    <span className="text-xs text-muted-foreground">无</span>
                  ) : Object.keys(promptHooks).slice(0, 8).map((hook) => (
                    <Badge key={`${row.id}-${hook}`} variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                      {hook}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            {conflictJson.length > 0 ? (
              <pre className="mt-3 max-h-24 overflow-auto rounded-md bg-amber-50 p-3 text-xs text-amber-800">
                {JSON.stringify(conflictJson, null, 2)}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function StoryStatePanel(props: {
  snapshot: StoryStateRuntimeSnapshot | null | undefined;
  hasNovelId: boolean;
  isLoading: boolean;
}) {
  if (!props.hasNovelId) {
    return <EmptyState label="输入 novelId 并应用过滤后加载 StoryState 运行快照。" />;
  }
  if (props.isLoading && !props.snapshot) {
    return <EmptyState label="正在加载 StoryState 运行快照。" />;
  }
  const snapshot = props.snapshot;
  if (!snapshot) {
    return <EmptyState label="暂无 StoryState 数据。" />;
  }

  const issueCount = snapshot.deterministicChecks.reduce((sum, check) => sum + check.totalIssues, 0);
  const blockedCount = snapshot.deterministicChecks.filter((check) => check.status === "blocked").length;
  const blockingDebtCount = snapshot.qualityDebt.filter((item) => item.severity === "blocking").length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-5">
        <div className="rounded-lg border bg-background p-4">
          <p className="text-xs text-muted-foreground">小说</p>
          <p className="mt-1 truncate text-sm font-medium">{snapshot.novel.title}</p>
          <p className="mt-2 text-xs text-muted-foreground">章节：{snapshot.currentChapterOrder ?? "无"} / {snapshot.novel.latestChapterOrder ?? "无"}</p>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <p className="text-xs text-muted-foreground">最新快照</p>
          <p className="mt-1 text-sm font-medium">{snapshot.latestSnapshot ? `第 ${snapshot.latestSnapshot.sourceChapterOrder ?? "未知"} 章` : "无"}</p>
          <p className="mt-2 text-xs text-muted-foreground">更新：{formatDate(snapshot.latestSnapshot?.updatedAt)}</p>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <p className="text-xs text-muted-foreground">确定性检查</p>
          <p className="mt-1 text-sm font-medium tabular-nums">{snapshot.deterministicChecks.length} 项 / {issueCount} 个问题</p>
          <p className="mt-2 text-xs text-muted-foreground">阻断：{blockedCount}</p>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <p className="text-xs text-muted-foreground">质量债</p>
          <p className="mt-1 text-sm font-medium tabular-nums">{snapshot.qualityDebt.length} 项</p>
          <p className="mt-2 text-xs text-muted-foreground">阻断：{blockingDebtCount}</p>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <p className="text-xs text-muted-foreground">待处理状态</p>
          <p className="mt-1 text-sm font-medium tabular-nums">{snapshot.statePatches.length} Patch / {snapshot.reviewGateResults.length} Gate</p>
          <p className="mt-2 text-xs text-muted-foreground">生成：{formatDate(snapshot.generatedAt)}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">覆盖率</h3>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">Postgres 聚合</Badge>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {snapshot.coverage.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="min-w-0 truncate">{item.label}</span>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs tabular-nums text-muted-foreground">{item.count}</span>
                <Badge variant="outline" className={statusBadgeClass(item.status)}>{item.status}</Badge>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">质量债</h3>
          <Badge variant="outline" className={statusBadgeClass(blockingDebtCount > 0 ? "blocked" : snapshot.qualityDebt.length > 0 ? "warning" : "pass")}>
            {blockingDebtCount > 0 ? "blocked" : snapshot.qualityDebt.length > 0 ? "warning" : "pass"}
          </Badge>
        </div>
        {snapshot.qualityDebt.length === 0 ? (
          <EmptyState label="暂无质量债。ReviewGate、StatePatch 和确定性检查的问题会汇总到这里。" />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {snapshot.qualityDebt.slice(0, 8).map((item) => (
              <div key={item.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusBadgeClass(item.severity)}>{item.severity}</Badge>
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{formatQualityDebtSource(item.source)}</Badge>
                  {item.status ? <StatusBadge status={item.status} /> : null}
                  <span className="font-medium">{item.title}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{item.summary}</p>
                <div className="mt-2 grid gap-2 rounded-md bg-muted/30 p-2 text-xs text-muted-foreground sm:grid-cols-2">
                  <span className="min-w-0 truncate">来源 ID：{item.sourceId}</span>
                  <span className="min-w-0 truncate">类别：{item.category}</span>
                  <span>
                    定位：{item.chapterOrder ? `第 ${item.chapterOrder} 章` : "全局"}
                    {item.chapterTitle ? ` · ${item.chapterTitle}` : ""}
                  </span>
                  <span>更新：{formatDate(item.updatedAt)}</span>
                  {item.recommendedAction ? (
                    <span className="sm:col-span-2">建议动作：{formatQualityDebtAction(item.recommendedAction)}</span>
                  ) : null}
                </div>
                {item.evidence.length > 0 ? (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">证据：{item.evidence.join("；")}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">确定性检查</h3>
          <Badge variant="outline" className={statusBadgeClass(blockedCount > 0 ? "blocked" : issueCount > 0 ? "warning" : "pass")}>
            {blockedCount > 0 ? "blocked" : issueCount > 0 ? "warning" : "pass"}
          </Badge>
        </div>
        <div className="space-y-3">
          {snapshot.deterministicChecks.map((check) => (
            <div key={check.key} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{check.label}</span>
                <Badge variant="outline" className={statusBadgeClass(check.status)}>{check.status}</Badge>
                <Badge variant="outline" className={statusBadgeClass(check.coverage)}>{check.coverage}</Badge>
                <span className="text-xs text-muted-foreground">{check.totalIssues} 个问题</span>
              </div>
              {check.issues.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {check.issues.slice(0, 3).map((issue) => (
                    <div key={issue.id} className="rounded-md bg-muted/40 p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={statusBadgeClass(issue.severity)}>{issue.severity}</Badge>
                        <span className="font-medium">{issue.title}</span>
                      </div>
                      <p className="mt-2 text-muted-foreground">{issue.summary}</p>
                      {issue.evidence.length > 0 ? (
                        <p className="mt-2 line-clamp-2 text-muted-foreground">证据：{issue.evidence.join("；")}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-medium">当前角色</h3>
          {snapshot.characters.length === 0 ? (
            <EmptyState label="暂无角色记录。" />
          ) : (
            <div className="mt-3 space-y-2">
              {snapshot.characters.slice(0, 8).map((character) => (
                <div key={character.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{character.name}</span>
                    <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{character.role}</Badge>
                    {character.availability ? <StatusBadge status={character.availability} /> : null}
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                    {character.currentState ?? character.currentGoal ?? character.currentLocation ?? "暂无当前状态"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-medium">开放冲突与伏笔</h3>
          <div className="mt-3 space-y-2">
            {snapshot.openConflicts.slice(0, 5).map((conflict) => (
              <div key={conflict.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusBadgeClass(conflict.severity)}>{conflict.severity}</Badge>
                  <span className="font-medium">{conflict.title}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{conflict.summary}</p>
              </div>
            ))}
            {snapshot.timeline.hooks.slice(0, 5).map((hook) => (
              <div key={hook.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={hook.status} />
                  <span className="font-medium">{hook.title}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  创建第 {hook.createdInChapterIndex} 章；预期解决：{hook.expectedResolveByChapterIndex ?? "未设置"}
                </p>
              </div>
            ))}
            {snapshot.openConflicts.length === 0 && snapshot.timeline.hooks.length === 0 ? (
              <EmptyState label="暂无开放冲突或未解决伏笔。" />
            ) : null}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">启用 Skills</h3>
          {snapshot.styleSkillConflicts.length > 0 ? (
            <Badge variant="outline" className={statusBadgeClass(snapshot.styleSkillConflicts.some((item) => item.severity === "error") ? "error" : "warning")}>
              StyleProfile 冲突提示 {snapshot.styleSkillConflicts.length}
            </Badge>
          ) : null}
        </div>
        {snapshot.styleSkillConflicts.length > 0 ? (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {snapshot.styleSkillConflicts.slice(0, 4).map((item) => (
              <div key={item.id} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusBadgeClass(item.severity)}>{item.severity}</Badge>
                  <span className="font-medium">{item.skillName}</span>
                  <span className="text-xs text-amber-700">×</span>
                  <span className="font-medium">{item.styleProfileName}</span>
                </div>
                <p className="mt-2 text-xs text-amber-800">{item.recommendedAction}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-amber-700">
                  {item.conflictKeys.map((key) => <span key={`${item.id}-${key}`}>{key}</span>)}
                </div>
                {item.evidence.length > 0 ? (
                  <p className="mt-2 line-clamp-2 text-xs text-amber-700">证据：{item.evidence.join("；")}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {snapshot.activeSkills.length === 0 ? (
          <div className="mt-3">
            <EmptyState label="当前小说未启用 Skill。" />
          </div>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {snapshot.activeSkills.map((skill) => (
              <div key={skill.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{skill.name}</span>
                  <Badge variant="outline" className={statusBadgeClass(skill.conflictStatus)}>
                    {skill.conflictStatus}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{skill.category} · P{skill.priority}</span>
                </div>
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {skill.promptHooks.write ? <p className="line-clamp-2">写作：{skill.promptHooks.write}</p> : null}
                  {skill.stateRequirements.length > 0 ? <p className="line-clamp-1">状态：{skill.stateRequirements.slice(0, 6).join(" / ")}</p> : null}
                  {skill.reviewGateChecks.length > 0 ? <p className="line-clamp-1">门禁：{skill.reviewGateChecks.slice(0, 6).join(" / ")}</p> : null}
                  {skill.riskTriggers.length > 0 ? <p className="line-clamp-1">风险：{skill.riskTriggers.slice(0, 6).join(" / ")}</p> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


function ChapterTreePanel(props: {
  snapshot: StoryStateRuntimeSnapshot | null | undefined;
  hasNovelId: boolean;
  isLoading: boolean;
  currentChapterOrder?: number;
  onOpenBatchPanel: () => void;
}) {
  if (!props.hasNovelId) return <EmptyState label="输入 novelId 后加载章节树。" />;
  if (props.isLoading && !props.snapshot) return <EmptyState label="正在加载章节树。" />;
  const snapshot = props.snapshot;
  if (!snapshot) return <EmptyState label="暂无章节树数据。" />;
  if (snapshot.chapterTree.length === 0) return <EmptyState label="暂无章节记录。" />;

  const volumeGroups = Array.from(snapshot.chapterTree.reduce((groups, chapter) => {
    const key = chapter.volumeId ?? `unassigned:${chapter.volumeTitle ?? "未分卷"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.chapters.push(chapter);
      return groups;
    }
    groups.set(key, {
      key,
      title: chapter.volumeTitle ?? "未分卷",
      order: chapter.volumeOrder ?? null,
      chapters: [chapter],
    });
    return groups;
  }, new Map<string, {
    key: string;
    title: string;
    order: number | null;
    chapters: typeof snapshot.chapterTree;
  }>()).values()).sort((left, right) =>
    (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
    || left.title.localeCompare(right.title, "zh-Hans-CN"));
  const currentChapter = typeof props.currentChapterOrder === "number"
    ? snapshot.chapterTree.find((chapter) => chapter.order === props.currentChapterOrder)
    : null;
  const draftedCount = snapshot.chapterTree.filter((chapter) => chapter.contentLength > 0).length;
  const pendingCount = snapshot.chapterTree.length - draftedCount;
  const averageQuality = snapshot.chapterTree
    .map((chapter) => chapter.qualityScore)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  const averageQualityLabel = averageQuality.length > 0
    ? Math.round(averageQuality.reduce((sum, score) => sum + score, 0) / averageQuality.length)
    : "无";

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">书 / 卷 / 章节结构</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              书：{snapshot.novel.title || snapshot.novel.id} · 卷 {volumeGroups.length} · 章节 {snapshot.chapterTree.length} · 已有正文 {draftedCount} · 待生成 {pendingCount}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={props.onOpenBatchPanel}>
            打开批量生成入口
          </Button>
        </div>
        <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">当前章节位置</div>
            <div className="mt-1 font-medium">
              {currentChapter
                ? `${currentChapter.volumeTitle ?? "未分卷"} / 第 ${currentChapter.order} 章`
                : typeof props.currentChapterOrder === "number"
                  ? `未找到第 ${props.currentChapterOrder} 章`
                  : "顶部输入章节号后高亮"}
            </div>
            {currentChapter ? <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{currentChapter.title}</div> : null}
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">质量均值</div>
            <div className="mt-1 font-medium tabular-nums">{averageQualityLabel}</div>
            <div className="mt-1 text-xs text-muted-foreground">来自已有章节质量分</div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">批量生成范围</div>
            <div className="mt-1 font-medium">1-5 章 / 风险暂停</div>
            <div className="mt-1 text-xs text-muted-foreground">复用生产链中的 BatchJob 与 ReviewGate</div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="grid grid-cols-[0.45fr_1.5fr_0.8fr_0.8fr_0.7fr_0.7fr] gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
          <span>章序</span>
          <span>标题</span>
          <span>生成状态</span>
          <span>字数</span>
          <span>质量</span>
          <span>风险</span>
        </div>
        {volumeGroups.map((group) => (
          <div key={group.key}>
            <div className="border-b bg-slate-50 px-4 py-2 text-xs font-medium text-slate-700">
              {group.order != null ? `第 ${group.order} 卷 · ` : ""}{group.title} · {group.chapters.length} 章
            </div>
            {group.chapters.map((chapter) => {
              const isCurrent = currentChapter?.id === chapter.id;
              return (
                <div
                  key={chapter.id}
                  className={cn(
                    "grid grid-cols-[0.45fr_1.5fr_0.8fr_0.8fr_0.7fr_0.7fr] gap-3 border-b px-4 py-3 text-sm last:border-b-0",
                    isCurrent && "border-l-4 border-l-sky-400 bg-sky-50/60",
                  )}
                >
                  <span className="tabular-nums">
                    {chapter.order}
                    {isCurrent ? <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">当前</span> : null}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{chapter.title}</div>
                    {chapter.summary ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">摘要：{chapter.summary}</div> : null}
                    {chapter.goal ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">目标：{chapter.goal}</div> : null}
                    {chapter.hook ? <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">钩子：{chapter.hook}</div> : null}
                    <div className="mt-1 text-xs text-muted-foreground">更新 {formatDate(chapter.updatedAt)}</div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={chapter.generationState} />
                    {chapter.chapterStatus ? <StatusBadge status={chapter.chapterStatus} /> : null}
                  </div>
                  <span className="tabular-nums text-muted-foreground">{chapter.contentLength}{chapter.targetWordCount ? ` / ${chapter.targetWordCount}` : ""}</span>
                  <span className="tabular-nums text-muted-foreground">{chapter.qualityScore ?? "无"} / {chapter.continuityScore ?? "无"}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{chapter.riskFlags || "无"}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function RelationshipGraphPanel(props: {
  snapshot: StoryStateRuntimeSnapshot | null | undefined;
  hasNovelId: boolean;
  isLoading: boolean;
}) {
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  if (!props.hasNovelId) return <EmptyState label="输入 novelId 后加载人物关系图。" />;
  if (props.isLoading && !props.snapshot) return <EmptyState label="正在加载人物关系图。" />;
  const snapshot = props.snapshot;
  if (!snapshot) return <EmptyState label="暂无人物关系数据。" />;
  if (snapshot.characters.length === 0 && snapshot.relations.length === 0) return <EmptyState label="暂无角色或关系记录。" />;

  const visibleCharacters = snapshot.characters.slice(0, 12);
  const selectedCharacter = snapshot.characters.find((character) => character.id === selectedCharacterId)
    ?? visibleCharacters[0]
    ?? snapshot.characters[0]
    ?? null;
  const effectiveSelectedCharacterId = selectedCharacter?.id ?? null;
  const graphNodes = visibleCharacters.map((character, index) => {
    const angle = visibleCharacters.length <= 1 ? -Math.PI / 2 : (Math.PI * 2 * index) / visibleCharacters.length - Math.PI / 2;
    return {
      character,
      x: visibleCharacters.length <= 1 ? 50 : 50 + 39 * Math.cos(angle),
      y: visibleCharacters.length <= 1 ? 50 : 50 + 35 * Math.sin(angle),
    };
  });
  const graphNodeById = new Map(graphNodes.map((node) => [node.character.id, node]));
  const graphEdges = snapshot.relations
    .map((relation) => ({
      relation,
      source: graphNodeById.get(relation.sourceCharacterId),
      target: graphNodeById.get(relation.targetCharacterId),
    }))
    .filter((edge): edge is {
      relation: typeof snapshot.relations[number];
      source: typeof graphNodes[number];
      target: typeof graphNodes[number];
    } => Boolean(edge.source && edge.target));
  const selectedRelations = effectiveSelectedCharacterId
    ? snapshot.relations.filter(
      (relation) =>
        relation.sourceCharacterId === effectiveSelectedCharacterId
        || relation.targetCharacterId === effectiveSelectedCharacterId,
    )
    : [];
  const selectedEvidenceChapterOrders = Array.from(new Set(
    selectedRelations.flatMap((relation) => relation.evidenceChapterOrders),
  )).sort((left, right) => left - right);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">人物关系图</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                点击节点查看证据章节；图中展示前 {visibleCharacters.length} 个角色和 {graphEdges.length} 条可连线关系。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">角色 {snapshot.characters.length}</Badge>
              <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">关系 {snapshot.relations.length}</Badge>
            </div>
          </div>
          <div className="relative h-80 overflow-hidden rounded-lg border bg-muted/20">
            <svg className="absolute inset-0 h-full w-full" role="img" aria-label="人物关系连线">
              {graphEdges.map(({ relation, source, target }) => {
                const stroke = typeof relation.conflictScore === "number" && relation.conflictScore >= 70
                  ? "#dc2626"
                  : typeof relation.trustScore === "number" && relation.trustScore >= 70
                    ? "#059669"
                    : "#94a3b8";
                const strokeWidth = Math.max(1.5, Math.min(4, ((relation.conflictScore ?? relation.trustScore ?? 35) / 30)));
                return (
                  <line
                    key={relation.id}
                    x1={`${source.x}%`}
                    y1={`${source.y}%`}
                    x2={`${target.x}%`}
                    y2={`${target.y}%`}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeOpacity="0.72"
                  />
                );
              })}
            </svg>
            {graphNodes.map(({ character, x, y }) => {
              const selected = character.id === effectiveSelectedCharacterId;
              return (
                <button
                  key={character.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedCharacterId(character.id)}
                  className={cn(
                    "absolute max-w-28 -translate-x-1/2 -translate-y-1/2 rounded-lg border px-2 py-1 text-center text-xs shadow-sm transition",
                    selected
                      ? "border-sky-400 bg-sky-50 text-sky-900"
                      : "border-slate-200 bg-background text-foreground hover:border-sky-300",
                  )}
                  style={{ left: `${x}%`, top: `${y}%` }}
                >
                  <span className="block truncate font-medium">{character.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{character.role || character.castRole || "角色"}</span>
                </button>
              );
            })}
            {graphNodes.length === 0 ? <EmptyState label="暂无可绘制角色节点。" /> : null}
          </div>
          {snapshot.characters.length > visibleCharacters.length ? (
            <p className="mt-2 text-xs text-muted-foreground">图谱仅显示前 {visibleCharacters.length} 个角色；完整角色仍在下方明细中。</p>
          ) : null}
        </div>

        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">选中节点证据</h3>
            {selectedCharacter ? <StatusBadge status={selectedCharacter.availability ?? "active"} /> : null}
          </div>
          {selectedCharacter ? (
            <div className="space-y-3">
              <div className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{selectedCharacter.name}</span>
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{selectedCharacter.role}</Badge>
                  {selectedCharacter.factionLabel ? <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{selectedCharacter.factionLabel}</Badge> : null}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {selectedCharacter.currentGoal ?? selectedCharacter.currentState ?? selectedCharacter.currentLocation ?? "暂无当前状态"}
                </p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">证据章节</div>
                <div className="mt-1">
                  {selectedEvidenceChapterOrders.length > 0
                    ? selectedEvidenceChapterOrders.map((order) => `第 ${order} 章`).join("、")
                    : "暂无证据章节。"}
                </div>
              </div>
              {selectedRelations.length === 0 ? <EmptyState label="该角色暂无关系边。" /> : null}
              {selectedRelations.slice(0, 8).map((relation) => (
                <div key={`selected-${relation.id}`} className="rounded-md border p-3 text-xs text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                    <span className="font-medium">{relation.sourceName ?? relation.sourceCharacterId}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium">{relation.targetName ?? relation.targetCharacterId}</span>
                    <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{relation.dynamicLabel ?? relation.surfaceRelation}</Badge>
                  </div>
                  {relation.evidence ? <p className="mt-2 line-clamp-2">证据：{relation.evidence}</p> : null}
                  {relation.hiddenTension ? <p className="mt-1 line-clamp-2">隐藏张力：{relation.hiddenTension}</p> : null}
                  {relation.currentStages.slice(0, 2).map((stage) => (
                    <p key={`${relation.id}-${stage.chapterOrder ?? "na"}-${stage.stageLabel}`} className="mt-1 line-clamp-2">
                      第 {stage.chapterOrder ?? "?"} 章 · {stage.stageLabel}：{stage.stageSummary}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          ) : <EmptyState label="暂无可选角色。" />}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">角色节点</h3>
            <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{snapshot.characters.length}</Badge>
          </div>
          <div className="space-y-2">
            {snapshot.characters.slice(0, 18).map((character) => (
              <div key={character.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{character.name}</span>
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{character.role}</Badge>
                  {character.availability ? <StatusBadge status={character.availability} /> : null}
                </div>
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                  {character.currentGoal ?? character.currentState ?? character.currentLocation ?? "暂无当前状态"}
                </p>
                <div className="mt-2 flex flex-wrap gap-1 text-xs text-muted-foreground">
                  {character.factionLabel ? <span className="rounded bg-muted px-2 py-0.5">势力：{character.factionLabel}</span> : null}
                  {character.stanceLabel ? <span className="rounded bg-muted px-2 py-0.5">立场：{character.stanceLabel}</span> : null}
                  {character.currentLocation ? <span className="rounded bg-muted px-2 py-0.5">位置：{character.currentLocation}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">关系边</h3>
            <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{snapshot.relations.length}</Badge>
          </div>
          {snapshot.relations.length === 0 ? <EmptyState label="暂无关系边。" /> : (
            <div className="space-y-3">
              {snapshot.relations.slice(0, 24).map((relation) => (
                <div key={relation.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-muted px-2 py-1 font-medium">{relation.sourceName ?? relation.sourceCharacterId}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="rounded-md bg-muted px-2 py-1 font-medium">{relation.targetName ?? relation.targetCharacterId}</span>
                    <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{relation.dynamicLabel ?? relation.surfaceRelation}</Badge>
                  </div>
                  <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <span>表层：{relation.surfaceRelation || "无"}</span>
                    <span>信任：{relation.trustScore ?? "无"}</span>
                    <span>冲突：{relation.conflictScore ?? "无"}</span>
                  </div>
                  <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <span>势力：{relation.sourceFactionLabel ?? "无"} → {relation.targetFactionLabel ?? "无"}</span>
                    <span>亲密 / 依赖：{relation.intimacyScore ?? "无"} / {relation.dependencyScore ?? "无"}</span>
                  </div>
                  {relation.hiddenTension || relation.evidence || relation.evidenceChapterOrders.length > 0 ? (
                    <div className="mt-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                      {relation.hiddenTension ? <div>隐藏张力：{relation.hiddenTension}</div> : null}
                      {relation.evidence ? <div className="mt-1 line-clamp-2">证据：{relation.evidence}</div> : null}
                      {relation.evidenceChapterOrders.length > 0 ? <div className="mt-1">证据章节：{relation.evidenceChapterOrders.map((order) => `第 ${order} 章`).join("、")}</div> : null}
                    </div>
                  ) : null}
                  {relation.currentStages.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {relation.currentStages.map((stage) => (
                        <div key={`${relation.id}-${stage.chapterOrder ?? "na"}-${stage.stageLabel}`} className="rounded-md bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
                          第 {stage.chapterOrder ?? "?"} 章 · {stage.stageLabel}：{stage.stageSummary}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineVisualizationPanel(props: {
  snapshot: StoryStateRuntimeSnapshot | null | undefined;
  hasNovelId: boolean;
  isLoading: boolean;
}) {
  if (!props.hasNovelId) return <EmptyState label="输入 novelId 后加载时间线。" />;
  if (props.isLoading && !props.snapshot) return <EmptyState label="正在加载时间线。" />;
  const snapshot = props.snapshot;
  if (!snapshot) return <EmptyState label="暂无时间线数据。" />;
  const timelineWarnings = snapshot.deterministicChecks.filter(
    (check) => check.key.includes("timeline") && check.totalIssues > 0,
  );
  if (
    snapshot.timeline.events.length === 0 &&
    snapshot.timeline.constraints.length === 0 &&
    snapshot.timeline.reports.length === 0 &&
    timelineWarnings.length === 0
  ) {
    return <EmptyState label="暂无事件、约束或检测报告。" />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">事件线</h3>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{snapshot.timeline.events.length}</Badge>
        </div>
        {snapshot.timeline.events.length === 0 ? <EmptyState label="暂无事件。" /> : (
          <div className="space-y-3 border-l pl-4">
            {snapshot.timeline.events.slice(0, 40).map((event) => (
              <div key={event.id} className="relative rounded-md border p-3 text-sm">
                <span className="absolute -left-[21px] top-4 h-2.5 w-2.5 rounded-full border bg-background" />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{event.title}</span>
                  <StatusBadge status={event.status} />
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{event.type}</Badge>
                </div>
                <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <span>章节：{event.chapterIndex ?? "未知"}</span>
                  <span>故事日：{event.storyDayIndex ?? "未知"}</span>
                  <span>时间：{event.storyTimeLabel ?? "未知"}</span>
                </div>
                {event.summary ? <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{event.summary}</p> : null}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-4">
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">时间线冲突预警</h3>
            <Badge
              variant="outline"
              className={statusBadgeClass(timelineWarnings.some((check) => check.status === "blocked") ? "blocked" : timelineWarnings.length > 0 ? "warning" : "pass")}
            >
              {timelineWarnings.length}
            </Badge>
          </div>
          {timelineWarnings.length === 0 ? <EmptyState label="暂无时间线冲突。" /> : (
            <div className="space-y-2">
              {timelineWarnings.slice(0, 5).map((check) => (
                <div key={check.key} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{check.label}</span>
                    <Badge variant="outline" className={statusBadgeClass(check.status)}>{check.status}</Badge>
                    <span className="text-xs text-muted-foreground">{check.totalIssues} 个问题</span>
                  </div>
                  {check.issues.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {check.issues.slice(0, 2).map((issue) => (
                        <div key={issue.id} className="rounded-md bg-muted/40 p-2 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className={statusBadgeClass(issue.severity)}>{issue.severity}</Badge>
                            <span className="font-medium">{issue.title}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-muted-foreground">{issue.summary}</p>
                          {issue.evidence.length > 0 ? (
                            <p className="mt-1 line-clamp-2 text-muted-foreground">证据：{issue.evidence.join("；")}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-medium">时间线约束</h3>
          <div className="mt-3 space-y-2">
            {snapshot.timeline.constraints.slice(0, 8).map((constraint) => (
              <div key={constraint.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusBadgeClass(constraint.severity)}>{constraint.severity}</Badge>
                  <span className="font-medium">{constraint.type}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{constraint.description}</p>
              </div>
            ))}
            {snapshot.timeline.constraints.length === 0 ? <EmptyState label="暂无活跃约束。" /> : null}
          </div>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-medium">检测报告</h3>
          <div className="mt-3 space-y-2">
            {snapshot.timeline.reports.slice(0, 8).map((report) => (
              <div key={report.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                <div>
                  <div className="font-medium">第 {report.chapterIndex} 章</div>
                  <div className="text-xs text-muted-foreground">{formatDate(report.createdAt)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground">{report.score}</span>
                  <StatusBadge status={report.status} />
                </div>
              </div>
            ))}
            {snapshot.timeline.reports.length === 0 ? <EmptyState label="暂无检测报告。" /> : null}
          </div>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-medium">角色位置 / 状态变化</h3>
          <div className="mt-3 space-y-2">
            {snapshot.timeline.characterMovements.slice(0, 10).map((event) => (
              <div key={event.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{event.characterName ?? event.characterId}</span>
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">第 {event.chapterOrder ?? "?"} 章</Badge>
                  <span className="text-xs text-muted-foreground">{event.source}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{event.title}</div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{event.content}</p>
              </div>
            ))}
            {snapshot.timeline.characterMovements.length === 0 ? <EmptyState label="暂无角色位置或状态变化。" /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ForeshadowBoardPanel(props: {
  snapshot: StoryStateRuntimeSnapshot | null | undefined;
  hasNovelId: boolean;
  isLoading: boolean;
}) {
  if (!props.hasNovelId) return <EmptyState label="输入 novelId 后加载伏笔看板。" />;
  if (props.isLoading && !props.snapshot) return <EmptyState label="正在加载伏笔看板。" />;
  const snapshot = props.snapshot;
  if (!snapshot) return <EmptyState label="暂无伏笔数据。" />;
  const foreshadowWarnings = snapshot.deterministicChecks.filter((check) => (
    (check.key.includes("hook") || check.key.includes("payoff") || check.label.includes("伏笔"))
    && check.totalIssues > 0
  ));
  const statusCounts = new Map<string, number>();
  for (const status of [
    ...snapshot.foreshadowStates.map((state) => state.status),
    ...snapshot.timeline.hooks.map((hook) => hook.status),
    ...snapshot.payoffItems.map((item) => item.currentStatus),
  ]) {
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const statusSummary = Array.from(statusCounts.entries())
    .sort(([leftStatus], [rightStatus]) => leftStatus.localeCompare(rightStatus))
    .map(([status, count]) => `${status} ${count}`);
  if (
    snapshot.foreshadowStates.length === 0 &&
    snapshot.timeline.hooks.length === 0 &&
    snapshot.payoffItems.length === 0 &&
    foreshadowWarnings.length === 0
  ) {
    return <EmptyState label="暂无伏笔或兑现记录。" />;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">伏笔状态总览</h3>
            <p className="mt-1 text-xs text-muted-foreground">候选、已埋设、待回收、已回收和超期状态均从 Postgres 派生。</p>
          </div>
          <Badge
            variant="outline"
            className={statusBadgeClass(foreshadowWarnings.some((check) => check.status === "blocked") ? "blocked" : foreshadowWarnings.length > 0 ? "warning" : "pass")}
          >
            预警 {foreshadowWarnings.reduce((sum, check) => sum + check.totalIssues, 0)}
          </Badge>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {statusSummary.length === 0 ? (
            <span className="text-xs text-muted-foreground">暂无状态记录</span>
          ) : statusSummary.map((item) => (
            <Badge key={item} variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
              {item}
            </Badge>
          ))}
        </div>
        {foreshadowWarnings.length > 0 ? (
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {foreshadowWarnings.slice(0, 4).map((check) => (
              <div key={check.key} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusBadgeClass(check.status)}>{check.status}</Badge>
                  <span className="font-medium">{check.label}</span>
                  <span className="text-xs text-amber-700">{check.totalIssues} 个问题</span>
                </div>
                {check.issues.slice(0, 2).map((issue) => (
                  <div key={issue.id} className="mt-2 rounded-md bg-white/70 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={statusBadgeClass(issue.severity)}>{issue.severity}</Badge>
                      <span className="font-medium">{issue.title}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-amber-800">{issue.summary}</p>
                    {issue.evidence.length > 0 ? (
                      <p className="mt-1 line-clamp-2 text-amber-700">证据：{issue.evidence.join("；")}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">状态快照伏笔</h3>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{snapshot.foreshadowStates.length}</Badge>
        </div>
        <div className="space-y-2">
          {snapshot.foreshadowStates.slice(0, 24).map((state) => (
            <div key={state.id} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={state.status} />
                <span className="font-medium">{state.title}</span>
              </div>
              {state.summary ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{state.summary}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">
                埋设：{state.setupChapterOrder != null ? `第 ${state.setupChapterOrder} 章` : "未绑定"}
                {state.setupChapterTitle ? ` · ${state.setupChapterTitle}` : ""}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                兑现：{state.payoffChapterOrder != null ? `第 ${state.payoffChapterOrder} 章` : "未绑定"}
                {state.payoffChapterTitle ? ` · ${state.payoffChapterTitle}` : ""}
              </p>
            </div>
          ))}
          {snapshot.foreshadowStates.length === 0 ? <EmptyState label="暂无状态快照伏笔。" /> : null}
        </div>
      </div>
      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">伏笔 / 钩子</h3>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{snapshot.timeline.hooks.length}</Badge>
        </div>
        <div className="space-y-2">
          {snapshot.timeline.hooks.slice(0, 24).map((hook) => (
            <div key={hook.id} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={hook.status} />
                <Badge variant="outline" className={statusBadgeClass(hook.blocking ? "blocked" : hook.priority)}>{hook.blocking ? "blocking" : hook.priority}</Badge>
                <span className="font-medium">{hook.title}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                创建第 {hook.createdInChapterIndex} 章；预期解决：{hook.expectedResolveByChapterIndex ?? "未设置"}
              </p>
            </div>
          ))}
          {snapshot.timeline.hooks.length === 0 ? <EmptyState label="暂无伏笔/钩子。" /> : null}
        </div>
      </div>
      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">兑现账本</h3>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{snapshot.payoffItems.length}</Badge>
        </div>
        <div className="space-y-2">
          {snapshot.payoffItems.slice(0, 24).map((item) => (
            <div key={item.id} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={item.currentStatus} />
                <span className="font-medium">{item.title}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                目标回收：{item.targetEndChapterOrder ?? "未设置"}；最近触达：{item.lastTouchedChapterOrder ?? "无"}
              </p>
            </div>
          ))}
          {snapshot.payoffItems.length === 0 ? <EmptyState label="暂无兑现账本。" /> : null}
        </div>
      </div>
      </div>
    </div>
  );
}

function StyleProfilesPanel(props: {
  snapshot: StoryStateRuntimeSnapshot | null | undefined;
  hasNovelId: boolean;
  isLoading: boolean;
}) {
  if (!props.hasNovelId) return <EmptyState label="输入 novelId 后加载风格画像。" />;
  if (props.isLoading && !props.snapshot) return <EmptyState label="正在加载风格画像。" />;
  const snapshot = props.snapshot;
  if (!snapshot) return <EmptyState label="暂无风格数据。" />;
  if (snapshot.styleProfiles.length === 0) return <EmptyState label="暂无 StyleProfile。" />;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {snapshot.styleProfiles.map((profile) => {
        const bindingLabel = STYLE_BINDING_TARGET_LABELS[profile.bindingTargetType ?? ""] ?? profile.bindingTargetType ?? "未绑定";
        return (
          <div key={`${profile.bindingTargetType ?? "profile"}-${profile.id}`} className="rounded-lg border bg-background p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{profile.name}</span>
              <Badge variant="outline" className={statusBadgeClass(profile.status)}>{profile.status}</Badge>
              <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{bindingLabel}</Badge>
              {profile.category ? <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{profile.category}</Badge> : null}
            </div>
            {profile.description ? <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{profile.description}</p> : null}
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              <span>来源：{profile.sourceType}</span>
              <span>优先级：{profile.bindingPriority ?? "无"}</span>
              <span>强度：{profile.bindingWeight ?? "无"}</span>
              <span>Preset：{profile.selectedExtractionPresetKey ?? "无"}</span>
              <span>特征：{profile.featureCount}</span>
              <span>反 AI 规则：{profile.antiAiRuleCount}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {profile.learningDimensions.length === 0 ? (
                <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">未识别学习维度</Badge>
              ) : profile.learningDimensions.map((dimension) => (
                <Badge key={dimension} variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{dimension}</Badge>
              ))}
            </div>
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="rounded-md bg-muted/40 p-3">叙事：{profile.narrativeSummary ?? "未设置"}</div>
              <div className="rounded-md bg-muted/40 p-3">人物：{profile.characterSummary ?? "未设置"}</div>
              <div className="rounded-md bg-muted/40 p-3">语言：{profile.languageSummary ?? "未设置"}</div>
              <div className="rounded-md bg-muted/40 p-3">节奏：{profile.rhythmSummary ?? "未设置"}</div>
            </div>
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground lg:grid-cols-2">
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">AI 腔检测</span>
                  <Badge variant="outline" className={statusBadgeClass(profile.antiAiRuleCount > 0 ? "warning" : "pass")}>
                    规则 {profile.antiAiRuleCount}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {profile.antiAiRuleKeys.length === 0 ? (
                    <span>暂无专属反 AI 规则</span>
                  ) : profile.antiAiRuleKeys.slice(0, 6).map((key) => (
                    <Badge key={`${profile.id}-${key}`} variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                      {key}
                    </Badge>
                  ))}
                </div>
                {profile.analysisPreview ? (
                  <p className="mt-2 line-clamp-2">分析：{profile.analysisPreview}</p>
                ) : null}
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">样章对比</span>
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                    {profile.sourceRefId ?? profile.sourceType}
                  </Badge>
                </div>
                {profile.sourceSamplePreview ? (
                  <p className="mt-2 line-clamp-3">样章片段：{profile.sourceSamplePreview}</p>
                ) : (
                  <p className="mt-2">暂无样章片段；可从 Reference Corpus 生成或重新导入。</p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StyleLabPanel(props: {
  profiles: StyleProfile[];
  hasNovelId: boolean;
  currentChapterId?: string | null;
  currentVolumeId?: string | null;
  currentVolumeTitle?: string | null;
  selectedProfileId: string;
  mode: "generate" | "rewrite";
  topic: string;
  sourceText: string;
  targetLength: string;
  intensity: string;
  provider: string;
  model: string;
  output: string;
  compiledBlocks: CompiledStylePromptBlocks | null;
  detectionReport?: StyleDetectionReport | null;
  comparisonRuns: StyleLabComparisonRun[];
  analysisMarkdownDraft: string;
  narrativeSummaryDraft: string;
  characterSummaryDraft: string;
  languageSummaryDraft: string;
  rhythmSummaryDraft: string;
  isLoadingProfiles: boolean;
  isTesting: boolean;
  isDetecting: boolean;
  isBinding: boolean;
  isSavingProfile: boolean;
  onSelectedProfileIdChange: (value: string) => void;
  onModeChange: (value: "generate" | "rewrite") => void;
  onTopicChange: (value: string) => void;
  onSourceTextChange: (value: string) => void;
  onTargetLengthChange: (value: string) => void;
  onIntensityChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onAnalysisMarkdownDraftChange: (value: string) => void;
  onNarrativeSummaryDraftChange: (value: string) => void;
  onCharacterSummaryDraftChange: (value: string) => void;
  onLanguageSummaryDraftChange: (value: string) => void;
  onRhythmSummaryDraftChange: (value: string) => void;
  onRunTestWrite: () => void;
  onDetectOutput: () => void;
  onSaveProfileDraft: () => void;
  onBind: (targetType: Extract<StyleBinding["targetType"], "novel" | "volume" | "chapter">) => void;
}) {
  if (!props.hasNovelId) return <EmptyState label="输入 novelId 后使用风格实验室。" />;
  if (props.isLoadingProfiles && props.profiles.length === 0) return <EmptyState label="正在加载 StyleProfile。" />;
  if (props.profiles.length === 0) return <EmptyState label="暂无 StyleProfile。可先在 Reference Corpus 中生成风格画像。" />;

  const selectedProfile = props.profiles.find((profile) => profile.id === props.selectedProfileId) ?? null;
  const intensity = parseStyleIntensity(props.intensity);
  const detectionReport = props.detectionReport ?? null;
  const comparisonSourceText = props.mode === "rewrite" ? props.sourceText : props.topic;
  const comparisonSourceKey = createStyleLabComparisonKey(props.mode, props.topic, props.sourceText);
  const visibleComparisonRuns = normalizeStyleLabComparisonText(comparisonSourceText)
    ? props.comparisonRuns.filter((run) => run.sourceKey === comparisonSourceKey && run.mode === props.mode)
    : [];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background p-4">
        <div className="grid gap-3 lg:grid-cols-[1.1fr_0.7fr_0.55fr_0.7fr_0.75fr_0.75fr] lg:items-end">
          <div>
            <label className="text-xs font-medium text-muted-foreground">StyleProfile</label>
            <Select value={props.selectedProfileId || "__none"} onValueChange={(value) => props.onSelectedProfileIdChange(value === "__none" ? "" : value)}>
              <SelectTrigger className="mt-1 h-10 rounded-md">
                <SelectValue placeholder="选择 StyleProfile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">未选择</SelectItem>
                {props.profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">任务</label>
            <Select value={props.mode} onValueChange={(value) => props.onModeChange(value as "generate" | "rewrite")}>
              <SelectTrigger className="mt-1 h-10 rounded-md">
                <SelectValue placeholder="试写任务" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STYLE_LAB_MODE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">字数</label>
            <Input
              value={props.targetLength}
              onChange={(event) => props.onTargetLengthChange(event.target.value)}
              placeholder="800"
              inputMode="numeric"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">强度 {Math.round(intensity * 100)}%</label>
            <input
              type="range"
              min="0.3"
              max="1"
              step="0.05"
              value={intensity}
              onChange={(event) => props.onIntensityChange(event.target.value)}
              className="mt-3 w-full accent-slate-900"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Provider</label>
            <Input
              value={props.provider}
              onChange={(event) => props.onProviderChange(event.target.value)}
              placeholder="openai"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            <Input
              value={props.model}
              onChange={(event) => props.onModelChange(event.target.value)}
              placeholder="系统默认"
              className="mt-1"
            />
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {props.mode === "rewrite" ? "待改写原文" : "同一剧情"}
            </label>
            <textarea
              value={props.mode === "rewrite" ? props.sourceText : props.topic}
              onChange={(event) => {
                if (props.mode === "rewrite") {
                  props.onSourceTextChange(event.target.value);
                  return;
                }
                props.onTopicChange(event.target.value);
              }}
              placeholder={props.mode === "rewrite" ? "粘贴需要按当前 StyleProfile 改写的原文" : "输入本次试写剧情、人物、冲突和场景目标"}
              className="mt-1 min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{selectedProfile?.name ?? "未选择 StyleProfile"}</span>
              {selectedProfile ? <StatusBadge status={selectedProfile.status} /> : null}
              {selectedProfile?.category ? (
                <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{selectedProfile.category}</Badge>
              ) : null}
            </div>
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="rounded-md bg-background p-2">特征：{selectedProfile?.extractedFeatures.length ?? 0}</div>
              <div className="rounded-md bg-background p-2">反 AI 规则：{selectedProfile?.antiAiRules.length ?? 0}</div>
              <div className="rounded-md bg-background p-2">来源：{selectedProfile?.sourceType ?? "无"}</div>
              <div className="rounded-md bg-background p-2">更新：{formatDate(selectedProfile?.updatedAt)}</div>
            </div>
            {selectedProfile?.description ? (
              <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{selectedProfile.description}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-3 rounded-md border bg-muted/20 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">规则摘要编辑</h3>
              <p className="mt-1 text-xs text-muted-foreground">保存后进入当前 StyleProfile，后续 Writer 编译风格提示词时会读取这些摘要。</p>
            </div>
            <Button type="button" variant="outline" disabled={!props.selectedProfileId || props.isSavingProfile} onClick={props.onSaveProfileDraft}>
              {props.isSavingProfile ? "保存中" : "保存摘要"}
            </Button>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">分析说明</label>
              <textarea
                value={props.analysisMarkdownDraft}
                onChange={(event) => props.onAnalysisMarkdownDraftChange(event.target.value)}
                className="mt-1 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">叙事摘要</label>
                <textarea
                  value={props.narrativeSummaryDraft}
                  onChange={(event) => props.onNarrativeSummaryDraftChange(event.target.value)}
                  className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">人物摘要</label>
                <textarea
                  value={props.characterSummaryDraft}
                  onChange={(event) => props.onCharacterSummaryDraftChange(event.target.value)}
                  className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">语言摘要</label>
                <textarea
                  value={props.languageSummaryDraft}
                  onChange={(event) => props.onLanguageSummaryDraftChange(event.target.value)}
                  className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">节奏摘要</label>
                <textarea
                  value={props.rhythmSummaryDraft}
                  onChange={(event) => props.onRhythmSummaryDraftChange(event.target.value)}
                  className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" disabled={!props.selectedProfileId || props.isTesting} onClick={props.onRunTestWrite}>
            {props.isTesting ? "试写中" : "运行试写"}
          </Button>
          <Button type="button" variant="outline" disabled={!props.output.trim() || props.isDetecting} onClick={props.onDetectOutput}>
            {props.isDetecting ? "检测中" : "检测风格偏离"}
          </Button>
          <Button type="button" variant="outline" disabled={!props.selectedProfileId || props.isBinding} onClick={() => props.onBind("novel")}>
            应用到当前书
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!props.selectedProfileId || !props.currentVolumeId || props.isBinding}
            onClick={() => props.onBind("volume")}
            title={props.currentVolumeTitle ? `当前卷：${props.currentVolumeTitle}` : "当前章节没有卷归属"}
          >
            应用到当前卷
          </Button>
          <Button type="button" variant="outline" disabled={!props.selectedProfileId || !props.currentChapterId || props.isBinding} onClick={() => props.onBind("chapter")}>
            应用到当前章节
          </Button>
          {props.selectedProfileId ? (
            <Button type="button" variant="outline" asChild>
              <a href={`/style-engine?profileId=${encodeURIComponent(props.selectedProfileId)}`}>编辑 StyleProfile</a>
            </Button>
          ) : (
            <Button type="button" variant="outline" disabled>
              编辑 StyleProfile
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">试写输出</h3>
            <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{props.output.length} 字符</Badge>
          </div>
          {props.output.trim() ? (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">{props.output}</pre>
          ) : (
            <EmptyState label="运行试写后显示生成文本。" />
          )}
        </div>

        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">风格偏离报告</h3>
            {detectionReport ? (
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant="outline"
                  className={statusBadgeClass(detectionReport.riskScore >= 60 ? "high" : detectionReport.riskScore > 40 ? "warning" : "pass")}
                >
                  风险 {detectionReport.riskScore}
                </Badge>
                <Badge variant="outline" className={statusBadgeClass(detectionReport.canAutoRewrite ? "ready" : "warning")}>
                  {detectionReport.canAutoRewrite ? "可自动改写" : "需人工调整"}
                </Badge>
              </div>
            ) : null}
          </div>
          {!detectionReport ? (
            <EmptyState label="检测试写输出后显示偏离位置、原因和建议。" />
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{detectionReport.summary || "无摘要"}</p>
              <div className="grid gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-md border bg-muted/30 px-2 py-2">
                  <div className="text-[11px] text-muted-foreground">风险分</div>
                  <div className="mt-1 font-semibold tabular-nums text-foreground">{detectionReport.riskScore}</div>
                </div>
                <div className="rounded-md border bg-muted/30 px-2 py-2">
                  <div className="text-[11px] text-muted-foreground">偏离点</div>
                  <div className="mt-1 font-semibold tabular-nums text-foreground">{detectionReport.violations.length}</div>
                </div>
                <div className="rounded-md border bg-muted/30 px-2 py-2">
                  <div className="text-[11px] text-muted-foreground">已应用规则</div>
                  <div className="mt-1 font-semibold tabular-nums text-foreground">{detectionReport.appliedRuleIds.length}</div>
                </div>
                <div className="rounded-md border bg-muted/30 px-2 py-2">
                  <div className="text-[11px] text-muted-foreground">处理方式</div>
                  <div className="mt-1 font-semibold text-foreground">{detectionReport.canAutoRewrite ? "自动改写可尝试" : "人工确认优先"}</div>
                </div>
              </div>
              {detectionReport.violations.length === 0 ? <EmptyState label="未发现风格偏离。" /> : null}
              {detectionReport.violations.map((violation, index) => (
                <div key={`${violation.ruleId}-${index}`} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={statusBadgeClass(violation.severity)}>
                      {STYLE_DETECTION_SEVERITY_LABELS[violation.severity] ?? violation.severity}
                    </Badge>
                    <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                      {STYLE_DETECTION_RULE_TYPE_LABELS[violation.ruleType] ?? violation.ruleType}
                    </Badge>
                    <Badge variant="outline" className={statusBadgeClass(violation.canAutoRewrite ? "ready" : "warning")}>
                      {violation.canAutoRewrite ? "可自动改写" : "需人工调整"}
                    </Badge>
                    <span className="font-medium">{violation.ruleName}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>来源：{STYLE_DETECTION_SOURCE_LABELS[violation.source] ?? violation.source}</span>
                    <span>类别：{STYLE_DETECTION_ISSUE_CATEGORY_LABELS[violation.issueCategory] ?? violation.issueCategory}</span>
                    <span>规则 ID：{violation.ruleId}</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">片段：{violation.excerpt}</p>
                  <p className="mt-1 text-xs text-muted-foreground">原因：{violation.reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground">建议：{violation.suggestion}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">{props.mode === "rewrite" ? "同一原文改写对比" : "同一剧情试写对比"}</h3>
            <p className="mt-1 text-xs text-muted-foreground">当前会话内按同一输入汇总最近试写结果，用于比较 StyleProfile、强度和偏离风险。</p>
          </div>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
            {visibleComparisonRuns.length} 条
          </Badge>
        </div>
        {visibleComparisonRuns.length === 0 ? (
          <EmptyState label={props.mode === "rewrite" ? "运行同一原文改写后显示对比结果。" : "运行同一剧情试写后显示对比结果。"} />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {visibleComparisonRuns.map((run) => (
              <div key={run.id} className="rounded-md border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{run.profileName}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{formatDate(run.createdAt)}</span>
                      <span>强度 {Math.round(run.intensity * 100)}%</span>
                      <span>目标 {run.targetLength ?? "默认"} 字</span>
                      {run.profileCategory ? <span>{run.profileCategory}</span> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className={statusBadgeClass((run.riskScore ?? 0) >= 60 ? "high" : (run.riskScore ?? 0) > 40 ? "warning" : "pass")}>
                      风险 {run.riskScore ?? "无"}
                    </Badge>
                    <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                      {run.outputLength} 字
                    </Badge>
                  </div>
                </div>
                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                  <div className="rounded-md bg-background px-2 py-2">规则 {run.appliedRuleCount}</div>
                  <div className="rounded-md bg-background px-2 py-2">偏离 {run.violationCount ?? "无"}</div>
                  <div className="rounded-md bg-background px-2 py-2">{run.canAutoRewrite === false ? "人工调整优先" : "可自动改写"}</div>
                </div>
                <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 text-xs text-muted-foreground">{run.output}</pre>
                {run.agentRunId ? <div className="mt-2 truncate text-xs text-muted-foreground">AgentRun：{run.agentRunId}</div> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Writer 编译提示词</h3>
          {props.compiledBlocks ? (
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className={statusBadgeClass(props.compiledBlocks.contract.meta.maturity)}>
                {props.compiledBlocks.contract.meta.maturity}
              </Badge>
              <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                规则 {props.compiledBlocks.appliedRuleIds.length}
              </Badge>
            </div>
          ) : null}
        </div>
        {!props.compiledBlocks ? (
          <EmptyState label="运行试写后显示进入 Writer 的风格、人物、反 AI 和自检提示词块。" />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {STYLE_COMPILED_BLOCK_LABELS.map(([key, label]) => (
              <div key={key} className="rounded-md border bg-muted/20 p-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">{label}</div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{props.compiledBlocks?.[key] || "无"}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ContinuationContextPanel(props: {
  snapshot?: ContinuationContextSnapshot | null;
  hasNovelId: boolean;
  isLoading: boolean;
  lastGenerationResult?: ContinuationGenerationResult | null;
  referenceCorpora: ReferenceCorpus[];
  mode: ContinuationWorkbenchMode;
  targetOrder: string;
  targetWordCount: string;
  positionCorpusId: string;
  positionChapterNumber: string;
  positionParagraphNumber: string;
  positionAnchorText: string;
  provider: string;
  model: string;
  isGenerating: boolean;
  onModeChange: (value: ContinuationWorkbenchMode) => void;
  onTargetOrderChange: (value: string) => void;
  onTargetWordCountChange: (value: string) => void;
  onPositionCorpusIdChange: (value: string) => void;
  onPositionChapterNumberChange: (value: string) => void;
  onPositionParagraphNumberChange: (value: string) => void;
  onPositionAnchorTextChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onGenerate: () => void;
}) {
  if (!props.hasNovelId) return <EmptyState label="输入 novelId 后加载续写上下文。" />;
  const snapshot = props.snapshot;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background p-4">
        <div className="grid gap-3 lg:grid-cols-[0.8fr_0.6fr_0.7fr_0.8fr_0.8fr_auto] lg:items-end">
          <div>
            <label className="text-xs font-medium text-muted-foreground">续写模式</label>
            <Select value={props.mode} onValueChange={(value) => props.onModeChange(value as ContinuationWorkbenchMode)}>
              <SelectTrigger className="mt-1 h-10 rounded-md">
                <SelectValue placeholder="续写模式" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CONTINUATION_MODE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">目标章节</label>
            <Input
              value={props.targetOrder}
              onChange={(event) => props.onTargetOrderChange(event.target.value)}
              placeholder={snapshot?.targetChapterOrder ? String(snapshot.targetChapterOrder) : "自动"}
              inputMode="numeric"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">目标字数</label>
            <Input
              value={props.targetWordCount}
              onChange={(event) => props.onTargetWordCountChange(event.target.value)}
              placeholder="2200"
              inputMode="numeric"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Provider</label>
            <Input
              value={props.provider}
              onChange={(event) => props.onProviderChange(event.target.value)}
              placeholder="openai，可选"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            <Input
              value={props.model}
              onChange={(event) => props.onModelChange(event.target.value)}
              placeholder="系统默认"
              className="mt-1"
            />
          </div>
          <Button type="button" disabled={props.isGenerating} onClick={props.onGenerate}>
            {props.isGenerating ? "生成中" : "生成续写章"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          调用现有 Writer / Reviewer / ReviewGate 流水线；没有可用续写源时会拒绝生成。
        </p>
        {props.mode === "position" ? (
          <div className="mt-4 grid gap-3 border-t pt-4 lg:grid-cols-[0.9fr_0.45fr_0.45fr_1.2fr] lg:items-end">
            <div>
              <label className="text-xs font-medium text-muted-foreground">续写语料</label>
              <Select
                value={props.positionCorpusId || "__any__"}
                onValueChange={(value) => props.onPositionCorpusIdChange(value === "__any__" ? "" : value)}
              >
                <SelectTrigger className="mt-1 h-10 rounded-md">
                  <SelectValue placeholder="选择语料" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">自动匹配</SelectItem>
                  {props.referenceCorpora.map((corpus) => (
                    <SelectItem key={corpus.id} value={corpus.id}>{corpus.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">语料章节</label>
              <Input
                value={props.positionChapterNumber}
                onChange={(event) => props.onPositionChapterNumberChange(event.target.value)}
                placeholder="1"
                inputMode="numeric"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">语料段落</label>
              <Input
                value={props.positionParagraphNumber}
                onChange={(event) => props.onPositionParagraphNumberChange(event.target.value)}
                placeholder="可选"
                inputMode="numeric"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">锚点文本</label>
              <Input
                value={props.positionAnchorText}
                onChange={(event) => props.onPositionAnchorTextChange(event.target.value)}
                placeholder="可粘贴续写点附近一句话"
                className="mt-1"
              />
            </div>
          </div>
        ) : null}
      </div>

      {props.lastGenerationResult ? (
        <div className="rounded-lg border bg-background p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">最近续写结果</span>
                <StatusBadge status={props.lastGenerationResult.chapter.generationState} />
                {props.lastGenerationResult.reviewGateResult ? (
                  <Badge
                    variant="outline"
                    className={props.lastGenerationResult.reviewGateResult.pass ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}
                  >
                    ReviewGate {props.lastGenerationResult.reviewGateResult.pass ? "pass" : "blocked"}
                  </Badge>
                ) : null}
                {props.lastGenerationResult.reviewGateResult?.needsHumanConfirmation ? (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">需要确认</Badge>
                ) : null}
              </div>
              <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                <span>章节：第 {props.lastGenerationResult.chapter.order} 章</span>
                <span>长度：{props.lastGenerationResult.chapter.contentLength}</span>
                <span>重试：{props.lastGenerationResult.runtime.retryCountUsed}</span>
                <span>来源：{props.lastGenerationResult.runtime.sourceType}</span>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              AgentRun：{props.lastGenerationResult.runtime.agentRunId ?? "未记录"}
            </div>
          </div>
          {props.lastGenerationResult.reviewGateResult ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>ReviewGate：{props.lastGenerationResult.reviewGateResult.id}</span>
              <StatusBadge status={props.lastGenerationResult.reviewGateResult.recommendedAction} />
              <span>{formatDate(props.lastGenerationResult.reviewGateResult.updatedAt)}</span>
            </div>
          ) : (
            <EmptyState label="本次结果没有返回 ReviewGate。" />
          )}
          <div className="mt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">StatePatch</span>
              <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                {props.lastGenerationResult.statePatches.length}
              </Badge>
            </div>
            {props.lastGenerationResult.statePatches.length > 0 ? (
              <div className="grid gap-2 lg:grid-cols-2">
                {props.lastGenerationResult.statePatches.map((patch) => (
                  <div key={patch.id} className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={patch.status} />
                      <Badge variant="outline" className={statusBadgeClass(patch.riskLevel)}>{patch.riskLevel}</Badge>
                      <span className="font-medium text-foreground">{patch.patchType}</span>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {patch.targetType} · {formatDate(patch.updatedAt)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState label="本次结果没有生成 StatePatch。" />
            )}
          </div>
          <ContinuationRecallHitsPreview
            title="本次生成引用片段与原因"
            hits={props.lastGenerationResult.continuationContext.recallHits}
            emptyLabel="本次生成没有记录召回片段。"
            maxItems={8}
            embedded
          />
        </div>
      ) : null}

      {props.isLoading && !snapshot ? <EmptyState label="正在加载续写上下文。" /> : null}
      {!props.isLoading && !snapshot ? <EmptyState label="暂无续写上下文。" /> : null}
      {snapshot ? (
        <>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-lg border bg-background p-4">
              <div className="text-xs text-muted-foreground">模式</div>
              <div className="mt-1 font-medium">{CONTINUATION_MODE_LABELS[snapshot.mode] ?? snapshot.mode}</div>
            </div>
            <div className="rounded-lg border bg-background p-4">
              <div className="text-xs text-muted-foreground">来源</div>
              <div className="mt-1 font-medium">{snapshot.continuation.sourceTitle || "无"}</div>
            </div>
            <div className="rounded-lg border bg-background p-4">
              <div className="text-xs text-muted-foreground">目标章节</div>
              <div className="mt-1 font-medium">{snapshot.targetChapterOrder ?? "未指定"}</div>
            </div>
          </div>
          {snapshot.positionAnchor ? (
            <div className="rounded-lg border bg-background p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">指定位置</span>
                <StatusBadge status={snapshot.positionAnchor.resolvedChunkId ? "active" : "not_enough_data"} />
                {snapshot.positionAnchor.corpusTitle ? <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{snapshot.positionAnchor.corpusTitle}</Badge> : null}
              </div>
              <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <span>章节：{typeof snapshot.positionAnchor.resolvedChapterIndex === "number" ? snapshot.positionAnchor.resolvedChapterIndex + 1 : "未定位"}</span>
                <span>段落：{typeof snapshot.positionAnchor.resolvedParagraphIndex === "number" ? snapshot.positionAnchor.resolvedParagraphIndex + 1 : "未定位"}</span>
                <span>Chunk：{snapshot.positionAnchor.resolvedChunkId ?? "未匹配"}</span>
              </div>
              {snapshot.positionAnchor.beforeText ? (
                <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">{snapshot.positionAnchor.beforeText}</pre>
              ) : null}
            </div>
          ) : null}
          {snapshot.outlineContext ? (
            <div className="rounded-lg border bg-background p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">反推大纲</span>
                <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                  导入章节 {snapshot.outlineContext.importedChapterCount}
                </Badge>
                <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                  伏笔 {snapshot.outlineContext.unresolvedForeshadows.length}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{snapshot.outlineContext.nextChapterBrief.premise}</p>
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-medium text-muted-foreground">最近章节摘要</div>
                  <div className="mt-2 space-y-2">
                    {snapshot.outlineContext.chapterSummaries.slice(-5).map((item, index) => (
                      <div key={`${item.corpusId}-${item.chapterIndex ?? index}`} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {typeof item.chapterIndex === "number" ? `第 ${item.chapterIndex + 1} 章` : "章节"}
                          {item.title ? ` · ${item.title}` : ""}
                        </span>
                        <span>：{item.summary}</span>
                      </div>
                    ))}
                    {snapshot.outlineContext.chapterSummaries.length === 0 ? <EmptyState label="暂无章节摘要。" /> : null}
                  </div>
                </div>
                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-medium text-muted-foreground">未解伏笔/冲突</div>
                  <div className="mt-2 space-y-2">
                    {snapshot.outlineContext.unresolvedForeshadows.slice(0, 5).map((item, index) => (
                      <div key={`${item.corpusId}-${item.title}-${index}`} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{item.title}</span>
                        <span>：{item.evidence}</span>
                      </div>
                    ))}
                    {snapshot.outlineContext.unresolvedForeshadows.length === 0 ? <EmptyState label="暂无未解伏笔候选。" /> : null}
                  </div>
                </div>
                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-medium text-muted-foreground">下一章约束</div>
                  <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                    {[...snapshot.outlineContext.nextChapterBrief.requiredContinuity, ...snapshot.outlineContext.nextChapterBrief.recommendedFocus]
                      .map((item) => <div key={item}>{item}</div>)}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {snapshot.styleContext ? (
            <div className="rounded-lg border bg-background p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">风格续写</span>
                <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                  StyleProfile {snapshot.styleContext.activeStyleProfiles.length}
                </Badge>
                <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                  候选 {snapshot.styleContext.styleCandidates.length}
                </Badge>
                <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
                  强度 {snapshot.styleContext.writingConstraints.styleIntensity}
                </Badge>
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-medium text-muted-foreground">绑定画像</div>
                  <div className="mt-2 space-y-2">
                    {snapshot.styleContext.activeStyleProfiles.slice(0, 4).map((profile) => (
                      <div key={profile.id} className="text-xs text-muted-foreground">
                        <div className="font-medium text-foreground">{profile.name}</div>
                        {profile.languageSummary ? <div className="line-clamp-2">语言：{profile.languageSummary}</div> : null}
                        {profile.rhythmSummary ? <div className="line-clamp-2">节奏：{profile.rhythmSummary}</div> : null}
                      </div>
                    ))}
                    {snapshot.styleContext.activeStyleProfiles.length === 0 ? <EmptyState label="暂无绑定 StyleProfile。" /> : null}
                  </div>
                </div>
                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-medium text-muted-foreground">语料风格候选</div>
                  <div className="mt-2 space-y-2">
                    {snapshot.styleContext.styleCandidates.slice(0, 4).map((candidate) => (
                      <div key={candidate.corpusId} className="text-xs text-muted-foreground">
                        <div className="font-medium text-foreground">{candidate.corpusTitle}</div>
                        <div>{candidate.summary}</div>
                        {candidate.sampleSentences[0] ? <div className="mt-1 line-clamp-1">样句：{candidate.sampleSentences[0]}</div> : null}
                      </div>
                    ))}
                    {snapshot.styleContext.styleCandidates.length === 0 ? <EmptyState label="暂无语料风格候选。" /> : null}
                  </div>
                </div>
                <div className="rounded-md border bg-muted/20 p-3">
                  <div className="text-xs font-medium text-muted-foreground">写作约束</div>
                  <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                    {snapshot.styleContext.writingConstraints.requiredContinuity.slice(0, 5).map((item) => <div key={item}>{item}</div>)}
                    {snapshot.styleContext.writingConstraints.avoidPatterns.slice(0, 3).map((item) => <div key={item}>避免：{item}</div>)}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">续写强约束</span>
          <Badge variant="outline" className={statusBadgeClass(snapshot.continuation.enabled ? "active" : "not_enough_data")}>{snapshot.continuation.enabled ? "enabled" : "not_enough_data"}</Badge>
          {snapshot.continuation.sourceType ? <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{snapshot.continuation.sourceType}</Badge> : null}
        </div>
        {snapshot.continuation.systemRule ? <p className="mt-2 text-sm text-muted-foreground">{snapshot.continuation.systemRule}</p> : null}
        {snapshot.continuation.humanBlock ? (
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">{snapshot.continuation.humanBlock}</pre>
        ) : <EmptyState label="当前没有可用续写约束。" />}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border bg-background p-4">
          <div className="font-medium">Reference Corpus</div>
          <div className="mt-3 space-y-2">
            {snapshot.referenceCorpora.length === 0 ? <EmptyState label="暂无续写语料。" /> : null}
            {snapshot.referenceCorpora.map((corpus) => (
              <div key={corpus.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{corpus.title}</span>
                  <StatusBadge status={corpus.latestIndexStatus} />
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{corpus.sourceType}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">章节 {corpus.chapterChunkCount} · 段落 {corpus.paragraphChunkCount} · 更新 {formatDate(corpus.updatedAt)}</div>
                {corpus.summary ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{corpus.summary}</p> : null}
              </div>
            ))}
          </div>
        </div>

        <ContinuationRecallHitsPreview
          title="引用片段与原因"
          hits={snapshot.recallHits}
          emptyLabel="暂无召回片段。"
        />
      </div>
        </>
      ) : null}
    </div>
  );
}

function ContinuationRecallHitsPreview(props: {
  title: string;
  hits: ContinuationContextSnapshot["recallHits"];
  emptyLabel: string;
  maxItems?: number;
  embedded?: boolean;
}) {
  const visibleHits = typeof props.maxItems === "number" ? props.hits.slice(0, props.maxItems) : props.hits;
  return (
    <div className={props.embedded ? "mt-4 border-t pt-4" : "rounded-lg border bg-background p-4"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{props.title}</span>
        <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{props.hits.length}</Badge>
        {props.maxItems && props.hits.length > props.maxItems ? (
          <span className="text-xs text-muted-foreground">显示前 {props.maxItems} 条</span>
        ) : null}
      </div>
      <div className="mt-3 space-y-2">
        {visibleHits.length === 0 ? <EmptyState label={props.emptyLabel} /> : null}
        {visibleHits.map((hit) => (
          <div key={`${hit.corpusId}:${hit.id}:${hit.reason}`} className="rounded-md border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {hit.source ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{hit.source}</Badge> : null}
              <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{hit.chunkType}</Badge>
              <span className="text-xs text-muted-foreground">{hit.corpusTitle} · chunk #{hit.chunkOrder}</span>
              {typeof hit.chapterIndex === "number" ? <span className="text-xs text-muted-foreground">第 {hit.chapterIndex + 1} 章</span> : null}
              {hit.title ? <span className="font-medium">{hit.title}</span> : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">使用原因：{hit.reason}</p>
            <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{hit.summary || hit.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReferenceCorpusPanel(props: {
  rows: ReferenceCorpus[];
  hasNovelId: boolean;
  title: string;
  sourceType: string;
  content: string;
  recallQuery: string;
  recallResult?: ReferenceCorpusRecallResult | null;
  pendingId?: string | null;
  stylePresetKey: "imitate" | "balanced" | "transfer";
  selectedStyleDimensions: ReferenceStyleLearningDimension[];
  isImporting: boolean;
  isCreatingStyleProfile: boolean;
  onTitleChange: (value: string) => void;
  onSourceTypeChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onRecallQueryChange: (value: string) => void;
  onStylePresetKeyChange: (value: "imitate" | "balanced" | "transfer") => void;
  onToggleStyleDimension: (dimension: ReferenceStyleLearningDimension, checked: boolean) => void;
  onImport: () => void;
  onReindex: (id: string) => void;
  onArchive: (id: string) => void;
  onRecall: (id: string) => void;
  onCreateStyleProfile: (id: string, title: string) => void;
}) {
  const latest = props.rows[0] ?? null;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background p-4">
        <div className="grid gap-3 lg:grid-cols-[0.8fr_0.45fr_1.2fr_auto] lg:items-end">
          <div>
            <label className="text-xs font-medium text-muted-foreground">标题</label>
            <Input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} placeholder="导入文本标题" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">类型</label>
            <Input value={props.sourceType} onChange={(event) => props.onSourceTypeChange(event.target.value)} placeholder="continuation_source" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">文本</label>
            <textarea
              value={props.content}
              onChange={(event) => props.onContentChange(event.target.value)}
              placeholder="粘贴 5-10 章、样章或参考材料"
              className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <Button type="button" disabled={!props.hasNovelId || props.isImporting || props.content.trim().length === 0} onClick={props.onImport}>
            导入
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          导入会写入 Postgres，并生成章节、段落、摘要、实体、时间线、伏笔与风格候选；Qdrant 只通过索引任务持有语义向量。
        </p>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className="grid gap-4 lg:grid-cols-[0.45fr_1fr]">
          <div>
            <label className="text-xs font-medium text-muted-foreground">生成方式</label>
            <Select value={props.stylePresetKey} onValueChange={(value) => props.onStylePresetKeyChange(value as "imitate" | "balanced" | "transfer")}>
              <SelectTrigger className="mt-1 h-10 rounded-md">
                <SelectValue placeholder="选择生成方式" />
              </SelectTrigger>
              <SelectContent>
                {REFERENCE_STYLE_PRESET_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-2 text-xs text-muted-foreground">
              {REFERENCE_STYLE_PRESET_OPTIONS.find((option) => option.value === props.stylePresetKey)?.summary}
            </p>
          </div>
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-medium text-muted-foreground">学习维度</label>
              <span className={cn("text-xs", props.selectedStyleDimensions.length === 0 ? "text-destructive" : "text-muted-foreground")}>
                已选 {props.selectedStyleDimensions.length} / {REFERENCE_STYLE_LEARNING_DIMENSIONS.length}
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {REFERENCE_STYLE_LEARNING_DIMENSIONS.map((dimension) => {
                const checked = props.selectedStyleDimensions.includes(dimension);
                return (
                  <label
                    key={dimension}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs",
                      checked ? "border-slate-300 bg-muted/40 text-foreground" : "border-border text-muted-foreground",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => props.onToggleStyleDimension(dimension, event.target.checked)}
                    />
                    <span>{REFERENCE_STYLE_LEARNING_DIMENSION_LABELS[dimension]}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {props.rows.length === 0 ? (
        <EmptyState label={props.hasNovelId ? "暂无 Reference Corpus。导入样章或旧章节后会显示切分和抽取结果。" : "输入 novelId 后可导入 Reference Corpus。"} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {props.rows.map((row) => (
            <div key={row.id} className="rounded-lg border bg-background p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.title}</span>
                <StatusBadge status={row.latestIndexStatus} />
                <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{row.sourceType}</Badge>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{row.summary ?? "暂无摘要"}</p>
              <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                <span>字符：{row.charCount}</span>
                <span>章节：{row.chapterChunkCount}</span>
                <span>段落：{row.paragraphChunkCount}</span>
                <span>更新：{formatDate(row.updatedAt)}</span>
              </div>
              <ReferenceCorpusIndexJobSummary job={row.latestIndexJob} />
              <ReferenceCorpusExtractionSummary extraction={parseReferenceCorpusExtraction(row.extractionJson)} />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" disabled={props.pendingId === row.id} onClick={() => props.onReindex(row.id)}>
                  重建索引
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={props.pendingId === row.id || props.isCreatingStyleProfile || props.selectedStyleDimensions.length === 0}
                  onClick={() => props.onCreateStyleProfile(row.id, row.title)}
                >
                  生成 StyleProfile
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={props.pendingId === row.id || !props.recallQuery.trim()} onClick={() => props.onRecall(row.id)}>
                  召回测试
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={props.pendingId === row.id} onClick={() => props.onArchive(row.id)}>
                  归档
                </Button>
              </div>
              <JsonPreview label="抽取候选" raw={row.extractionJson} />
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border bg-background p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label className="text-xs font-medium text-muted-foreground">召回查询</label>
            <Input value={props.recallQuery} onChange={(event) => props.onRecallQueryChange(event.target.value)} placeholder="主角状态 / 地点 / 伏笔 / 风格片段" />
          </div>
          <Button type="button" variant="outline" disabled={!latest || !props.recallQuery.trim()} onClick={() => latest && props.onRecall(latest.id)}>
            用最新语料召回
          </Button>
        </div>
        {props.recallResult ? (
          <div className="mt-4 space-y-2">
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-xs",
                props.recallResult.keywordFallbackUsed
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">召回路径</span>
                <span>索引状态：{props.recallResult.latestIndexStatus ?? "unknown"}</span>
                <span>语义命中：{props.recallResult.semanticHitCount}</span>
                <span>结果：{props.recallResult.hits.length}</span>
                <span>{props.recallResult.semanticAvailable && !props.recallResult.keywordFallbackUsed ? "Qdrant 语义召回" : "Postgres 关键词回退"}</span>
              </div>
              {props.recallResult.notice ? <p className="mt-1">{props.recallResult.notice}</p> : null}
            </div>
            {props.recallResult.hits.length === 0 ? <EmptyState label="没有命中召回片段。" /> : null}
            {props.recallResult.hits.map((hit) => (
              <div key={hit.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{hit.source}</Badge>
                  <span className="text-xs text-muted-foreground">chunk #{hit.chunkOrder} · score {hit.score}</span>
                  {hit.title ? <span className="font-medium">{hit.title}</span> : null}
                </div>
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{hit.chunkText}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReferenceCorpusIndexJobSummary({ job }: { job?: ReferenceCorpusIndexJob | null }) {
  if (!job) {
    return (
      <div className="mt-3 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
        暂无 RAG 索引任务记录。
      </div>
    );
  }
  const progress = job.progress;
  return (
    <div className="mt-3 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">RAG 索引任务</span>
        <StatusBadge status={job.status} />
        <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{job.jobType}</Badge>
        <span>尝试 {job.attempts}/{job.maxAttempts}</span>
        <span>更新 {formatDate(job.updatedAt)}</span>
      </div>
      {progress ? (
        <div className="mt-2 grid gap-1 sm:grid-cols-4">
          <span>阶段：{progress.label}</span>
          <span>进度：{formatPercent(progress.percent)}</span>
          <span>文档：{progress.documents ?? "无"}</span>
          <span>Chunk：{progress.chunks ?? "无"}</span>
          {progress.detail ? <span className="min-w-0 truncate sm:col-span-4">详情：{progress.detail}</span> : null}
        </div>
      ) : null}
      {job.lastError ? <p className="mt-2 line-clamp-2 text-destructive">错误：{job.lastError}</p> : null}
    </div>
  );
}

function ReferenceCorpusExtractionSummary({ extraction }: { extraction: ReferenceCorpusExtraction | null }) {
  if (!extraction) {
    return <EmptyState label="暂无可解析抽取结果。" />;
  }
  const entityGroups: Array<[string, string[]]> = [
    ["角色", extraction.characters],
    ["地点", extraction.locations],
    ["势力", extraction.factions],
    ["物品", extraction.items],
  ];
  return (
    <div className="mt-3 space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
        <span>角色 {extraction.characters.length}</span>
        <span>地点 {extraction.locations.length}</span>
        <span>势力 {extraction.factions.length}</span>
        <span>物品 {extraction.items.length}</span>
        <span>时间线 {extraction.timelineCandidates.length}</span>
        <span>伏笔 {extraction.foreshadowCandidates.length}</span>
        <span>均句长 {extraction.styleCandidate.avgSentenceLength}</span>
        <span>对话占比 {Math.round(extraction.styleCandidate.dialogueRatio * 100)}%</span>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {entityGroups.map(([label, items]) => (
          <div key={label} className="rounded-md bg-background p-2">
            <div className="text-xs font-medium text-muted-foreground">{label}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {items.slice(0, 12).map((item) => (
                <Badge key={`${label}-${item}`} variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{item}</Badge>
              ))}
              {items.length === 0 ? <span className="text-xs text-muted-foreground">无候选</span> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        <div className="rounded-md bg-background p-2">
          <div className="text-xs font-medium text-muted-foreground">时间线候选</div>
          <div className="mt-2 space-y-2">
            {extraction.timelineCandidates.slice(0, 4).map((item, index) => (
              <div key={`${item.title}-${index}`} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{item.title}</span>
                <span>：{item.summary}</span>
              </div>
            ))}
            {extraction.timelineCandidates.length === 0 ? <span className="text-xs text-muted-foreground">无候选</span> : null}
          </div>
        </div>
        <div className="rounded-md bg-background p-2">
          <div className="text-xs font-medium text-muted-foreground">伏笔/疑点候选</div>
          <div className="mt-2 space-y-2">
            {extraction.foreshadowCandidates.slice(0, 4).map((item, index) => (
              <div key={`${item.title}-${index}`} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{item.title}</span>
                <span>：{item.evidence}</span>
              </div>
            ))}
            {extraction.foreshadowCandidates.length === 0 ? <span className="text-xs text-muted-foreground">无候选</span> : null}
          </div>
        </div>
      </div>
      <div className="rounded-md bg-background p-2">
        <div className="text-xs font-medium text-muted-foreground">风格候选</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {extraction.styleCandidate.dominantPunctuation.map((mark) => (
            <Badge key={mark} variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">{mark}</Badge>
          ))}
          {extraction.styleCandidate.sampleSentences.slice(0, 2).map((sentence, index) => (
            <span key={`${sentence}-${index}`} className="line-clamp-1 text-xs text-muted-foreground">{sentence}</span>
          ))}
          {extraction.styleCandidate.dominantPunctuation.length === 0 && extraction.styleCandidate.sampleSentences.length === 0
            ? <span className="text-xs text-muted-foreground">无候选</span>
            : null}
        </div>
      </div>
    </div>
  );
}

export default function AIWorkbenchPage() {
  const navigate = useNavigate();
  const llm = useLLMStore();
  const [activeWorkbenchTab, setActiveWorkbenchTab] = useState("from-zero");
  const [novelIdInput, setNovelIdInput] = useState("");
  const [chapterOrderInput, setChapterOrderInput] = useState("");
  const [appliedNovelId, setAppliedNovelId] = useState("");
  const [appliedChapterOrder, setAppliedChapterOrder] = useState<number | undefined>(undefined);
  const [fromZeroIdea, setFromZeroIdea] = useState("");
  const [fromZeroTitle, setFromZeroTitle] = useState("");
  const [fromZeroStyleTone, setFromZeroStyleTone] = useState("");
  const [fromZeroFirstChapterCount, setFromZeroFirstChapterCount] = useState("3");
  const [fromZeroDefaultChapterLength, setFromZeroDefaultChapterLength] = useState("2800");
  const [fromZeroProvider, setFromZeroProvider] = useState("");
  const [fromZeroModel, setFromZeroModel] = useState("");
  const [fromZeroTaskId, setFromZeroTaskId] = useState<string | null>(null);
  const [fromZeroGenerationResult, setFromZeroGenerationResult] = useState<FromZeroGenerationResult | null>(null);
  const [continuationMode, setContinuationMode] = useState<ContinuationWorkbenchMode>("direct");
  const [continuationTargetOrder, setContinuationTargetOrder] = useState("");
  const [continuationTargetWordCount, setContinuationTargetWordCount] = useState("2200");
  const [continuationPositionCorpusId, setContinuationPositionCorpusId] = useState("");
  const [continuationPositionChapterNumber, setContinuationPositionChapterNumber] = useState("");
  const [continuationPositionParagraphNumber, setContinuationPositionParagraphNumber] = useState("");
  const [continuationPositionAnchorText, setContinuationPositionAnchorText] = useState("");
  const [continuationProvider, setContinuationProvider] = useState("openai");
  const [continuationModel, setContinuationModel] = useState("");
  const [lastContinuationGenerationResult, setLastContinuationGenerationResult] = useState<ContinuationGenerationResult | null>(null);
  const continuationContextChapterOrder = parseOptionalPositiveInteger(continuationTargetOrder) ?? appliedChapterOrder;
  const continuationPositionChapterIndex = continuationMode === "position"
    ? parseOptionalPositiveInteger(continuationPositionChapterNumber)
    : undefined;
  const continuationPositionParagraphIndex = continuationMode === "position"
    ? parseOptionalPositiveInteger(continuationPositionParagraphNumber)
    : undefined;
  const params = useMemo(
    () => ({
      novelId: appliedNovelId.trim() || undefined,
      limit: 30,
    }),
    [appliedNovelId],
  );
  const paramsKey = JSON.stringify(params);
  const storyStateParams = useMemo(
    () => ({
      novelId: appliedNovelId.trim(),
      chapterOrder: appliedChapterOrder,
      limit: 60,
    }),
    [appliedNovelId, appliedChapterOrder],
  );
  const storyStateParamsKey = JSON.stringify(storyStateParams);
  const continuationContextParams = useMemo(
    () => ({
      novelId: appliedNovelId.trim(),
      chapterOrder: continuationContextChapterOrder,
      mode: continuationMode,
      positionCorpusId: continuationMode === "position" ? continuationPositionCorpusId.trim() || undefined : undefined,
      positionChapterIndex: continuationPositionChapterIndex ? continuationPositionChapterIndex - 1 : undefined,
      positionParagraphIndex: continuationPositionParagraphIndex ? continuationPositionParagraphIndex - 1 : undefined,
      positionAnchorText: continuationMode === "position" ? continuationPositionAnchorText.trim() || undefined : undefined,
    }),
    [
      appliedNovelId,
      continuationContextChapterOrder,
      continuationMode,
      continuationPositionAnchorText,
      continuationPositionChapterIndex,
      continuationPositionCorpusId,
      continuationPositionParagraphIndex,
    ],
  );
  const continuationContextParamsKey = JSON.stringify(continuationContextParams);
  const referenceCorporaParams = useMemo(
    () => ({
      novelId: appliedNovelId.trim(),
      limit: 20,
    }),
    [appliedNovelId],
  );
  const referenceCorporaParamsKey = JSON.stringify(referenceCorporaParams);

  const chainQuery = useQuery({
    queryKey: queryKeys.aiWorkbench.productionChain(paramsKey),
    queryFn: () => getProductionChainSnapshot(params),
    refetchInterval: (query) => {
      const snapshot = query.state.data?.data;
      if (!snapshot) return false;
      const hasActiveBatch = snapshot.batchJobs.some((job) => ACTIVE_BATCH_STATUSES.has(job.status));
      const hasPendingReview = snapshot.reviewGateResults.some((item) => item.needsHumanConfirmation);
      return hasActiveBatch || hasPendingReview ? 4000 : false;
    },
  });

  const skillsQuery = useQuery({
    queryKey: queryKeys.aiWorkbench.skills("all"),
    queryFn: () => listSkills({ limit: 200 }),
  });

  const styleProfilesQuery = useQuery({
    queryKey: queryKeys.styleEngine.profiles,
    queryFn: getStyleProfiles,
  });

  const modelRoutesQuery = useQuery({
    queryKey: queryKeys.settings.modelRoutes,
    queryFn: getModelRoutes,
  });

  const structuredFallbackQuery = useQuery({
    queryKey: queryKeys.settings.structuredFallback,
    queryFn: getStructuredFallbackConfig,
  });

  const projectSkillsQuery = useQuery({
    queryKey: queryKeys.aiWorkbench.projectSkills(appliedNovelId.trim()),
    queryFn: () => listProjectSkills(appliedNovelId.trim()),
    enabled: appliedNovelId.trim().length > 0,
  });

  const storyStateQuery = useQuery({
    queryKey: queryKeys.aiWorkbench.storyState(storyStateParamsKey),
    queryFn: () => getStoryStateRuntimeSnapshot(storyStateParams),
    enabled: storyStateParams.novelId.length > 0,
  });

  const continuationContextQuery = useQuery({
    queryKey: queryKeys.aiWorkbench.continuationContext(continuationContextParamsKey),
    queryFn: () => getContinuationContextSnapshot(continuationContextParams),
    enabled: continuationContextParams.novelId.length > 0,
  });

  const referenceCorporaQuery = useQuery({
    queryKey: queryKeys.aiWorkbench.referenceCorpora(referenceCorporaParamsKey),
    queryFn: () => listReferenceCorpora(referenceCorporaParams),
    enabled: referenceCorporaParams.novelId.length > 0,
  });

  const snapshot = chainQuery.data?.data;
  const storyStateSnapshot = storyStateQuery.data?.data;
  const continuationContextSnapshot = continuationContextQuery.data?.data;
  const referenceCorpora = referenceCorporaQuery.data?.data ?? [];
  const skills = skillsQuery.data?.data ?? [];
  const styleProfiles = styleProfilesQuery.data?.data ?? [];
  const modelRoutes = modelRoutesQuery.data?.data ?? null;
  const structuredFallback = structuredFallbackQuery.data?.data ?? null;
  const projectSkills = projectSkillsQuery.data?.data ?? [];
  const modelCallTokens = snapshot?.modelCallLogs.reduce((sum, item) => sum + item.totalTokens, 0) ?? 0;
  const activeBatchCount = snapshot?.batchJobs.filter((item) => ACTIVE_BATCH_STATUSES.has(item.status)).length ?? 0;
  const pendingReviewGateCount = snapshot?.reviewGateResults.filter((item) => item.needsHumanConfirmation).length ?? 0;
  const highRiskPatchCount = snapshot?.statePatches.filter((item) => item.riskLevel === "high").length ?? 0;
  const deterministicIssueCount = storyStateSnapshot?.deterministicChecks.reduce((sum, check) => sum + check.totalIssues, 0) ?? 0;
  const blockedCheckCount = storyStateSnapshot?.deterministicChecks.filter((check) => check.status === "blocked").length ?? 0;
  const [batchStartOrder, setBatchStartOrder] = useState("");
  const [batchChapterCount, setBatchChapterCount] = useState("1");
  const [batchProvider, setBatchProvider] = useState("");
  const [batchModel, setBatchModel] = useState("");
  const [pendingBatchActionId, setPendingBatchActionId] = useState<string | null>(null);
  const [pendingStatePatchId, setPendingStatePatchId] = useState<string | null>(null);
  const [pendingSkillId, setPendingSkillId] = useState<string | null>(null);
  const [referenceTitle, setReferenceTitle] = useState("");
  const [referenceSourceType, setReferenceSourceType] = useState("continuation_source");
  const [referenceContent, setReferenceContent] = useState("");
  const [referenceRecallQuery, setReferenceRecallQuery] = useState("");
  const [referenceRecallResult, setReferenceRecallResult] = useState<ReferenceCorpusRecallResult | null>(null);
  const [pendingReferenceCorpusId, setPendingReferenceCorpusId] = useState<string | null>(null);
  const [referenceStylePresetKey, setReferenceStylePresetKey] = useState<"imitate" | "balanced" | "transfer">("balanced");
  const [referenceStyleDimensions, setReferenceStyleDimensions] = useState<ReferenceStyleLearningDimension[]>(
    DEFAULT_REFERENCE_STYLE_DIMENSIONS,
  );
  const [styleLabProfileId, setStyleLabProfileId] = useState("");
  const [styleLabMode, setStyleLabMode] = useState<"generate" | "rewrite">("generate");
  const [styleLabTopic, setStyleLabTopic] = useState("");
  const [styleLabSourceText, setStyleLabSourceText] = useState("");
  const [styleLabTargetLength, setStyleLabTargetLength] = useState("800");
  const [styleLabIntensity, setStyleLabIntensity] = useState("0.8");
  const [styleLabProvider, setStyleLabProvider] = useState("openai");
  const [styleLabModel, setStyleLabModel] = useState("");
  const [styleLabOutput, setStyleLabOutput] = useState("");
  const [styleLabCompiledBlocks, setStyleLabCompiledBlocks] = useState<CompiledStylePromptBlocks | null>(null);
  const [styleLabDetectionReport, setStyleLabDetectionReport] = useState<StyleDetectionReport | null>(null);
  const [styleLabComparisonRuns, setStyleLabComparisonRuns] = useState<StyleLabComparisonRun[]>([]);
  const [styleProfileAnalysisDraft, setStyleProfileAnalysisDraft] = useState("");
  const [styleProfileNarrativeSummaryDraft, setStyleProfileNarrativeSummaryDraft] = useState("");
  const [styleProfileCharacterSummaryDraft, setStyleProfileCharacterSummaryDraft] = useState("");
  const [styleProfileLanguageSummaryDraft, setStyleProfileLanguageSummaryDraft] = useState("");
  const [styleProfileRhythmSummaryDraft, setStyleProfileRhythmSummaryDraft] = useState("");
  const selectedStyleLabProfile = styleProfiles.find((profile) => profile.id === styleLabProfileId) ?? null;
  const currentStyleChapter = typeof appliedChapterOrder === "number"
    ? storyStateSnapshot?.chapterTree.find((chapter) => chapter.order === appliedChapterOrder) ?? null
    : null;
  const currentStyleVolume = currentStyleChapter?.volumeId
    ? {
      id: currentStyleChapter.volumeId,
      title: currentStyleChapter.volumeTitle ?? `第 ${currentStyleChapter.volumeOrder ?? "?"} 卷`,
    }
    : null;
  const isRefreshing = chainQuery.isFetching
    || skillsQuery.isFetching
    || styleProfilesQuery.isFetching
    || projectSkillsQuery.isFetching
    || storyStateQuery.isFetching
    || continuationContextQuery.isFetching
    || referenceCorporaQuery.isFetching;

  const refreshWorkbench = async () => {
    await chainQuery.refetch();
    await skillsQuery.refetch();
    await styleProfilesQuery.refetch();
    if (appliedNovelId.trim()) {
      await projectSkillsQuery.refetch();
      await referenceCorporaQuery.refetch();
      await continuationContextQuery.refetch();
    }
    if (storyStateParams.novelId) {
      await storyStateQuery.refetch();
    }
  };

  useEffect(() => {
    if (!selectedStyleLabProfile) {
      setStyleProfileAnalysisDraft("");
      setStyleProfileNarrativeSummaryDraft("");
      setStyleProfileCharacterSummaryDraft("");
      setStyleProfileLanguageSummaryDraft("");
      setStyleProfileRhythmSummaryDraft("");
      return;
    }
    setStyleProfileAnalysisDraft(selectedStyleLabProfile.analysisMarkdown ?? "");
    setStyleProfileNarrativeSummaryDraft(readRuleSummary(selectedStyleLabProfile.narrativeRules));
    setStyleProfileCharacterSummaryDraft(readRuleSummary(selectedStyleLabProfile.characterRules));
    setStyleProfileLanguageSummaryDraft(readRuleSummary(selectedStyleLabProfile.languageRules));
    setStyleProfileRhythmSummaryDraft(readRuleSummary(selectedStyleLabProfile.rhythmRules));
  }, [selectedStyleLabProfile]);

  const handleStyleLabProfileChange = (value: string) => {
    setStyleLabProfileId(value);
    setStyleLabOutput("");
    setStyleLabCompiledBlocks(null);
    setStyleLabDetectionReport(null);
  };

  const createAndStartBatchMutation = useMutation({
    mutationFn: async () => {
      const novelId = appliedNovelId.trim();
      if (!novelId) {
        throw new Error("请先在顶部应用 novelId。");
      }
      const parsedStartOrder = Number.parseInt(batchStartOrder, 10);
      const parsedChapterCount = Number.parseInt(batchChapterCount, 10);
      if (!Number.isFinite(parsedStartOrder) || parsedStartOrder < 1) {
        throw new Error("请填写有效的起始章。");
      }
      if (!Number.isFinite(parsedChapterCount) || parsedChapterCount < 1 || parsedChapterCount > 5) {
        throw new Error("章数必须是 1-5。");
      }
      const config: Record<string, unknown> = {};
      if (batchProvider.trim()) config.provider = batchProvider.trim();
      if (batchModel.trim()) config.model = batchModel.trim();
      const created = await createBatchJob({
        novelId,
        jobType: "chapter_batch_generation",
        requestedChapterCount: parsedChapterCount,
        startChapterOrder: parsedStartOrder,
        endChapterOrder: parsedStartOrder + parsedChapterCount - 1,
        configJson: JSON.stringify(config),
      });
      if (!created.data?.id) {
        throw new Error(created.error ?? "批量任务创建失败。");
      }
      return startBatchJob(created.data.id);
    },
    onSuccess: async () => {
      toast.success("批量任务已创建并启动。");
      await refreshWorkbench();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "批量任务创建失败。");
    },
  });

  const createFromZeroTaskMutation = useMutation({
    mutationFn: async () => {
      const idea = fromZeroIdea.trim();
      if (!idea) {
        throw new Error("请先填写一句灵感。");
      }
      const parsedChapterCount = Number.parseInt(fromZeroFirstChapterCount, 10);
      if (!Number.isFinite(parsedChapterCount) || parsedChapterCount < 1 || parsedChapterCount > 5) {
        throw new Error("首批章节必须是 1-5。");
      }
      const parsedChapterLength = Number.parseInt(fromZeroDefaultChapterLength, 10);
      if (!Number.isFinite(parsedChapterLength) || parsedChapterLength < 500) {
        throw new Error("单章字数必须不少于 500。");
      }
      const basicForm = {
        ...createDefaultNovelBasicFormState(),
        title: fromZeroTitle.trim(),
        description: idea,
        writingMode: "original" as const,
        projectMode: "ai_led" as const,
        styleTone: fromZeroStyleTone.trim(),
        defaultChapterLength: parsedChapterLength,
        estimatedChapterCount: 80,
        projectStatus: "in_progress" as const,
        storylineStatus: "not_started" as const,
        outlineStatus: "not_started" as const,
        resourceReadyScore: 0,
      };
      const provider = fromZeroProvider.trim();
      const model = fromZeroModel.trim();
      const response = await createFromZeroOpenBook({
        idea,
        title: fromZeroTitle.trim() || undefined,
        basicForm,
        styleTone: fromZeroStyleTone.trim(),
        firstChapterCount: parsedChapterCount,
        defaultChapterLength: parsedChapterLength,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        temperature: llm.temperature,
        maxTokens: llm.maxTokens,
      });
      const taskId = response.data?.autoDirectorTaskId ?? response.data?.task?.id ?? "";
      if (!taskId) {
        throw new Error(response.error ?? "自动导演任务创建失败。");
      }
      return taskId;
    },
    onSuccess: (taskId) => {
      setFromZeroTaskId(taskId);
      toast.success("自动导演任务已创建。");
      navigate(`/novels/auto-director?taskId=${encodeURIComponent(taskId)}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "自动导演任务创建失败。");
    },
  });

  const generateFromZeroBookMutation = useMutation({
    mutationFn: async () => {
      const idea = fromZeroIdea.trim();
      if (!idea) {
        throw new Error("请先填写一句灵感。");
      }
      const parsedChapterCount = Number.parseInt(fromZeroFirstChapterCount, 10);
      if (!Number.isFinite(parsedChapterCount) || parsedChapterCount < 1 || parsedChapterCount > 3) {
        throw new Error("直接生成验收样本的首批章节必须是 1-3。");
      }
      const parsedChapterLength = Number.parseInt(fromZeroDefaultChapterLength, 10);
      if (!Number.isFinite(parsedChapterLength) || parsedChapterLength < 2500 || parsedChapterLength > 4000) {
        throw new Error("直接生成验收样本的单章字数必须是 2500-4000。");
      }
      const provider = fromZeroProvider.trim();
      const model = fromZeroModel.trim();
      const response = await generateFromZeroBook({
        idea,
        title: fromZeroTitle.trim() || undefined,
        styleTone: fromZeroStyleTone.trim(),
        firstChapterCount: parsedChapterCount,
        defaultChapterLength: parsedChapterLength,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        temperature: llm.temperature,
        maxTokens: Math.max(llm.maxTokens ?? 0, 24000),
        targetOutlineChapterCount: 20,
        enqueueIndex: true,
      });
      if (!response.data) {
        throw new Error(response.error ?? "从零开书生成失败。");
      }
      return response.data;
    },
    onSuccess: async (result) => {
      setFromZeroGenerationResult(result);
      setNovelIdInput(result.novel.id);
      setAppliedNovelId(result.novel.id);
      setChapterOrderInput("1");
      setAppliedChapterOrder(1);
      toast.success(`从零开书已生成：《${result.novel.title}》。`);
      await refreshWorkbench();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "从零开书生成失败。");
    },
  });

  const batchActionMutation = useMutation({
    mutationFn: async (input: { id: string; action: "start" | "resume" | "cancel" }) => {
      setPendingBatchActionId(input.id);
      if (input.action === "start") return startBatchJob(input.id);
      if (input.action === "resume") return resumeBatchJob(input.id);
      return cancelBatchJob(input.id);
    },
    onSuccess: async (_result, input) => {
      const message = input.action === "cancel" ? "批量任务已取消。" : input.action === "resume" ? "批量任务已继续。" : "批量任务已启动。";
      toast.success(message);
      setPendingBatchActionId(null);
      await refreshWorkbench();
    },
    onError: (error) => {
      setPendingBatchActionId(null);
      toast.error(error instanceof Error ? error.message : "批量任务操作失败。");
    },
  });

  const statePatchDecisionMutation = useMutation({
    mutationFn: async (input: { id: string; status: Extract<StatePatchStatus, "accepted" | "rejected" | "reverted"> }) => {
      setPendingStatePatchId(input.id);
      return updateStatePatch(input.id, {
        status: input.status,
        decisionNote: input.status === "accepted"
          ? "human_accepted_and_applied_from_ai_workbench"
          : input.status === "reverted"
            ? "human_reverted_from_ai_workbench"
            : "human_rejected_from_ai_workbench",
      });
    },
    onSuccess: async (_result, input) => {
      const message = input.status === "accepted"
        ? "StatePatch 已接受并应用。"
        : input.status === "reverted"
          ? "StatePatch 已撤销。"
          : "StatePatch 已拒绝。";
      toast.success(message);
      setPendingStatePatchId(null);
      await refreshWorkbench();
    },
    onError: (error) => {
      setPendingStatePatchId(null);
      toast.error(error instanceof Error ? error.message : "StatePatch 决策失败。");
    },
  });

  const referenceImportMutation = useMutation({
    mutationFn: async () => {
      const novelId = appliedNovelId.trim();
      if (!novelId) {
        throw new Error("请先在顶部应用 novelId。");
      }
      const content = referenceContent.trim();
      if (!content) {
        throw new Error("请粘贴需要导入的参考文本。");
      }
      return createReferenceCorpus({
        novelId,
        title: referenceTitle.trim() || undefined,
        sourceType: referenceSourceType.trim() || "continuation_source",
        content,
        enqueueIndex: true,
      });
    },
    onSuccess: async () => {
      toast.success("Reference Corpus 已导入。");
      setReferenceTitle("");
      setReferenceContent("");
      setReferenceRecallResult(null);
      await refreshWorkbench();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Reference Corpus 导入失败。");
    },
  });

  const referenceReindexMutation = useMutation({
    mutationFn: async (id: string) => {
      setPendingReferenceCorpusId(id);
      return reindexReferenceCorpus(id);
    },
    onSuccess: async () => {
      toast.success("Reference Corpus 索引任务已入队。");
      setPendingReferenceCorpusId(null);
      await refreshWorkbench();
    },
    onError: (error) => {
      setPendingReferenceCorpusId(null);
      toast.error(error instanceof Error ? error.message : "Reference Corpus 索引重建失败。");
    },
  });

  const referenceArchiveMutation = useMutation({
    mutationFn: async (id: string) => {
      setPendingReferenceCorpusId(id);
      return archiveReferenceCorpus(id);
    },
    onSuccess: async () => {
      toast.success("Reference Corpus 已归档。");
      setPendingReferenceCorpusId(null);
      setReferenceRecallResult(null);
      await refreshWorkbench();
    },
    onError: (error) => {
      setPendingReferenceCorpusId(null);
      toast.error(error instanceof Error ? error.message : "Reference Corpus 归档失败。");
    },
  });

  const referenceRecallMutation = useMutation({
    mutationFn: async (id: string) => {
      const query = referenceRecallQuery.trim();
      if (!query) {
        throw new Error("请先填写召回查询。");
      }
      setPendingReferenceCorpusId(id);
      return recallReferenceCorpus(id, { query, limit: 10 });
    },
    onSuccess: (result) => {
      toast.success("Reference Corpus 召回完成。");
      setPendingReferenceCorpusId(null);
      setReferenceRecallResult(result.data ?? null);
    },
    onError: (error) => {
      setPendingReferenceCorpusId(null);
      toast.error(error instanceof Error ? error.message : "Reference Corpus 召回失败。");
    },
  });

  const referenceStyleProfileMutation = useMutation({
    mutationFn: async (input: { id: string; title: string }) => {
      setPendingReferenceCorpusId(input.id);
      return createReferenceCorpusStyleProfile(input.id, {
        name: `${input.title} 风格画像`,
        category: "Reference Corpus",
        provider: "openai",
        presetKey: referenceStylePresetKey,
        selectedDimensions: referenceStyleDimensions,
        bindToNovel: true,
      });
    },
    onSuccess: async (result) => {
      toast.success(`StyleProfile 已生成：${result.data?.styleProfile.name ?? "未命名写法资产"}`);
      setPendingReferenceCorpusId(null);
      await refreshWorkbench();
    },
    onError: (error) => {
      setPendingReferenceCorpusId(null);
      toast.error(error instanceof Error ? error.message : "StyleProfile 生成失败。");
    },
  });

  const continuationGenerateMutation = useMutation({
    mutationFn: async () => {
      const novelId = appliedNovelId.trim();
      if (!novelId) {
        throw new Error("请先在顶部应用 novelId。");
      }
      const targetChapterOrder = parseOptionalPositiveInteger(continuationTargetOrder);
      if (continuationTargetOrder.trim() && !targetChapterOrder) {
        throw new Error("目标章节必须是正整数。");
      }
      const targetWordCount = parseOptionalPositiveInteger(continuationTargetWordCount);
      if (continuationTargetWordCount.trim() && !targetWordCount) {
        throw new Error("目标字数必须是正整数。");
      }
      const positionChapterNumber = parseOptionalPositiveInteger(continuationPositionChapterNumber);
      if (continuationPositionChapterNumber.trim() && !positionChapterNumber) {
        throw new Error("语料章节必须是正整数。");
      }
      const positionParagraphNumber = parseOptionalPositiveInteger(continuationPositionParagraphNumber);
      if (continuationPositionParagraphNumber.trim() && !positionParagraphNumber) {
        throw new Error("语料段落必须是正整数。");
      }
      if (continuationMode === "position") {
        const hasPosition =
          continuationPositionCorpusId.trim().length > 0
          || Boolean(positionChapterNumber)
          || Boolean(positionParagraphNumber)
          || continuationPositionAnchorText.trim().length > 0;
        if (!hasPosition) {
          throw new Error("指定位置续写需要选择语料、填写章节/段落，或粘贴锚点文本。");
        }
        if (positionParagraphNumber && !positionChapterNumber && !continuationPositionAnchorText.trim()) {
          throw new Error("只填写段落时无法定位，请同时填写语料章节或锚点文本。");
        }
      }
      return generateContinuationChapter({
        novelId,
        mode: continuationMode,
        targetChapterOrder: targetChapterOrder ?? appliedChapterOrder,
        targetWordCount,
        positionCorpusId: continuationMode === "position" ? continuationPositionCorpusId.trim() || undefined : undefined,
        positionChapterIndex: continuationMode === "position" && positionChapterNumber ? positionChapterNumber - 1 : undefined,
        positionParagraphIndex: continuationMode === "position" && positionParagraphNumber ? positionParagraphNumber - 1 : undefined,
        positionAnchorText: continuationMode === "position" ? continuationPositionAnchorText.trim() || undefined : undefined,
        provider: continuationProvider.trim() || undefined,
        model: continuationModel.trim() || undefined,
      });
    },
    onSuccess: async (result) => {
      setLastContinuationGenerationResult(result.data ?? null);
      const chapter = result.data?.chapter;
      if (chapter) {
        setAppliedChapterOrder(chapter.order);
        setChapterOrderInput(String(chapter.order));
        setContinuationTargetOrder(String(chapter.order));
      }
      const gate = result.data?.reviewGateResult;
      const message = gate?.needsHumanConfirmation
        ? `第 ${chapter?.order ?? ""} 章已生成，ReviewGate 需要确认。`
        : `第 ${chapter?.order ?? ""} 章续写已生成。`;
      toast.success(result.data?.runtime.agentRunId ? `${message} AgentRun 已记录。` : message);
      await refreshWorkbench();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "续写章生成失败。");
    },
  });

  const styleLabTestWriteMutation = useMutation({
    mutationFn: async () => {
      if (!styleLabProfileId) {
        throw new Error("请先选择 StyleProfile。");
      }
      const targetLength = parseOptionalPositiveInteger(styleLabTargetLength);
      if (styleLabTargetLength.trim() && !targetLength) {
        throw new Error("试写字数必须是正整数。");
      }
      if (styleLabMode === "generate" && !styleLabTopic.trim()) {
        throw new Error("请填写同一剧情。");
      }
      if (styleLabMode === "rewrite" && !styleLabSourceText.trim()) {
        throw new Error("请粘贴待改写原文。");
      }
      return testWriteWithStyleProfileInWorkbench({
        styleProfileId: styleLabProfileId,
        mode: styleLabMode,
        topic: styleLabMode === "generate" ? styleLabTopic.trim() : undefined,
        sourceText: styleLabMode === "rewrite" ? styleLabSourceText.trim() : undefined,
        targetLength,
        novelId: appliedNovelId.trim() || undefined,
        volumeId: currentStyleVolume?.id,
        chapterId: currentStyleChapter?.id ?? undefined,
        provider: styleLabProvider.trim() || undefined,
        model: styleLabModel.trim() || undefined,
        temperature: 0.7,
        styleIntensity: parseStyleIntensity(styleLabIntensity),
      });
    },
    onSuccess: (result) => {
      const data = result.data;
      setStyleLabOutput(data?.output ?? "");
      setStyleLabCompiledBlocks(data?.compiledBlocks ?? null);
      setStyleLabDetectionReport(data?.detectionReport ?? null);
      if (data) {
        const profile = styleProfiles.find((item) => item.id === data.styleProfileId) ?? selectedStyleLabProfile;
        const sourceKey = createStyleLabComparisonKey(styleLabMode, styleLabTopic, styleLabSourceText);
        const comparisonRun: StyleLabComparisonRun = {
          id: data.agentRunId,
          sourceKey,
          mode: data.mode,
          profileId: data.styleProfileId,
          profileName: profile?.name ?? data.styleProfileId,
          profileCategory: profile?.category ?? null,
          intensity: parseStyleIntensity(styleLabIntensity),
          targetLength: data.targetLength ?? null,
          output: data.output,
          outputLength: data.outputLength,
          riskScore: data.detectionReport?.riskScore ?? null,
          violationCount: data.detectionReport?.violations.length ?? null,
          appliedRuleCount: data.compiledBlocks.appliedRuleIds.length,
          canAutoRewrite: data.detectionReport?.canAutoRewrite ?? null,
          agentRunId: data.agentRunId,
          createdAt: new Date().toISOString(),
        };
        setStyleLabComparisonRuns((runs) => [
          comparisonRun,
          ...runs.filter((run) => run.id !== comparisonRun.id),
        ].slice(0, 8));
      }
      void refreshWorkbench();
      toast.success(result.data?.detectionReport ? "风格试写和偏离检测完成。" : result.data?.agentRunId ? "风格试写完成，AgentRun 已记录。" : "风格试写完成。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "风格试写失败。");
    },
  });

  const styleProfileQuickEditMutation = useMutation({
    mutationFn: async () => {
      if (!selectedStyleLabProfile) {
        throw new Error("请先选择 StyleProfile。");
      }
      return updateStyleProfile(selectedStyleLabProfile.id, {
        analysisMarkdown: styleProfileAnalysisDraft,
        narrativeRules: {
          ...selectedStyleLabProfile.narrativeRules,
          summary: styleProfileNarrativeSummaryDraft.trim() || null,
        },
        characterRules: {
          ...selectedStyleLabProfile.characterRules,
          summary: styleProfileCharacterSummaryDraft.trim() || null,
        },
        languageRules: {
          ...selectedStyleLabProfile.languageRules,
          summary: styleProfileLanguageSummaryDraft.trim() || null,
        },
        rhythmRules: {
          ...selectedStyleLabProfile.rhythmRules,
          summary: styleProfileRhythmSummaryDraft.trim() || null,
        },
      });
    },
    onSuccess: async () => {
      toast.success("StyleProfile 摘要已保存。");
      setStyleLabCompiledBlocks(null);
      await refreshWorkbench();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "StyleProfile 摘要保存失败。");
    },
  });

  const styleLabDetectMutation = useMutation({
    mutationFn: async () => {
      if (!styleLabProfileId) {
        throw new Error("请先选择 StyleProfile。");
      }
      if (!styleLabOutput.trim()) {
        throw new Error("请先运行试写。");
      }
      return detectStyleLabDeviation({
        content: styleLabOutput,
        styleProfileId: styleLabProfileId,
        novelId: appliedNovelId.trim() || undefined,
        volumeId: currentStyleVolume?.id,
        chapterId: currentStyleChapter?.id ?? undefined,
        provider: styleLabProvider.trim() || undefined,
        model: styleLabModel.trim() || undefined,
        temperature: 0.2,
      });
    },
    onSuccess: (result) => {
      setStyleLabDetectionReport(result.data?.report ?? null);
      void refreshWorkbench();
      toast.success("风格偏离检测完成。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "风格偏离检测失败。");
    },
  });

  const styleLabBindingMutation = useMutation({
    mutationFn: async (targetType: Extract<StyleBinding["targetType"], "novel" | "volume" | "chapter">) => {
      const novelId = appliedNovelId.trim();
      if (!novelId) {
        throw new Error("请先在顶部应用 novelId。");
      }
      if (!styleLabProfileId) {
        throw new Error("请先选择 StyleProfile。");
      }
      const targetId = targetType === "chapter"
        ? currentStyleChapter?.id
        : targetType === "volume"
          ? currentStyleVolume?.id
          : novelId;
      if (!targetId) {
        throw new Error(targetType === "volume" ? "当前章节没有卷归属，无法绑定到卷。" : "当前章节未加载，无法绑定到章节。");
      }
      return createStyleBinding({
        styleProfileId: styleLabProfileId,
        targetType,
        targetId,
        priority: 1,
        weight: parseStyleIntensity(styleLabIntensity),
      });
    },
    onSuccess: async (_result, targetType) => {
      const label = targetType === "chapter" ? "当前章节" : targetType === "volume" ? "当前卷" : "当前书";
      toast.success(`StyleProfile 已应用到${label}。`);
      await refreshWorkbench();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "StyleProfile 应用失败。");
    },
  });

  const projectSkillMutation = useMutation({
    mutationFn: async (input: { skillId: string; enabled: boolean; priority: number }) => {
      const novelId = appliedNovelId.trim();
      if (!novelId) {
        throw new Error("请先在顶部应用 novelId。");
      }
      setPendingSkillId(input.skillId);
      return setProjectSkill(novelId, {
        skillId: input.skillId,
        enabled: input.enabled,
        priority: input.priority,
      });
    },
    onSuccess: async (_result, input) => {
      toast.success(input.enabled ? "Skill 已启用。" : "Skill 已禁用。");
      setPendingSkillId(null);
      await refreshWorkbench();
    },
    onError: (error) => {
      setPendingSkillId(null);
      toast.error(error instanceof Error ? error.message : "Skill 操作失败。");
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-col gap-4 rounded-lg border bg-background p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">一期工作台</Badge>
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">Postgres 主事实源</Badge>
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">AI Workbench</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            汇总从零开书、生产链、模型调用、ReviewGate、StatePatch 和 Skills 注册状态，用于批量生成与风险确认前的排障。
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[560px] sm:flex-row">
          <Input
            value={novelIdInput}
            onChange={(event) => setNovelIdInput(event.target.value)}
            placeholder="按 novelId 过滤"
            className="sm:flex-1"
          />
          <Input
            value={chapterOrderInput}
            onChange={(event) => setChapterOrderInput(event.target.value)}
            placeholder="章节号，可选"
            inputMode="numeric"
            className="sm:w-32"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const parsedChapterOrder = Number.parseInt(chapterOrderInput, 10);
              setAppliedNovelId(novelIdInput.trim());
              setAppliedChapterOrder(Number.isFinite(parsedChapterOrder) ? parsedChapterOrder : undefined);
              setLastContinuationGenerationResult(null);
            }}
          >
            应用过滤
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              void chainQuery.refetch();
              void skillsQuery.refetch();
              if (appliedNovelId.trim()) {
                void projectSkillsQuery.refetch();
                void referenceCorporaQuery.refetch();
                void continuationContextQuery.refetch();
              }
              if (storyStateParams.novelId) {
                void storyStateQuery.refetch();
              }
            }}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <SummaryCard
          label="AgentRun"
          value={snapshot?.agentRuns.length ?? 0}
          description="当前筛选范围内的执行记录"
          icon={Activity}
        />
        <SummaryCard
          label="活跃批次"
          value={activeBatchCount}
          description="queued/running/waiting/paused"
          icon={SlidersHorizontal}
          tone={activeBatchCount > 0 ? "warning" : undefined}
        />
        <SummaryCard
          label="模型 Token"
          value={modelCallTokens}
          description="最近模型调用合计"
          icon={Database}
        />
        <SummaryCard
          label="待确认门禁"
          value={pendingReviewGateCount}
          description="ReviewGate 需要人类确认"
          icon={pendingReviewGateCount > 0 ? ShieldAlert : CheckCircle2}
          tone={pendingReviewGateCount > 0 ? "warning" : "success"}
        />
        <SummaryCard
          label="高风险 Patch"
          value={highRiskPatchCount}
          description="StatePatch riskLevel=high"
          icon={AlertTriangle}
          tone={highRiskPatchCount > 0 ? "warning" : undefined}
        />
        <SummaryCard
          label="一致性问题"
          value={deterministicIssueCount}
          description={`阻断检查 ${blockedCheckCount} 项`}
          icon={GitBranch}
          tone={blockedCheckCount > 0 || deterministicIssueCount > 0 ? "warning" : "success"}
        />
      </div>

      <Tabs value={activeWorkbenchTab} onValueChange={setActiveWorkbenchTab} className="space-y-4">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="from-zero">从零开书</TabsTrigger>
          <TabsTrigger value="chain">生产链</TabsTrigger>
          <TabsTrigger value="story-state">StoryState</TabsTrigger>
          <TabsTrigger value="chapters">章节树</TabsTrigger>
          <TabsTrigger value="relations">人物图谱</TabsTrigger>
          <TabsTrigger value="timeline">时间线</TabsTrigger>
          <TabsTrigger value="foreshadow">伏笔</TabsTrigger>
          <TabsTrigger value="style">风格</TabsTrigger>
          <TabsTrigger value="continuation">续写上下文</TabsTrigger>
          <TabsTrigger value="reference">Reference Corpus</TabsTrigger>
          <TabsTrigger value="model">模型调用</TabsTrigger>
          <TabsTrigger value="review">ReviewGate</TabsTrigger>
          <TabsTrigger value="state">StatePatch</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
        </TabsList>

        <TabsContent value="from-zero">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">从零开书链路</CardTitle>
              <CardDescription>支持创建自动导演任务，也可直接生成书设、角色、前 20 章大纲和前 3 章正文验收样本。</CardDescription>
            </CardHeader>
            <CardContent>
              <FromZeroOpenBookPanel
                idea={fromZeroIdea}
                title={fromZeroTitle}
                styleTone={fromZeroStyleTone}
                firstChapterCount={fromZeroFirstChapterCount}
                defaultChapterLength={fromZeroDefaultChapterLength}
                provider={fromZeroProvider}
                model={fromZeroModel}
                createdTaskId={fromZeroTaskId}
                generationResult={fromZeroGenerationResult}
                isCreating={createFromZeroTaskMutation.isPending}
                isGenerating={generateFromZeroBookMutation.isPending}
                onIdeaChange={setFromZeroIdea}
                onTitleChange={setFromZeroTitle}
                onStyleToneChange={setFromZeroStyleTone}
                onFirstChapterCountChange={setFromZeroFirstChapterCount}
                onDefaultChapterLengthChange={setFromZeroDefaultChapterLength}
                onProviderChange={setFromZeroProvider}
                onModelChange={setFromZeroModel}
                onCreate={() => createFromZeroTaskMutation.mutate()}
                onGenerate={() => generateFromZeroBookMutation.mutate()}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chain" className="space-y-4">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Agent 运行</CardTitle>
              <CardDescription>Planner / ContextBuilder / Writer / Reviewer 的执行记录会在这里汇总。</CardDescription>
            </CardHeader>
            <CardContent>
              <AgentRunsPanel rows={snapshot?.agentRuns ?? []} />
            </CardContent>
          </Card>
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">批量任务</CardTitle>
              <CardDescription>批量生成任务、风险暂停和章节完成数。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <BatchJobCreatePanel
                novelId={appliedNovelId.trim()}
                startOrder={batchStartOrder}
                chapterCount={batchChapterCount}
                provider={batchProvider}
                model={batchModel}
                isPending={createAndStartBatchMutation.isPending}
                onStartOrderChange={setBatchStartOrder}
                onChapterCountChange={setBatchChapterCount}
                onProviderChange={setBatchProvider}
                onModelChange={setBatchModel}
                onCreate={() => createAndStartBatchMutation.mutate()}
              />
              <BatchJobsPanel
                rows={snapshot?.batchJobs ?? []}
                onAction={(input) => batchActionMutation.mutate(input)}
                pendingActionId={pendingBatchActionId}
              />
            </CardContent>
          </Card>
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Checkpoints</CardTitle>
              <CardDescription>记录批量进度、风险暂停和失败恢复点，作为工作包 B 的恢复证据。</CardDescription>
            </CardHeader>
            <CardContent>
              <CheckpointsPanel rows={snapshot?.checkpoints ?? []} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="story-state">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">StoryState 运行快照</CardTitle>
              <CardDescription>从 Postgres 聚合角色、时间线、伏笔、冲突、StatePatch、ReviewGate 和 Skill 状态。</CardDescription>
            </CardHeader>
            <CardContent>
              <StoryStatePanel
                snapshot={storyStateSnapshot}
                hasNovelId={storyStateParams.novelId.length > 0}
                isLoading={storyStateQuery.isFetching}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chapters">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">章节树</CardTitle>
              <CardDescription>按章节顺序展示生成状态、字数、质量分和风险标记。</CardDescription>
            </CardHeader>
            <CardContent>
              <ChapterTreePanel
                snapshot={storyStateSnapshot}
                hasNovelId={storyStateParams.novelId.length > 0}
                isLoading={storyStateQuery.isFetching}
                currentChapterOrder={appliedChapterOrder}
                onOpenBatchPanel={() => setActiveWorkbenchTab("chain")}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="relations">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">人物关系图</CardTitle>
              <CardDescription>从 Postgres 角色和关系表读取节点、关系边、信任与冲突评分。</CardDescription>
            </CardHeader>
            <CardContent>
              <RelationshipGraphPanel
                snapshot={storyStateSnapshot}
                hasNovelId={storyStateParams.novelId.length > 0}
                isLoading={storyStateQuery.isFetching}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="timeline">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">时间线</CardTitle>
              <CardDescription>展示事件线、活跃时间线约束和检测报告。</CardDescription>
            </CardHeader>
            <CardContent>
              <TimelineVisualizationPanel
                snapshot={storyStateSnapshot}
                hasNovelId={storyStateParams.novelId.length > 0}
                isLoading={storyStateQuery.isFetching}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="foreshadow">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">伏笔看板</CardTitle>
              <CardDescription>展示开放钩子、阻断伏笔和兑现账本状态。</CardDescription>
            </CardHeader>
            <CardContent>
              <ForeshadowBoardPanel
                snapshot={storyStateSnapshot}
                hasNovelId={storyStateParams.novelId.length > 0}
                isLoading={storyStateQuery.isFetching}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="style">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">风格分析</CardTitle>
              <CardDescription>展示当前小说绑定 StyleProfile 和可用风格画像摘要。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <StyleProfilesPanel
                snapshot={storyStateSnapshot}
                hasNovelId={storyStateParams.novelId.length > 0}
                isLoading={storyStateQuery.isFetching}
              />
              <StyleLabPanel
                profiles={styleProfiles}
                hasNovelId={storyStateParams.novelId.length > 0}
                currentChapterId={currentStyleChapter?.id}
                currentVolumeId={currentStyleVolume?.id}
                currentVolumeTitle={currentStyleVolume?.title}
                selectedProfileId={styleLabProfileId}
                mode={styleLabMode}
                topic={styleLabTopic}
                sourceText={styleLabSourceText}
                targetLength={styleLabTargetLength}
                intensity={styleLabIntensity}
                provider={styleLabProvider}
                model={styleLabModel}
                output={styleLabOutput}
                compiledBlocks={styleLabCompiledBlocks}
                detectionReport={styleLabDetectionReport}
                comparisonRuns={styleLabComparisonRuns}
                analysisMarkdownDraft={styleProfileAnalysisDraft}
                narrativeSummaryDraft={styleProfileNarrativeSummaryDraft}
                characterSummaryDraft={styleProfileCharacterSummaryDraft}
                languageSummaryDraft={styleProfileLanguageSummaryDraft}
                rhythmSummaryDraft={styleProfileRhythmSummaryDraft}
                isLoadingProfiles={styleProfilesQuery.isFetching}
                isTesting={styleLabTestWriteMutation.isPending}
                isDetecting={styleLabDetectMutation.isPending}
                isBinding={styleLabBindingMutation.isPending}
                isSavingProfile={styleProfileQuickEditMutation.isPending}
                onSelectedProfileIdChange={handleStyleLabProfileChange}
                onModeChange={setStyleLabMode}
                onTopicChange={setStyleLabTopic}
                onSourceTextChange={setStyleLabSourceText}
                onTargetLengthChange={setStyleLabTargetLength}
                onIntensityChange={setStyleLabIntensity}
                onProviderChange={setStyleLabProvider}
                onModelChange={setStyleLabModel}
                onAnalysisMarkdownDraftChange={setStyleProfileAnalysisDraft}
                onNarrativeSummaryDraftChange={setStyleProfileNarrativeSummaryDraft}
                onCharacterSummaryDraftChange={setStyleProfileCharacterSummaryDraft}
                onLanguageSummaryDraftChange={setStyleProfileLanguageSummaryDraft}
                onRhythmSummaryDraftChange={setStyleProfileRhythmSummaryDraft}
                onRunTestWrite={() => styleLabTestWriteMutation.mutate()}
                onDetectOutput={() => styleLabDetectMutation.mutate()}
                onSaveProfileDraft={() => styleProfileQuickEditMutation.mutate()}
                onBind={(targetType) => styleLabBindingMutation.mutate(targetType)}
              />
            </CardContent>
          </Card>
        </TabsContent>


        <TabsContent value="continuation">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">续写上下文</CardTitle>
              <CardDescription>展示 ContextBuilder 将交给 Writer 的续写约束、导入语料和引用原因。</CardDescription>
            </CardHeader>
            <CardContent>
              <ContinuationContextPanel
                snapshot={continuationContextSnapshot}
                hasNovelId={continuationContextParams.novelId.length > 0}
                isLoading={continuationContextQuery.isFetching}
                lastGenerationResult={lastContinuationGenerationResult}
                referenceCorpora={referenceCorpora}
                mode={continuationMode}
                targetOrder={continuationTargetOrder}
                targetWordCount={continuationTargetWordCount}
                positionCorpusId={continuationPositionCorpusId}
                positionChapterNumber={continuationPositionChapterNumber}
                positionParagraphNumber={continuationPositionParagraphNumber}
                positionAnchorText={continuationPositionAnchorText}
                provider={continuationProvider}
                model={continuationModel}
                isGenerating={continuationGenerateMutation.isPending}
                onModeChange={setContinuationMode}
                onTargetOrderChange={setContinuationTargetOrder}
                onTargetWordCountChange={setContinuationTargetWordCount}
                onPositionCorpusIdChange={setContinuationPositionCorpusId}
                onPositionChapterNumberChange={setContinuationPositionChapterNumber}
                onPositionParagraphNumberChange={setContinuationPositionParagraphNumber}
                onPositionAnchorTextChange={setContinuationPositionAnchorText}
                onProviderChange={setContinuationProvider}
                onModelChange={setContinuationModel}
                onGenerate={() => continuationGenerateMutation.mutate()}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reference">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Reference Corpus</CardTitle>
              <CardDescription>导入续写源、样章和参考材料，查看切分、抽取候选和召回结果。</CardDescription>
            </CardHeader>
            <CardContent>
              <ReferenceCorpusPanel
                rows={referenceCorpora}
                hasNovelId={referenceCorporaParams.novelId.length > 0}
                title={referenceTitle}
                sourceType={referenceSourceType}
                content={referenceContent}
                recallQuery={referenceRecallQuery}
                recallResult={referenceRecallResult}
                pendingId={pendingReferenceCorpusId}
                stylePresetKey={referenceStylePresetKey}
                selectedStyleDimensions={referenceStyleDimensions}
                isImporting={referenceImportMutation.isPending}
                isCreatingStyleProfile={referenceStyleProfileMutation.isPending}
                onTitleChange={setReferenceTitle}
                onSourceTypeChange={setReferenceSourceType}
                onContentChange={setReferenceContent}
                onRecallQueryChange={setReferenceRecallQuery}
                onStylePresetKeyChange={setReferenceStylePresetKey}
                onToggleStyleDimension={(dimension, checked) => {
                  setReferenceStyleDimensions((current) => {
                    if (checked) {
                      return current.includes(dimension) ? current : [...current, dimension];
                    }
                    return current.filter((item) => item !== dimension);
                  });
                }}
                onImport={() => referenceImportMutation.mutate()}
                onReindex={(id) => referenceReindexMutation.mutate(id)}
                onArchive={(id) => referenceArchiveMutation.mutate(id)}
                onRecall={(id) => referenceRecallMutation.mutate(id)}
                onCreateStyleProfile={(id, title) => referenceStyleProfileMutation.mutate({ id, title })}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="model">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">模型调用</CardTitle>
              <CardDescription>记录 provider、model、token、耗时和调用状态。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ModelConfigurationPanel
                provider={llm.provider}
                model={llm.model}
                temperature={llm.temperature}
                maxTokens={llm.maxTokens}
                modelRoutes={modelRoutes}
                structuredFallback={structuredFallback}
              />
              <ModelCallsPanel rows={snapshot?.modelCallLogs ?? []} summary={snapshot?.modelUsageSummary} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="review">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">ReviewGate 结果</CardTitle>
              <CardDescription>统一展示章节质量、一致性、风格偏离和人工确认信号。</CardDescription>
            </CardHeader>
            <CardContent>
              <ReviewGatePanel rows={snapshot?.reviewGateResults ?? []} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="state">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">StatePatch</CardTitle>
              <CardDescription>所有状态回灌都应有证据、风险等级和可追踪状态。</CardDescription>
            </CardHeader>
            <CardContent>
              <StatePatchesPanel
                rows={snapshot?.statePatches ?? []}
                reviewGateResults={snapshot?.reviewGateResults ?? []}
                onDecision={(input) => statePatchDecisionMutation.mutate(input)}
                pendingPatchId={pendingStatePatchId}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="skills">
          <Card className="rounded-lg shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Skills 注册表</CardTitle>
              <CardDescription>本地 Skill 注册、类型、优先级和冲突键。</CardDescription>
            </CardHeader>
            <CardContent>
              <SkillsPanel
                rows={skills}
                projectSkills={projectSkills}
                novelId={appliedNovelId.trim()}
                pendingSkillId={pendingSkillId}
                onToggle={(input) => projectSkillMutation.mutate(input)}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
