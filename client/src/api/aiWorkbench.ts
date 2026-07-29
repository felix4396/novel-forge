import type { ApiResponse } from "@ai-novel/shared/types/api";
import type {
  BatchJob,
  BatchJobStatus,
  ContinuationContextSnapshot,
  ContinuationGenerationResult,
  ContinuationWorkbenchMode,
  FromZeroGenerationResult,
  FromZeroOpenBookResult,
  ModelCallLog,
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
  StoryStateRuntimeSnapshot,
  WorkbenchCheckpoint,
} from "@ai-novel/shared/types/aiWorkbench";
import type {
  ReferenceCorpus,
  ReferenceCorpusDetail,
  ReferenceCorpusRecallResult,
  ReferenceCorpusStyleProfileResult,
  ReferenceStyleLearningDimension,
  ReferenceCorpusSourceType,
} from "@ai-novel/shared/types/referenceCorpus";
import { apiClient } from "./client";

export interface ProductionChainQuery {
  novelId?: string;
  chapterId?: string;
  limit?: number;
}

export interface StoryStateQuery {
  novelId: string;
  chapterOrder?: number;
  limit?: number;
}

export interface ContinuationContextQuery {
  novelId: string;
  chapterOrder?: number;
  mode?: ContinuationWorkbenchMode;
  positionCorpusId?: string;
  positionChapterIndex?: number;
  positionParagraphIndex?: number;
  positionAnchorText?: string;
}

export interface GenerateContinuationChapterInput {
  novelId: string;
  targetChapterOrder?: number;
  mode?: ContinuationWorkbenchMode;
  positionCorpusId?: string;
  positionChapterIndex?: number;
  positionParagraphIndex?: number;
  positionAnchorText?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  targetWordCount?: number;
}

