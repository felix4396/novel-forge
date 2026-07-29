import type { AuditReport, QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import type { GenerationContextPackage, RuntimeActiveSkill } from "@ai-novel/shared/types/chapterRuntime";
import { prisma } from "../../db/prisma";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import {
  chapterReviewPrompt,
} from "../../prompting/prompts/novel/review.prompts";
import { ragServices } from "../rag";
import { auditService } from "../audit/AuditService";
import { payoffLedgerSyncService } from "../payoff/PayoffLedgerSyncService";
import { plannerService } from "../planner/PlannerService";
import { stateService } from "../state/StateService";
import {
  isPass,
  LLMGenerateOptions,
  logPipelineError,
  normalizeScore,
  RepairOptions,
  ReviewOptions,
  ruleScore,
} from "./novelCoreShared";
import { GenerationContextAssembler } from "./runtime/GenerationContextAssembler";
import { chapterQualityLoopService } from "./quality/ChapterQualityLoopService";
import {
  chapterStatePairAfterManualQualityReview,
  chapterStatePairAfterPipelineApproval,
  type ChapterStatePairPatch,
} from "./chapterLifecycleState";
import { directorAutomationLedgerEventService } from "./director/runtime/DirectorAutomationLedgerEventService";
import { ChapterRuntimeCoordinator } from "./runtime/ChapterRuntimeCoordinator";
import {
  ChapterContextAssemblyError,
  type AuditContextOperation,
  assembleChapterAuditContextPackage,
} from "./runtime/repair/chapterAuditContext";
import type { ReviewGateScore } from "@ai-novel/shared/types/aiWorkbench";
import { aiWorkbenchService } from "../aiWorkbench/AiWorkbenchService";
import { skillRuntimeContextService } from "../aiWorkbench/SkillRuntimeContextService";

export interface CreateQualityReportOptions {
  sourceType?: string;
  contentLength?: number;
  auditReports?: AuditReport[];
  chapterStatePatch?: ChapterStatePairPatch;
  batchJobId?: string | null;
  agentRunId?: string | null;
}

function shouldUsePipelineApprovedStatePatch(sourceType: string | undefined, score: QualityScore): boolean {
  if (!isPass(score)) {
    return false;
  }
  const normalized = sourceType?.trim() ?? "";
  return normalized === "pipeline_review"
    || normalized === "repair_recheck"
    || normalized.endsWith("_pipeline_review")
    || normalized.endsWith("_repair_recheck");
}

export async function createQualityReport(
  novelId: string,
  chapterId: string,
  score: QualityScore,
  issues: ReviewIssue[],
  options: CreateQualityReportOptions = {},
) {
  await prisma.qualityReport.create({
    data: {
      novelId,
      chapterId,
      coherence: score.coherence,
      repetition: score.repetition,
      pacing: score.pacing,
      voice: score.voice,
      engagement: score.engagement,
      overall: score.overall,
      issues: issues.length > 0 ? JSON.stringify(issues) : null,
    },
  });
  const chapter = await prisma.chapter.findFirst({
    where: { id: chapterId, novelId },
    select: { id: true, order: true, content: true },
  });
  if (!chapter) {
    return;
  }
  const chapterStatePatch = options.chapterStatePatch
    ?? (shouldUsePipelineApprovedStatePatch(options.sourceType, score)
      ? chapterStatePairAfterPipelineApproval()
      : chapterStatePairAfterManualQualityReview(isPass(score)));
  await recordChapterReviewGate({
    novelId,
    chapterId,
    chapterOrder: chapter.order,
    sourceType: options.sourceType ?? "quality_report",
    content: chapter.content,
    contentLength: options.contentLength ?? (chapter.content ?? "").length,
    score,
    issues,
    auditReports: options.auditReports,
    chapterStatePatch,
    batchJobId: options.batchJobId ?? null,
    agentRunId: options.agentRunId ?? null,
  }).catch((error) => {
    logPipelineError("Failed to record chapter ReviewGate result.", {
      novelId,
      chapterId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

type ReviewGateRiskLevel = "low" | "medium" | "high";

const REVIEW_SEVERITY_RANK: Record<ReviewIssue["severity"], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DETERMINISTIC_HIGH_RISK_PATTERNS: Array<{
  category: string;
  pattern: RegExp;
  fixSuggestion: string;
}> = [
  {
    category: "character_death",
    pattern: /(主角|男主|女主|核心角色|重要角色|队友|父亲|母亲|师父|导师|搭档|警官|记者|嫌疑人|凶手|反派)?.{0,12}(死亡|死了|死去|牺牲|阵亡|被杀|杀死|咽气|断气|尸体|遗体)/,
    fixSuggestion: "暂停批量推进，确认该角色死亡是否符合长期大纲和当前 StoryState。",
  },
  {
    category: "core_setting_change",
    pattern: /(核心设定|世界规则|能力规则|科技规则|修炼体系|境界体系|副本规则|案件真相|旧案真相|时间线).{0,16}(改变|改写|推翻|重置|失效|不再成立|彻底改变|完全不同)/,
    fixSuggestion: "暂停批量推进，确认重大设定变化是否允许写入主事实源。",
  },
  {
    category: "major_identity_or_truth_reveal",
    pattern: /(凶手|真凶|幕后黑手|隐藏身份|真实身份|血缘真相|家庭真相|旧案真相).{0,16}(揭晓|暴露|公开|确认|原来是|就是)/,
    fixSuggestion: "暂停批量推进，确认真相/身份揭示是否过早或是否破坏后续悬念。",
  },
  {
    category: "major_resource_or_base_loss",
    pattern: /(基地|宗门|组织|公司|队伍|法宝|神器|关键证据|录音笔|档案|核心线索).{0,16}(毁灭|被毁|丢失|消失|失窃|崩溃|解散|失效)/,
    fixSuggestion: "暂停批量推进，确认关键资源或组织状态变化是否符合长期规划。",
  },
];

type ReviewGateRiskItem = {
  source: string;
  severity: string;
  category?: string;
  evidence: string;
  fixSuggestion?: string;
  [key: string]: unknown;
};

function severityRank(severity: unknown): number {
  if (severity === "blocking") {
    return 4;
  }
  return REVIEW_SEVERITY_RANK[severity as ReviewIssue["severity"]] ?? 0;
}

type SkillReviewGateCheckStatus = "checked" | "warning" | "blocking";

type SkillReviewGateCheckResult = {
  skillId: string;
  skillVersionId: string | null;
  slug: string;
  name: string;
  check: string;
  status: SkillReviewGateCheckStatus;
  matchedSignalCount: number;
  highestSeverity: ReviewIssue["severity"] | null;
  evidence: string[];
};

function normalizeReviewGateRisk(input: {
  pass: boolean;
  risks: ReviewGateRiskItem[];
}): ReviewGateRiskLevel {
  const maxSeverity = input.risks.reduce(
    (max, risk) => Math.max(max, severityRank(risk.severity)),
    0,
  );
  if (!input.pass || maxSeverity >= REVIEW_SEVERITY_RANK.high) {
    return "high";
  }
  if (maxSeverity >= REVIEW_SEVERITY_RANK.medium) {
    return "medium";
  }
  return "low";
}

function clampReviewGateScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function maxRiskPenalty(risks: ReviewGateRiskItem[], matcher: (risk: ReviewGateRiskItem) => boolean): number {
  return risks
    .filter(matcher)
    .reduce((penalty, risk) => {
      const rank = severityRank(risk.severity);
      if (rank >= 4) return Math.max(penalty, 45);
      if (rank >= 3) return Math.max(penalty, 30);
      if (rank >= 2) return Math.max(penalty, 15);
      if (rank >= 1) return Math.max(penalty, 5);
      return penalty;
    }, 0);
}

function buildReviewGateScore(input: {
  qualityScore: QualityScore;
  risks: ReviewGateRiskItem[];
  requiredFixCount: number;
  riskLevel: ReviewGateRiskLevel;
}): ReviewGateScore {
  const signal = (risk: ReviewGateRiskItem) => [
    risk.source,
    risk.category,
    risk.auditType,
    risk.code,
    risk.evidence,
    risk.fixSuggestion,
  ].filter(Boolean).join(" ").toLowerCase();
  const continuityPenalty = maxRiskPenalty(input.risks, (risk) => {
    const text = signal(risk);
    return text.includes("continuity")
      || text.includes("一致")
      || text.includes("逻辑")
      || text.includes("timeline")
      || text.includes("状态");
  });
  const stylePenalty = maxRiskPenalty(input.risks, (risk) => {
    const text = signal(risk);
    return text.includes("style")
      || text.includes("voice")
      || text.includes("ai")
      || text.includes("风格")
      || text.includes("ai 腔");
  });
  const taskPenalty = maxRiskPenalty(input.risks, (risk) => {
    const text = signal(risk);
    return text.includes("task")
      || text.includes("mode_fit")
      || text.includes("plot")
      || text.includes("目标")
      || text.includes("任务");
  });
  const statePatchSafetyBase = input.riskLevel === "low" ? 95 : input.riskLevel === "medium" ? 75 : 40;
  return {
    taskFit: clampReviewGateScore(((input.qualityScore.engagement + input.qualityScore.pacing) / 2) - taskPenalty),
    continuity: clampReviewGateScore(input.qualityScore.coherence - continuityPenalty),
    style: clampReviewGateScore(input.qualityScore.voice - stylePenalty),
    readability: clampReviewGateScore((input.qualityScore.pacing + input.qualityScore.repetition + input.qualityScore.voice) / 3),
    statePatchSafety: clampReviewGateScore(statePatchSafetyBase - Math.min(input.requiredFixCount * 5, 25)),
    legacyQualityScore: {
      coherence: input.qualityScore.coherence,
      repetition: input.qualityScore.repetition,
      pacing: input.qualityScore.pacing,
      voice: input.qualityScore.voice,
      engagement: input.qualityScore.engagement,
      overall: input.qualityScore.overall,
    },
  };
}

function buildReviewGateRisks(reviewIssues: ReviewIssue[], auditReports?: AuditReport[]): ReviewGateRiskItem[] {
  return [
    ...reviewIssues.map((issue) => ({
      source: "quality_review",
      severity: issue.severity,
      category: issue.category,
      evidence: issue.evidence,
      fixSuggestion: issue.fixSuggestion,
    })),
    ...(auditReports ?? []).flatMap((report) => (report.issues ?? []).map((issue) => ({
      source: "audit",
      reportId: report.id,
      auditType: report.auditType,
      severity: issue.severity,
      code: issue.code,
      evidence: issue.evidence,
      fixSuggestion: issue.fixSuggestion,
    }))),
  ];
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function collectReviewSignalText(reviewIssues: ReviewIssue[], auditReports?: AuditReport[]): string {
  return normalizeForMatch([
    ...reviewIssues.flatMap((issue) => [
      issue.category,
      issue.evidence,
      issue.fixSuggestion,
    ]),
    ...(auditReports ?? []).flatMap((report) => [
      report.auditType,
      ...(report.issues ?? []).flatMap((issue) => [
        issue.code,
        issue.evidence,
        issue.fixSuggestion,
      ]),
    ]),
  ].filter(Boolean).join("\n"));
}

function collectSkillCheckSignals(input: {
  check: string;
  reviewIssues: ReviewIssue[];
  auditReports?: AuditReport[];
}): Array<{
  source: "review_issue" | "audit_issue";
  severity: ReviewIssue["severity"];
  evidence: string;
}> {
  const normalizedCheck = normalizeForMatch(input.check);
  if (!normalizedCheck) {
    return [];
  }
  const reviewMatches = input.reviewIssues.flatMap((issue) => {
    const text = normalizeForMatch([
      issue.category,
      issue.evidence,
      issue.fixSuggestion,
    ].filter(Boolean).join("\n"));
    return text.includes(normalizedCheck)
      ? [{
        source: "review_issue" as const,
        severity: issue.severity,
        evidence: [issue.category, issue.evidence, issue.fixSuggestion].filter(Boolean).join(" / ").slice(0, 260),
      }]
      : [];
  });
  const auditMatches = (input.auditReports ?? []).flatMap((report) => (
    report.issues.flatMap((issue) => {
      const text = normalizeForMatch([
        report.auditType,
        issue.code,
        issue.evidence,
        issue.fixSuggestion,
      ].filter(Boolean).join("\n"));
      return text.includes(normalizedCheck)
        ? [{
          source: "audit_issue" as const,
          severity: issue.severity,
          evidence: [report.auditType, issue.code, issue.evidence, issue.fixSuggestion].filter(Boolean).join(" / ").slice(0, 260),
        }]
        : [];
    })
  ));
  return [...reviewMatches, ...auditMatches].slice(0, 6);
}

function buildSkillReviewGateCheckResults(input: {
  activeSkills: RuntimeActiveSkill[];
  reviewIssues: ReviewIssue[];
  auditReports?: AuditReport[];
}): SkillReviewGateCheckResult[] {
  return input.activeSkills.flatMap((skill) => (
    skill.reviewGateChecks.map((check) => {
      const signals = collectSkillCheckSignals({
        check,
        reviewIssues: input.reviewIssues,
        auditReports: input.auditReports,
      });
      const highest = signals.reduce<ReviewIssue["severity"] | null>((current, signal) => (
        severityRank(signal.severity) > severityRank(current) ? signal.severity : current
      ), null);
      return {
        skillId: skill.skillId,
        skillVersionId: skill.skillVersionId ?? null,
        slug: skill.slug,
        name: skill.name,
        check,
        status: highest && severityRank(highest) >= severityRank("high")
          ? "blocking"
          : highest
            ? "warning"
            : "checked",
        matchedSignalCount: signals.length,
        highestSeverity: highest,
        evidence: signals.map((signal) => `${signal.source}:${signal.severity}:${signal.evidence}`),
      };
    })
  ));
}

function buildDeterministicRiskGateSignals(input: {
  content?: string | null;
  reviewIssues: ReviewIssue[];
  auditReports?: AuditReport[];
}): ReviewGateRiskItem[] {
  const content = input.content ?? "";
  const reviewSignals = collectReviewSignalText(input.reviewIssues, input.auditReports);
  const searchText = `${content}\n${reviewSignals}`;
  const seenCategories = new Set<string>();
  return DETERMINISTIC_HIGH_RISK_PATTERNS.flatMap((item) => {
    if (seenCategories.has(item.category) || !item.pattern.test(searchText)) {
      return [];
    }
    seenCategories.add(item.category);
    const evidence = content.match(item.pattern)?.[0]
      ?? reviewSignals.match(item.pattern)?.[0]
      ?? item.category;
    return [{
      source: "deterministic_risk_gate",
      severity: "high",
      category: item.category,
      evidence: evidence.slice(0, 180),
      fixSuggestion: item.fixSuggestion,
    }];
  });
}

function buildSkillReviewGateSignals(input: {
  activeSkills: RuntimeActiveSkill[];
  reviewIssues: ReviewIssue[];
  auditReports?: AuditReport[];
}): {
  risks: ReviewGateRiskItem[];
  evidence: Record<string, unknown>;
} {
  const signalText = collectReviewSignalText(input.reviewIssues, input.auditReports);
  const activeSkillChecks = input.activeSkills.flatMap((skill) => (
    skill.reviewGateChecks.map((check) => ({
      skillId: skill.skillId,
      slug: skill.slug,
      name: skill.name,
      check,
    }))
  ));
  const activeSkillRiskTriggers = input.activeSkills.flatMap((skill) => (
    skill.riskTriggers.map((trigger) => ({
      skillId: skill.skillId,
      slug: skill.slug,
      name: skill.name,
      trigger,
    }))
  ));
  const triggerMatches = activeSkillRiskTriggers.filter((item) => {
    const normalizedTrigger = normalizeForMatch(item.trigger);
    return Boolean(normalizedTrigger) && signalText.includes(normalizedTrigger);
  });
  const conflictWarnings = input.activeSkills.filter((skill) => (
    skill.conflictStatus !== "ok" && skill.conflictStatus !== "disabled"
  ));
  const executedChecks = buildSkillReviewGateCheckResults(input);
  const failedCheckRisks: ReviewGateRiskItem[] = executedChecks
    .filter((item) => item.status !== "checked")
    .map((item) => ({
      source: "skill_review_gate_check",
      severity: item.status === "blocking" ? "high" : "medium",
      category: item.slug,
      check: item.check,
      evidence: `Active Skill ${item.name} ReviewGate check ${item.check} matched ${item.matchedSignalCount} review/audit signal(s). ${item.evidence.slice(0, 2).join(" | ")}`,
      fixSuggestion: "按该 Skill 的门禁规则修订章节，或人工确认本次生成允许偏离该 Skill。",
    }));

  return {
    risks: [
      ...conflictWarnings.map((skill) => ({
        source: "skill_conflict",
        severity: "medium",
        category: skill.slug,
        evidence: `Active Skill ${skill.name} has conflictStatus=${skill.conflictStatus}. ${skill.conflictJson}`,
        fixSuggestion: "确认项目启用的 Skills 是否应同时生效，必要时禁用冲突 Skill 或调整优先级。",
      })),
      ...triggerMatches.map((item) => ({
        source: "skill_risk_trigger",
        severity: "high",
        category: item.slug,
        evidence: `Active Skill ${item.name} risk trigger matched review/audit signal: ${item.trigger}`,
        fixSuggestion: "暂停批量推进，人工确认该风险是否允许写入 StoryState。",
      })),
      ...failedCheckRisks,
    ],
    evidence: {
      activeSkillCount: input.activeSkills.length,
      activeSkills: input.activeSkills.map((skill) => ({
        skillId: skill.skillId,
        skillVersionId: skill.skillVersionId,
        slug: skill.slug,
        name: skill.name,
        category: skill.category,
        priority: skill.priority,
        conflictStatus: skill.conflictStatus,
        stateRequirements: skill.stateRequirements,
        reviewGateChecks: skill.reviewGateChecks,
        riskTriggers: skill.riskTriggers,
      })),
      activeSkillChecks,
      executedChecks,
      activeSkillRiskTriggers,
      triggerMatches,
      conflictWarnings: conflictWarnings.map((skill) => ({
        skillId: skill.skillId,
        slug: skill.slug,
        name: skill.name,
        conflictStatus: skill.conflictStatus,
        conflictJson: skill.conflictJson,
      })),
    },
  };
}

async function recordChapterReviewGate(input: {
  novelId: string;
  chapterId: string;
  chapterOrder: number;
  sourceType: string;
  content?: string | null;
  contentLength: number;
  score: QualityScore;
  issues: ReviewIssue[];
  auditReports?: AuditReport[];
  chapterStatePatch: ChapterStatePairPatch;
  batchJobId?: string | null;
  agentRunId?: string | null;
}) {
  const qualityPass = isPass(input.score);
  const activeSkills = await skillRuntimeContextService.getActiveSkills(input.novelId).catch(() => []);
  const skillSignals = buildSkillReviewGateSignals({
    activeSkills,
    reviewIssues: input.issues,
    auditReports: input.auditReports,
  });
  const risks = [
    ...buildReviewGateRisks(input.issues, input.auditReports),
    ...buildDeterministicRiskGateSignals({
      content: input.content,
      reviewIssues: input.issues,
      auditReports: input.auditReports,
    }),
    ...skillSignals.risks,
  ];
  const requiredFixes = risks
    .filter((risk) => risk.severity === "high" || risk.severity === "critical" || risk.severity === "blocking")
    .map((risk) => ({
      source: risk.source,
      severity: risk.severity,
      evidence: risk.evidence,
      fixSuggestion: risk.fixSuggestion,
    }));
  const riskLevel = normalizeReviewGateRisk({
    pass: qualityPass,
    risks,
  });
  const reviewGateScore = buildReviewGateScore({
    qualityScore: input.score,
    risks,
    requiredFixCount: requiredFixes.length,
    riskLevel,
  });
  const needsHumanConfirmation = riskLevel === "high" || requiredFixes.length > 0;
  const gatePass = qualityPass && !needsHumanConfirmation && requiredFixes.length === 0;
  const statePatchStatus = needsHumanConfirmation ? "needs_confirmation" : "auto_accepted";
  const statePatch = {
    targetType: "chapter",
    targetId: input.chapterId,
    patchType: "chapter_review_lifecycle",
    patch: input.chapterStatePatch,
    riskLevel,
    status: statePatchStatus,
  };
  const activeSkillsJson = JSON.stringify(activeSkills);
  const gate = await aiWorkbenchService.createReviewGateResult({
    novelId: input.novelId,
    chapterId: input.chapterId,
    agentRunId: input.agentRunId ?? null,
    batchJobId: input.batchJobId ?? null,
    sourceType: input.sourceType,
    pass: gatePass,
    scoreJson: JSON.stringify(reviewGateScore),
    risksJson: JSON.stringify(risks),
    requiredFixesJson: JSON.stringify(requiredFixes),
    statePatchesJson: JSON.stringify([statePatch]),
    evidenceJson: JSON.stringify({
      chapterOrder: input.chapterOrder,
      contentLength: input.contentLength,
      auditReportIds: (input.auditReports ?? []).map((report) => report.id),
      auditReportCount: input.auditReports?.length ?? 0,
      sourceType: input.sourceType,
      qualityPass,
      gatePass,
      skillReviewGate: skillSignals.evidence,
    }),
    activeSkillsJson,
    needsHumanConfirmation,
    recommendedAction: needsHumanConfirmation ? "ask_user" : gatePass ? "accept" : "revise",
  });
  await aiWorkbenchService.createStatePatch({
    novelId: input.novelId,
    chapterId: input.chapterId,
    agentRunId: input.agentRunId ?? null,
    batchJobId: input.batchJobId ?? null,
    reviewGateResultId: gate.id,
    targetType: "chapter",
    targetId: input.chapterId,
    patchType: "chapter_review_lifecycle",
    status: statePatchStatus,
    riskLevel,
    patchJson: JSON.stringify(input.chapterStatePatch),
    evidenceJson: JSON.stringify({
      reviewGateResultId: gate.id,
      pass: gatePass,
      qualityPass,
      score: input.score,
      sourceType: input.sourceType,
    }),
    decisionNote: needsHumanConfirmation
      ? "ReviewGate requires human confirmation before this high-risk lifecycle patch is applied."
      : "ReviewGate auto-accepted this low-risk lifecycle patch.",
  });
}

export class NovelCoreReviewService {
  private readonly generationContextAssembler = new GenerationContextAssembler();
  private readonly chapterRuntimeCoordinator = new ChapterRuntimeCoordinator({
    reviewChapterAfterRepair: (novelId, chapterId, options) => this.reviewChapter(novelId, chapterId, options),
    resolveAuditIssues: (novelId, issueIds) => this.resolveAuditIssues(novelId, issueIds),
  });

  async reviewChapter(novelId: string, chapterId: string, options: ReviewOptions = {}) {
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      include: { novel: true },
    });
    if (!chapter) {
      throw new Error("章节不存在");
    }

    const review = await this.reviewChapterWithAudit(
      chapter.novel.title,
      chapter.title,
      options.content ?? chapter.content ?? "",
      options,
      novelId,
      chapterId,
    );

    const chapterStatePatch = chapterStatePairAfterManualQualityReview(isPass(review.score));
    await prisma.chapter.update({
      where: { id: chapterId },
      data: chapterStatePatch,
    });
    await createQualityReport(novelId, chapterId, review.score, review.issues, {
      sourceType: options.content ? "repair_recheck" : "manual_review",
      contentLength: (options.content ?? chapter.content ?? "").length,
      auditReports: review.auditReports,
      chapterStatePatch,
    });
    await chapterQualityLoopService.recordAssessment({
      novelId,
      chapterId,
      chapterOrder: chapter.order,
      score: review.score,
      issues: review.issues,
      source: options.content ? "repair_recheck" : "manual_review",
    }).catch((error) => {
      logPipelineError("Failed to record chapter quality loop assessment.", {
        novelId,
        chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const replanRecommendation = plannerService.buildReplanRecommendation({
      auditReports: review.auditReports ?? [],
      ledgerSummary: review.contextPackage?.ledgerSummary ?? null,
      contextPackage: review.contextPackage ?? null,
    });
    if (
      (review.auditReports?.length ?? 0) > 0
      && replanRecommendation.recommended
      && replanRecommendation.action === "stop_for_replan"
    ) {
      await plannerService.replan(novelId, {
        chapterId,
        triggerType: "audit_failure",
        reason: replanRecommendation.triggerReason || replanRecommendation.reason,
        sourceIssueIds: replanRecommendation.blockingIssueIds,
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
      }).catch(() => null);
    }

    return review;
  }

  async createRepairStream(novelId: string, chapterId: string, options: RepairOptions = {}) {
    return this.chapterRuntimeCoordinator.createRepairStream(novelId, chapterId, options);
  }

  async getNovelState(novelId: string) {
    return stateService.getNovelState(novelId);
  }

  async getLatestStateSnapshot(novelId: string) {
    return stateService.getLatestSnapshot(novelId);
  }

  async getChapterStateSnapshot(novelId: string, chapterId: string) {
    return stateService.getChapterSnapshot(novelId, chapterId);
  }

  async rebuildNovelState(novelId: string, options: LLMGenerateOptions = {}) {
    return stateService.rebuildState(novelId, options);
  }

  async generateBookPlan(novelId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateBookPlan(novelId, options);
  }

  async generateArcPlan(novelId: string, arcId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateArcPlan(novelId, arcId, options);
  }

  async generateChapterPlan(novelId: string, chapterId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateChapterPlan(novelId, chapterId, options);
  }

  async getChapterPlan(novelId: string, chapterId: string) {
    return plannerService.getChapterPlan(novelId, chapterId);
  }

  async replanNovel(
    novelId: string,
    input: {
      chapterId?: string;
      triggerType?: string;
      sourceIssueIds?: string[];
      windowSize?: number;
      reason: string;
    } & LLMGenerateOptions,
  ) {
    const result = await plannerService.replan(novelId, input);
    if (result.run) {
      await directorAutomationLedgerEventService.recordReplanRunCreated({
        novelId,
        replanRunId: result.run.id,
        affectedChapterIds: result.affectedChapterIds,
        affectedChapterOrders: result.affectedChapterOrders,
        generatedPlanIds: result.generatedPlans.map((plan) => plan.id),
        blockingLedgerKeys: result.blockingLedgerKeys ?? [],
        triggerReason: result.triggerReason || result.reason,
      }).catch(() => null);
    }
    return result;
  }

  async auditChapter(
    novelId: string,
    chapterId: string,
    scope: "full" | "continuity" | "character" | "plot" | "mode_fit",
    options: ReviewOptions = {},
  ) {
    const contextPackage = await this.assembleAuditContextPackage(novelId, chapterId, options, "audit");
    return auditService.auditChapter(novelId, chapterId, scope, {
      ...options,
      contextPackage,
    });
  }

  async listChapterAuditReports(novelId: string, chapterId: string) {
    return auditService.listChapterAuditReports(novelId, chapterId);
  }

  async resolveAuditIssues(novelId: string, issueIds: string[]) {
    return auditService.resolveIssues(novelId, issueIds);
  }

  async getQualityReport(novelId: string) {
    const reports = await prisma.qualityReport.findMany({
      where: { novelId },
      orderBy: { createdAt: "desc" },
    });
    if (reports.length === 0) {
      return { novelId, summary: normalizeScore({}), chapterReports: [] };
    }

    const latestByChapter = new Map<string, (typeof reports)[number]>();
    for (const report of reports) {
      if (report.chapterId && !latestByChapter.has(report.chapterId)) {
        latestByChapter.set(report.chapterId, report);
      }
    }
    const chapterReports = Array.from(latestByChapter.values());
    const source = chapterReports.length > 0 ? chapterReports : reports;
    const total = source.length;

    const summary = normalizeScore({
      coherence: source.reduce((sum, item) => sum + item.coherence, 0) / total,
      repetition: source.reduce((sum, item) => sum + item.repetition, 0) / total,
      pacing: source.reduce((sum, item) => sum + item.pacing, 0) / total,
      voice: source.reduce((sum, item) => sum + item.voice, 0) / total,
      engagement: source.reduce((sum, item) => sum + item.engagement, 0) / total,
      overall: source.reduce((sum, item) => sum + item.overall, 0) / total,
    });

    return { novelId, summary, chapterReports: source, totalReports: reports.length };
  }

  async getPayoffLedger(novelId: string, chapterOrder?: number) {
    return payoffLedgerSyncService.getPayoffLedger(novelId, { chapterOrder });
  }

  private async reviewChapterContent(
    novelTitle: string,
    chapterTitle: string,
    content: string,
    options: ReviewOptions = {},
    novelId?: string,
  ): Promise<{ score: QualityScore; issues: ReviewIssue[] }> {
    if (!content.trim()) {
      return {
        score: normalizeScore({}),
        issues: [{
          severity: "critical",
          category: "coherence",
          evidence: "章节内容为空",
          fixSuggestion: "先生成或补充正文，再进行审校",
        }],
      };
    }

    try {
      let ragContext = "";
      if (novelId) {
        try {
          ragContext = await ragServices.hybridRetrievalService.buildContextBlock(
            `章节审校 ${novelTitle}\n${chapterTitle}\n${content.slice(0, 1500)}`,
            {
              novelId,
              ownerTypes: ["novel", "chapter", "chapter_summary", "consistency_fact", "character", "bible"],
              finalTopK: 6,
            },
          );
        } catch {
          ragContext = "";
        }
      }

      const result = await runStructuredPrompt({
        asset: chapterReviewPrompt,
        promptInput: {
          novelTitle,
          chapterTitle,
          content,
          ragContext: ragContext || "",
        },
        options: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature ?? 0.1,
        },
      });
      const parsed = result.output;

      return {
        score: normalizeScore(parsed.score ?? {}),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      };
    } catch {
      return { score: ruleScore(content), issues: [] };
    }
  }

  private async reviewChapterWithAudit(
    novelTitle: string,
    chapterTitle: string,
    content: string,
    options: ReviewOptions = {},
    novelId?: string,
    chapterId?: string,
  ): Promise<{
    score: QualityScore;
    issues: ReviewIssue[];
    auditReports?: AuditReport[];
    contextPackage?: GenerationContextPackage;
  }> {
    if (!content.trim()) {
      return {
        score: normalizeScore({}),
        issues: [{
          severity: "critical",
          category: "coherence",
          evidence: "章节内容为空",
          fixSuggestion: "先生成或补全正文，再进行审校",
        }],
        auditReports: [],
      };
    }

    if (novelId && chapterId) {
      const contextPackage = await this.assembleAuditContextPackage(novelId, chapterId, options, "review");
      const auditResult = await auditService.auditChapter(novelId, chapterId, "full", {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
        content,
        contextPackage,
      });
      return {
        ...auditResult,
        contextPackage,
      };
    }

    return this.reviewChapterContent(novelTitle, chapterTitle, content, options, novelId);
  }

  private async assembleAuditContextPackage(
    novelId: string,
    chapterId: string,
    options: ReviewOptions,
    operation: AuditContextOperation,
  ): Promise<GenerationContextPackage> {
    return assembleChapterAuditContextPackage({
      assembler: this.generationContextAssembler,
      novelId,
      chapterId,
      options,
      operation,
    });
  }
}
