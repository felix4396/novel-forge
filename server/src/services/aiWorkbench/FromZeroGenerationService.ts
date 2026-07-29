import { z } from "zod";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import type {
  FromZeroGenerationResult,
  FromZeroGeneratedChapterSummary,
} from "@ai-novel/shared/types/aiWorkbench";
import { invokeStructuredLlmDetailed } from "../../llm/structuredInvoke";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { createQualityReport } from "../novel/novelCoreReviewService";
import { ragServices } from "../rag";
import { StyleBindingService } from "../styleEngine/StyleBindingService";
import { StyleProfileService } from "../styleEngine/StyleProfileService";
import { aiWorkbenchService } from "./AiWorkbenchService";
import { aiWorkbenchAgentRunLogger } from "./AiWorkbenchAgentRunLogger";
import {
  skillRuntimeContextService,
  summarizeActiveSkillsForAgentLog,
} from "./SkillRuntimeContextService";

const DEFAULT_OUTLINE_CHAPTER_COUNT = 20;
const DEFAULT_FIRST_CHAPTER_COUNT = 3;
const MIN_BENCHMARK_CHAPTER_WORDS = 2500;
const MAX_BENCHMARK_CHAPTER_WORDS = 4000;
const styleProfileService = new StyleProfileService();
const styleBindingService = new StyleBindingService();

const fromZeroCharacterSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  gender: z.enum(["male", "female", "unknown"]).default("unknown"),
  storyFunction: z.string().min(1),
  relationToProtagonist: z.string().optional().default(""),
  personality: z.string().optional().default(""),
  background: z.string().optional().default(""),
  currentState: z.string().optional().default(""),
  currentGoal: z.string().optional().default(""),
  secret: z.string().optional().default(""),
});

const fromZeroOutlineChapterSchema = z.object({
  order: z.number().int().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  conflict: z.string().min(1),
  clueProgress: z.string().min(1),
  hook: z.string().min(1),
  summary: z.string().min(1),
});

const fromZeroChapterDraftSchema = z.object({
  order: z.number().int().min(1),
  title: z.string().min(1),
  content: z.string().min(200),
  summary: z.string().min(1),
  keyEvents: z.array(z.string()).default([]),
  characterStates: z.array(z.string()).default([]),
  hook: z.string().min(1),
  timelineEvents: z.array(z.string()).default([]),
  foreshadowCandidates: z.array(z.string()).default([]),
});

const expandedChapterDraftSchema = fromZeroChapterDraftSchema.extend({
  content: z.string().min(MIN_BENCHMARK_CHAPTER_WORDS),
});

const fromZeroBookPackageSchema = z.object({
  title: z.string().min(1),
  titleCandidates: z.array(z.string()).min(1).max(8),
  genre: z.string().min(1),
  targetAudience: z.string().min(1),
  coreSellingPoint: z.string().min(1),
  worldbuilding: z.string().min(1),
  protagonistMotivation: z.string().min(1),
  mainConflict: z.string().min(1),
  mainLine: z.string().min(1),
  sideLines: z.array(z.string()).default([]),
  styleTone: z.string().min(1),
  characters: z.array(fromZeroCharacterSchema).min(3).max(8),
  outlineChapters: z.array(fromZeroOutlineChapterSchema).min(DEFAULT_OUTLINE_CHAPTER_COUNT),
  firstChapters: z.array(fromZeroChapterDraftSchema).min(DEFAULT_FIRST_CHAPTER_COUNT),
});

type FromZeroBookPackage = z.infer<typeof fromZeroBookPackageSchema>;

export interface GenerateFromZeroBookInput {
  idea: string;
  title?: string | null;
  styleTone?: string | null;
  firstChapterCount?: number | null;
  targetOutlineChapterCount?: number | null;
  defaultChapterLength?: number | null;
  provider?: LLMProvider | string | null;
  model?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  enqueueIndex?: boolean | null;
}

function clampInt(value: number | null | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function compactText(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function slugText(value: string, limit = 32): string {
  const normalized = value
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (normalized || "item").slice(0, limit);
}

interface StructuredRuntimeTarget {
  provider: LLMProvider;
  model: string;
  modelRoute?: string;
  routeDegraded?: boolean;
}

function readStructuredRuntimeTarget(
  result: {
    diagnostics: {
      provider?: LLMProvider;
      model?: string;
      modelRoute?: string;
      routeDegraded?: boolean;
    };
  },
  fallback: { provider?: LLMProvider; model?: string } = {},
): StructuredRuntimeTarget {
  return {
    provider: result.diagnostics.provider ?? fallback.provider ?? "openai",
    model: result.diagnostics.model ?? fallback.model ?? "default",
    modelRoute: result.diagnostics.modelRoute,
    routeDegraded: result.diagnostics.routeDegraded,
  };
}

function ensureArrayLength<T>(items: T[], count: number): T[] {
  return items.slice(0, count);
}

function buildStructuredOutline(plan: FromZeroBookPackage): string {
  return JSON.stringify({
    source: "ai_workbench_from_zero",
    titleCandidates: plan.titleCandidates,
    genre: plan.genre,
    targetAudience: plan.targetAudience,
    coreSellingPoint: plan.coreSellingPoint,
    protagonistMotivation: plan.protagonistMotivation,
    mainConflict: plan.mainConflict,
    mainLine: plan.mainLine,
    sideLines: plan.sideLines,
    outlineChapters: plan.outlineChapters,
  }, null, 2);
}

function buildMarkdownOutline(plan: FromZeroBookPackage): string {
  return plan.outlineChapters
    .sort((left, right) => left.order - right.order)
    .map((chapter) => [
      `第 ${chapter.order} 章 ${chapter.title}`,
      `目标：${chapter.goal}`,
      `冲突：${chapter.conflict}`,
      `主线/线索推进：${chapter.clueProgress}`,
      `钩子：${chapter.hook}`,
      `摘要：${chapter.summary}`,
    ].join("\n"))
    .join("\n\n");
}

function buildCommercialTags(plan: FromZeroBookPackage, styleTone?: string): string[] {
  return Array.from(new Set([
    plan.genre,
    plan.targetAudience,
    styleTone || plan.styleTone,
    ...plan.sideLines.slice(0, 3),
  ]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))))
    .slice(0, 8);
}

