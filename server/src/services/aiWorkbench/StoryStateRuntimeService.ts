import type {
  StoryStateCoverageItem,
  StoryStateCoverageStatus,
  StoryStateDeterministicCheck,
  StoryStateDeterministicIssue,
  StoryStateQualityDebt,
  StoryStateRuntimeSnapshot,
  StoryStateStyleSkillConflict,
} from "@ai-novel/shared/types/aiWorkbench";
import { REFERENCE_STYLE_LEARNING_DIMENSION_LABELS } from "@ai-novel/shared/types/referenceCorpus";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { skillRuntimeContextService } from "./SkillRuntimeContextService";

const OK_SKILL_CONFLICT_STATUSES = new Set(["ok", "none", "checked", "compatible", "resolved"]);
const INACTIVE_CHARACTER_TERMS = [
  "死亡",
  "已死",
  "牺牲",
  "离队",
  "失踪",
  "不可用",
  "下线",
  "dead",
  "deceased",
  "departed",
  "unavailable",
  "absent",
];

interface DeterministicCheckInput {
  currentChapterOrder: number | null;
  characters: Array<{
    id: string;
    name: string;
    availability: string | null;
    currentState: string | null;
  }>;
  timelineEvents: Array<{
    id: string;
    title: string;
    summary: string;
    type: string;
    status: string;
    chapterIndex: number | null;
    eventOrder: number;
    storyDayIndex: number | null;
    storyTimeLabel: string | null;
    source: string;
    participantIdsJson: string;
    locationId: string | null;
    eventKey: string | null;
  }>;
  hooks: Array<{
    id: string;
    title: string;
    status: string;
    blocking: boolean;
    priority: string;
    expectedResolveByChapterIndex: number | null;
    participantIdsJson: string;
  }>;
  reports: Array<{
    id: string;
    status: string;
    chapterIndex: number;
    issuesJson: string;
  }>;
  resourceItems: Array<{
    id: string;
    name: string;
    holderCharacterId: string | null;
    holderCharacterName: string | null;
    status: string;
  }>;
  resourceEvents: Array<{
    id: string;
    resourceId: string;
    chapterOrder: number | null;
    toHolderCharacterId: string | null;
  }>;
  coreAssignments: Array<{
    characterId: string;
    responsibility: string;
    absenceWarningThreshold: number;
    absenceHighRiskThreshold: number;
    character: { id: string; name: string };
  }>;
  characterTimelines: Array<{
    characterId: string;
    chapterOrder: number | null;
    title: string;
  }>;
  openConflicts: Array<{
    id: string;
    conflictType: string;
    conflictKey: string;
    title: string;
    summary: string;
    severity: string;
  }>;
  payoffItems: Array<{
    id: string;
    title: string;
    currentStatus: string;
    targetStartChapterOrder: number | null;
    targetEndChapterOrder: number | null;
    lastTouchedChapterOrder: number | null;
  }>;
  projectSkills: Array<{
    id: string;
    skillId: string;
    enabled: boolean;
    conflictStatus: string;
    conflictJson: string;
    skill: { name: string; slug: string } | null;
  }>;
  styleSkillConflicts: StoryStateStyleSkillConflict[];
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseUnknownArray(value: string | null | undefined): unknown[] {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
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

function readRuleSummary(value: string | null | undefined): string | null {
  const parsed = parseJsonObject(value);
  const summary = parsed.summary;
  return typeof summary === "string" && summary.trim().length > 0 ? summary.trim() : null;
}

function readStyleLearningDimensions(input: {
  analysisMarkdown?: string | null;
  description?: string | null;
  extractedFeaturesJson?: string | null;
}): string[] {
  const labels = Object.values(REFERENCE_STYLE_LEARNING_DIMENSION_LABELS);
  const text = [input.analysisMarkdown, input.description].filter(Boolean).join("\n");
  const matchedLine = text.match(/选择学习维度[:：]\s*([^\n]+)/);
  if (matchedLine?.[1]) {
    const fromText = labels.filter((label) => matchedLine[1].includes(label));
    if (fromText.length > 0) {
      return fromText;
    }
  }

  const featureGroups = new Set(
    parseUnknownArray(input.extractedFeaturesJson)
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .filter((item) => item.enabled !== false && item.selectedDecision !== "remove")
      .map((item) => typeof item.group === "string" ? item.group : null)
      .filter((item): item is string => Boolean(item)),
  );
  const inferred: string[] = [];
  if (featureGroups.has("language")) inferred.push(REFERENCE_STYLE_LEARNING_DIMENSION_LABELS.language);
  if (featureGroups.has("narrative")) inferred.push(REFERENCE_STYLE_LEARNING_DIMENSION_LABELS.chapter_structure);
  if (featureGroups.has("rhythm")) inferred.push(REFERENCE_STYLE_LEARNING_DIMENSION_LABELS.pacing_payoff);
  if (featureGroups.has("dialogue")) inferred.push(REFERENCE_STYLE_LEARNING_DIMENSION_LABELS.dialogue);
  if (featureGroups.has("fingerprint")) inferred.push(REFERENCE_STYLE_LEARNING_DIMENSION_LABELS.anti_ai);
  return inferred;
}

function countEnabledStyleFeatures(value: string | null | undefined): number {
  return parseUnknownArray(value)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .filter((item) => item.enabled !== false && item.selectedDecision !== "remove").length;
}

function styleProfileWorkbenchSummary(profile: {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  sourceType: string;
  sourceRefId: string | null;
  sourceContent: string | null;
  status: string;
  selectedExtractionPresetKey: string | null;
  extractedFeaturesJson: string | null;
  extractionAntiAiRuleKeysJson: string | null;
  analysisMarkdown: string | null;
  narrativeRulesJson: string | null;
  characterRulesJson: string | null;
  languageRulesJson: string | null;
  rhythmRulesJson: string | null;
  updatedAt: Date;
}) {
  const antiAiRuleKeys = parseJsonArray(profile.extractionAntiAiRuleKeysJson);
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    category: profile.category,
    sourceType: profile.sourceType,
    sourceRefId: profile.sourceRefId,
    sourceSamplePreview: compactStoryText(profile.sourceContent, 260),
    analysisPreview: compactStoryText(profile.analysisMarkdown, 260),
    status: profile.status,
    selectedExtractionPresetKey: profile.selectedExtractionPresetKey,
    featureCount: countEnabledStyleFeatures(profile.extractedFeaturesJson),
    antiAiRuleCount: antiAiRuleKeys.length,
    antiAiRuleKeys,
    learningDimensions: readStyleLearningDimensions(profile),
    narrativeSummary: readRuleSummary(profile.narrativeRulesJson),
    characterSummary: readRuleSummary(profile.characterRulesJson),
    languageSummary: readRuleSummary(profile.languageRulesJson),
    rhythmSummary: readRuleSummary(profile.rhythmRulesJson),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function coverageFor(count: number, label: string, key: string, detail?: string): StoryStateCoverageItem {
  return {
    key,
    label,
    count,
    status: count > 0 ? "ready" : "not_enough_data",
    detail,
  };
}

function isInactiveCharacter(input: {
  currentState?: string | null;
  availability?: string | null;
}): boolean {
  const text = `${input.currentState ?? ""} ${input.availability ?? ""}`.toLowerCase();
  return INACTIVE_CHARACTER_TERMS.some((term) => text.includes(term.toLowerCase()));
}

function makeIssue(input: Omit<StoryStateDeterministicIssue, "id"> & { id?: string }): StoryStateDeterministicIssue {
  return {
    id: input.id ?? `${input.title}:${input.evidence.join("|")}`,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    evidence: input.evidence,
    relatedIds: input.relatedIds,
  };
}

function makeCheck(
  key: string,
  label: string,
  coverage: StoryStateCoverageStatus,
  issues: StoryStateDeterministicIssue[],
): StoryStateDeterministicCheck {
  let status: StoryStateDeterministicCheck["status"] = "pass";
  if (coverage === "not_enough_data") {
    status = "not_enough_data";
  } else if (issues.some((issue) => issue.severity === "blocking" || issue.severity === "error")) {
    status = "blocked";
  } else if (issues.length > 0) {
    status = "warning";
  }
  return {
    key,
    label,
    status,
    coverage,
    totalIssues: issues.length,
    issues,
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function compactStoryText(value: string | null | undefined, limit = 220): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function compactDebtText(value: unknown, limit = 180): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim().slice(0, limit);
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value).replace(/\s+/g, " ").trim().slice(0, limit);
  }
  return "";
}

function includesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

const STYLE_RELATED_SKILL_CONFLICT_KEYS = new Set(["tone", "style_contract", "anti_ai_policy"]);
const COLD_TONE_TERMS = ["冷峻", "克制", "冷静", "悬疑", "沉郁", "压抑", "严肃", "暗黑", "低情绪", "restrained", "cold", "suspense"];
const LIGHT_TONE_TERMS = ["轻松", "吐槽", "轻快", "幽默", "欢脱", "日常", "俏皮", "轻小说", "banter", "humor", "light"];

function intersectStrings(left: string[], right: Set<string>): string[] {
  return left.filter((item) => right.has(item));
}

function clippedEvidence(value: string | null | undefined, label: string, limit = 120): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? `${label}=${text.slice(0, limit)}` : null;
}

export class StoryStateRuntimeService {
  async buildRuntimeSnapshot(input: {
    novelId: string;
    chapterOrder?: number;
    limit?: number;
  }): Promise<StoryStateRuntimeSnapshot> {
    const limit = Math.max(10, Math.min(input.limit ?? 60, 120));
    const novel = await prisma.novel.findUnique({
      where: { id: input.novelId },
      select: {
        id: true,
        title: true,
        writingMode: true,
        _count: {
          select: { chapters: true },
        },
      },
    });

    if (!novel) {
      throw new AppError("小说不存在，无法聚合 StoryState。", 404, { novelId: input.novelId });
    }

    const latestChapter = await prisma.chapter.findFirst({
      where: {
        novelId: input.novelId,
        ...(input.chapterOrder ? { order: { lte: input.chapterOrder } } : {}),
      },
      orderBy: [{ order: "desc" }, { updatedAt: "desc" }],
      select: { id: true, title: true, order: true },
    });
    const currentChapterOrder = input.chapterOrder ?? latestChapter?.order ?? null;
    const chapterWindow = currentChapterOrder == null ? undefined : currentChapterOrder + 20;
    const currentVolumeChapter = latestChapter?.id
      ? await prisma.volumeChapterPlan.findFirst({
        where: { chapterId: latestChapter.id },
        select: {
          volumeId: true,
          volume: {
            select: {
              title: true,
              sortOrder: true,
            },
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      })
      : null;

    const [
      latestSnapshot,
      chapters,
      characters,
      relations,
      openConflicts,
      timelineEvents,
      hooks,
      constraints,
      reports,
      statePatches,
      reviewGateResults,
      projectSkills,
      activeSkillContexts,
      payoffItems,
      resourceItems,
      resourceEvents,
      coreAssignments,
      characterTimelines,
      styleBindings,
      availableStyleProfiles,
    ] = await Promise.all([
      prisma.storyStateSnapshot.findFirst({
        where: { novelId: input.novelId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          sourceChapter: { select: { id: true, order: true, title: true } },
          foreshadowStates: {
            include: {
              setupChapter: { select: { id: true, order: true, title: true } },
              payoffChapter: { select: { id: true, order: true, title: true } },
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 80,
          },
          _count: {
            select: {
              characterStates: true,
              relationStates: true,
              informationStates: true,
              foreshadowStates: true,
            },
          },
        },
      }),
      prisma.chapter.findMany({
        where: { novelId: input.novelId },
        select: {
          id: true,
          title: true,
          order: true,
          generationState: true,
          chapterStatus: true,
          targetWordCount: true,
          content: true,
          qualityScore: true,
          continuityScore: true,
          riskFlags: true,
          expectation: true,
          hook: true,
          updatedAt: true,
          chapterSummary: {
            select: {
              summary: true,
              hook: true,
            },
          },
          volumeChapterPlans: {
            select: {
              volumeId: true,
              volume: {
                select: {
                  title: true,
                  sortOrder: true,
                },
              },
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 1,
          },
        },
        orderBy: [{ order: "asc" }, { updatedAt: "asc" }],
        take: Math.max(limit, 120),
      }),
      prisma.character.findMany({
        where: { novelId: input.novelId },
        orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
        take: limit,
      }),
      prisma.characterRelation.findMany({
        where: { novelId: input.novelId },
        include: {
          sourceCharacter: { select: { id: true, name: true, factionLabel: true } },
          targetCharacter: { select: { id: true, name: true, factionLabel: true } },
          stages: {
            where: { isCurrent: true },
            select: {
              chapterOrder: true,
              stageLabel: true,
              stageSummary: true,
              sourceType: true,
              confidence: true,
            },
            orderBy: [{ chapterOrder: "desc" }, { updatedAt: "desc" }],
            take: 3,
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      prisma.openConflict.findMany({
        where: { novelId: input.novelId, status: { in: ["open", "active", "pending"] } },
        orderBy: [{ severity: "desc" }, { updatedAt: "desc" }],
        take: limit,
      }),
      prisma.storyTimelineEvent.findMany({
        where: {
          novelId: input.novelId,
          ...(chapterWindow == null
            ? {}
            : { OR: [{ chapterIndex: { lte: chapterWindow } }, { chapterIndex: null }] }),
          status: { notIn: ["cancelled", "superseded"] },
        },
        orderBy: [{ eventOrder: "desc" }, { updatedAt: "desc" }],
        take: Math.max(limit, 80),
      }),
      prisma.timelineHook.findMany({
        where: { novelId: input.novelId, status: { in: ["open", "addressed"] } },
        orderBy: [{ blocking: "desc" }, { priority: "desc" }, { updatedAt: "desc" }],
        take: limit,
      }),
      prisma.timelineConstraint.findMany({
        where: { novelId: input.novelId, active: true },
        orderBy: [{ severity: "desc" }, { updatedAt: "desc" }],
        take: limit,
      }),
      prisma.timelineCheckReport.findMany({
        where: {
          novelId: input.novelId,
          ...(currentChapterOrder == null ? {} : { chapterIndex: { lte: currentChapterOrder } }),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      prisma.statePatch.findMany({
        where: { novelId: input.novelId, status: { in: ["proposed", "needs_confirmation", "accepted"] } },
        include: { chapter: { select: { id: true, order: true, title: true } } },
        orderBy: [{ riskLevel: "desc" }, { updatedAt: "desc" }],
        take: limit,
      }),
      prisma.reviewGateResult.findMany({
        where: {
          novelId: input.novelId,
          OR: [{ pass: false }, { needsHumanConfirmation: true }],
        },
        include: { chapter: { select: { id: true, order: true, title: true } } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      prisma.projectSkill.findMany({
        where: { novelId: input.novelId },
        include: { skill: true },
        orderBy: [{ enabled: "desc" }, { priority: "asc" }, { updatedAt: "desc" }],
        take: 200,
      }),
      skillRuntimeContextService.getActiveSkills(input.novelId).catch(() => []),
      prisma.payoffLedgerItem.findMany({
        where: { novelId: input.novelId, currentStatus: { in: ["setup", "hinted", "pending_payoff", "overdue", "failed", "paid_off"] } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      prisma.characterResourceLedgerItem.findMany({
        where: { novelId: input.novelId },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      prisma.characterResourceEvent.findMany({
        where: { novelId: input.novelId },
        orderBy: [{ chapterOrder: "desc" }, { createdAt: "desc" }],
        take: Math.max(limit, 80),
      }),
      prisma.characterVolumeAssignment.findMany({
        where: { novelId: input.novelId, isCore: true },
        include: { character: { select: { id: true, name: true } } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      prisma.characterTimeline.findMany({
        where: {
          novelId: input.novelId,
          ...(currentChapterOrder == null ? {} : { chapterOrder: { lte: currentChapterOrder } }),
        },
        include: {
          character: { select: { id: true, name: true } },
        },
        orderBy: [{ chapterOrder: "desc" }, { updatedAt: "desc" }],
        take: 300,
      }),
      prisma.styleBinding.findMany({
        where: {
          enabled: true,
          OR: [
            { targetType: "novel", targetId: input.novelId },
            ...(currentVolumeChapter?.volumeId ? [{ targetType: "volume" as const, targetId: currentVolumeChapter.volumeId }] : []),
            ...(latestChapter?.id ? [{ targetType: "chapter" as const, targetId: latestChapter.id }] : []),
          ],
        },
        include: { styleProfile: true },
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        take: 20,
      }),
      prisma.styleProfile.findMany({
        where: { status: "active" },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 20,
      }),
    ]);

    const boundStyleProfileIds = new Set(styleBindings.map((binding) => binding.styleProfileId));
    const styleProfiles = [
      ...styleBindings.map((binding) => ({
        ...styleProfileWorkbenchSummary(binding.styleProfile),
        bindingTargetType: binding.targetType,
        bindingPriority: binding.priority,
        bindingWeight: binding.weight,
      })),
      ...availableStyleProfiles
        .filter((profile) => !boundStyleProfileIds.has(profile.id))
        .slice(0, Math.max(0, 10 - styleBindings.length))
        .map((profile) => ({
          ...styleProfileWorkbenchSummary(profile),
          bindingTargetType: "available" as const,
          bindingPriority: null,
          bindingWeight: null,
        })),
    ];

    const projectSkillBySkillId = new Map(projectSkills.map((item) => [item.skillId, item]));
    const styleSkillConflicts = this.buildStyleSkillConflicts({
      activeSkills: activeSkillContexts,
      styleProfiles,
    });

    const deterministicChecks = this.runDeterministicChecks({
      currentChapterOrder,
      characters,
      timelineEvents,
      hooks,
      reports,
      resourceItems,
      resourceEvents,
      coreAssignments,
      characterTimelines,
      openConflicts,
      payoffItems,
      projectSkills,
      styleSkillConflicts,
    });
    const qualityDebt = this.buildQualityDebt({
      reviewGateResults,
      statePatches,
      deterministicChecks,
      limit,
    });

    const coverage = [
      coverageFor(latestSnapshot ? 1 : 0, "StoryState 快照", "snapshot", latestSnapshot?.summary ?? undefined),
      coverageFor(chapters.length, "章节树", "chapter_tree"),
      coverageFor(characters.length, "角色状态", "characters"),
      coverageFor(relations.length, "角色关系", "relations"),
      coverageFor(timelineEvents.length, "时间线事件", "timeline_events"),
      coverageFor((latestSnapshot?.foreshadowStates.length ?? 0) + hooks.length + payoffItems.length, "伏笔/钩子", "foreshadow_states"),
      coverageFor(openConflicts.length, "开放冲突", "open_conflicts"),
      coverageFor(styleProfiles.length, "StyleProfile", "style_profiles"),
      coverageFor(activeSkillContexts.length, "启用 Skills", "active_skills"),
      coverageFor(statePatches.length, "待处理 StatePatch", "state_patches"),
      coverageFor(reviewGateResults.length, "待处理 ReviewGate", "review_gate"),
      coverageFor(qualityDebt.length, "质量债", "quality_debt"),
    ];

    return {
      novel: {
        id: novel.id,
        title: novel.title,
        writingMode: novel.writingMode,
        chapterCount: novel._count.chapters,
        latestChapterOrder: latestChapter?.order ?? null,
      },
      currentChapterOrder,
      generatedAt: new Date().toISOString(),
      latestSnapshot: latestSnapshot
        ? {
          id: latestSnapshot.id,
          sourceChapterId: latestSnapshot.sourceChapterId,
          sourceChapterOrder: latestSnapshot.sourceChapter?.order ?? null,
          summary: latestSnapshot.summary,
          characterStateCount: latestSnapshot._count.characterStates,
          relationStateCount: latestSnapshot._count.relationStates,
          informationStateCount: latestSnapshot._count.informationStates,
          foreshadowStateCount: latestSnapshot._count.foreshadowStates,
          createdAt: latestSnapshot.createdAt.toISOString(),
          updatedAt: latestSnapshot.updatedAt.toISOString(),
        }
        : null,
      coverage,
      foreshadowStates: (latestSnapshot?.foreshadowStates ?? []).map((state) => ({
        id: state.id,
        title: state.title,
        summary: state.summary,
        status: state.status,
        setupChapterId: state.setupChapterId,
        setupChapterOrder: state.setupChapter?.order ?? null,
        setupChapterTitle: state.setupChapter?.title ?? null,
        payoffChapterId: state.payoffChapterId,
        payoffChapterOrder: state.payoffChapter?.order ?? null,
        payoffChapterTitle: state.payoffChapter?.title ?? null,
        createdAt: state.createdAt.toISOString(),
        updatedAt: state.updatedAt.toISOString(),
      })),
      chapterTree: chapters.map((chapter) => ({
        id: chapter.id,
        order: chapter.order,
        title: chapter.title,
        volumeId: chapter.volumeChapterPlans[0]?.volumeId ?? null,
        volumeTitle: chapter.volumeChapterPlans[0]?.volume?.title ?? null,
        volumeOrder: chapter.volumeChapterPlans[0]?.volume?.sortOrder ?? null,
        summary: compactStoryText(chapter.chapterSummary?.summary, 240),
        goal: compactStoryText(chapter.expectation, 240),
        hook: compactStoryText(chapter.hook ?? chapter.chapterSummary?.hook, 160),
        generationState: chapter.generationState,
        chapterStatus: chapter.chapterStatus,
        targetWordCount: chapter.targetWordCount,
        contentLength: chapter.content?.length ?? 0,
        qualityScore: chapter.qualityScore,
        continuityScore: chapter.continuityScore,
        riskFlags: chapter.riskFlags,
        updatedAt: chapter.updatedAt.toISOString(),
      })),
      styleProfiles,
      activeSkills: activeSkillContexts.map((skill) => {
        const projectSkill = projectSkillBySkillId.get(skill.skillId);
        return {
          id: projectSkill?.id ?? skill.skillId,
          skillId: skill.skillId,
          name: skill.name,
          slug: skill.slug,
          category: skill.category,
          enabled: true,
          priority: skill.priority,
          conflictStatus: skill.conflictStatus,
          conflictJson: skill.conflictJson,
          stateRequirements: skill.stateRequirements,
          promptHooks: skill.promptHooks,
          reviewGateChecks: skill.reviewGateChecks,
          riskTriggers: skill.riskTriggers,
          visualFocus: skill.visualFocus,
        };
      }),
      styleSkillConflicts,
      characters: characters.map((character) => ({
        id: character.id,
        name: character.name,
        role: character.role,
        castRole: character.castRole,
        factionLabel: character.factionLabel,
        stanceLabel: character.stanceLabel,
        currentState: character.currentState,
        currentLocation: character.currentLocation,
        availability: character.availability,
        currentGoal: character.currentGoal,
        powerLevel: character.powerLevel,
        realm: character.realm,
        updatedAt: character.updatedAt.toISOString(),
      })),
      relations: relations.map((relation) => ({
        id: relation.id,
        sourceCharacterId: relation.sourceCharacterId,
        sourceName: relation.sourceCharacter?.name ?? null,
        sourceFactionLabel: relation.sourceCharacter?.factionLabel ?? null,
        targetCharacterId: relation.targetCharacterId,
        targetName: relation.targetCharacter?.name ?? null,
        targetFactionLabel: relation.targetCharacter?.factionLabel ?? null,
        surfaceRelation: relation.surfaceRelation,
        hiddenTension: relation.hiddenTension,
        evidence: relation.evidence,
        dynamicLabel: relation.dynamicLabel,
        trustScore: relation.trustScore,
        conflictScore: relation.conflictScore,
        intimacyScore: relation.intimacyScore,
        dependencyScore: relation.dependencyScore,
        evidenceChapterOrders: relation.stages
          .map((stage) => stage.chapterOrder)
          .filter((chapterOrder): chapterOrder is number => chapterOrder != null),
        currentStages: relation.stages.map((stage) => ({
          chapterOrder: stage.chapterOrder,
          stageLabel: stage.stageLabel,
          stageSummary: stage.stageSummary,
          sourceType: stage.sourceType,
          confidence: stage.confidence,
        })),
        updatedAt: relation.updatedAt.toISOString(),
      })),
      openConflicts: openConflicts.map((conflict) => ({
        id: conflict.id,
        conflictType: conflict.conflictType,
        conflictKey: conflict.conflictKey,
        title: conflict.title,
        summary: conflict.summary,
        severity: conflict.severity,
        status: conflict.status,
        lastSeenChapterOrder: conflict.lastSeenChapterOrder,
        updatedAt: conflict.updatedAt.toISOString(),
      })),
      timeline: {
        events: timelineEvents.slice().reverse().map((event) => ({
          id: event.id,
          chapterIndex: event.chapterIndex,
          eventOrder: event.eventOrder,
          storyDayIndex: event.storyDayIndex,
          storyTimeLabel: event.storyTimeLabel,
          title: event.title,
          summary: event.summary,
          type: event.type,
          status: event.status,
          participantIds: parseJsonArray(event.participantIdsJson),
          locationId: event.locationId,
          eventKey: event.eventKey,
          updatedAt: event.updatedAt.toISOString(),
        })),
        characterMovements: characterTimelines.slice(0, 80).map((event) => ({
          id: event.id,
          characterId: event.characterId,
          characterName: event.character?.name ?? null,
          chapterId: event.chapterId,
          chapterOrder: event.chapterOrder,
          title: event.title,
          content: event.content,
          source: event.source,
          updatedAt: event.updatedAt.toISOString(),
        })),
        hooks: hooks.map((hook) => ({
          id: hook.id,
          createdInChapterIndex: hook.createdInChapterIndex,
          expectedResolveByChapterIndex: hook.expectedResolveByChapterIndex,
          title: hook.title,
          status: hook.status,
          priority: hook.priority,
          blocking: hook.blocking,
          participantIds: parseJsonArray(hook.participantIdsJson),
          updatedAt: hook.updatedAt.toISOString(),
        })),
        constraints: constraints.map((constraint) => ({
          id: constraint.id,
          chapterIndex: constraint.chapterIndex,
          type: constraint.type,
          severity: constraint.severity,
          description: constraint.description,
          active: constraint.active,
          updatedAt: constraint.updatedAt.toISOString(),
        })),
        reports: reports.map((report) => ({
          id: report.id,
          chapterId: report.chapterId,
          chapterIndex: report.chapterIndex,
          status: report.status,
          score: report.score,
          issueCount: parseUnknownArray(report.issuesJson).length,
          createdAt: report.createdAt.toISOString(),
        })),
      },
      statePatches: statePatches.map((patch) => ({
        id: patch.id,
        targetType: patch.targetType,
        patchType: patch.patchType,
        status: patch.status,
        riskLevel: patch.riskLevel,
        createdAt: patch.createdAt.toISOString(),
        updatedAt: patch.updatedAt.toISOString(),
      })),
      reviewGateResults: reviewGateResults.map((gate) => ({
        id: gate.id,
        sourceType: gate.sourceType,
        pass: gate.pass,
        needsHumanConfirmation: gate.needsHumanConfirmation,
        recommendedAction: gate.recommendedAction,
        createdAt: gate.createdAt.toISOString(),
        updatedAt: gate.updatedAt.toISOString(),
      })),
      qualityDebt,
      payoffItems: payoffItems.map((item) => ({
        id: item.id,
        title: item.title,
        currentStatus: item.currentStatus,
        targetEndChapterOrder: item.targetEndChapterOrder,
        lastTouchedChapterOrder: item.lastTouchedChapterOrder,
        updatedAt: item.updatedAt.toISOString(),
      })),
      resourceItems: resourceItems.map((item) => ({
        id: item.id,
        name: item.name,
        resourceType: item.resourceType,
        status: item.status,
        holderCharacterId: item.holderCharacterId,
        holderCharacterName: item.holderCharacterName,
        lastTouchedChapterOrder: item.lastTouchedChapterOrder,
        updatedAt: item.updatedAt.toISOString(),
      })),
      deterministicChecks,
    };
  }

  private buildStyleSkillConflicts(input: {
    activeSkills: Array<{
      skillId: string;
      slug: string;
      name: string;
      category: string;
      priority: number;
      conflictKeys: string[];
      promptHooks: Record<string, string>;
    }>;
    styleProfiles: StoryStateRuntimeSnapshot["styleProfiles"];
  }): StoryStateStyleSkillConflict[] {
    const boundProfiles = input.styleProfiles
      .filter((profile) => profile.bindingTargetType && profile.bindingTargetType !== "available");
    if (boundProfiles.length === 0) {
      return [];
    }

    const conflicts: StoryStateStyleSkillConflict[] = [];
    for (const skill of input.activeSkills) {
      const matchedKeys = intersectStrings(skill.conflictKeys, STYLE_RELATED_SKILL_CONFLICT_KEYS);
      if (matchedKeys.length === 0) {
        continue;
      }
      const skillText = [
        skill.name,
        skill.category,
        ...Object.values(skill.promptHooks),
      ].join(" ");
      const skillIsCold = includesAny(skillText, COLD_TONE_TERMS);
      const skillIsLight = includesAny(skillText, LIGHT_TONE_TERMS);

      for (const profile of boundProfiles) {
        const profileText = [
          profile.name,
          profile.description,
          profile.category,
          profile.narrativeSummary,
          profile.characterSummary,
          profile.languageSummary,
          profile.rhythmSummary,
          profile.learningDimensions.join(" "),
        ].filter(Boolean).join(" ");
        const profileIsCold = includesAny(profileText, COLD_TONE_TERMS);
        const profileIsLight = includesAny(profileText, LIGHT_TONE_TERMS);
        const oppositeTone = (skillIsCold && profileIsLight) || (skillIsLight && profileIsCold);
        const strongBinding = (profile.bindingWeight ?? 1) >= 0.7;
        const severity: StoryStateStyleSkillConflict["severity"] = oppositeTone || strongBinding ? "warning" : "info";
        const evidence = [
          `skillKeys=${matchedKeys.join(",")}`,
          `skillPriority=${skill.priority}`,
          `styleBinding=${profile.bindingTargetType}:P${profile.bindingPriority ?? "默认"}:W${profile.bindingWeight ?? "默认"}`,
          oppositeTone ? "tone=可能相反" : "tone=需确认叠加顺序",
          clippedEvidence(profile.category, "profileCategory"),
          clippedEvidence(profile.languageSummary, "language"),
          clippedEvidence(profile.rhythmSummary, "rhythm"),
        ].filter((item): item is string => Boolean(item));

        conflicts.push({
          id: `style_skill:${skill.skillId}:${profile.id}`,
          severity,
          skillId: skill.skillId,
          skillName: skill.name,
          skillSlug: skill.slug,
          styleProfileId: profile.id,
          styleProfileName: profile.name,
          conflictKeys: matchedKeys,
          evidence,
          recommendedAction: "人工确认本次生成以 Skill 优先、StyleProfile 优先，或降低 StyleProfile 强度后再批量推进。",
        });
      }
    }

    return conflicts
      .sort((left, right) => {
        const severityRank = { error: 3, warning: 2, info: 1 };
        return severityRank[right.severity] - severityRank[left.severity];
      })
      .slice(0, 20);
  }

  private buildQualityDebt(input: {
    reviewGateResults: Array<{
      id: string;
      sourceType: string;
      pass: boolean;
      scoreJson: string;
      risksJson: string;
      requiredFixesJson: string;
      needsHumanConfirmation: boolean;
      recommendedAction: string;
      chapterId: string | null;
      chapter?: { id: string; order: number; title: string } | null;
      updatedAt: Date;
    }>;
    statePatches: Array<{
      id: string;
      targetType: string;
      patchType: string;
      status: string;
      riskLevel: string;
      patchJson: string;
      evidenceJson: string;
      chapterId: string | null;
      chapter?: { id: string; order: number; title: string } | null;
      updatedAt: Date;
    }>;
    deterministicChecks: StoryStateDeterministicCheck[];
    limit: number;
  }): StoryStateQualityDebt[] {
    const reviewGateDebt: StoryStateQualityDebt[] = input.reviewGateResults.map((gate) => {
      const risks = parseUnknownArray(gate.risksJson).map((item) => compactDebtText(item)).filter(Boolean);
      const fixes = parseUnknownArray(gate.requiredFixesJson).map((item) => compactDebtText(item)).filter(Boolean);
      const scores = parseJsonObject(gate.scoreJson);
      const lowScores = Object.entries(scores)
        .filter(([, value]) => typeof value === "number" && value < 70)
        .map(([key, value]) => `${key}=${value}`);
      const evidence = [...risks, ...fixes, ...lowScores].slice(0, 6);
      const severity: StoryStateQualityDebt["severity"] = gate.needsHumanConfirmation
        ? "blocking"
        : gate.recommendedAction === "stop_batch"
          ? "blocking"
          : gate.recommendedAction === "ask_user"
            ? "error"
            : "warning";
      return {
        id: `review_gate:${gate.id}`,
        source: "review_gate",
        severity,
        category: gate.sourceType,
        title: gate.needsHumanConfirmation ? "ReviewGate 需要人工确认" : "ReviewGate 未通过",
        summary: evidence[0] ?? `recommendedAction=${gate.recommendedAction}`,
        evidence,
        sourceId: gate.id,
        chapterId: gate.chapterId,
        chapterOrder: gate.chapter?.order ?? null,
        chapterTitle: gate.chapter?.title ?? null,
        recommendedAction: gate.recommendedAction,
        status: gate.pass ? "pass" : "failed",
        updatedAt: gate.updatedAt.toISOString(),
      };
    });

    const statePatchDebt: StoryStateQualityDebt[] = input.statePatches.map((patch) => {
      const evidenceRecord = parseJsonObject(patch.evidenceJson);
      const patchRecord = parseJsonObject(patch.patchJson);
      const evidence = [
        compactDebtText(evidenceRecord.reason),
        compactDebtText(evidenceRecord.summary),
        compactDebtText(patchRecord.after ?? patchRecord),
      ].filter(Boolean).slice(0, 5);
      const severity: StoryStateQualityDebt["severity"] = patch.riskLevel === "high" && ["proposed", "needs_confirmation"].includes(patch.status)
        ? "blocking"
        : patch.riskLevel === "high"
          ? "error"
          : patch.riskLevel === "medium"
            ? "warning"
            : "info";
      return {
        id: `state_patch:${patch.id}`,
        source: "state_patch",
        severity,
        category: patch.patchType,
        title: `${patch.riskLevel} 风险 StatePatch`,
        summary: `${patch.targetType} 状态变更处于 ${patch.status}`,
        evidence,
        sourceId: patch.id,
        chapterId: patch.chapterId,
        chapterOrder: patch.chapter?.order ?? null,
        chapterTitle: patch.chapter?.title ?? null,
        recommendedAction: ["proposed", "needs_confirmation"].includes(patch.status) ? "human_decision" : null,
        status: patch.status,
        updatedAt: patch.updatedAt.toISOString(),
      };
    });

    const deterministicDebt: StoryStateQualityDebt[] = input.deterministicChecks.flatMap((check) =>
      check.issues.map((issue) => ({
        id: `deterministic_check:${check.key}:${issue.id}`,
        source: "deterministic_check" as const,
        severity: issue.severity,
        category: check.key,
        title: issue.title,
        summary: issue.summary,
        evidence: issue.evidence.slice(0, 6),
        sourceId: check.key,
        chapterId: null,
        chapterOrder: null,
        chapterTitle: null,
        recommendedAction: issue.severity === "blocking" || issue.severity === "error" ? "review_before_generation" : "monitor",
        status: check.status,
        updatedAt: new Date().toISOString(),
      })),
    );

    const severityRank: Record<StoryStateQualityDebt["severity"], number> = {
      blocking: 4,
      error: 3,
      warning: 2,
      info: 1,
    };
    return [...reviewGateDebt, ...statePatchDebt, ...deterministicDebt]
      .sort((left, right) => {
        const severityDiff = severityRank[right.severity] - severityRank[left.severity];
        if (severityDiff !== 0) {
          return severityDiff;
        }
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      })
      .slice(0, input.limit);
  }

  private runDeterministicChecks(input: DeterministicCheckInput): StoryStateDeterministicCheck[] {
    const characterById = new Map(input.characters.map((character) => [character.id, character]));
    const checks: StoryStateDeterministicCheck[] = [];

    checks.push(makeCheck(
      "inactive_character_appearance",
      "死亡/离场角色再出现",
      input.characters.length > 0 && input.timelineEvents.length > 0 ? "partial" : "not_enough_data",
      this.checkInactiveCharacterAppearance(input, characterById),
    ));

    checks.push(makeCheck(
      "location_time_conflict",
      "同一时间地点冲突",
      input.timelineEvents.some((event) => event.storyDayIndex != null && event.storyTimeLabel && event.locationId)
        ? "partial"
        : "not_enough_data",
      this.checkLocationTimeConflict(input),
    ));

    checks.push(makeCheck(
      "overdue_hook",
      "伏笔/钩子逾期",
      input.currentChapterOrder != null && input.hooks.length > 0 ? "ready" : "not_enough_data",
      this.checkOverdueHooks(input),
    ));

    checks.push(makeCheck(
      "core_character_absence",
      "核心角色缺席",
      input.currentChapterOrder != null && input.coreAssignments.length > 0 ? "partial" : "not_enough_data",
      this.checkCoreCharacterAbsence(input),
    ));

    checks.push(makeCheck(
      "timeline_regression",
      "时间线倒退",
      input.reports.length > 0 || input.timelineEvents.some((event) => event.storyDayIndex != null)
        ? "ready"
        : "not_enough_data",
      this.checkTimelineRegression(input),
    ));

    checks.push(makeCheck(
      "resource_holder_conflict",
      "资源/道具持有人冲突",
      input.resourceItems.length > 0 ? "partial" : "not_enough_data",
      this.checkResourceHolderConflict(input, characterById),
    ));

    checks.push(makeCheck(
      "ability_setting_conflict",
      "能力/境界设定冲突",
      input.openConflicts.length > 0 ? "partial" : "not_enough_data",
      this.checkOpenConflictTerms(input, ["能力", "境界", "战力", "修为", "power", "realm", "ability", "cultivation"]),
    ));

    checks.push(makeCheck(
      "mainline_early_resolution",
      "主线/伏笔过早兑现",
      input.currentChapterOrder != null && input.payoffItems.length > 0 ? "partial" : "not_enough_data",
      this.checkEarlyPayoff(input),
    ));

    checks.push(makeCheck(
      "repeated_event",
      "重复事件",
      input.timelineEvents.length > 0 ? "partial" : "not_enough_data",
      this.checkRepeatedEvents(input),
    ));

    checks.push(makeCheck(
      "skill_rule_conflict",
      "Skill 规则冲突",
      input.projectSkills.length > 0 || input.styleSkillConflicts.length > 0 ? "ready" : "not_enough_data",
      this.checkSkillConflicts(input),
    ));

    return checks;
  }

  private checkInactiveCharacterAppearance(
    input: DeterministicCheckInput,
    characterById: Map<string, { id: string; name: string; availability: string | null; currentState: string | null }>,
  ): StoryStateDeterministicIssue[] {
    if (input.currentChapterOrder == null) {
      return [];
    }
    const inactiveIds = new Set(
      input.characters.filter(isInactiveCharacter).map((character) => character.id),
    );
    if (inactiveIds.size === 0) {
      return [];
    }
    const issues: StoryStateDeterministicIssue[] = [];
    for (const event of input.timelineEvents) {
      if (event.status !== "planned" || event.chapterIndex == null || event.chapterIndex < input.currentChapterOrder) {
        continue;
      }
      const hitIds = parseJsonArray(event.participantIdsJson).filter((id) => inactiveIds.has(id));
      if (hitIds.length === 0) {
        continue;
      }
      const names = hitIds.map((id) => characterById.get(id)?.name ?? id);
      issues.push(makeIssue({
        severity: "error",
        title: `不可用角色进入未来事件：${names.join(", ")}`,
        summary: `计划事件「${event.title}」包含当前状态不可用的角色。`,
        evidence: [
          `chapterIndex=${event.chapterIndex}`,
          `status=${event.status}`,
          `characters=${names.join(", ")}`,
        ],
        relatedIds: [event.id, ...hitIds],
      }));
    }
    return issues.slice(0, 12);
  }

  private checkLocationTimeConflict(
    input: DeterministicCheckInput,
  ): StoryStateDeterministicIssue[] {
    const groups = new Map<string, Array<{ eventId: string; title: string; locationId: string }>>();
    for (const event of input.timelineEvents) {
      if (event.storyDayIndex == null || !event.storyTimeLabel || !event.locationId) {
        continue;
      }
      const participantIds = parseJsonArray(event.participantIdsJson);
      for (const participantId of participantIds) {
        const key = `${participantId}:${event.storyDayIndex}:${event.storyTimeLabel}`;
        const rows = groups.get(key) ?? [];
        rows.push({ eventId: event.id, title: event.title, locationId: event.locationId });
        groups.set(key, rows);
      }
    }
    return Array.from(groups.entries()).flatMap(([key, rows]) => {
      const locations = uniqueStrings(rows.map((row) => row.locationId));
      if (locations.length <= 1) {
        return [];
      }
      return [makeIssue({
        severity: "error",
        title: "同一角色同一时间出现在多个地点",
        summary: `检测键 ${key} 下存在多个 locationId。`,
        evidence: rows.map((row) => `${row.title}: ${row.locationId}`),
        relatedIds: rows.map((row) => row.eventId),
      })];
    }).slice(0, 12);
  }

  private checkOverdueHooks(
    input: DeterministicCheckInput,
  ): StoryStateDeterministicIssue[] {
    if (input.currentChapterOrder == null) {
      return [];
    }
    return input.hooks
      .filter((hook) => hook.expectedResolveByChapterIndex != null)
      .filter((hook) => Number(hook.expectedResolveByChapterIndex) < Number(input.currentChapterOrder))
      .map((hook) => makeIssue({
        severity: hook.blocking || hook.priority === "critical" ? "blocking" : "warning",
        title: `伏笔逾期：${hook.title}`,
        summary: `预期第 ${hook.expectedResolveByChapterIndex} 章前解决，当前检查章为第 ${input.currentChapterOrder} 章。`,
        evidence: [`status=${hook.status}`, `priority=${hook.priority}`, `blocking=${hook.blocking}`],
        relatedIds: [hook.id, ...parseJsonArray(hook.participantIdsJson)],
      }))
      .slice(0, 20);
  }

  private checkCoreCharacterAbsence(
    input: DeterministicCheckInput,
  ): StoryStateDeterministicIssue[] {
    if (input.currentChapterOrder == null) {
      return [];
    }
    const latestByCharacter = new Map<string, { chapterOrder: number; title: string }>();
    for (const item of input.characterTimelines) {
      if (item.chapterOrder == null || latestByCharacter.has(item.characterId)) {
        continue;
      }
      latestByCharacter.set(item.characterId, { chapterOrder: item.chapterOrder, title: item.title });
    }
    return input.coreAssignments.flatMap((assignment) => {
      const latest = latestByCharacter.get(assignment.characterId);
      const lastChapterOrder = latest?.chapterOrder ?? 0;
      const absentChapters = input.currentChapterOrder == null ? 0 : input.currentChapterOrder - lastChapterOrder;
      if (absentChapters < assignment.absenceWarningThreshold) {
        return [];
      }
      return [makeIssue({
        severity: absentChapters >= assignment.absenceHighRiskThreshold ? "error" : "warning",
        title: `核心角色缺席：${assignment.character.name}`,
        summary: `核心角色已 ${absentChapters} 章没有可见时间线记录。`,
        evidence: [
          `responsibility=${assignment.responsibility}`,
          latest ? `last=${latest.chapterOrder} ${latest.title}` : "last=无时间线记录",
          `threshold=${assignment.absenceWarningThreshold}/${assignment.absenceHighRiskThreshold}`,
        ],
        relatedIds: [assignment.characterId],
      })];
    }).slice(0, 20);
  }

  private isExplicitFlashbackEvent(event: DeterministicCheckInput["timelineEvents"][number]): boolean {
    const text = `${event.type} ${event.title} ${event.summary} ${event.source}`;
    if (/(不是|非|无|没有)\s*(回忆|倒叙|追忆|flashback|memory|retrospective)/i.test(text)) {
      return false;
    }
    return includesAny(text, ["回忆", "倒叙", "追忆", "flashback", "memory", "retrospective"]);
  }

  private checkTimelineRegression(
    input: DeterministicCheckInput,
  ): StoryStateDeterministicIssue[] {
    const reportIssues = input.reports
      .filter((report) => report.status !== "passed")
      .map((report) => {
        const issues = parseUnknownArray(report.issuesJson);
        return makeIssue({
          severity: report.status === "failed" ? "error" : "warning",
          title: `时间线报告：第 ${report.chapterIndex} 章 ${report.status}`,
          summary: `该章节最近一次时间线报告包含 ${issues.length} 个问题。`,
          evidence: issues.slice(0, 3).map((issue) => JSON.stringify(issue)),
          relatedIds: [report.id],
        });
      })
      .slice(0, 12);

    const orderedEvents = input.timelineEvents
      .filter((event) => event.status !== "planned")
      .filter((event) => event.storyDayIndex != null && event.chapterIndex != null)
      .slice()
      .sort((left, right) => {
        const chapterDiff = Number(left.chapterIndex) - Number(right.chapterIndex);
        if (chapterDiff !== 0) {
          return chapterDiff;
        }
        return left.eventOrder - right.eventOrder;
      });
    const regressionIssues: StoryStateDeterministicIssue[] = [];
    let latest: DeterministicCheckInput["timelineEvents"][number] | null = null;
    for (const event of orderedEvents) {
      if (!latest) {
        latest = event;
        continue;
      }
      const eventDay = Number(event.storyDayIndex);
      const latestDay = Number(latest.storyDayIndex);
      if (eventDay < latestDay && !this.isExplicitFlashbackEvent(event)) {
        regressionIssues.push(makeIssue({
          severity: "warning",
          title: `时间线倒退：${event.title}`,
          summary: `第 ${event.chapterIndex} 章事件的 storyDayIndex=${eventDay}，早于前序事件「${latest.title}」的 storyDayIndex=${latestDay}。`,
          evidence: [
            `previous=chapter ${latest.chapterIndex}, eventOrder ${latest.eventOrder}, storyDayIndex ${latestDay}, title=${latest.title}`,
            `current=chapter ${event.chapterIndex}, eventOrder ${event.eventOrder}, storyDayIndex ${eventDay}, title=${event.title}`,
            `currentType=${event.type}`,
          ],
          relatedIds: [latest.id, event.id],
        }));
      }
      if (eventDay >= latestDay || this.isExplicitFlashbackEvent(latest)) {
        latest = event;
      }
    }
    return [...reportIssues, ...regressionIssues].slice(0, 20);
  }

  private checkResourceHolderConflict(
    input: DeterministicCheckInput,
    characterById: Map<string, { id: string; name: string; availability: string | null; currentState: string | null }>,
  ): StoryStateDeterministicIssue[] {
    const latestEventByResource = new Map<string, { id: string; toHolderCharacterId: string | null; chapterOrder: number | null }>();
    for (const event of input.resourceEvents) {
      if (!latestEventByResource.has(event.resourceId)) {
        latestEventByResource.set(event.resourceId, event);
      }
    }
    const issues: StoryStateDeterministicIssue[] = [];
    for (const item of input.resourceItems) {
      const latestEvent = latestEventByResource.get(item.id);
      if (latestEvent?.toHolderCharacterId && latestEvent.toHolderCharacterId !== item.holderCharacterId) {
        issues.push(makeIssue({
          severity: "warning",
          title: `资源持有人未同步：${item.name}`,
          summary: "最新资源事件的接收者与资源账本当前持有人不一致。",
          evidence: [
            `ledgerHolder=${item.holderCharacterName ?? item.holderCharacterId ?? "无"}`,
            `eventToHolder=${latestEvent.toHolderCharacterId}`,
            `eventChapter=${latestEvent.chapterOrder ?? "未知"}`,
          ],
          relatedIds: [item.id, latestEvent.id, latestEvent.toHolderCharacterId],
        }));
      }
      const holder = item.holderCharacterId ? characterById.get(item.holderCharacterId) : null;
      if (holder && isInactiveCharacter(holder)) {
        issues.push(makeIssue({
          severity: "warning",
          title: `资源由不可用角色持有：${item.name}`,
          summary: `当前持有人 ${holder.name} 的状态或可用性为不可用。`,
          evidence: [`holder=${holder.name}`, `state=${holder.currentState ?? "无"}`, `availability=${holder.availability ?? "无"}`],
          relatedIds: [item.id, holder.id],
        }));
      }
    }
    return issues.slice(0, 20);
  }

  private checkOpenConflictTerms(
    input: DeterministicCheckInput,
    terms: string[],
  ): StoryStateDeterministicIssue[] {
    return input.openConflicts
      .filter((conflict) => includesAny(
        `${conflict.conflictType} ${conflict.conflictKey} ${conflict.title} ${conflict.summary}`,
        terms,
      ))
      .map((conflict) => makeIssue({
        severity: conflict.severity === "high" || conflict.severity === "blocking" ? "error" : "warning",
        title: conflict.title,
        summary: conflict.summary,
        evidence: [`type=${conflict.conflictType}`, `key=${conflict.conflictKey}`, `severity=${conflict.severity}`],
        relatedIds: [conflict.id],
      }))
      .slice(0, 20);
  }

  private checkEarlyPayoff(
    input: DeterministicCheckInput,
  ): StoryStateDeterministicIssue[] {
    if (input.currentChapterOrder == null) {
      return [];
    }
    const currentChapterOrder = input.currentChapterOrder;
    return input.payoffItems
      .filter((item) => item.currentStatus === "paid_off")
      .filter((item) => {
        if (item.targetStartChapterOrder == null) {
          return false;
        }
        const touched = item.lastTouchedChapterOrder ?? currentChapterOrder;
        return touched < item.targetStartChapterOrder;
      })
      .map((item) => makeIssue({
        severity: "warning",
        title: `过早兑现：${item.title}`,
        summary: "伏笔账本显示已兑现，但最后触达章节早于预期兑现窗口。",
        evidence: [
          `lastTouched=${item.lastTouchedChapterOrder ?? "未知"}`,
          `targetStart=${item.targetStartChapterOrder}`,
          `targetEnd=${item.targetEndChapterOrder ?? "未知"}`,
        ],
        relatedIds: [item.id],
      }))
      .slice(0, 20);
  }

  private checkRepeatedEvents(
    input: DeterministicCheckInput,
  ): StoryStateDeterministicIssue[] {
    const groups = new Map<string, Array<{ id: string; title: string; chapterIndex: number | null }>>();
    for (const event of input.timelineEvents) {
      const key = event.eventKey?.trim();
      if (!key) {
        continue;
      }
      const rows = groups.get(key) ?? [];
      rows.push({ id: event.id, title: event.title, chapterIndex: event.chapterIndex });
      groups.set(key, rows);
    }
    return Array.from(groups.entries()).flatMap(([eventKey, rows]) => {
      if (rows.length <= 1) {
        return [];
      }
      return [makeIssue({
        severity: "warning",
        title: `重复事件键：${eventKey}`,
        summary: "同一 eventKey 对应多个未取消事件，需要确认是否为重复推进。",
        evidence: rows.map((row) => `chapter=${row.chapterIndex ?? "未知"} ${row.title}`),
        relatedIds: rows.map((row) => row.id),
      })];
    }).slice(0, 20);
  }

  private checkSkillConflicts(
    input: DeterministicCheckInput,
  ): StoryStateDeterministicIssue[] {
    const projectSkillIssues = input.projectSkills
      .filter((item) => item.enabled)
      .filter((item) => !OK_SKILL_CONFLICT_STATUSES.has(item.conflictStatus))
      .map((item) => makeIssue({
        severity: item.conflictStatus === "blocked" ? "error" : "warning",
        title: `Skill 冲突：${item.skill?.name ?? item.skillId}`,
        summary: `项目 Skill 冲突状态为 ${item.conflictStatus}。`,
        evidence: parseUnknownArray(item.conflictJson).slice(0, 3).map((entry) => JSON.stringify(entry)),
        relatedIds: [item.id, item.skill?.slug ?? item.skillId],
      }));
    const styleSkillIssues = input.styleSkillConflicts.map((item) => makeIssue({
      severity: item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "info",
      title: `Skill × StyleProfile：${item.skillName} / ${item.styleProfileName}`,
      summary: item.recommendedAction,
      evidence: item.evidence,
      relatedIds: [item.skillId, item.styleProfileId],
    }));
    return [...projectSkillIssues, ...styleSkillIssues].slice(0, 20);
  }
}

export const storyStateRuntimeService = new StoryStateRuntimeService();
