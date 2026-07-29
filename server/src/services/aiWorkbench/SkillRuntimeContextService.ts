import type { RuntimeActiveSkill } from "@ai-novel/shared/types/chapterRuntime";
import { prisma } from "../../db/prisma";
import { localSkillRegistryService } from "./LocalSkillRegistryService";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRecordJson(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringArrayJson(value: string | null | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return readStringArray(parsed);
  } catch {
    return [];
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

function readPromptHooks(value: string | null | undefined): Record<string, string> {
  const parsed = parseRecordJson(value);
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([, item]) => typeof item === "string" && item.trim().length > 0)
      .map(([key, item]) => [key, String(item).trim()]),
  );
}

function readMetadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  return readStringArray(metadata[key]);
}

function readManifestStringArray(manifest: Record<string, unknown>, key: string): string[] {
  return readStringArray(manifest[key]);
}

export function summarizeActiveSkillsForAgentLog(activeSkills: RuntimeActiveSkill[]): Record<string, unknown> {
  return {
    activeSkillCount: activeSkills.length,
    skills: activeSkills.slice(0, 12).map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      category: skill.category,
      priority: skill.priority,
      conflictStatus: skill.conflictStatus,
      stateRequirements: skill.stateRequirements.slice(0, 12),
      promptHooks: Object.fromEntries(
        Object.entries(skill.promptHooks)
          .filter(([, value]) => value.trim().length > 0)
          .map(([key, value]) => [key, value.slice(0, 260)]),
      ),
      reviewGateChecks: skill.reviewGateChecks.slice(0, 12),
      riskTriggers: skill.riskTriggers.slice(0, 12),
    })),
  };
}

export class SkillRuntimeContextService {
  async getActiveSkills(novelId: string): Promise<RuntimeActiveSkill[]> {
    await localSkillRegistryService.syncLocalSkills();
    const rows = await prisma.projectSkill.findMany({
      where: { novelId, enabled: true },
      include: {
        skill: {
          include: {
            versions: {
              where: { status: "active" },
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              take: 1,
            },
          },
        },
        skillVersion: true,
      },
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
    });

    return rows.map((row) => {
      const version = row.skillVersion ?? row.skill.versions[0] ?? null;
      const metadata = parseRecordJson(row.skill.metadataJson);
      const manifest = parseRecordJson(version?.manifestJson);
      const stateRequirements = readMetadataStringArray(metadata, "stateRequirements");
      const riskTriggers = readMetadataStringArray(metadata, "riskTriggers");
      const visualFocus = readMetadataStringArray(metadata, "visualFocus");
      return {
        skillId: row.skillId,
        skillVersionId: version?.id ?? row.skillVersionId ?? null,
        slug: row.skill.slug,
        name: row.skill.name,
        category: row.skill.category,
        description: row.skill.description ?? null,
        priority: row.priority,
        conflictStatus: row.conflictStatus,
        conflictJson: row.conflictJson,
        conflictKeys: parseStringArrayJson(row.skill.conflictKeysJson),
        stateRequirements: stateRequirements.length > 0
          ? stateRequirements
          : readManifestStringArray(manifest, "stateRequirements"),
        promptHooks: readPromptHooks(version?.promptHooksJson),
        reviewGateChecks: parseStringArrayJson(version?.reviewGateChecksJson),
        riskTriggers: riskTriggers.length > 0
          ? riskTriggers
          : readManifestStringArray(manifest, "riskTriggers"),
        visualFocus: visualFocus.length > 0
          ? visualFocus
          : readManifestStringArray(manifest, "visualFocus"),
        config: parseRecordJson(row.configJson),
        metadata,
      };
    });
  }

  async serializeActiveSkills(novelId: string): Promise<string> {
    return JSON.stringify(await this.getActiveSkills(novelId));
  }
}

export const skillRuntimeContextService = new SkillRuntimeContextService();