function buildPlannerPrompts(input: {
  idea: string;
  title?: string;
  styleTone?: string;
  firstChapterCount: number;
  outlineChapterCount: number;
  targetWordCount: number;
}): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: [
      "你是个人本地 AI 小说工作台中的 Planner + Writer。",
      "必须面向中文网文和泛小说生成可落库的开书包，题材、主角身份、核心动机和风格以用户灵感为准。",
      "输出必须严格符合 JSON schema，不要输出 Markdown。",
      "要求：书设、角色、世界观、前 20 章大纲、前 3 章正文必须互相一致。",
      "前三章每章必须有明确目标、冲突、主线/线索推进和章末钩子。",
      "避免提前解决核心冲突、避免重大设定随意改写。",
    ].join("\n"),
    userPrompt: [
      `灵感：${input.idea}`,
      input.title ? `暂定书名：${input.title}` : "暂定书名：请给出最适合的中文书名。",
      input.styleTone ? `风格关键词：${input.styleTone}` : "风格关键词：请根据灵感自动选择适合的中文网文/泛小说风格，并保持可读、稳定、强钩子。",
      `请生成 ${input.outlineChapterCount} 章大纲，并生成前 ${input.firstChapterCount} 章正文草稿。`,
      `正文目标：每章约 ${input.targetWordCount} 字；如受单次输出限制，也必须保持章节结构完整、内容可继续扩写。`,
      "必须继承用户灵感中已经给出的主角身份、核心设定、题材方向和不可改写的动机；如果灵感包含旧案/记者/家庭秘密等悬疑要素，则按 Benchmark A 口径逐步推进线索，不提前揭晓最终真相。",
    ].join("\n"),
  };
}

function inferChapterMainlineSignal(plan: FromZeroBookPackage, content: string): {
  matched: boolean;
  evidence: string;
  fixSuggestion: string;
} {
  const planText = [
    plan.genre,
    plan.coreSellingPoint,
    plan.protagonistMotivation,
    plan.mainConflict,
    plan.mainLine,
    plan.worldbuilding,
    plan.styleTone,
  ].join(" ");
  const checks: Array<{ pattern: RegExp; evidence: string; fixSuggestion: string }> = [
    {
      pattern: /悬疑|推理|旧案|卷宗|档案|线索|记者|真相|失踪|家庭|嫌疑/,
      evidence: "章节没有明显推进悬疑线索或核心谜题。",
      fixSuggestion: "补充关键证据、嫌疑关系、调查动作或旧案/谜题推进。",
    },
    {
      pattern: /玄幻|修真|修仙|仙侠|升级|境界|功法|宗门|灵力|法宝|妖|魔/,
      evidence: "章节没有明显推进升级、修炼、能力或势力冲突。",
      fixSuggestion: "补充境界目标、功法限制、资源争夺、战斗结果或势力压力。",
    },
    {
      pattern: /都市|职场|现实|商业|行业|公司|家族|身份|逆袭/,
      evidence: "章节没有明显推进现实/都市主线目标。",
      fixSuggestion: "补充职业目标、身份压力、关系变化、资源博弈或阶段性反转。",
    },
    {
      pattern: /言情|恋爱|情感|婚恋|误会|心动|关系|亲密/,
      evidence: "章节没有明显推进情感关系或核心误会。",
      fixSuggestion: "补充关系变化、误会推进、情绪选择或双方目标冲突。",
    },
    {
      pattern: /科幻|星际|未来|科技|实验|AI|舰队|宇宙|机器人/,
      evidence: "章节没有明显推进科幻设定、技术风险或探索目标。",
      fixSuggestion: "补充技术限制、探索发现、系统风险或势力冲突。",
    },
    {
      pattern: /末世|灾变|生存|丧尸|基地|资源|废土/,
      evidence: "章节没有明显推进生存压力、资源目标或灾变冲突。",
      fixSuggestion: "补充资源争夺、基地风险、感染/灾变压力或生存选择。",
    },
    {
      pattern: /无限流|副本|规则|任务|轮回|通关/,
      evidence: "章节没有明显推进副本规则、任务目标或通关压力。",
      fixSuggestion: "补充规则发现、任务阶段、队伍冲突或通关代价。",
    },
  ];
  const selected = checks.find((check) => check.pattern.test(planText));
  if (selected) {
    return {
      matched: selected.pattern.test(content),
      evidence: selected.evidence,
      fixSuggestion: selected.fixSuggestion,
    };
  }

  const keywords = Array.from(new Set((planText.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,12}/g) ?? [])
    .filter((word) => !/目标|冲突|主线|核心|世界观|风格|读者|故事|角色|章节|推进/.test(word))))
    .slice(0, 10);
  return {
    matched: keywords.length === 0 || keywords.some((word) => content.includes(word)),
    evidence: "章节没有明显呼应开书包中的核心设定或主线关键词。",
    fixSuggestion: "补充主角动机、核心冲突、关键设定或本章阶段目标的可见推进。",
  };
}

