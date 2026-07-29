import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../../db/prisma";

interface LocalSkillManifest {
  id: string;
  name: string;
  type: string[];
  description?: string;
  stateRequirements?: string[];
  stateSchema?: Record<string, unknown>;
  promptHooks?: Record<string, string>;
  reviewGates?: string[];
  riskTriggers?: string[];
  visualFocus?: string[];
  conflictKeys?: string[];
  readme?: string;
  rules?: Record<string, string>;
  examples?: Record<string, string>;
  priority?: number;
}

export interface LocalSkillSyncResult {
  sourcePath: string | null;
  sourcePaths?: string[];
  syncedCount: number;
  skipped: boolean;
}

interface LocalSkillManifestSource {
  manifest: LocalSkillManifest;
  sourcePath: string;
}

const MAX_LOCAL_SKILL_TEXT_LENGTH = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function normalizeManifest(value: unknown): LocalSkillManifest | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const type = readStringArray(value.type);
  if (!id || !name || type.length === 0) {
    return null;
  }
  return {
    id,
    name,
    type,
    description: typeof value.description === "string" ? value.description.trim() : undefined,
    stateRequirements: readStringArray(value.stateRequirements),
    promptHooks: isRecord(value.promptHooks)
      ? Object.fromEntries(Object.entries(value.promptHooks).filter(([, item]) => typeof item === "string")) as Record<string, string>
      : {},
    reviewGates: readStringArray(value.reviewGates),
    riskTriggers: readStringArray(value.riskTriggers),
    visualFocus: readStringArray(value.visualFocus),
    conflictKeys: readStringArray(value.conflictKeys),
    priority: typeof value.priority === "number" && Number.isFinite(value.priority) ? value.priority : 100,
  };
}

function checksumManifest(manifest: LocalSkillManifest): string {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSkillsRoots(): Promise<string[]> {
  const candidates = Array.from(new Set([
    path.resolve(process.cwd(), "skills"),
    path.resolve(process.cwd(), "..", "skills"),
  ]));
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      roots.push(candidate);
    }
  }
  return roots;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

async function readTextFile(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8");
  const trimmed = raw.trim();
  return trimmed.length > MAX_LOCAL_SKILL_TEXT_LENGTH
    ? trimmed.slice(0, MAX_LOCAL_SKILL_TEXT_LENGTH)
    : trimmed;
}

async function loadBuiltinJsonManifests(root: string): Promise<LocalSkillManifestSource[]> {
  const sourcePath = path.join(root, "builtin-skills.json");
  if (!await pathExists(sourcePath)) {
    return [];
  }
  const parsed = await readJsonFile(sourcePath);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map(normalizeManifest)
    .filter((item): item is LocalSkillManifest => Boolean(item))
    .map((manifest) => ({ manifest, sourcePath }));
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function expandPromptHooks(skillDir: string, manifest: LocalSkillManifest): Promise<LocalSkillManifest> {
  const promptHooks = manifest.promptHooks ?? {};
  const entries = await Promise.all(Object.entries(promptHooks).map(async ([key, value]) => {
    const trimmed = value.trim();
    if (!trimmed || path.isAbsolute(trimmed)) {
      return [key, trimmed] as const;
    }
    const promptPath = path.resolve(skillDir, trimmed);
    if (!isPathInside(skillDir, promptPath) || !await pathExists(promptPath)) {
      return [key, trimmed] as const;
    }
    const stat = await fs.stat(promptPath);
    if (!stat.isFile()) {
      return [key, trimmed] as const;
    }
    return [key, (await fs.readFile(promptPath, "utf8")).trim()] as const;
  }));
  return {
    ...manifest,
    promptHooks: Object.fromEntries(entries),
  };
}

async function readOptionalTextFile(skillDir: string, relativePath: string): Promise<string | undefined> {
  const filePath = path.resolve(skillDir, relativePath);
  if (!isPathInside(skillDir, filePath) || !await pathExists(filePath)) {
    return undefined;
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    return undefined;
  }
  return readTextFile(filePath);
}

async function readOptionalJsonObjectFile(skillDir: string, relativePath: string): Promise<Record<string, unknown> | undefined> {
  const filePath = path.resolve(skillDir, relativePath);
  if (!isPathInside(skillDir, filePath) || !await pathExists(filePath)) {
    return undefined;
  }
  const parsed = await readJsonFile(filePath);
  return isRecord(parsed) ? parsed : undefined;
}

async function readMarkdownDirectory(skillDir: string, relativeDir: string): Promise<Record<string, string>> {
  const dirPath = path.resolve(skillDir, relativeDir);
  if (!isPathInside(skillDir, dirPath) || !await pathExists(dirPath)) {
    return {};
  }
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return {};
  }
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const docs = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(async (entry) => {
      const filePath = path.join(dirPath, entry.name);
      return [entry.name, await readTextFile(filePath)] as const;
    }));
  return Object.fromEntries(docs);
}