export interface CreateFromZeroOpenBookInput {
  idea: string;
  title?: string | null;
  basicForm?: Record<string, unknown> | null;
  styleTone?: string | null;
  firstChapterCount?: number;
  defaultChapterLength?: number;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateFromZeroBookInput extends CreateFromZeroOpenBookInput {
  targetOutlineChapterCount?: number;
  enqueueIndex?: boolean;
}

export interface DetectStyleLabDeviationInput {
  content: string;
  styleProfileId?: string | null;
  novelId?: string | null;
  volumeId?: string | null;
  chapterId?: string | null;
  taskStyleProfileId?: string | null;
  previewAntiAiRuleIds?: string[];
  provider?: string;
  model?: string;
  temperature?: number;
}

export interface TestWriteWithStyleProfileInput {
  styleProfileId: string;
  mode: "generate" | "rewrite";
  topic?: string | null;
  sourceText?: string | null;
  targetLength?: number | null;
  novelId?: string | null;
  volumeId?: string | null;
  chapterId?: string | null;
  provider?: string;
  model?: string;
  temperature?: number;
  styleIntensity?: number;
}

export interface BatchJobListQuery {
  novelId?: string;
  status?: BatchJobStatus | string;
  limit?: number;
}

export interface CheckpointListQuery {
  novelId?: string;
  batchJobId?: string;
  status?: string;
  limit?: number;
}

export interface CreateBatchJobInput {
  novelId: string;
  agentRunId?: string | null;
  jobType: string;
  requestedChapterCount?: number;
  startChapterOrder?: number | null;
  endChapterOrder?: number | null;
  activeSkillsJson?: string;
  configJson?: string;
}

export interface UpdateBatchJobInput {
  status?: BatchJobStatus | string;
  completedChapterCount?: number;
  riskPauseRequired?: boolean;
  riskSummaryJson?: string;
  currentStep?: string | null;
  error?: string | null;
  startedAt?: string | Date | null;
  pausedAt?: string | Date | null;
  finishedAt?: string | Date | null;
}

export interface ModelCallLogListQuery {
  novelId?: string;
  agentRunId?: string;
  taskType?: string;
  limit?: number;
}

export interface RecordModelCallInput {
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
}

export interface ReviewGateResultListQuery {
  novelId?: string;
  chapterId?: string;
  agentRunId?: string;
  batchJobId?: string;
  needsHumanConfirmation?: boolean;
  limit?: number;
}

export interface CreateReviewGateResultInput {
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
  recommendedAction?: ReviewGateRecommendedAction;
}

export interface StatePatchListQuery {
  novelId?: string;
  chapterId?: string;
  status?: StatePatchStatus | string;
  reviewGateResultId?: string;
  limit?: number;
}

export interface CreateStatePatchInput {
  novelId: string;
  chapterId?: string | null;
  agentRunId?: string | null;
  batchJobId?: string | null;
  reviewGateResultId?: string | null;
  targetType: string;
  targetId?: string | null;
  patchType: string;
  status?: StatePatchStatus;
  riskLevel?: StatePatchRiskLevel;
  patchJson: string;
  evidenceJson?: string;
  decisionNote?: string | null;
}

export interface UpdateStatePatchInput {
  status: StatePatchStatus;
  decisionNote?: string | null;
}

export interface SkillListQuery {
  category?: string;
  sourceType?: string;
  limit?: number;
}

export interface RegisterSkillInput {
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
}

export interface SetProjectSkillInput {
  skillId: string;
  skillVersionId?: string | null;
  enabled?: boolean;
  priority?: number;
  configJson?: string;
  conflictStatus?: string;
  conflictJson?: string;
}

export interface ReferenceCorpusListQuery {
  novelId?: string;
  sourceType?: ReferenceCorpusSourceType | string;
  status?: string;
  limit?: number;
}

export interface CreateReferenceCorpusInput {
  novelId?: string | null;
  title?: string | null;
  fileName?: string | null;
  sourceType?: ReferenceCorpusSourceType | string;
  content: string;
  metadataJson?: string;
  enqueueIndex?: boolean;
}

export interface CreateReferenceCorpusStyleProfileInput {
  name?: string | null;
  category?: string | null;
  provider?: string;
  model?: string;
  temperature?: number;
  presetKey?: "imitate" | "balanced" | "transfer";
  selectedDimensions?: ReferenceStyleLearningDimension[];
  bindToNovel?: boolean;
}

export async function getProductionChainSnapshot(params?: ProductionChainQuery) {
  const { data } = await apiClient.get<ApiResponse<ProductionChainSnapshot>>(
    "/ai-workbench/production-chain",
    { params },
  );
  return data;
}

export async function getStoryStateRuntimeSnapshot(params: StoryStateQuery) {
  const { data } = await apiClient.get<ApiResponse<StoryStateRuntimeSnapshot>>(
    "/ai-workbench/story-state",
    { params },
  );
  return data;
}

export async function getContinuationContextSnapshot(params: ContinuationContextQuery) {
  const { data } = await apiClient.get<ApiResponse<ContinuationContextSnapshot>>(
    "/ai-workbench/continuation-context",
    { params },
  );
  return data;
}

export async function generateContinuationChapter(payload: GenerateContinuationChapterInput) {
  const { data } = await apiClient.post<ApiResponse<ContinuationGenerationResult>>(
    "/ai-workbench/continuation/generate",
    payload,
  );
  return data;
}

export async function createFromZeroOpenBook(payload: CreateFromZeroOpenBookInput) {
  const { data } = await apiClient.post<ApiResponse<FromZeroOpenBookResult>>(
    "/ai-workbench/from-zero/open-book",
    payload,
  );
  return data;
}

export async function generateFromZeroBook(payload: GenerateFromZeroBookInput) {
  const { data } = await apiClient.post<ApiResponse<FromZeroGenerationResult>>(
    "/ai-workbench/from-zero/generate-book",
    payload,
  );
  return data;
}

export async function detectStyleLabDeviation(payload: DetectStyleLabDeviationInput) {
  const { data } = await apiClient.post<ApiResponse<StyleLabDetectionResult>>(
    "/ai-workbench/style-lab/detect",
    payload,
  );
  return data;
}

export async function testWriteWithStyleProfileInWorkbench(payload: TestWriteWithStyleProfileInput) {
  const { data } = await apiClient.post<ApiResponse<StyleLabTestWriteResult>>(
    "/ai-workbench/style-lab/test-write",
    payload,
  );
  return data;
}

export async function listReferenceCorpora(params?: ReferenceCorpusListQuery) {
  const { data } = await apiClient.get<ApiResponse<ReferenceCorpus[]>>(
    "/ai-workbench/reference-corpora",
    { params },
  );
  return data;
}

export async function createReferenceCorpus(payload: CreateReferenceCorpusInput) {
  const { data } = await apiClient.post<ApiResponse<ReferenceCorpusDetail>>(
    "/ai-workbench/reference-corpora",
    payload,
  );
  return data;
}

export async function getReferenceCorpus(id: string) {
  const { data } = await apiClient.get<ApiResponse<ReferenceCorpusDetail>>(
    `/ai-workbench/reference-corpora/${id}`,
  );
  return data;
}

export async function reindexReferenceCorpus(id: string) {
  const { data } = await apiClient.post<ApiResponse<ReferenceCorpus>>(
    `/ai-workbench/reference-corpora/${id}/reindex`,
  );
  return data;
}

export async function recallReferenceCorpus(id: string, payload: { query: string; limit?: number }) {
  const { data } = await apiClient.post<ApiResponse<ReferenceCorpusRecallResult>>(
    `/ai-workbench/reference-corpora/${id}/recall`,
    payload,
  );
  return data;
}

export async function createReferenceCorpusStyleProfile(
  id: string,
  payload: CreateReferenceCorpusStyleProfileInput,
) {
  const { data } = await apiClient.post<ApiResponse<ReferenceCorpusStyleProfileResult>>(
    `/ai-workbench/reference-corpora/${id}/style-profile`,
    payload,
  );
  return data;
}

export async function archiveReferenceCorpus(id: string) {
  const { data } = await apiClient.delete<ApiResponse<ReferenceCorpus>>(
    `/ai-workbench/reference-corpora/${id}`,
  );
  return data;
}

export async function listBatchJobs(params?: BatchJobListQuery) {
  const { data } = await apiClient.get<ApiResponse<BatchJob[]>>("/ai-workbench/batch-jobs", { params });
  return data;
}

export async function listCheckpoints(params?: CheckpointListQuery) {
  const { data } = await apiClient.get<ApiResponse<WorkbenchCheckpoint[]>>(
    "/ai-workbench/checkpoints",
    { params },
  );
  return data;
}

export async function createBatchJob(payload: CreateBatchJobInput) {
  const { data } = await apiClient.post<ApiResponse<BatchJob>>("/ai-workbench/batch-jobs", payload);
  return data;
}

export async function updateBatchJob(id: string, payload: UpdateBatchJobInput) {
  const { data } = await apiClient.patch<ApiResponse<BatchJob>>(`/ai-workbench/batch-jobs/${id}`, payload);
  return data;
}

export async function startBatchJob(id: string) {
  const { data } = await apiClient.post<ApiResponse<BatchJob>>(`/ai-workbench/batch-jobs/${id}/start`);
  return data;
}

export async function resumeBatchJob(id: string) {
  const { data } = await apiClient.post<ApiResponse<BatchJob>>(`/ai-workbench/batch-jobs/${id}/resume`);
  return data;
}

export async function cancelBatchJob(id: string) {
  const { data } = await apiClient.post<ApiResponse<BatchJob>>(`/ai-workbench/batch-jobs/${id}/cancel`);
  return data;
}

export async function listModelCallLogs(params?: ModelCallLogListQuery) {
  const { data } = await apiClient.get<ApiResponse<ModelCallLog[]>>(
    "/ai-workbench/model-call-logs",
    { params },
  );
  return data;
}

export async function recordModelCall(payload: RecordModelCallInput) {
  const { data } = await apiClient.post<ApiResponse<ModelCallLog>>("/ai-workbench/model-call-logs", payload);
  return data;
}

export async function listReviewGateResults(params?: ReviewGateResultListQuery) {
  const { data } = await apiClient.get<ApiResponse<ReviewGateResult[]>>(
    "/ai-workbench/review-gate-results",
    { params },
  );
  return data;
}

export async function createReviewGateResult(payload: CreateReviewGateResultInput) {
  const { data } = await apiClient.post<ApiResponse<ReviewGateResult>>(
    "/ai-workbench/review-gate-results",
    payload,
  );
  return data;
}

export async function listStatePatches(params?: StatePatchListQuery) {
  const { data } = await apiClient.get<ApiResponse<StatePatch[]>>("/ai-workbench/state-patches", { params });
  return data;
}

export async function createStatePatch(payload: CreateStatePatchInput) {
  const { data } = await apiClient.post<ApiResponse<StatePatch>>("/ai-workbench/state-patches", payload);
  return data;
}

export async function updateStatePatch(id: string, payload: UpdateStatePatchInput) {
  const { data } = await apiClient.patch<ApiResponse<StatePatch>>(`/ai-workbench/state-patches/${id}`, payload);
  return data;
}

export async function listSkills(params?: SkillListQuery) {
  const { data } = await apiClient.get<ApiResponse<Skill[]>>("/ai-workbench/skills", { params });
  return data;
}

export async function registerSkill(payload: RegisterSkillInput) {
  const { data } = await apiClient.post<ApiResponse<{ skill: Skill; version: SkillVersion }>>(
    "/ai-workbench/skills",
    payload,
  );
  return data;
}

export async function listProjectSkills(novelId: string) {
  const { data } = await apiClient.get<ApiResponse<ProjectSkill[]>>(`/ai-workbench/projects/${novelId}/skills`);
  return data;
}

export async function setProjectSkill(novelId: string, payload: SetProjectSkillInput) {
  const { data } = await apiClient.put<ApiResponse<ProjectSkill>>(
    `/ai-workbench/projects/${novelId}/skills`,
    payload,
  );
  return data;
}