function evaluateChapterDraft(input: {
  content: string;
  hook: string;
  targetWordCount: number;
  plan: FromZeroBookPackage;
}): { score: QualityScore; issues: ReviewIssue[] } {
  const contentLength = input.content.trim().length;
  const hasHook = input.hook.trim().length > 0 || /(却|突然|门外|电话|短信|档案|卷宗|真相|脚步|敲门|血迹|录音)/.test(input.content.slice(-260));
  const mainlineSignal = inferChapterMainlineSignal(input.plan, input.content);
  const lengthPenalty = contentLength < Math.floor(input.targetWordCount * 0.55) ? 12 : 0;
  const base = Math.max(72, 90 - lengthPenalty);
  const issues: ReviewIssue[] = [];
  if (!hasHook) {
    issues.push({
      severity: "medium",
      category: "engagement",
      evidence: "章节末钩子不够明确。",
      fixSuggestion: "补充章末悬念、反转线索或下一章行动压力。",
    });
  }
  if (!mainlineSignal.matched) {
    issues.push({
      severity: "medium",
      category: "logic",
      evidence: mainlineSignal.evidence,
      fixSuggestion: mainlineSignal.fixSuggestion,
    });
  }
  return {
    score: {
      coherence: mainlineSignal.matched ? base : base - 8,
      repetition: 88,
      pacing: hasHook ? base : base - 8,
      voice: 86,
      engagement: hasHook ? base : base - 10,
      overall: issues.length === 0 ? base : base - 8,
    },
    issues,
  };
}

async function enqueueIndexes(input: {
  novelId: string;
  chapterIds: string[];
  chapterSummaryIds: string[];
  characterIds: string[];
}): Promise<void> {
  await Promise.all([
    ragServices.ragIndexService.enqueueOwnerJob("rebuild", "novel", input.novelId).catch(() => null),
    ...input.chapterIds.map((id) => ragServices.ragIndexService.enqueueOwnerJob("rebuild", "chapter", id).catch(() => null)),
    ...input.chapterSummaryIds.map((id) => ragServices.ragIndexService.enqueueOwnerJob("rebuild", "chapter_summary", id).catch(() => null)),
    ...input.characterIds.map((id) => ragServices.ragIndexService.enqueueOwnerJob("rebuild", "character", id).catch(() => null)),
  ]);
}

function inferInitialRelationScores(character: {
  role: string | null;
  relationToProtagonist: string | null;
  storyFunction: string | null;
  secret: string | null;
}): {
  trustScore: number;
  conflictScore: number;
  intimacyScore: number;
  dependencyScore: number;
} {
  const text = [
    character.role,
    character.relationToProtagonist,
    character.storyFunction,
    character.secret,
  ].filter(Boolean).join(" ");
  const isAntagonistic = /(反派|对手|敌|嫌疑|阻碍|威胁|黑手|真凶|追杀|背叛)/.test(text);
  const isClose = /(亲人|父|母|兄|姐|妹|家人|搭档|朋友|同伴|盟友|导师|助手)/.test(text);
  const hasSecret = Boolean(character.secret?.trim()) || /(秘密|隐瞒|伪装|卧底|交易|旧案)/.test(text);
  return {
    trustScore: isAntagonistic ? 30 : isClose ? 70 : 50,
    conflictScore: isAntagonistic ? 75 : hasSecret ? 60 : 35,
    intimacyScore: isClose ? 65 : 35,
    dependencyScore: isClose ? 55 : 40,
  };
}

async function recordInitialCharacterRelations(input: {
  novelId: string;
  characters: Array<{
    id: string;
    name: string;
    role: string | null;
    storyFunction: string | null;
    relationToProtagonist: string | null;
    secret: string | null;
    currentGoal: string | null;
  }>;
}): Promise<{ characterRelationCount: number }> {
  const protagonist = input.characters.find((character) => character.role === "protagonist") ?? input.characters[0];
  if (!protagonist) {
    return { characterRelationCount: 0 };
  }

  let characterRelationCount = 0;
  for (const character of input.characters) {
    if (character.id === protagonist.id) {
      continue;
    }
    const surfaceRelation = compactText(
      character.relationToProtagonist
        || character.storyFunction
        || character.role
        || `与${protagonist.name}围绕主线发生关联`,
      120,
    );
    const scores = inferInitialRelationScores(character);
    const relation = await prisma.characterRelation.upsert({
      where: {
        novelId_sourceCharacterId_targetCharacterId: {
          novelId: input.novelId,
          sourceCharacterId: protagonist.id,
          targetCharacterId: character.id,
        },
      },
      create: {
        novelId: input.novelId,
        sourceCharacterId: protagonist.id,
        targetCharacterId: character.id,
        surfaceRelation,
        hiddenTension: character.secret ? compactText(character.secret, 180) : null,
        conflictSource: character.secret ? "从零开书阶段生成的隐藏信息，需经 ReviewGate 后才能转为重大设定。" : null,
        dynamicLabel: surfaceRelation,
        nextTurnPoint: character.currentGoal ? compactText(character.currentGoal, 180) : null,
        trustScore: scores.trustScore,
        conflictScore: scores.conflictScore,
        intimacyScore: scores.intimacyScore,
        dependencyScore: scores.dependencyScore,
        evidence: `从零开书 Planner 生成：${protagonist.name} 与 ${character.name} 的初始关系。`,
      },
      update: {
        surfaceRelation,
        hiddenTension: character.secret ? compactText(character.secret, 180) : null,
        conflictSource: character.secret ? "从零开书阶段生成的隐藏信息，需经 ReviewGate 后才能转为重大设定。" : null,
        dynamicLabel: surfaceRelation,
        nextTurnPoint: character.currentGoal ? compactText(character.currentGoal, 180) : null,
        trustScore: scores.trustScore,
        conflictScore: scores.conflictScore,
        intimacyScore: scores.intimacyScore,
        dependencyScore: scores.dependencyScore,
        evidence: `从零开书 Planner 生成：${protagonist.name} 与 ${character.name} 的初始关系。`,
      },
    });
    await prisma.characterRelationStage.create({
      data: {
        novelId: input.novelId,
        relationId: relation.id,
        sourceCharacterId: protagonist.id,
        targetCharacterId: character.id,
        stageLabel: "开书初始关系",
        stageSummary: `${protagonist.name} 与 ${character.name}：${surfaceRelation}`,
        nextTurnPoint: character.currentGoal ? compactText(character.currentGoal, 180) : null,
        sourceType: "ai_workbench_from_zero",
        confidence: 0.75,
      },
    });
    characterRelationCount += 1;
  }
  return { characterRelationCount };
}

