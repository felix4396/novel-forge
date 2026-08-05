import { prisma } from "../../db/prisma";

export function isMissingTableError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "P2021"
  );
}

export function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function hasLegacyKnowledgeData(): Promise<boolean> {
  try {
    const [existingChunk, existingDocument, existingJob] = await Promise.all([
      prisma.knowledgeChunk.findFirst({ select: { id: true } }),
      prisma.knowledgeDocument.findFirst({ select: { id: true } }),
      prisma.ragIndexJob.findFirst({ select: { id: true } }),
    ]);
    return Boolean(existingChunk || existingDocument || existingJob);
  } catch (error) {
    if (isMissingTableError(error)) {
      return false;
    }
    throw error;
  }
}

export async function shouldPreserveLegacyQdrantCollection(): Promise<boolean> {
  return hasLegacyKnowledgeData();
}