async function enrichDirectoryManifest(skillDir: string, manifest: LocalSkillManifest): Promise<LocalSkillManifest> {
  const [withPromptHooks, readme, stateSchema, rules, examples] = await Promise.all([
    expandPromptHooks(skillDir, manifest),
    readOptionalTextFile(skillDir, "README.md"),
    readOptionalJsonObjectFile(skillDir, "state.schema.json"),
    readMarkdownDirectory(skillDir, "rules"),
    readMarkdownDirectory(skillDir, "examples"),
  ]);
  return {
    ...withPromptHooks,
    ...(readme ? { readme } : {}),
    ...(stateSchema ? { stateSchema } : {}),
    ...(Object.keys(rules).length > 0 ? { rules } : {}),
    ...(Object.keys(examples).length > 0 ? { examples } : {}),
  };
}

async function loadDirectorySkillManifests(root: string): Promise<LocalSkillManifestSource[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const manifests: LocalSkillManifestSource[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(root, entry.name);
    const sourcePath = path.join(skillDir, "skill.json");
    if (!await pathExists(sourcePath)) {
      continue;
    }
    const manifest = normalizeManifest(await readJsonFile(sourcePath));
    if (!manifest) {
      continue;
    }
    manifests.push({
      manifest: await enrichDirectoryManifest(skillDir, manifest),
      sourcePath,
    });
  }
  return manifests;
}

async function loadLocalSkillManifests(): Promise<LocalSkillManifestSource[]> {
  const roots = await resolveSkillsRoots();
  const byId = new Map<string, LocalSkillManifestSource>();
  for (const root of roots) {
    const sources = [
      ...await loadBuiltinJsonManifests(root),
      ...await loadDirectorySkillManifests(root),
    ];
    for (const source of sources) {
      byId.set(source.manifest.id, source);
    }
  }
  return Array.from(byId.values()).sort((a, b) => (a.manifest.priority ?? 100) - (b.manifest.priority ?? 100));
}

export class LocalSkillRegistryService {
  private lastSyncAt = 0;
  private syncPromise: Promise<LocalSkillSyncResult> | null = null;

  async syncLocalSkills(options?: { force?: boolean }): Promise<LocalSkillSyncResult> {
    const now = Date.now();
    if (!options?.force && this.lastSyncAt > 0 && now - this.lastSyncAt < 5000) {
      return { sourcePath: null, syncedCount: 0, skipped: true };
    }
    if (this.syncPromise) {
      return this.syncPromise;
    }
    this.syncPromise = this.syncLocalSkillsNow()
      .finally(() => {
        this.syncPromise = null;
      });
    return this.syncPromise;
  }

  private async syncLocalSkillsNow(): Promise<LocalSkillSyncResult> {
    const sources = await loadLocalSkillManifests();
    if (sources.length === 0) {
      this.lastSyncAt = Date.now();
      return { sourcePath: null, syncedCount: 0, skipped: true };
    }

    for (const source of sources) {
      await this.upsertManifest(source.manifest, source.sourcePath);
    }
    this.lastSyncAt = Date.now();
    const sourcePaths = sources.map((source) => source.sourcePath);
    return { sourcePath: sourcePaths[0] ?? null, sourcePaths, syncedCount: sources.length, skipped: false };
  }

  private async upsertManifest(manifest: LocalSkillManifest, sourcePath: string): Promise<void> {
    const manifestJson = JSON.stringify(manifest);
    const promptHooksJson = JSON.stringify(manifest.promptHooks ?? {});
    const reviewGateChecksJson = JSON.stringify(manifest.reviewGates ?? []);
    const metadataJson = JSON.stringify({
      stateRequirements: manifest.stateRequirements ?? [],
      stateSchema: manifest.stateSchema ?? null,
      riskTriggers: manifest.riskTriggers ?? [],
      visualFocus: manifest.visualFocus ?? [],
      type: manifest.type,
      source: path.relative(process.cwd(), sourcePath),
      readme: manifest.readme ?? null,
      rules: manifest.rules ?? {},
      examples: manifest.examples ?? {},
    });
    const checksum = checksumManifest(manifest);

    await prisma.$transaction(async (tx) => {
      const skill = await tx.skill.upsert({
        where: { slug: manifest.id },
        create: {
          slug: manifest.id,
          name: manifest.name,
          category: manifest.type[0] ?? "Skill",
          description: manifest.description ?? null,
          sourceType: "builtin_local",
          defaultEnabled: false,
          priority: manifest.priority ?? 100,
          conflictKeysJson: JSON.stringify(manifest.conflictKeys ?? []),
          metadataJson,
        },
        update: {
          name: manifest.name,
          category: manifest.type[0] ?? "Skill",
          description: manifest.description ?? null,
          sourceType: "builtin_local",
          defaultEnabled: false,
          priority: manifest.priority ?? 100,
          conflictKeysJson: JSON.stringify(manifest.conflictKeys ?? []),
          metadataJson,
        },
      });
      await tx.skillVersion.upsert({
        where: {
          skillId_version: {
            skillId: skill.id,
            version: "1.0.0",
          },
        },
        create: {
          skillId: skill.id,
          version: "1.0.0",
          manifestJson,
          promptHooksJson,
          reviewGateChecksJson,
          checksum,
        },
        update: {
          status: "active",
          manifestJson,
          promptHooksJson,
          reviewGateChecksJson,
          checksum,
        },
      });
    });
  }
}

export const localSkillRegistryService = new LocalSkillRegistryService();