function inferFromZeroSkillSlugs(input: {
  plan: FromZeroBookPackage;
  styleTone?: string;
}): string[] {
  const text = [
    input.plan.genre,
    input.plan.styleTone,
    input.styleTone,
    input.plan.coreSellingPoint,
    input.plan.mainConflict,
    input.plan.mainLine,
  ].filter(Boolean).join(" ");
  const genreRules: Array<{ slug: string; pattern: RegExp }> = [
    { slug: "mystery-deduction", pattern: /悬疑|推理|旧案|线索|嫌疑|真相|侦探|记者/ },
    { slug: "xuanhuan-upgrade", pattern: /玄幻|升级|境界|功法|法宝|宗门/ },
    { slug: "xianxia-cultivation", pattern: /仙侠|修真|修仙|因果|洞府/ },
    { slug: "urban-superpower", pattern: /都市异能|异能|隐藏身份|组织|能力体系/ },
    { slug: "urban-realistic", pattern: /都市|现实|职业|城市|人情/ },
    { slug: "science-fiction", pattern: /科幻|科技|星球|太空|未来/ },
    { slug: "alternate-history", pattern: /历史|架空|朝代|政权|制度/ },
    { slug: "romance", pattern: /言情|情感|恋爱|亲密|误会/ },
    { slug: "infinite-flow", pattern: /无限流|副本|任务|规则|轮回/ },
    { slug: "post-apocalypse", pattern: /末世|丧尸|基地|生存|资源/ },
    { slug: "light-novel", pattern: /轻小说|吐槽|日常|校园|人设标签/ },
  ];
  const selectedGenreSkill = genreRules.find((rule) => rule.pattern.test(text))?.slug;
  return Array.from(new Set([
    ...(selectedGenreSkill ? [selectedGenreSkill] : []),
    /冷峻|克制|冷静|低情绪|悬疑/.test(text) ? "cold-restrained-style" : null,
    "anti-ai-writing",
  ].filter((slug): slug is string => Boolean(slug))));
}

async function enableFromZeroProjectSkills(input: {
  novelId: string;
  plan: FromZeroBookPackage;
  styleTone?: string;
}): Promise<{ activeSkillCount: number; skillSlugs: string[] }> {
  const skillSlugs = inferFromZeroSkillSlugs({ plan: input.plan, styleTone: input.styleTone });
  const registeredSkills = await aiWorkbenchService.listSkills({ limit: 200 });
  const enabledSlugs: string[] = [];
  for (const slug of skillSlugs) {
    const skill = registeredSkills.find((item) => item.slug === slug);
    if (!skill) {
      continue;
    }
    await aiWorkbenchService.setProjectSkill({
      novelId: input.novelId,
      skillId: skill.id,
      skillVersionId: skill.latestVersion?.id ?? null,
      enabled: true,
      priority: skill.priority,
      configJson: JSON.stringify({
        source: "ai_workbench_from_zero",
        generatedFrom: "from_zero_generate_book",
      }),
    });
    enabledSlugs.push(slug);
  }
  return { activeSkillCount: enabledSlugs.length, skillSlugs: enabledSlugs };
}

async function createFromZeroStyleProfileBinding(input: {
  novelId: string;
  novelTitle: string;
  idea: string;
  plan: FromZeroBookPackage;
  styleTone?: string;
}): Promise<{ styleProfileCount: number; styleProfileId: string; styleBindingId: string }> {
  const effectiveTone = input.styleTone || input.plan.styleTone || "稳定、可控、前后一致的中文网文叙事。";
  const profile = await styleProfileService.createManualProfile({
    name: `${input.novelTitle} 开书风格画像`,
    description: `从零开书阶段生成的书级 StyleProfile：${effectiveTone}`,
    category: "from_zero_book",
    tags: Array.from(new Set([input.plan.genre, "from_zero", "ai_workbench"].filter(Boolean))),
    applicableGenres: [input.plan.genre],
    sourceType: "from_current_work",
    sourceRefId: input.novelId,
    sourceContent: [
      `灵感：${input.idea}`,
      `风格关键词：${effectiveTone}`,
      `核心卖点：${input.plan.coreSellingPoint}`,
      `主线：${input.plan.mainLine}`,
    ].join("\n"),
    analysisMarkdown: [
      `# ${input.novelTitle} 开书风格画像`,
      "",
      `选择学习维度：文风语言、章节结构、节奏爽点、去 AI 味`,
      "",
      `- 题材：${input.plan.genre}`,
      `- 目标读者：${input.plan.targetAudience}`,
      `- 风格关键词：${effectiveTone}`,
      `- 核心卖点：${input.plan.coreSellingPoint}`,
    ].join("\n"),
    narrativeRules: {
      summary: `围绕“${input.plan.mainConflict}”稳定推进，每章保留目标、冲突、线索推进和章末钩子。`,
      progressionMode: "线索递进 + 章末钩子",
      endingStyle: "保留未解信息差，不提前揭晓最终真相",
    },
    characterRules: {
      summary: `角色行动必须服务“${input.plan.protagonistMotivation}”，关系变化经 ReviewGate 后回灌。`,
      emotionExpression: "克制，优先用动作、选择和细节表现心理",
      dialogueStyle: "短句、信息控制、保留潜台词",
    },
    languageRules: {
      summary: effectiveTone,
      register: "现代中文网文，可读但不过度解释",
      sentenceVariation: "短中句交替，避免模板化总结",
      allowUselessDetails: false,
    },
    rhythmRules: {
      summary: "章节内保持行动压力、线索推进和阶段性反转。",
      pace: "中快节奏",
      paragraphDensity: "中等偏紧",
      actionOverExplanation: true,
    },
  });
  const binding = await styleBindingService.createBinding({
    styleProfileId: profile.id,
    targetType: "novel",
    targetId: input.novelId,
    priority: 10,
    weight: 0.85,
    enabled: true,
  });
  return {
    styleProfileCount: 1,
    styleProfileId: profile.id,
    styleBindingId: binding.id,
  };
}

