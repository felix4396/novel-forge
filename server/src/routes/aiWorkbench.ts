import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { llmProviderSchema } from "../llm/providerSchema";
import { authMiddleware } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { aiWorkbenchService } from "../services/aiWorkbench/AiWorkbenchService";
import { aiWorkbenchBatchRunnerService } from "../services/aiWorkbench/AiWorkbenchBatchRunnerService";
import { storyStateRuntimeService } from "../services/aiWorkbench/StoryStateRuntimeService";
import { referenceCorpusService } from "../services/aiWorkbench/ReferenceCorpusService";
import { continuationWorkbenchService } from "../services/aiWorkbench/ContinuationWorkbenchService";
import { continuationGenerationService } from "../services/aiWorkbench/ContinuationGenerationService";
import { fromZeroGenerationService } from "../services/aiWorkbench/FromZeroGenerationService";

const router = Router();

const limitQuery = z.coerce.number().int().min(1).max(100).optional();
const optionalString = z.string().trim().min(1).optional();
const optionalJsonString = z.string().trim().min(1).optional();

const productionChainQuerySchema = z.object({
  novelId: optionalString,
  chapterId: optionalString,
  limit: limitQuery,
});

const storyStateQuerySchema = z.object({
  novelId: z.string().trim().min(1),
  chapterOrder: z.coerce.number().int().min(1).optional(),
  limit: limitQuery,
});

const continuationContextQuerySchema = z.object({
  novelId: z.string().trim().min(1),
  chapterOrder: z.coerce.number().int().min(1).optional(),
  mode: z.enum(["direct", "position", "outline", "style"]).optional(),
  positionCorpusId: z.string().trim().min(1).optional(),
  positionChapterIndex: z.coerce.number().int().min(0).optional(),
  positionParagraphIndex: z.coerce.number().int().min(0).optional(),
  positionAnchorText: z.string().trim().min(1).optional(),
});

const generateContinuationChapterBodySchema = z.object({
  novelId: z.string().trim().min(1),
  targetChapterOrder: z.coerce.number().int().min(1).optional(),
  mode: z.enum(["direct", "position", "outline", "style"]).optional(),
  positionCorpusId: z.string().trim().min(1).optional(),
  positionChapterIndex: z.coerce.number().int().min(0).optional(),
  positionParagraphIndex: z.coerce.number().int().min(0).optional(),
  positionAnchorText: z.string().trim().min(1).optional(),
  provider: llmProviderSchema.optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  targetWordCount: z.coerce.number().int().min(300).max(10000).optional(),
  maxRetries: z.coerce.number().int().min(0).max(1).optional(),
  autoReview: z.boolean().optional(),
  autoRepair: z.boolean().optional(),
  qualityThreshold: z.coerce.number().min(0).max(100).optional(),
  repairMode: z.enum(["detect_only", "light_repair", "heavy_repair", "continuity_only", "character_only", "ending_only"]).optional(),
  artifactSyncMode: z.enum(["adaptive", "deferred", "strict"]).optional(),
});

const createFromZeroOpenBookBodySchema = z.object({
  idea: z.string().trim().min(1),
  title: z.string().trim().nullable().optional(),
  basicForm: z.record(z.string(), z.unknown()).nullable().optional(),
  styleTone: z.string().trim().nullable().optional(),
  firstChapterCount: z.coerce.number().int().min(1).max(5).optional(),
  defaultChapterLength: z.coerce.number().int().min(500).max(20000).optional(),
  provider: llmProviderSchema.optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  maxTokens: z.coerce.number().int().min(1).max(200000).optional(),
});

const generateFromZeroBookBodySchema = createFromZeroOpenBookBodySchema.extend({
  targetOutlineChapterCount: z.coerce.number().int().min(20).max(40).optional(),
  enqueueIndex: z.boolean().optional(),
});

const styleLabDetectBodySchema = z.object({
  content: z.string().trim().min(1),
  styleProfileId: z.string().trim().min(1).nullable().optional(),
  novelId: z.string().trim().min(1).nullable().optional(),
  volumeId: z.string().trim().min(1).nullable().optional(),
  chapterId: z.string().trim().min(1).nullable().optional(),
  taskStyleProfileId: z.string().trim().min(1).nullable().optional(),
  previewAntiAiRuleIds: z.array(z.string().trim().min(1)).optional(),
  provider: llmProviderSchema.optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
});

