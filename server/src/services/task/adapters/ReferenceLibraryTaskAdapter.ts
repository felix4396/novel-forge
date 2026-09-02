import type { TaskKind, TaskStatus, UnifiedTaskDetail, UnifiedTaskSummary } from "@ai-novel/shared/types/task";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { archiveTask as recordTaskArchive, getArchivedTaskIds, isTaskArchived } from "../taskArchive";

type ReferenceTaskKind = Extract<TaskKind, "reference_search" | "reference_download">;

function searchLabel(authorsJson: string): string {
  const authors = JSON.parse(authorsJson) as string[];
  const marker = authors[0] ?? "";
  if (marker.startsWith("__fanqie_rank__:")) {
    try {
      const request = JSON.parse(marker.slice("__fanqie_rank__:".length)) as { gender: string; list: string; categoryId: string };
      const gender = request.gender === "female" ? "女频" : "男频";
      const list = request.list === "new" ? "新书榜" : "阅读榜";
      return `番茄热门：${gender}${list} · ${request.categoryId}`;
    } catch {
      return "番茄热门";
    }
  }
  return authors.join("、");
}

function steps(status: TaskStatus, createdAt: string, updatedAt: string, download: boolean) {
  const labels = download ? ["准备", "下载", "导入知识库"] : ["排队", "搜索", "验证来源"];
  const active = status === "queued" ? 0 : status === "running" ? 1 : 2;
  return labels.map((label, index) => ({
    key: `${index}`,
    label,
    status: index < active || status === "succeeded" ? "succeeded" as const
      : index === active && status === "running" ? "running" as const
        : status === "failed" && index === active ? "failed" as const : "idle" as const,
    startedAt: index <= active ? createdAt : null,
    updatedAt: index <= active ? updatedAt : null,
  }));
}

export class ReferenceLibraryTaskAdapter {
  async list(kind: ReferenceTaskKind, input: { status?: TaskStatus; keyword?: string; take: number }): Promise<UnifiedTaskSummary[]> {
    if (input.status === "waiting_approval") return [];
    const archivedIds = await getArchivedTaskIds(kind);
    if (kind === "reference_search") {
      const rows = await prisma.referenceSearchJob.findMany({
        where: {
          ...(archivedIds.length ? { id: { notIn: archivedIds } } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.keyword ? { authorsJson: { contains: input.keyword } } : {}),
        },
        orderBy: { updatedAt: "desc" }, take: input.take,
      });
      return rows.map((row) => {
        const authors = JSON.parse(row.authorsJson) as string[];
        const label = searchLabel(row.authorsJson);
        return {
          id: row.id, kind, title: `参考书搜索：${label}`, status: row.status as TaskStatus,
          progress: row.progress, currentStage: row.status === "running" ? "搜索并验证来源" : null,
          currentItemLabel: `${row.processedAuthors}/${row.totalAuthors} 位作者`, attemptCount: 1, maxAttempts: 1,
          lastError: row.lastError, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
          heartbeatAt: row.heartbeatAt?.toISOString() ?? null, ownerId: row.id, ownerLabel: label,
          sourceRoute: "/reference-library", failureSummary: row.lastError,
        } satisfies UnifiedTaskSummary;
      });
    }
    const rows = await prisma.referenceDownloadJob.findMany({
      where: {
        ...(archivedIds.length ? { id: { notIn: archivedIds } } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.keyword ? { book: { OR: [{ title: { contains: input.keyword } }, { author: { contains: input.keyword } }] } } : {}),
      },
      include: { book: true }, orderBy: { updatedAt: "desc" }, take: input.take,
    });
    return rows.map((row) => ({
      id: row.id, kind, title: `参考书下载：${row.book.title}`, status: row.status as TaskStatus,
      progress: row.progress, currentStage: row.currentStage, attemptCount: row.attemptCount, maxAttempts: row.maxAttempts,
      lastError: row.lastError, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      heartbeatAt: row.heartbeatAt?.toISOString() ?? null, ownerId: row.bookId,
      ownerLabel: `${row.book.title}（${row.book.author}）`, sourceRoute: "/reference-library",
      failureSummary: row.lastError,
    } satisfies UnifiedTaskSummary));
  }

  async detail(kind: ReferenceTaskKind, id: string): Promise<UnifiedTaskDetail | null> {
    if (await isTaskArchived(kind, id)) return null;
    const summary = (await this.list(kind, { take: 200 })).find((item) => item.id === id);
    if (!summary) return null;
    if (kind === "reference_search") {
      const row = await prisma.referenceSearchJob.findUnique({ where: { id } });
      if (!row) return null;
      return { ...summary, retryCountLabel: "1/1", startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, meta: { authors: JSON.parse(row.authorsJson), expiresAt: row.expiresAt.toISOString() }, steps: steps(summary.status, summary.createdAt, summary.updatedAt, false), failureDetails: row.lastError };
    }
    const row = await prisma.referenceDownloadJob.findUnique({ where: { id }, include: { currentSource: true } });
    if (!row) return null;
    return { ...summary, retryCountLabel: `${row.attemptCount}/${row.maxAttempts}`, startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, meta: { currentSource: row.currentSource?.sourceName ?? null }, steps: steps(summary.status, summary.createdAt, summary.updatedAt, true), failureDetails: row.lastError };
  }

  async retry(kind: ReferenceTaskKind, id: string): Promise<UnifiedTaskDetail> {
    if (kind === "reference_search") await prisma.referenceSearchJob.update({ where: { id }, data: { status: "queued", progress: 0, processedAuthors: 0, resultJson: "[]", lastError: null, finishedAt: null } });
    else await prisma.referenceDownloadJob.update({ where: { id }, data: { status: "queued", progress: 0, currentStage: "等待重试", lastError: null, finishedAt: null } });
    const detail = await this.detail(kind, id);
    if (!detail) throw new AppError("Task not found.", 404);
    return detail;
  }

  async cancel(kind: ReferenceTaskKind, id: string): Promise<UnifiedTaskDetail> {
    const detail = await this.detail(kind, id);
    if (!detail) throw new AppError("Task not found.", 404);
    if (detail.status === "running") throw new AppError("运行中的抓取将在当前阶段完成，暂不支持强制取消。", 400);
    if (kind === "reference_search") await prisma.referenceSearchJob.update({ where: { id }, data: { status: "cancelled", finishedAt: new Date() } });
    else await prisma.referenceDownloadJob.update({ where: { id }, data: { status: "cancelled", finishedAt: new Date() } });
    return (await this.detail(kind, id))!;
  }

  async archive(kind: ReferenceTaskKind, id: string): Promise<null> {
    const detail = await this.detail(kind, id);
    if (!detail) throw new AppError("Task not found.", 404);
    if (!["succeeded", "failed", "cancelled"].includes(detail.status)) throw new AppError("Only finished tasks can be archived.", 400);
    await recordTaskArchive(kind, id);
    return null;
  }
}