async function recordChapterVisualArtifacts(input: {
  novelId: string;
  chapterId: string;
  chapterOrder: number;
  draft: z.infer<typeof fromZeroChapterDraftSchema>;
  outlineItem?: z.infer<typeof fromZeroOutlineChapterSchema>;
  characterIds: string[];
}): Promise<{ timelineEventCount: number; foreshadowCandidateCount: number }> {
  const eventTexts = input.draft.timelineEvents.length > 0
    ? input.draft.timelineEvents
    : [
      input.outlineItem?.summary,
      input.outlineItem?.clueProgress,
      input.draft.summary,
    ].filter((item): item is string => Boolean(item?.trim()));
  const events = await Promise.all(eventTexts.slice(0, 4).map((eventText, index) => prisma.storyTimelineEvent.create({
    data: {
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterIndex: input.chapterOrder,
      eventOrder: input.chapterOrder * 100 + index,
      storyTimeLabel: `第 ${input.chapterOrder} 章`,
      title: index === 0 ? input.draft.title : `第 ${input.chapterOrder} 章事件 ${index + 1}`,
      summary: compactText(eventText, 500),
      type: "plot_progress",
      status: "confirmed",
      visibility: "known_to_reader",
      source: "ai_workbench_from_zero",
      participantIdsJson: JSON.stringify(input.characterIds.slice(0, 4)),
      stateChangesJson: JSON.stringify(input.draft.characterStates.slice(0, 6)),
      eventKey: `from-zero:${input.chapterOrder}:${index}:${slugText(eventText, 20)}`,
      confidence: 0.8,
    },
  })));
  const hookTexts = Array.from(new Set([
    input.draft.hook,
    ...input.draft.foreshadowCandidates,
    input.outlineItem?.hook,
  ].filter((item): item is string => Boolean(item?.trim())))).slice(0, 6);
  await Promise.all(hookTexts.map((hookText, index) => prisma.timelineHook.create({
    data: {
      novelId: input.novelId,
      createdInChapterId: input.chapterId,
      createdInChapterIndex: input.chapterOrder,
      expectedResolveByChapterIndex: input.chapterOrder + (index === 0 ? 2 : 6),
      resolveMode: index === 0 ? "short_arc" : "long_arc",
      blocking: index === 0,
      title: compactText(hookText, 80),
      description: compactText(hookText, 500),
      status: "open",
      priority: index === 0 ? "high" : "medium",
      relatedEventIdsJson: JSON.stringify(events.map((event) => event.id)),
      participantIdsJson: JSON.stringify(input.characterIds.slice(0, 4)),
    },
  })));
  await Promise.all(hookTexts.map((hookText, index) => prisma.payoffLedgerItem.upsert({
    where: {
      novelId_ledgerKey: {
        novelId: input.novelId,
        ledgerKey: `from-zero:${input.chapterOrder}:${index}:${slugText(hookText, 28)}`,
      },
    },
    update: {
      summary: compactText(hookText, 500),
      lastTouchedChapterOrder: input.chapterOrder,
      lastTouchedChapterId: input.chapterId,
      targetEndChapterOrder: input.chapterOrder + (index === 0 ? 2 : 8),
      evidenceJson: JSON.stringify({
        source: "ai_workbench_from_zero",
        chapterOrder: input.chapterOrder,
        hook: hookText,
      }),
    },
    create: {
      novelId: input.novelId,
      ledgerKey: `from-zero:${input.chapterOrder}:${index}:${slugText(hookText, 28)}`,
      title: compactText(hookText, 80),
      summary: compactText(hookText, 500),
      scopeType: "book",
      currentStatus: index === 0 ? "pending_payoff" : "setup",
      targetStartChapterOrder: input.chapterOrder + 1,
      targetEndChapterOrder: input.chapterOrder + (index === 0 ? 2 : 8),
      firstSeenChapterOrder: input.chapterOrder,
      lastTouchedChapterOrder: input.chapterOrder,
      lastTouchedChapterId: input.chapterId,
      setupChapterId: input.chapterId,
      sourceRefsJson: JSON.stringify([{ type: "chapter", id: input.chapterId, order: input.chapterOrder }]),
      evidenceJson: JSON.stringify({
        source: "ai_workbench_from_zero",
        chapterOrder: input.chapterOrder,
        hook: hookText,
      }),
      confidence: 0.75,
    },
  })));
  return {
    timelineEventCount: events.length,
    foreshadowCandidateCount: hookTexts.length,
  };
}

