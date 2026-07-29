import type { UnifiedTaskDetail } from "./task";
import type { CompiledStylePromptBlocks, StyleDetectionReport } from "./styleEngine";

export type BatchJobStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ReviewGateRecommendedAction = "revise" | "accept" | "ask_user" | "stop_batch";

export type StatePatchStatus =
  | "proposed"
  | "auto_accepted"
  | "needs_confirmation"
  | "accepted"
  | "rejected"
  | "applied"
  | "reverted";

export type StatePatchRiskLevel = "low" | "medium" | "high";

export interface ReviewGateScore {
  taskFit: number;
  continuity: number;
  style: number;
  readability: number;
  statePatchSafety: number;
  legacyQualityScore?: Record<string, number>;
}

export interface BatchJob {
  id: string;
  novelId: string;
  agentRunId?: string | null;
  jobType: string;
  status: BatchJobStatus | string;
  requestedChapterCount: number;
  startChapterOrder?: number | null;
  endChapterOrder?: number | null;
  completedChapterCount: number;
  riskPauseRequired: boolean;
  riskSummaryJson: string;
  activeSkillsJson: string;
  configJson: string;
  currentStep?: string | null;
  error?: string | null;
  startedAt?: string | null;
  pausedAt?: string | null;
  finishedAt?: string | null;
  latestCheckpoint?: WorkbenchCheckpoint | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchCheckpoint {
  id: string;
  novelId: string;
  batchJobId?: string | null;
  agentRunId?: string | null;
  chapterId?: string | null;
  reviewGateResultId?: string | null;
  statePatchId?: string | null;
  checkpointType: string;
  status: string;
  summary?: string | null;
  resumeStep?: string | null;
  resumePayloadJson: string;
  evidenceJson: string;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelCallLog {
  id: string;
  novelId?: string | null;
  agentRunId?: string | null;
  agentStepId?: string | null;
  taskType: string;
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number | null;
  latencyMs?: number | null;
  requestDigest?: string | null;
  responseDigest?: string | null;
  error?: string | null;
  metadataJson: string;
  createdAt: string;
}

export type ModelCallUsageScope = "current_filter" | "today" | "project_total";

export interface ModelCallUsageSummary {
  scope: ModelCallUsageScope;
  label: string;
  available: boolean;
  callCount: number;
  failedCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  averageLatencyMs?: number | null;
}

export interface ReviewGateResult {
  id: string;
  novelId: string;
  chapterId?: string | null;
  agentRunId?: string | null;
  batchJobId?: string | null;
  sourceType: string;
  pass: boolean;
  scoreJson: string;
  risksJson: string;
  requiredFixesJson: string;
  statePatchesJson: string;
  evidenceJson: string;
  activeSkillsJson: string;
  styleProfileId?: string | null;
  needsHumanConfirmation: boolean;
  recommendedAction: ReviewGateRecommendedAction | string;
  createdAt: string;
  updatedAt: string;
}

export interface StatePatch {
  id: string;
  novelId: string;
  chapterId?: string | null;
  agentRunId?: string | null;
  batchJobId?: string | null;
  reviewGateResultId?: string | null;
  targetType: string;
  targetId?: string | null;
  patchType: string;
  status: StatePatchStatus | string;
  riskLevel: StatePatchRiskLevel | string;
  patchJson: string;
  evidenceJson: string;
  appliedAt?: string | null;
  revertedAt?: string | null;
  decisionNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  id: string;
  slug: string;
  name: string;
  category: string;
  description?: string | null;
  sourceType: string;
  defaultEnabled: boolean;
  priority: number;
  conflictKeysJson: string;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
  latestVersion?: SkillVersion | null;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: string;
  status: string;
  manifestJson: string;
  promptHooksJson: string;
  reviewGateChecksJson: string;
  checksum?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSkill {
  id: string;
  novelId: string;
  skillId: string;
  skillVersionId?: string | null;
  enabled: boolean;
  priority: number;
  configJson: string;
  conflictStatus: string;
  conflictJson: string;
  createdAt: string;
  updatedAt: string;
  skill?: Skill;
  skillVersion?: SkillVersion | null;
}

export interface ProductionChainSnapshot {
  agentRuns: Array<{
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
  }>;
  batchJobs: BatchJob[];
  checkpoints: WorkbenchCheckpoint[];
  modelCallLogs: ModelCallLog[];
  modelUsageSummary: {
    currentFilter: ModelCallUsageSummary;
    today: ModelCallUsageSummary;
    projectTotal: ModelCallUsageSummary;
  };
  reviewGateResults: ReviewGateResult[];
  statePatches: StatePatch[];
}

export interface FromZeroOpenBookResult {
  task: UnifiedTaskDetail | null;
  agentRunId: string;
  autoDirectorTaskId: string;
  targetFirstChapterCount: number;
  targetOutlineChapterCount: number;
}

export interface FromZeroGeneratedChapterSummary {
  id: string;
  order: number;
  title: string;
  contentLength: number;
  summaryId: string;
  hook: string;
}

export interface FromZeroGenerationResult {
  novel: {
    id: string;
    title: string;
    outlineChapterCount: number;
    characterCount: number;
  };
  agentRunId: string;
  chapters: FromZeroGeneratedChapterSummary[];
  reviewGateResults: Array<{
    id: string;
    chapterId?: string | null;
    pass: boolean;
    needsHumanConfirmation: boolean;
    recommendedAction: ReviewGateRecommendedAction | string;
  }>;
  statePatches: Array<{
    id: string;
    chapterId?: string | null;
    status: StatePatchStatus | string;
    riskLevel: StatePatchRiskLevel | string;
    patchType: string;
  }>;
  checks: {
    hasBookSetup: boolean;
    outlineChapterCount: number;
    firstChapterCount: number;
    everyChapterHasHook: boolean;
    reviewGateCount: number;
    statePatchCount: number;
    characterRelationCount?: number;
    styleProfileCount?: number;
    activeSkillCount?: number;
    timelineEventCount?: number;
    foreshadowCandidateCount?: number;
  };
}

export interface StyleLabDetectionResult {
  report: StyleDetectionReport;
  agentRunId: string;
}

export type StoryStateCoverageStatus = "ready" | "partial" | "not_enough_data";

export type StoryStateDeterministicCheckStatus = "pass" | "warning" | "blocked" | "not_enough_data";

export type StoryStateDeterministicIssueSeverity = "info" | "warning" | "error" | "blocking";

export interface StoryStateCoverageItem {
  key: string;
  label: string;
  status: StoryStateCoverageStatus;
  count: number;
  detail?: string;
}

export interface StoryStateDeterministicIssue {
  id: string;
  severity: StoryStateDeterministicIssueSeverity;
  title: string;
  summary: string;
  evidence: string[];
  relatedIds?: string[];
}

export interface StoryStateDeterministicCheck {
  key: string;
  label: string;
  status: StoryStateDeterministicCheckStatus;
  coverage: StoryStateCoverageStatus;
  totalIssues: number;
  issues: StoryStateDeterministicIssue[];
}

export interface StoryStateQualityDebt {
  id: string;
  source: "review_gate" | "state_patch" | "deterministic_check";
  severity: StoryStateDeterministicIssueSeverity;
  category: string;
  title: string;
  summary: string;
  evidence: string[];
  sourceId: string;
  chapterId?: string | null;
  chapterOrder?: number | null;
  chapterTitle?: string | null;
  recommendedAction?: string | null;
  status?: string | null;
  updatedAt: string;
}

export interface StoryStateStyleSkillConflict {
  id: string;
  severity: "info" | "warning" | "error";
  skillId: string;
  skillName: string;
  skillSlug: string;
  styleProfileId: string;
  styleProfileName: string;
  conflictKeys: string[];
  evidence: string[];
  recommendedAction: string;
}

export interface StoryStateRuntimeSnapshot {
  novel: {
    id: string;
    title: string;
    writingMode?: string | null;
    chapterCount: number;
    latestChapterOrder?: number | null;
  };
  currentChapterOrder?: number | null;
  generatedAt: string;
  latestSnapshot?: {
    id: string;
    sourceChapterId?: string | null;
    sourceChapterOrder?: number | null;
    summary?: string | null;
    characterStateCount: number;
    relationStateCount: number;
    informationStateCount: number;
    foreshadowStateCount: number;
    createdAt: string;
    updatedAt: string;
  } | null;
  foreshadowStates: Array<{
    id: string;
    title: string;
    summary?: string | null;
    status: string;
    setupChapterId?: string | null;
    setupChapterOrder?: number | null;
    setupChapterTitle?: string | null;
    payoffChapterId?: string | null;
    payoffChapterOrder?: number | null;
    payoffChapterTitle?: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  coverage: StoryStateCoverageItem[];
  chapterTree: Array<{
    id: string;
    order: number;
    title: string;
    volumeId?: string | null;
    volumeTitle?: string | null;
    volumeOrder?: number | null;
    summary?: string | null;
    goal?: string | null;
    hook?: string | null;
    generationState: string;
    chapterStatus?: string | null;
    targetWordCount?: number | null;
    contentLength: number;
    qualityScore?: number | null;
    continuityScore?: number | null;
    riskFlags?: string | null;
    updatedAt: string;
  }>;
  styleProfiles: Array<{
    id: string;
    name: string;
    description?: string | null;
    category?: string | null;
    sourceType: string;
    sourceRefId?: string | null;
    sourceSamplePreview?: string | null;
    analysisPreview?: string | null;
    status: string;
    bindingTargetType?: "novel" | "volume" | "chapter" | "task" | "available" | null;
    bindingPriority?: number | null;
    bindingWeight?: number | null;
    selectedExtractionPresetKey?: string | null;
    featureCount: number;
    antiAiRuleCount: number;
    antiAiRuleKeys: string[];
    learningDimensions: string[];
    narrativeSummary?: string | null;
    characterSummary?: string | null;
    languageSummary?: string | null;
    rhythmSummary?: string | null;
    updatedAt: string;
  }>;
  activeSkills: Array<{
    id: string;
    skillId: string;
    name: string;
    slug: string;
    category: string;
    enabled: boolean;
    priority: number;
    conflictStatus: string;
    conflictJson?: string;
    stateRequirements: string[];
    promptHooks: Record<string, string>;
    reviewGateChecks: string[];
    riskTriggers: string[];
    visualFocus: string[];
  }>;
  styleSkillConflicts: StoryStateStyleSkillConflict[];
  characters: Array<{
    id: string;
    name: string;
    role: string;
    castRole?: string | null;
    factionLabel?: string | null;
    stanceLabel?: string | null;
    currentState?: string | null;
    currentLocation?: string | null;
    availability?: string | null;
    currentGoal?: string | null;
    powerLevel?: string | null;
    realm?: string | null;
    updatedAt: string;
  }>;
  relations: Array<{
    id: string;
    sourceCharacterId: string;
    sourceName?: string | null;
    sourceFactionLabel?: string | null;
    targetCharacterId: string;
    targetName?: string | null;
    targetFactionLabel?: string | null;
    surfaceRelation: string;
    hiddenTension?: string | null;
    evidence?: string | null;
    dynamicLabel?: string | null;
    trustScore?: number | null;
    conflictScore?: number | null;
    intimacyScore?: number | null;
    dependencyScore?: number | null;
    evidenceChapterOrders: number[];
    currentStages: Array<{
      chapterOrder?: number | null;
      stageLabel: string;
      stageSummary: string;
      sourceType: string;
      confidence?: number | null;
    }>;
    updatedAt: string;
  }>;
  openConflicts: Array<{
    id: string;
    conflictType: string;
    conflictKey: string;
    title: string;
    summary: string;
    severity: string;
    status: string;
    lastSeenChapterOrder?: number | null;
    updatedAt: string;
  }>;
  timeline: {
    events: Array<{
      id: string;
      chapterIndex?: number | null;
      eventOrder: number;
      storyDayIndex?: number | null;
      storyTimeLabel?: string | null;
      title: string;
      summary?: string | null;
      type: string;
      status: string;
      participantIds: string[];
      locationId?: string | null;
      eventKey?: string | null;
      updatedAt: string;
    }>;
    characterMovements: Array<{
      id: string;
      characterId: string;
      characterName?: string | null;
      chapterId?: string | null;
      chapterOrder?: number | null;
      title: string;
      content: string;
      source: string;
      updatedAt: string;
    }>;
    hooks: Array<{
      id: string;
      createdInChapterIndex: number;
      expectedResolveByChapterIndex?: number | null;
      title: string;
      status: string;
      priority: string;
      blocking: boolean;
      participantIds: string[];
      updatedAt: string;
    }>;
    constraints: Array<{
      id: string;
      chapterIndex?: number | null;
      type: string;
      severity: string;
      description: string;
      active: boolean;
      updatedAt: string;
    }>;
    reports: Array<{
      id: string;
      chapterId: string;
      chapterIndex: number;
      status: string;
      score: number;
      issueCount: number;
      createdAt: string;
    }>;
  };
  statePatches: Array<Pick<StatePatch, "id" | "targetType" | "patchType" | "status" | "riskLevel" | "createdAt" | "updatedAt">>;
  reviewGateResults: Array<Pick<ReviewGateResult, "id" | "sourceType" | "pass" | "needsHumanConfirmation" | "recommendedAction" | "createdAt" | "updatedAt">>;
  qualityDebt: StoryStateQualityDebt[];
  payoffItems: Array<{
    id: string;
    title: string;
    currentStatus: string;
    targetEndChapterOrder?: number | null;
    lastTouchedChapterOrder?: number | null;
    updatedAt: string;
  }>;
  resourceItems: Array<{
    id: string;
    name: string;
    resourceType: string;
    status: string;
    holderCharacterId?: string | null;
    holderCharacterName?: string | null;
    lastTouchedChapterOrder?: number | null;
    updatedAt: string;
  }>;
  deterministicChecks: StoryStateDeterministicCheck[];
}

export type ContinuationWorkbenchMode = "direct" | "position" | "outline" | "style";

export interface ContinuationContextReferenceCorpusSummary {
  id: string;
  title: string;
  sourceType: string;
  summary?: string | null;
  chapterChunkCount: number;
  paragraphChunkCount: number;
  latestIndexStatus: string;
  updatedAt: string;
}

export interface ContinuationContextRecallHit {
  id: string;
  corpusId: string;
  corpusTitle: string;
  source?: "vector" | "keyword" | "reranked" | "structured";
  chunkType: string;
  chunkOrder: number;
  chapterIndex?: number | null;
  title?: string | null;
  text: string;
  summary?: string | null;
  reason: string;
}

export interface ContinuationPositionAnchor {
  corpusId?: string | null;
  corpusTitle?: string | null;
  chapterIndex?: number | null;
  paragraphIndex?: number | null;
  anchorText?: string | null;
  resolvedChunkId?: string | null;
  resolvedChapterIndex?: number | null;
  resolvedParagraphIndex?: number | null;
  resolvedTitle?: string | null;
  beforeText?: string | null;
  afterText?: string | null;
}

export interface ContinuationOutlineContext {
  sourceCorpusIds: string[];
  importedChapterCount: number;
  chapterSummaries: Array<{
    corpusId: string;
    corpusTitle: string;
    chapterIndex?: number | null;
    title?: string | null;
    summary: string;
  }>;
  unresolvedForeshadows: Array<{
    corpusId: string;
    corpusTitle: string;
    chapterIndex?: number | null;
    title: string;
    evidence: string;
    reason: string;
  }>;
  nextChapterBrief: {
    targetChapterOrder?: number | null;
    premise: string;
    requiredContinuity: string[];
    recommendedFocus: string[];
  };
}

export interface ContinuationStyleContext {
  sourceCorpusIds: string[];
  styleCandidates: Array<{
    corpusId: string;
    corpusTitle: string;
    avgSentenceLength?: number | null;
    dialogueRatio?: number | null;
    paragraphCount?: number | null;
    chapterCount?: number | null;
    dominantPunctuation: string[];
    sampleSentences: string[];
    summary: string;
  }>;
  activeStyleProfiles: Array<{
    id: string;
    name: string;
    category?: string | null;
    bindingTargetType: string;
    bindingWeight: number;
    selectedExtractionPresetKey?: string | null;
    narrativeSummary?: string | null;
    characterSummary?: string | null;
    languageSummary?: string | null;
    rhythmSummary?: string | null;
    antiAiRuleCount: number;
  }>;
  writingConstraints: {
    styleIntensity: number;
    requiredContinuity: string[];
    avoidPatterns: string[];
    referenceExamples: string[];
  };
}

export interface ContinuationContextSnapshot {
  novelId: string;
  mode: ContinuationWorkbenchMode;
  targetChapterOrder?: number | null;
  positionAnchor?: ContinuationPositionAnchor | null;
  outlineContext?: ContinuationOutlineContext | null;
  styleContext?: ContinuationStyleContext | null;
  generatedAt: string;
  continuation: {
    enabled: boolean;
    sourceType?: "novel" | "knowledge_document" | "reference_corpus" | null;
    sourceId?: string | null;
    sourceTitle: string;
    systemRule: string;
    humanBlock: string;
    antiCopyCorpusPreview: string[];
  };
  referenceCorpora: ContinuationContextReferenceCorpusSummary[];
  recallHits: ContinuationContextRecallHit[];
}

export interface ContinuationGenerationResult {
  chapter: {
    id: string;
    novelId: string;
    order: number;
    title: string;
    generationState: string;
    chapterStatus?: string | null;
    targetWordCount?: number | null;
    contentLength: number;
    updatedAt: string;
  };
  runtime: {
    agentRunId?: string | null;
    reviewExecuted: boolean;
    pass: boolean;
    retryCountUsed: number;
    sourceType: string;
  };
  reviewGateResult?: Pick<
    ReviewGateResult,
    "id" | "sourceType" | "pass" | "needsHumanConfirmation" | "recommendedAction" | "createdAt" | "updatedAt"
  > | null;
  statePatches: Array<Pick<StatePatch, "id" | "targetType" | "patchType" | "status" | "riskLevel" | "createdAt" | "updatedAt">>;
  continuationContext: ContinuationContextSnapshot;
}

export interface StyleLabTestWriteResult {
  output: string;
  compiledBlocks: CompiledStylePromptBlocks;
  detectionReport?: StyleDetectionReport | null;
  agentRunId: string;
  styleProfileId: string;
  mode: "generate" | "rewrite";
  outputLength: number;
  targetLength?: number | null;
}