const styleLabTestWriteBodySchema = z.object({
  styleProfileId: z.string().trim().min(1),
  mode: z.enum(["generate", "rewrite"]),
  topic: z.string().trim().min(1).nullable().optional(),
  sourceText: z.string().min(1).nullable().optional(),
  targetLength: z.coerce.number().int().min(100).max(8000).nullable().optional(),
  novelId: z.string().trim().min(1).nullable().optional(),
  volumeId: z.string().trim().min(1).nullable().optional(),
  chapterId: z.string().trim().min(1).nullable().optional(),
  provider: llmProviderSchema.optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  styleIntensity: z.coerce.number().min(0.3).max(1).optional(),
});

const listBatchJobsQuerySchema = z.object({
  novelId: optionalString,
  status: optionalString,
  limit: limitQuery,
});

const listCheckpointsQuerySchema = z.object({
  novelId: optionalString,
  batchJobId: optionalString,
  status: optionalString,
  limit: limitQuery,
});

const createBatchJobBodySchema = z.object({
  novelId: z.string().trim().min(1),
  agentRunId: z.string().trim().min(1).nullable().optional(),
  jobType: z.string().trim().min(1),
  requestedChapterCount: z.coerce.number().int().min(1).max(5).optional(),
  startChapterOrder: z.coerce.number().int().min(1).nullable().optional(),
  endChapterOrder: z.coerce.number().int().min(1).nullable().optional(),
  activeSkillsJson: optionalJsonString,
  configJson: optionalJsonString,
});

const updateBatchJobBodySchema = z.object({
  status: optionalString,
  completedChapterCount: z.coerce.number().int().min(0).optional(),
  riskPauseRequired: z.boolean().optional(),
  riskSummaryJson: optionalJsonString,
  currentStep: z.string().trim().nullable().optional(),
  error: z.string().trim().nullable().optional(),
  startedAt: z.coerce.date().nullable().optional(),
  pausedAt: z.coerce.date().nullable().optional(),
  finishedAt: z.coerce.date().nullable().optional(),
});

const listModelCallLogsQuerySchema = z.object({
  novelId: optionalString,
  agentRunId: optionalString,
  taskType: optionalString,
  limit: limitQuery,
});

const recordModelCallBodySchema = z.object({
  novelId: z.string().trim().min(1).nullable().optional(),
  agentRunId: z.string().trim().min(1).nullable().optional(),
  agentStepId: z.string().trim().min(1).nullable().optional(),
  taskType: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  status: optionalString,
  promptTokens: z.coerce.number().int().min(0).optional(),
  completionTokens: z.coerce.number().int().min(0).optional(),
  totalTokens: z.coerce.number().int().min(0).optional(),
  costUsd: z.coerce.number().min(0).nullable().optional(),
  latencyMs: z.coerce.number().int().min(0).nullable().optional(),
  requestDigest: z.string().trim().nullable().optional(),
  responseDigest: z.string().trim().nullable().optional(),
  error: z.string().trim().nullable().optional(),
  metadataJson: optionalJsonString,
});

const listReviewGateResultsQuerySchema = z.object({
  novelId: optionalString,
  chapterId: optionalString,
  agentRunId: optionalString,
  batchJobId: optionalString,
  needsHumanConfirmation: z.coerce.boolean().optional(),
  limit: limitQuery,
});

const createReviewGateResultBodySchema = z.object({
  novelId: z.string().trim().min(1),
  chapterId: z.string().trim().min(1).nullable().optional(),
  agentRunId: z.string().trim().min(1).nullable().optional(),
  batchJobId: z.string().trim().min(1).nullable().optional(),
  sourceType: z.string().trim().min(1),
  pass: z.boolean(),
  scoreJson: optionalJsonString,
  risksJson: optionalJsonString,
  requiredFixesJson: optionalJsonString,
  statePatchesJson: optionalJsonString,
  evidenceJson: optionalJsonString,
  activeSkillsJson: optionalJsonString,
  styleProfileId: z.string().trim().min(1).nullable().optional(),
  needsHumanConfirmation: z.boolean().optional(),
  recommendedAction: z.enum(["revise", "accept", "ask_user", "stop_batch"]).optional(),
});

const listStatePatchesQuerySchema = z.object({
  novelId: optionalString,
  chapterId: optionalString,
  status: optionalString,
  reviewGateResultId: optionalString,
  limit: limitQuery,
});