export class FromZeroGenerationService {
  private async expandChapterDraft(input: {
    novelId: string;
    agentRunId: string;
    plan: FromZeroBookPackage;
    draft: z.infer<typeof fromZeroChapterDraftSchema>;
    outlineItem?: z.infer<typeof fromZeroOutlineChapterSchema>;
    targetWordCount: number;
    provider?: LLMProvider;
    model?: string;
    temperature: number;
  }): Promise<{
    draft: z.infer<typeof fromZeroChapterDraftSchema>;
    runtimeTarget?: StructuredRuntimeTarget;
  }> {
    if (input.draft.content.trim().length >= MIN_BENCHMARK_CHAPTER_WORDS) {
      return { draft: input.draft };
    }
    const startedAt = Date.now();
    const result = await invokeStructuredLlmDetailed({
      systemPrompt: [
        "你是 AI 小说工作台的 Writer。",
        "任务是把已有章节草稿扩写为中文网文/泛小说章节，题材和风格必须继承开书包。",
        "必须保留原章节目标、冲突、主线/线索推进和章末钩子。",
        "不要提前解决核心冲突，不要改变书设、人物关系或核心设定。",
        "输出严格符合 JSON schema。",
      ].join("\n"),
      userPrompt: [
        `书名：${input.plan.title}`,
        `核心卖点：${input.plan.coreSellingPoint}`,
        `世界观：${input.plan.worldbuilding}`,
        `主角动机：${input.plan.protagonistMotivation}`,
        `主线：${input.plan.mainLine}`,
        input.outlineItem
          ? `本章大纲：目标=${input.outlineItem.goal}；冲突=${input.outlineItem.conflict}；主线/线索推进=${input.outlineItem.clueProgress}；钩子=${input.outlineItem.hook}`
          : "",
        `目标长度：正文至少 ${MIN_BENCHMARK_CHAPTER_WORDS} 个中文字符，控制在 ${MAX_BENCHMARK_CHAPTER_WORDS} 字符以内。`,
        "已有草稿：",
        JSON.stringify(input.draft, null, 2),
      ].filter(Boolean).join("\n"),
      schema: expandedChapterDraftSchema,
      provider: input.provider,
      model: input.model,
      temperature: Math.min(0.55, input.temperature + 0.05),
      maxTokens: Math.max(8000, Math.ceil(input.targetWordCount * 2.4)),
      taskType: "writer",
      label: `ai_workbench.from_zero.expand_chapter_${input.draft.order}@v1`,
      maxRepairAttempts: 1,
    });
    const runtimeTarget = readStructuredRuntimeTarget(result, {
      provider: input.provider,
      model: input.model,
    });
    await aiWorkbenchService.recordModelCall({
      novelId: input.novelId,
      agentRunId: input.agentRunId,
      taskType: "from_zero_chapter_expand",
      provider: runtimeTarget.provider,
      model: runtimeTarget.model,
      status: "succeeded",
      promptTokens: result.tokenUsage?.promptTokens ?? 0,
      completionTokens: result.tokenUsage?.completionTokens ?? 0,
      totalTokens: result.tokenUsage?.totalTokens ?? 0,
      latencyMs: Date.now() - startedAt,
      metadataJson: JSON.stringify({
        chapterOrder: input.draft.order,
        originalLength: input.draft.content.length,
        expandedLength: result.data.content.length,
        repairUsed: result.repairUsed,
        repairAttempts: result.repairAttempts,
        strategy: result.diagnostics.strategy,
        modelRoute: runtimeTarget.modelRoute,
        routeDegraded: runtimeTarget.routeDegraded,
      }),
    });
    return {
      draft: {
        ...result.data,
        order: input.draft.order,
      },
      runtimeTarget,
    };
  }