const createStatePatchBodySchema = z.object({
  novelId: z.string().trim().min(1),
  chapterId: z.string().trim().min(1).nullable().optional(),
  agentRunId: z.string().trim().min(1).nullable().optional(),
  batchJobId: z.string().trim().min(1).nullable().optional(),
  reviewGateResultId: z.string().trim().min(1).nullable().optional(),
  targetType: z.string().trim().min(1),
  targetId: z.string().trim().min(1).nullable().optional(),
  patchType: z.string().trim().min(1),
  status: z.enum(["proposed", "auto_accepted", "needs_confirmation", "accepted", "rejected", "applied", "reverted"]).optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  patchJson: z.string().trim().min(1),
  evidenceJson: optionalJsonString,
  decisionNote: z.string().trim().nullable().optional(),
});

const updateStatePatchBodySchema = z.object({
  status: z.enum(["proposed", "auto_accepted", "needs_confirmation", "accepted", "rejected", "applied", "reverted"]),
  decisionNote: z.string().trim().nullable().optional(),
});

const listSkillsQuerySchema = z.object({
  category: optionalString,
  sourceType: optionalString,
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const registerSkillBodySchema = z.object({
  slug: z.string().trim().min(1),
  name: z.string().trim().min(1),
  category: z.string().trim().min(1),
  description: z.string().trim().nullable().optional(),
  sourceType: optionalString,
  defaultEnabled: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(10000).optional(),
  conflictKeysJson: optionalJsonString,
  metadataJson: optionalJsonString,
  version: z.string().trim().min(1),
  manifestJson: z.string().trim().min(1),
  promptHooksJson: optionalJsonString,
  reviewGateChecksJson: optionalJsonString,
  checksum: z.string().trim().nullable().optional(),
});

const novelIdParamsSchema = z.object({
  novelId: z.string().trim().min(1),
});

const idParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const setProjectSkillBodySchema = z.object({
  skillId: z.string().trim().min(1),
  skillVersionId: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(10000).optional(),
  configJson: optionalJsonString,
  conflictStatus: optionalString,
  conflictJson: optionalJsonString,
});

const listReferenceCorporaQuerySchema = z.object({
  novelId: optionalString,
  sourceType: optionalString,
  status: optionalString,
  limit: limitQuery,
});

const createReferenceCorpusBodySchema = z.object({
  novelId: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).nullable().optional(),
  fileName: z.string().trim().min(1).nullable().optional(),
  sourceType: z.string().trim().min(1).optional(),
  content: z.string().min(1),
  metadataJson: optionalJsonString,
  enqueueIndex: z.boolean().optional(),
});

const recallReferenceCorpusBodySchema = z.object({
  query: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

const referenceStyleLearningDimensionSchema = z.enum([
  "language",
  "chapter_structure",
  "pacing_payoff",
  "characterization",
  "dialogue",
  "worldbuilding",
  "emotion_curve",
  "commercial_packaging",
  "anti_ai",
]);

const createReferenceCorpusStyleProfileBodySchema = z.object({
  name: z.string().trim().min(1).nullable().optional(),
  category: z.string().trim().min(1).nullable().optional(),
  provider: llmProviderSchema.optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  presetKey: z.enum(["imitate", "balanced", "transfer"]).optional(),
  selectedDimensions: z.array(referenceStyleLearningDimensionSchema).min(1).optional(),
  bindToNovel: z.boolean().optional(),
});

router.use(authMiddleware);

router.get("/production-chain", validate({ query: productionChainQuerySchema }), async (req, res, next) => {
  try {
    const query = productionChainQuerySchema.parse(req.query);
    const data = await aiWorkbenchService.getProductionChainSnapshot(query);
    res.status(200).json({
      success: true,
      data,
      message: "Production chain snapshot loaded.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/story-state", validate({ query: storyStateQuerySchema }), async (req, res, next) => {
  try {
    const query = storyStateQuerySchema.parse(req.query);
    const data = await storyStateRuntimeService.buildRuntimeSnapshot(query);
    res.status(200).json({
      success: true,
      data,
      message: "StoryState runtime snapshot loaded.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/continuation-context", validate({ query: continuationContextQuerySchema }), async (req, res, next) => {
  try {
    const query = continuationContextQuerySchema.parse(req.query);
    const data = await continuationWorkbenchService.buildSnapshot(query);
    res.status(200).json({
      success: true,
      data,
      message: "Continuation context snapshot loaded.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/continuation/generate", validate({ body: generateContinuationChapterBodySchema }), async (req, res, next) => {
  try {
    const body = generateContinuationChapterBodySchema.parse(req.body);
    const data = await continuationGenerationService.generateChapter(body);
    res.status(201).json({
      success: true,
      data,
      message: "Continuation chapter generated.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/from-zero/open-book", validate({ body: createFromZeroOpenBookBodySchema }), async (req, res, next) => {
  try {
    const body = createFromZeroOpenBookBodySchema.parse(req.body);
    const data = await aiWorkbenchService.createFromZeroOpenBookTask(body);
    res.status(201).json({
      success: true,
      data,
      message: "From-zero open-book task created.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/from-zero/generate-book", validate({ body: generateFromZeroBookBodySchema }), async (req, res, next) => {
  try {
    const body = generateFromZeroBookBodySchema.parse(req.body);
    const data = await fromZeroGenerationService.generateBook(body);
    res.status(201).json({
      success: true,
      data,
      message: "From-zero book generated.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/style-lab/detect", validate({ body: styleLabDetectBodySchema }), async (req, res, next) => {
  try {
    const body = styleLabDetectBodySchema.parse(req.body);
    const data = await aiWorkbenchService.detectStyleLabDeviation(body);
    res.status(200).json({
      success: true,
      data,
      message: "Style Lab detection completed.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/style-lab/test-write", validate({ body: styleLabTestWriteBodySchema }), async (req, res, next) => {
  try {
    const body = styleLabTestWriteBodySchema.parse(req.body);
    const data = await aiWorkbenchService.testWriteWithStyleProfile(body);
    res.status(200).json({
      success: true,
      data,
      message: "Style Lab test write completed.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/reference-corpora", validate({ query: listReferenceCorporaQuerySchema }), async (req, res, next) => {
  try {
    const query = listReferenceCorporaQuerySchema.parse(req.query);
    const data = await referenceCorpusService.list(query);
    res.status(200).json({ success: true, data, message: "Reference corpora loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/reference-corpora", validate({ body: createReferenceCorpusBodySchema }), async (req, res, next) => {
  try {
    const data = await referenceCorpusService.importText(req.body as z.infer<typeof createReferenceCorpusBodySchema>);
    res.status(201).json({ success: true, data, message: "Reference corpus imported." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/reference-corpora/:id", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParamsSchema>;
    const data = await referenceCorpusService.get(id);
    if (!data) {
      res.status(404).json({ success: false, error: "Reference corpus not found." } satisfies ApiResponse<null>);
      return;
    }
    res.status(200).json({ success: true, data, message: "Reference corpus loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/reference-corpora/:id/reindex", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParamsSchema>;
    const data = await referenceCorpusService.reindex(id);
    res.status(202).json({ success: true, data, message: "Reference corpus reindex queued." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post(
  "/reference-corpora/:id/recall",
  validate({ params: idParamsSchema, body: recallReferenceCorpusBodySchema }),
  async (req, res, next) => {
    try {
      const { id } = req.params as z.infer<typeof idParamsSchema>;
      const body = req.body as z.infer<typeof recallReferenceCorpusBodySchema>;
      const data = await referenceCorpusService.recall(id, body.query, body.limit);
      res.status(200).json({ success: true, data, message: "Reference corpus recall completed." } satisfies ApiResponse<typeof data>);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/reference-corpora/:id/style-profile",
  validate({ params: idParamsSchema, body: createReferenceCorpusStyleProfileBodySchema }),
  async (req, res, next) => {
    try {
      const { id } = req.params as z.infer<typeof idParamsSchema>;
      const body = req.body as z.infer<typeof createReferenceCorpusStyleProfileBodySchema>;
      const data = await referenceCorpusService.createStyleProfile({ corpusId: id, ...body });
      res.status(201).json({ success: true, data, message: "Reference corpus style profile created." } satisfies ApiResponse<typeof data>);
    } catch (error) {
      next(error);
    }
  },
);

router.delete("/reference-corpora/:id", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParamsSchema>;
    const data = await referenceCorpusService.archive(id);
    res.status(200).json({ success: true, data, message: "Reference corpus archived." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/batch-jobs", validate({ query: listBatchJobsQuerySchema }), async (req, res, next) => {
  try {
    const query = listBatchJobsQuerySchema.parse(req.query);
    const data = await aiWorkbenchService.listBatchJobs(query);
    res.status(200).json({ success: true, data, message: "Batch jobs loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/checkpoints", validate({ query: listCheckpointsQuerySchema }), async (req, res, next) => {
  try {
    const query = listCheckpointsQuerySchema.parse(req.query);
    const data = await aiWorkbenchService.listCheckpoints(query);
    res.status(200).json({ success: true, data, message: "Checkpoints loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/batch-jobs", validate({ body: createBatchJobBodySchema }), async (req, res, next) => {
  try {
    const data = await aiWorkbenchService.createBatchJob(req.body as z.infer<typeof createBatchJobBodySchema>);
    res.status(201).json({ success: true, data, message: "Batch job created." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.patch("/batch-jobs/:id", validate({ params: idParamsSchema, body: updateBatchJobBodySchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParamsSchema>;
    const data = await aiWorkbenchService.updateBatchJob(id, req.body as z.infer<typeof updateBatchJobBodySchema>);
    res.status(200).json({ success: true, data, message: "Batch job updated." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/batch-jobs/:id/start", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParamsSchema>;
    const data = await aiWorkbenchBatchRunnerService.startBatchJob(id);
    res.status(202).json({ success: true, data, message: "Batch job started." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/batch-jobs/:id/resume", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParamsSchema>;
    const data = await aiWorkbenchBatchRunnerService.resumeBatchJob(id);
    res.status(202).json({ success: true, data, message: "Batch job resumed." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/batch-jobs/:id/cancel", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParamsSchema>;
    const data = await aiWorkbenchBatchRunnerService.cancelBatchJob(id);
    res.status(200).json({ success: true, data, message: "Batch job cancelled." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/model-call-logs", validate({ query: listModelCallLogsQuerySchema }), async (req, res, next) => {
  try {
    const query = listModelCallLogsQuerySchema.parse(req.query);
    const data = await aiWorkbenchService.listModelCallLogs(query);
    res.status(200).json({ success: true, data, message: "Model call logs loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/model-call-logs", validate({ body: recordModelCallBodySchema }), async (req, res, next) => {
  try {
    const data = await aiWorkbenchService.recordModelCall(req.body as z.infer<typeof recordModelCallBodySchema>);
    res.status(201).json({ success: true, data, message: "Model call logged." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/review-gate-results", validate({ query: listReviewGateResultsQuerySchema }), async (req, res, next) => {
  try {
    const query = listReviewGateResultsQuerySchema.parse(req.query);
    const data = await aiWorkbenchService.listReviewGateResults(query);
    res.status(200).json({ success: true, data, message: "ReviewGate results loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/review-gate-results", validate({ body: createReviewGateResultBodySchema }), async (req, res, next) => {
  try {
    const data = await aiWorkbenchService.createReviewGateResult(req.body as z.infer<typeof createReviewGateResultBodySchema>);
    res.status(201).json({ success: true, data, message: "ReviewGate result recorded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/state-patches", validate({ query: listStatePatchesQuerySchema }), async (req, res, next) => {
  try {
    const query = listStatePatchesQuerySchema.parse(req.query);
    const data = await aiWorkbenchService.listStatePatches(query);
    res.status(200).json({ success: true, data, message: "State patches loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/state-patches", validate({ body: createStatePatchBodySchema }), async (req, res, next) => {
  try {
    const data = await aiWorkbenchService.createStatePatch(req.body as z.infer<typeof createStatePatchBodySchema>);
    res.status(201).json({ success: true, data, message: "State patch created." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.patch("/state-patches/:id", validate({ params: idParamsSchema, body: updateStatePatchBodySchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParamsSchema>;
    const data = await aiWorkbenchService.updateStatePatch(id, req.body as z.infer<typeof updateStatePatchBodySchema>);
    res.status(200).json({ success: true, data, message: "State patch updated." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/skills", validate({ query: listSkillsQuerySchema }), async (req, res, next) => {
  try {
    const query = listSkillsQuerySchema.parse(req.query);
    const data = await aiWorkbenchService.listSkills(query);
    res.status(200).json({ success: true, data, message: "Skills loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/skills", validate({ body: registerSkillBodySchema }), async (req, res, next) => {
  try {
    const data = await aiWorkbenchService.registerSkill(req.body as z.infer<typeof registerSkillBodySchema>);
    res.status(201).json({ success: true, data, message: "Skill registered." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/projects/:novelId/skills", validate({ params: novelIdParamsSchema }), async (req, res, next) => {
  try {
    const { novelId } = req.params as z.infer<typeof novelIdParamsSchema>;
    const data = await aiWorkbenchService.listProjectSkills(novelId);
    res.status(200).json({ success: true, data, message: "Project skills loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.put("/projects/:novelId/skills", validate({ params: novelIdParamsSchema, body: setProjectSkillBodySchema }), async (req, res, next) => {
  try {
    const { novelId } = req.params as z.infer<typeof novelIdParamsSchema>;
    const data = await aiWorkbenchService.setProjectSkill({
      novelId,
      ...(req.body as z.infer<typeof setProjectSkillBodySchema>),
    });
    res.status(200).json({ success: true, data, message: "Project skill updated." } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

export default router;