  async generateBook(input: GenerateFromZeroBookInput): Promise<FromZeroGenerationResult> {
    const idea = input.idea.trim();
    if (!idea) {
      throw new AppError("Idea is required.", 400);
    }
    const firstChapterCount = clampInt(input.firstChapterCount, DEFAULT_FIRST_CHAPTER_COUNT, 1, 3);
    const outlineChapterCount = clampInt(input.targetOutlineChapterCount, DEFAULT_OUTLINE_CHAPTER_COUNT, DEFAULT_OUTLINE_CHAPTER_COUNT, 40);
    const targetWordCount = clampInt(input.defaultChapterLength, 2800, MIN_BENCHMARK_CHAPTER_WORDS, MAX_BENCHMARK_CHAPTER_WORDS);
    const provider = input.provider?.trim() ? (input.provider.trim() as LLMProvider) : undefined;
    const model = input.model?.trim() || undefined;
    const temperature = input.temperature ?? 0.45;
    const maxTokens = input.maxTokens ?? 24000;
    const title = input.title?.trim() || undefined;
    const styleTone = input.styleTone?.trim() || undefined;
    const prompts = buildPlannerPrompts({ idea, title, styleTone, firstChapterCount, outlineChapterCount, targetWordCount });
    const startedAt = Date.now();
    const generated = await invokeStructuredLlmDetailed({
      ...prompts,
      schema: fromZeroBookPackageSchema,
      provider,
      model,
      temperature,
      maxTokens,
      taskType: "planner",
      label: "ai_workbench.from_zero.book_package@v1",
      maxRepairAttempts: 1,
    });
    const plannerRuntimeTarget = readStructuredRuntimeTarget(generated, { provider, model });
    const plan = generated.data;
    const outline = ensureArrayLength(
      plan.outlineChapters.sort((left, right) => left.order - right.order),
      outlineChapterCount,
    );
    const firstChapters = ensureArrayLength(
      plan.firstChapters.sort((left, right) => left.order - right.order),
      firstChapterCount,
    );
    if (outline.length < DEFAULT_OUTLINE_CHAPTER_COUNT || firstChapters.length < firstChapterCount) {
      throw new AppError("从零开书结果不完整，缺少前 20 章大纲或前三章正文。", 502, {
        outlineCount: outline.length,
        firstChapterCount: firstChapters.length,
      });
    }

    const novel = await prisma.novel.create({
      data: {
        title: title || plan.title,
        description: idea,
        targetAudience: plan.targetAudience,
        bookSellingPoint: plan.coreSellingPoint,
        first30ChapterPromise: plan.mainLine,
        status: "draft",
        writingMode: "original",
        projectMode: "ai_led",
        styleTone: styleTone || plan.styleTone,
        defaultChapterLength: targetWordCount,
        estimatedChapterCount: 80,
        projectStatus: "in_progress",
        storylineStatus: "in_progress",
        outlineStatus: "in_progress",
        resourceReadyScore: 60,
        outline: buildMarkdownOutline({ ...plan, outlineChapters: outline }),
        structuredOutline: buildStructuredOutline({ ...plan, outlineChapters: outline }),
        storyWorldSliceJson: JSON.stringify({
          worldbuilding: plan.worldbuilding,
          mainConflict: plan.mainConflict,
          protagonistMotivation: plan.protagonistMotivation,
          source: "ai_workbench_from_zero",
        }),
        commercialTagsJson: JSON.stringify(buildCommercialTags(plan, styleTone)),
      },
    });
    const agentRunId = await aiWorkbenchAgentRunLogger.startRun({
      novelId: novel.id,
      sessionId: `ai-workbench:from-zero-generate:${novel.id}`,
      goal: "从零开书：灵感 -> 书设/角色/世界观/前 20 章大纲/前 3 章正文",
      metadata: {
        source: "from_zero_generate_book",
        targetFirstChapterCount: firstChapterCount,
        targetOutlineChapterCount: outlineChapterCount,
        targetWordCount,
      },
    });
    await aiWorkbenchService.recordModelCall({
      novelId: novel.id,
      agentRunId,
      taskType: "from_zero_book_package",
      provider: plannerRuntimeTarget.provider,
      model: plannerRuntimeTarget.model,
      status: "succeeded",
      promptTokens: generated.tokenUsage?.promptTokens ?? 0,
      completionTokens: generated.tokenUsage?.completionTokens ?? 0,
      totalTokens: generated.tokenUsage?.totalTokens ?? 0,
      latencyMs: Date.now() - startedAt,
      metadataJson: JSON.stringify({
        repairUsed: generated.repairUsed,
        repairAttempts: generated.repairAttempts,
        strategy: generated.diagnostics.strategy,
        modelRoute: plannerRuntimeTarget.modelRoute,
        routeDegraded: plannerRuntimeTarget.routeDegraded,
      }),
    });
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Planner",
      stepType: "planning",
      status: "succeeded",
      input: { idea, targetOutlineChapterCount: outlineChapterCount, targetFirstChapterCount: firstChapterCount },
      output: {
        novelId: novel.id,
        title: novel.title,
        titleCandidates: plan.titleCandidates,
        outlineChapterCount: outline.length,
        characterCount: plan.characters.length,
      },
      provider: plannerRuntimeTarget.provider,
      model: plannerRuntimeTarget.model,
    });

    const characters = await prisma.character.createManyAndReturn({
      data: plan.characters.slice(0, 8).map((character, index) => ({
        novelId: novel.id,
        name: character.name,
        role: index === 0 ? "protagonist" : character.role,
        gender: character.gender,
        storyFunction: character.storyFunction,
        relationToProtagonist: character.relationToProtagonist || null,
        personality: character.personality || null,
        background: character.background || null,
        secret: character.secret || null,
        currentState: character.currentState || "从零开书阶段建立，等待章节推进校准。",
        currentGoal: character.currentGoal || `围绕“${compactText(plan.mainConflict, 80)}”推进当前行动。`,
        availability: "active",
        prohibitionsJson: JSON.stringify(["from_zero_generated", "requires_review_gate_before_major_change"]),
      })),
    });
    const initialRelations = await recordInitialCharacterRelations({
      novelId: novel.id,
      characters,
    });
    const styleSetup = await createFromZeroStyleProfileBinding({
      novelId: novel.id,
      novelTitle: novel.title,
      idea,
      plan: { ...plan, outlineChapters: outline },
      styleTone,
    });
    const skillSetup = await enableFromZeroProjectSkills({
      novelId: novel.id,
      plan: { ...plan, outlineChapters: outline },
      styleTone,
    });
    const activeSkills = await skillRuntimeContextService.getActiveSkills(novel.id).catch(() => []);
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "ContextBuilder",
      stepType: "reasoning",
      status: "succeeded",
      input: { novelId: novel.id, source: "Postgres + Skills + StyleProfile + generated book package" },
      output: {
        worldbuilding: compactText(plan.worldbuilding, 500),
        activeSkills: summarizeActiveSkillsForAgentLog(activeSkills),
        enabledSkillSlugs: skillSetup.skillSlugs,
        styleProfileId: styleSetup.styleProfileId,
        styleBindingId: styleSetup.styleBindingId,
        characterCount: characters.length,
        characterRelationCount: initialRelations.characterRelationCount,
        outlineChapterCount: outline.length,
      },
      provider: plannerRuntimeTarget.provider,
      model: plannerRuntimeTarget.model,
    });

    const expandedChapters: Array<z.infer<typeof fromZeroChapterDraftSchema>> = [];
    const writerRuntimeTargets: StructuredRuntimeTarget[] = [];
    for (const draft of firstChapters) {
      const outlineItem = outline.find((item) => item.order === draft.order);
      const expanded = await this.expandChapterDraft({
        novelId: novel.id,
        agentRunId,
        plan: { ...plan, outlineChapters: outline },
        draft,
        outlineItem,
        targetWordCount,
        provider,
        model,
        temperature,
      });
      expandedChapters.push(expanded.draft);
      if (expanded.runtimeTarget) {
        writerRuntimeTargets.push(expanded.runtimeTarget);
      }
    }
    const writerRuntimeTarget = writerRuntimeTargets[0] ?? plannerRuntimeTarget;

    const createdChapterSummaries: FromZeroGeneratedChapterSummary[] = [];
    let timelineEventCount = 0;
    let foreshadowCandidateCount = 0;
    for (const draft of expandedChapters) {
      const outlineItem = outline.find((item) => item.order === draft.order);
      const chapter = await prisma.chapter.create({
        data: {
          novelId: novel.id,
          order: draft.order,
          title: draft.title,
          content: draft.content,
          generationState: "reviewed",
          chapterStatus: "completed",
          targetWordCount,
          expectation: outlineItem
            ? [`目标：${outlineItem.goal}`, `冲突：${outlineItem.conflict}`, `主线/线索推进：${outlineItem.clueProgress}`, `钩子：${outlineItem.hook}`].join("\n")
            : null,
          hook: draft.hook,
        },
      });
      const summary = await prisma.chapterSummary.create({
        data: {
          novelId: novel.id,
          chapterId: chapter.id,
          summary: draft.summary,
          keyEvents: JSON.stringify(draft.keyEvents),
          characterStates: JSON.stringify(draft.characterStates),
          hook: draft.hook,
        },
      });
      await prisma.plotBeat.create({
        data: {
          novelId: novel.id,
          chapterOrder: chapter.order,
          beatType: "from_zero_outline",
          title: outlineItem?.title ?? draft.title,
          content: outlineItem?.summary ?? draft.summary,
          status: "completed",
          metadata: JSON.stringify({
            goal: outlineItem?.goal,
            conflict: outlineItem?.conflict,
            clueProgress: outlineItem?.clueProgress,
            hook: outlineItem?.hook ?? draft.hook,
          }),
        },
      });
      await Promise.all(characters.slice(0, 4).map((character) => prisma.characterTimeline.create({
        data: {
          novelId: novel.id,
          characterId: character.id,
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          title: `第 ${chapter.order} 章状态`,
          content: draft.characterStates.find((state) => state.includes(character.name)) ?? `${character.name} 参与第 ${chapter.order} 章主线推进。`,
          source: "ai_workbench_from_zero",
        },
      })));
      const visualArtifacts = await recordChapterVisualArtifacts({
        novelId: novel.id,
        chapterId: chapter.id,
        chapterOrder: chapter.order,
        draft,
        outlineItem,
        characterIds: characters.map((character) => character.id),
      });
      timelineEventCount += visualArtifacts.timelineEventCount;
      foreshadowCandidateCount += visualArtifacts.foreshadowCandidateCount;
      const quality = evaluateChapterDraft({ content: draft.content, hook: draft.hook, targetWordCount, plan });
      await createQualityReport(novel.id, chapter.id, quality.score, quality.issues, {
        sourceType: "from_zero_pipeline_review",
        contentLength: draft.content.length,
        agentRunId,
      });
      createdChapterSummaries.push({
        id: chapter.id,
        order: chapter.order,
        title: chapter.title,
        contentLength: draft.content.length,
        summaryId: summary.id,
        hook: draft.hook,
      });
    }

    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Writer",
      stepType: "write",
      status: "succeeded",
      input: { chapterRange: [1, firstChapterCount], targetWordCount },
      output: {
        generatedChapterCount: createdChapterSummaries.length,
        chapters: createdChapterSummaries.map((chapter) => ({
          order: chapter.order,
          title: chapter.title,
          contentLength: chapter.contentLength,
          hook: chapter.hook,
        })),
        timelineEventCount,
        foreshadowCandidateCount,
      },
      provider: writerRuntimeTarget.provider,
      model: writerRuntimeTarget.model,
    });

    const [reviewGateResults, statePatches] = await Promise.all([
      prisma.reviewGateResult.findMany({
        where: { novelId: novel.id, agentRunId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.statePatch.findMany({
        where: { novelId: novel.id, agentRunId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);
    await aiWorkbenchAgentRunLogger.addStep({
      runId: agentRunId,
      role: "Reviewer",
      stepType: "approval",
      status: "succeeded",
      input: { reviewGate: "统一 ReviewGate", chapterCount: createdChapterSummaries.length },
      output: {
        reviewGateCount: reviewGateResults.length,
        statePatchCount: statePatches.length,
        needsHumanConfirmation: reviewGateResults.some((gate) => gate.needsHumanConfirmation),
      },
      provider: writerRuntimeTarget.provider,
      model: writerRuntimeTarget.model,
    });
    await aiWorkbenchAgentRunLogger.finishRun({
      runId: agentRunId,
      status: reviewGateResults.some((gate) => gate.needsHumanConfirmation) ? "waiting_approval" : "succeeded",
    });

    if (input.enqueueIndex !== false) {
      await enqueueIndexes({
        novelId: novel.id,
        chapterIds: createdChapterSummaries.map((chapter) => chapter.id),
        chapterSummaryIds: createdChapterSummaries.map((chapter) => chapter.summaryId),
        characterIds: characters.map((character) => character.id),
      });
    }

    return {
      novel: {
        id: novel.id,
        title: novel.title,
        outlineChapterCount: outline.length,
        characterCount: characters.length,
      },
      agentRunId,
      chapters: createdChapterSummaries,
      reviewGateResults: reviewGateResults.map((gate) => ({
        id: gate.id,
        chapterId: gate.chapterId,
        pass: gate.pass,
        needsHumanConfirmation: gate.needsHumanConfirmation,
        recommendedAction: gate.recommendedAction,
      })),
      statePatches: statePatches.map((patch) => ({
        id: patch.id,
        chapterId: patch.chapterId,
        status: patch.status,
        riskLevel: patch.riskLevel,
        patchType: patch.patchType,
      })),
      checks: {
        hasBookSetup: Boolean(plan.coreSellingPoint && plan.worldbuilding && plan.mainConflict),
        outlineChapterCount: outline.length,
        firstChapterCount: createdChapterSummaries.length,
        everyChapterHasHook: createdChapterSummaries.every((chapter) => chapter.hook.trim().length > 0),
        reviewGateCount: reviewGateResults.length,
        statePatchCount: statePatches.length,
        characterRelationCount: initialRelations.characterRelationCount,
        styleProfileCount: styleSetup.styleProfileCount,
        activeSkillCount: skillSetup.activeSkillCount,
        timelineEventCount,
        foreshadowCandidateCount,
      },
    };
  }
}

export const fromZeroGenerationService = new FromZeroGenerationService();
