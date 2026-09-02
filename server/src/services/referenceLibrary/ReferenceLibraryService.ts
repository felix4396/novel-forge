import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { htmlToText } from "html-to-text";
import type {
  ReferenceBookCandidate,
  ReferenceBookSourceCandidate,
  ReferenceSearchJob as ReferenceSearchJobDto,
  FanqieRankOptions,
  FanqieRankSearchRequest,
} from "@ai-novel/shared/types/referenceLibrary";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { KnowledgeService } from "../knowledge/KnowledgeService";
import {
  FANQIE_RANK_CATEGORIES,
  FanqieRankClient,
  type FanqieRankGender,
  type FanqieRankItem,
  type FanqieRankList,
} from "./FanqieRankClient";
import { SoNovelClient, type SoNovelSearchResult } from "./SoNovelClient";
import {
  buildCandidateId,
  cleanAuthorName,
  normalizeAuthors,
  normalizeReferenceIdentity,
} from "./referenceLibraryNormalization";

const SEARCH_TTL_MS = 24 * 60 * 60_000;
const SEARCH_CACHE_MS = 30 * 60_000;
const MAX_FILE_SIZE = 200 * 1024 * 1024;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const SEARCH_VALIDATION_CONCURRENCY = 3;
const FANQIE_BOOK_CONCURRENCY = 5;
const FANQIE_SEARCH_PREFIX = "__fanqie_rank__:";

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nullable(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

interface EpubRootfile {
  "full-path"?: string;
}

interface EpubManifestItem {
  id?: string;
  href?: string;
  "media-type"?: string;
}

interface EpubSpineItem {
  idref?: string;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeEpubPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractEpubChapters(filePath: string): Array<{ title: string; content: string }> {
  const zip = new AdmZip(filePath);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true });
  const containerEntry = zip.getEntry("META-INF/container.xml");
  if (!containerEntry) throw new Error("EPUB 缺少 META-INF/container.xml。");
  const container = parser.parse(containerEntry.getData().toString("utf8")) as {
    container?: { rootfiles?: { rootfile?: EpubRootfile | EpubRootfile[] } };
  };
  const opfPath = toArray(container.container?.rootfiles?.rootfile)[0]?.["full-path"];
  if (!opfPath) throw new Error("EPUB 未声明 OPF 文件。");

  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error("EPUB 的 OPF 文件不存在。");
  const opf = parser.parse(opfEntry.getData().toString("utf8")) as {
    package?: {
      manifest?: { item?: EpubManifestItem | EpubManifestItem[] };
      spine?: { itemref?: EpubSpineItem | EpubSpineItem[] };
    };
  };
  const manifest = new Map(
    toArray(opf.package?.manifest?.item)
      .filter((item): item is EpubManifestItem & { id: string; href: string } => Boolean(item.id && item.href))
      .map((item) => [item.id, item]),
  );
  const opfDirectory = path.posix.dirname(opfPath);

  return toArray(opf.package?.spine?.itemref).flatMap((item, index) => {
    const manifestItem = item.idref ? manifest.get(item.idref) : undefined;
    if (!manifestItem || !/html|xhtml/i.test(manifestItem["media-type"] ?? "")) return [];
    const href = decodeEpubPath(manifestItem.href.split("#", 1)[0] ?? "");
    const entryPath = path.posix.normalize(path.posix.join(opfDirectory, href));
    const chapterEntry = zip.getEntry(entryPath);
    if (!chapterEntry) return [];
    const content = htmlToText(chapterEntry.getData().toString("utf8"), {
      wordwrap: false,
      selectors: [{ selector: "img", format: "skip" }],
    }).trim();
    if (!content) return [];
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
    return [{ title: firstLine || `章节 ${index + 1}`, content }];
  });
}

export class ReferenceLibraryService {
  private readonly soNovel = new SoNovelClient();
  private readonly fanqieRank = new FanqieRankClient();
  private readonly knowledgeService = new KnowledgeService();
  private readonly libraryRoot = path.resolve(
    process.env.REFERENCE_LIBRARY_ROOT ?? path.join(process.cwd(), "data", "reference-books"),
  );

  async createSearchJob(rawAuthors: string[]): Promise<ReferenceSearchJobDto> {
    const authors = normalizeAuthors(rawAuthors);
    if (authors.length === 0) throw new AppError("请至少输入一个作者名。", 400);
    if (authors.length > 20) throw new AppError("每批最多搜索 20 个作者。", 400);

    const cacheBoundary = new Date(Date.now() - SEARCH_CACHE_MS);
    const cached = await prisma.referenceSearchJob.findFirst({
      where: {
        authorsJson: JSON.stringify(authors),
        status: "succeeded",
        resultJson: { not: "[]" },
        updatedAt: { gte: cacheBoundary },
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: "desc" },
    });
    if (cached) return this.mapSearchJob(cached);

    const job = await prisma.referenceSearchJob.create({
      data: {
        authorsJson: JSON.stringify(authors),
        totalAuthors: authors.length,
        expiresAt: new Date(Date.now() + SEARCH_TTL_MS),
      },
    });
    return this.mapSearchJob(job);
  }

  async createFanqieRankSearchJob(rawInput: FanqieRankSearchRequest): Promise<ReferenceSearchJobDto> {
    const request = this.normalizeFanqieSearchRequest(rawInput);
    const authorsJson = JSON.stringify([`${FANQIE_SEARCH_PREFIX}${JSON.stringify(request)}`]);
    const cached = await prisma.referenceSearchJob.findFirst({
      where: {
        authorsJson,
        status: "succeeded",
        updatedAt: { gte: new Date(Date.now() - SEARCH_CACHE_MS) },
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: "desc" },
    });
    if (cached) return this.mapSearchJob(cached);
    const job = await prisma.referenceSearchJob.create({
      data: {
        authorsJson,
        totalAuthors: 1,
        expiresAt: new Date(Date.now() + SEARCH_TTL_MS),
      },
    });
    return this.mapSearchJob(job);
  }

  async listFanqieRankOptions(): Promise<FanqieRankOptions> {
    return {
      genders: [
        {
          gender: "male",
          genderLabel: "男频",
          lists: this.buildFanqieRankOptionLists("male"),
        },
        {
          gender: "female",
          genderLabel: "女频",
          lists: this.buildFanqieRankOptionLists("female"),
        },
      ],
    };
  }

  private buildFanqieRankOptionLists(gender: FanqieRankGender): FanqieRankOptions["genders"][number]["lists"] {
    const readLabel = gender === "male" ? "男频阅读榜" : "女频阅读榜";
    const newLabel = gender === "male" ? "男频新书榜" : "女频新书榜";
    const categories = FANQIE_RANK_CATEGORIES[gender];
    return [
      { id: "read", label: readLabel, categories },
      { id: "new", label: newLabel, categories },
    ];
  }

  private describeFanqieRankRequest(request: FanqieRankSearchRequest): string {
    const genderLabel = request.gender === "male" ? "男频" : "女频";
    const listLabel = request.list === "read" ? "阅读榜" : "新书榜";
    const categoryLabel = FANQIE_RANK_CATEGORIES[request.gender].find((item) => item.id === request.categoryId)?.name ?? request.categoryId;
    return `番茄热门：${genderLabel}${listLabel} · ${categoryLabel}`;
  }

  private normalizeFanqieSearchRequest(rawInput: FanqieRankSearchRequest): FanqieRankSearchRequest {
    const gender: FanqieRankGender = rawInput.gender === "female" ? "female" : "male";
    const list: FanqieRankList = rawInput.list === "new" ? "new" : "read";
    const categoryId = FANQIE_RANK_CATEGORIES[gender].some((item) => item.id === rawInput.categoryId)
      ? rawInput.categoryId
      : FANQIE_RANK_CATEGORIES[gender][0].id;
    const limit = Math.max(1, Math.min(50, Math.trunc(Number(rawInput.limit ?? 20) || 20)));
    return { gender, list, categoryId, limit };
  }

  private tryParseFanqieSearchRequest(authorsJson: string): FanqieRankSearchRequest | null {
    const authors = parseJson<string[]>(authorsJson, []);
    const marker = authors[0];
    if (!marker?.startsWith(FANQIE_SEARCH_PREFIX)) return null;
    try {
      return this.normalizeFanqieSearchRequest(JSON.parse(marker.slice(FANQIE_SEARCH_PREFIX.length)) as FanqieRankSearchRequest);
    } catch {
      return null;
    }
  }

  private async searchAuthors(jobId: string, authors: string[]): Promise<ReferenceBookCandidate[]> {
    const batches: string[][] = [];
    for (let index = 0; index < authors.length; index += 2) batches.push(authors.slice(index, index + 2));
    const all: ReferenceBookCandidate[] = [];
    let processed = 0;
    for (const batch of batches) {
      const partialResults = new Map<string, ReferenceBookCandidate[]>();
      const authorProgress = new Map<string, number>();
      let updateQueue = Promise.resolve();
      const reportProgress = (author: string, progress: number, candidates: ReferenceBookCandidate[]) => {
        updateQueue = updateQueue.then(async () => {
          partialResults.set(author, candidates);
          authorProgress.set(author, progress);
          const batchProgress = batch.reduce((sum, item) => sum + (authorProgress.get(item) ?? 0), 0) / 100;
          const overallProgress = Math.min(99, Math.round(((processed + batchProgress) / authors.length) * 100));
          await prisma.referenceSearchJob.update({
            where: { id: jobId },
            data: {
              progress: Math.max(1, overallProgress),
              processedAuthors: processed,
              resultJson: JSON.stringify([...all, ...batch.flatMap((item) => partialResults.get(item) ?? [])]),
              heartbeatAt: new Date(),
            },
          });
        });
        return updateQueue;
      };
      const results = await Promise.all(batch.map((author) => this.searchAuthor(
        author,
        (progress, candidates) => reportProgress(author, progress, candidates),
      )));
      await updateQueue;
      all.push(...results.flat());
      processed += batch.length;
      await prisma.referenceSearchJob.update({
        where: { id: jobId },
        data: {
          processedAuthors: processed,
          progress: Math.round((processed / authors.length) * 100),
          resultJson: JSON.stringify(all),
          heartbeatAt: new Date(),
        },
      });
    }
    return all;
  }

  private async searchFanqieRank(jobId: string, request: FanqieRankSearchRequest): Promise<ReferenceBookCandidate[]> {
    const rank = await this.fanqieRank.listRank({ ...request, limit: request.limit ?? 20 });
    if (rank.items.length === 0) {
      await prisma.referenceSearchJob.update({
        where: { id: jobId },
        data: { progress: 100, processedAuthors: 1, resultJson: "[]", heartbeatAt: new Date() },
      });
      return [];
    }
    const results = new Array<ReferenceBookCandidate | null>(rank.items.length).fill(null);
    let completed = 0;
    let updateQueue = Promise.resolve();
    await mapWithConcurrency(
      rank.items.map((item, index) => ({ item, index })),
      FANQIE_BOOK_CONCURRENCY,
      async ({ item, index }) => {
        results[index] = await this.searchBookCandidate(item, rank.label);
        completed += 1;
        const completedCount = completed;
        const snapshot = results.filter((candidate): candidate is ReferenceBookCandidate => candidate !== null);
        updateQueue = updateQueue.then(() => prisma.referenceSearchJob.update({
          where: { id: jobId },
          data: {
            progress: Math.min(99, Math.round((completedCount / rank.items.length) * 100)),
            processedAuthors: 1,
            resultJson: JSON.stringify(snapshot),
            heartbeatAt: new Date(),
          },
        }).then(() => undefined));
        await updateQueue;
        return null;
      },
    );
    return results.filter((candidate): candidate is ReferenceBookCandidate => candidate !== null);
  }

  private async searchBookCandidate(
    item: FanqieRankItem,
    sourceLabel: string,
  ): Promise<ReferenceBookCandidate | null> {
    const expectedAuthor = normalizeReferenceIdentity(item.author);
    const expectedTitle = normalizeReferenceIdentity(item.title);
    const searchKeywords = [item.title, `${item.title} ${item.author}`, `${item.author} ${item.title}`];
    const searched = new Set<string>();
    const results: SoNovelSearchResult[] = [];
    for (const keyword of searchKeywords) {
      const normalizedKeyword = normalizeReferenceIdentity(keyword);
      if (!normalizedKeyword || searched.has(normalizedKeyword)) continue;
      searched.add(normalizedKeyword);
      try {
        const found = await this.soNovel.search(keyword);
        results.push(...found);
        if (found.some((result) => {
          const authorKey = normalizeReferenceIdentity(cleanAuthorName(result.author ?? ""));
          const titleKey = normalizeReferenceIdentity(result.bookName);
          return authorKey === expectedAuthor && titleKey === expectedTitle;
        })) break;
      } catch {
        // Keep trying alternative keywords.
      }
    }
    const filtered = results.filter((result) => {
      const authorKey = normalizeReferenceIdentity(cleanAuthorName(result.author ?? ""));
      const titleKey = normalizeReferenceIdentity(result.bookName);
      return authorKey === expectedAuthor && titleKey === expectedTitle;
    });
    return this.buildCandidateFromResults(item.author, item.title, filtered, {
      sourceType: "fanqie_rank",
      sourceLabel,
      fallbackCategory: item.categoryName,
      fallbackIntro: item.intro,
      fallbackLatestChapter: item.latestChapter,
      fallbackPublicationStatus: item.publicationStatus,
      fallbackWordCount: item.wordCount,
    });
  }

  async getSearchJob(id: string): Promise<ReferenceSearchJobDto | null> {
    const job = await prisma.referenceSearchJob.findUnique({ where: { id } });
    return job ? this.mapSearchJob(job) : null;
  }

  async listBooks(keyword?: string) {
    const query = keyword?.trim();
    return prisma.referenceBook.findMany({
      where: query ? { OR: [{ title: { contains: query } }, { author: { contains: query } }] } : undefined,
      include: { sources: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] } },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  }

  getBook(id: string) {
    return prisma.referenceBook.findUnique({
      where: { id },
      include: { sources: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] } },
    });
  }

  listDownloadJobs() {
    return prisma.referenceDownloadJob.findMany({
      include: {
        book: { select: { id: true, author: true, title: true, fileStatus: true, importStatus: true } },
        currentSource: { select: { id: true, sourceName: true, url: true } },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
    });
  }

  getDownloadJob(id: string) {
    return prisma.referenceDownloadJob.findUnique({
      where: { id },
      include: {
        book: { select: { id: true, author: true, title: true, fileStatus: true, importStatus: true } },
        currentSource: { select: { id: true, sourceName: true, url: true } },
      },
    });
  }

  async createDownloadJobs(searchJobId: string, candidateIds: string[]) {
    const searchJob = await prisma.referenceSearchJob.findUnique({ where: { id: searchJobId } });
    if (!searchJob || searchJob.status !== "succeeded" || searchJob.expiresAt <= new Date()) {
      throw new AppError("搜索结果已失效，请重新搜索。", 409);
    }
    const selectedIds = new Set(candidateIds);
    const candidates = parseJson<ReferenceBookCandidate[]>(searchJob.resultJson, [])
      .filter((candidate) => selectedIds.has(candidate.id));
    if (candidates.length === 0) throw new AppError("请选择至少一本可下载的书。", 400);

    const jobs = [];
    for (const candidate of candidates) {
      const book = await prisma.referenceBook.upsert({
        where: {
          normalizedAuthor_normalizedTitle: {
            normalizedAuthor: candidate.normalizedAuthor,
            normalizedTitle: candidate.normalizedTitle,
          },
        },
        create: {
          author: candidate.author,
          normalizedAuthor: candidate.normalizedAuthor,
          title: candidate.title,
          normalizedTitle: candidate.normalizedTitle,
          category: nullable(candidate.category),
          intro: nullable(candidate.intro),
          latestChapter: nullable(candidate.latestChapter),
          publicationStatus: nullable(candidate.publicationStatus),
          wordCount: nullable(candidate.wordCount),
          chapterCount: candidate.chapterCount,
        },
        update: {
          category: nullable(candidate.category),
          intro: nullable(candidate.intro),
          latestChapter: nullable(candidate.latestChapter),
          publicationStatus: nullable(candidate.publicationStatus),
          wordCount: nullable(candidate.wordCount),
          chapterCount: candidate.chapterCount,
        },
      });
      for (const source of candidate.sources) {
        await prisma.referenceBookSource.upsert({
          where: { bookId_url: { bookId: book.id, url: source.url } },
          create: {
            bookId: book.id,
            sourceId: source.sourceId,
            sourceName: source.sourceName,
            url: source.url,
            priority: source.priority,
            chapterCount: source.chapterCount,
            checkedAt: new Date(),
          },
          update: {
            sourceName: source.sourceName,
            priority: source.priority,
            chapterCount: source.chapterCount,
            availabilityStatus: "available",
            checkedAt: new Date(),
            lastError: null,
          },
        });
      }
      const active = await prisma.referenceDownloadJob.findFirst({
        where: { bookId: book.id, status: { in: ["queued", "running"] } },
      });
      jobs.push(active ?? await prisma.referenceDownloadJob.create({
        data: {
          bookId: book.id,
          searchJobId,
          maxAttempts: Math.max(1, candidate.sources.length),
        },
      }));
    }
    return jobs;
  }

  async redownload(bookId: string) {
    const book = await this.getBook(bookId);
    if (!book) throw new AppError("书籍不存在。", 404);
    if (!book.sources.some((source) => source.sourceId > 0)) throw new AppError("历史书籍没有可用的在线来源，请重新搜索。", 409);
    const active = await prisma.referenceDownloadJob.findFirst({
      where: { bookId, status: { in: ["queued", "running"] } },
    });
    return active ?? prisma.referenceDownloadJob.create({
      data: { bookId, maxAttempts: Math.max(1, book.sources.length) },
    });
  }

  async retryImport(bookId: string) {
    const book = await prisma.referenceBook.findUnique({ where: { id: bookId } });
    if (!book?.filePath || !fs.existsSync(book.filePath)) throw new AppError("EPUB 文件不存在，请先重新下载。", 409);
    await this.importBook(book.id, book.filePath, book.fileName ?? `${book.title}.epub`);
    return this.getBook(book.id);
  }

  async removeBookFile(bookId: string): Promise<void> {
    const book = await prisma.referenceBook.findUnique({ where: { id: bookId } });
    if (!book) throw new AppError("书籍不存在。", 404);
    if (book.filePath) await fs.promises.rm(book.filePath, { force: true });
    await prisma.referenceBook.update({
      where: { id: bookId },
      data: { fileStatus: "removed", filePath: null, fileSize: null, fileRemovedAt: new Date() },
    });
  }

  async resolveBookFile(bookId: string): Promise<{ path: string; fileName: string } | null> {
    const book = await prisma.referenceBook.findUnique({ where: { id: bookId } });
    if (!book?.filePath || !book.fileName || !fs.existsSync(book.filePath)) return null;
    return { path: book.filePath, fileName: book.fileName };
  }

  async recoverInterruptedJobs(): Promise<void> {
    await prisma.referenceSearchJob.updateMany({
      where: { status: "running" },
      data: { status: "queued", lastError: "服务重启后自动恢复。", heartbeatAt: null },
    });
    await prisma.referenceDownloadJob.updateMany({
      where: { status: "running" },
      data: { status: "queued", lastError: "服务重启后自动恢复。", heartbeatAt: null },
    });
  }

  async claimAndRunSearchJob(): Promise<boolean> {
    const job = await prisma.referenceSearchJob.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
    if (!job) return false;
    const claimed = await prisma.referenceSearchJob.updateMany({
      where: { id: job.id, status: "queued" },
      data: { status: "running", startedAt: job.startedAt ?? new Date(), heartbeatAt: new Date(), lastError: null },
    });
    if (claimed.count === 0) return true;
    try {
      const fanqieRequest = this.tryParseFanqieSearchRequest(job.authorsJson);
      const all = fanqieRequest
        ? await this.searchFanqieRank(job.id, fanqieRequest)
        : await this.searchAuthors(job.id, parseJson<string[]>(job.authorsJson, []));
      await prisma.referenceSearchJob.update({
        where: { id: job.id },
        data: { status: "succeeded", progress: 100, finishedAt: new Date(), heartbeatAt: new Date() },
      });
    } catch (error) {
      await prisma.referenceSearchJob.update({
        where: { id: job.id },
        data: { status: "failed", lastError: error instanceof Error ? error.message : String(error), finishedAt: new Date() },
      });
    }
    return true;
  }

  async claimAndRunDownloadJob(): Promise<boolean> {
    const job = await prisma.referenceDownloadJob.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      include: { book: true },
    });
    if (!job) return false;
    const claimed = await prisma.referenceDownloadJob.updateMany({
      where: { id: job.id, status: "queued" },
      data: { status: "running", progress: 5, currentStage: "准备下载", startedAt: job.startedAt ?? new Date(), heartbeatAt: new Date() },
    });
    if (claimed.count === 0) return true;
    const sources = await prisma.referenceBookSource.findMany({
      where: { bookId: job.bookId, sourceId: { gt: 0 }, availabilityStatus: "available" },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
    let lastError = "没有可用书源。";
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      try {
        await prisma.referenceDownloadJob.update({
          where: { id: job.id },
          data: {
            currentSourceId: source.id,
            currentStage: `下载中：${source.sourceName}`,
            progress: 10,
            attemptCount: index + 1,
            heartbeatAt: new Date(),
          },
        });
        const result = await this.soNovel.download(source.url, job.id);
        await this.storeAndImport(job.bookId, result.fileName, job.id);
        await prisma.referenceDownloadJob.update({
          where: { id: job.id },
          data: { status: "succeeded", progress: 100, currentStage: "已入库", finishedAt: new Date(), heartbeatAt: new Date(), lastError: null },
        });
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await prisma.referenceBookSource.update({
          where: { id: source.id },
          data: { availabilityStatus: "failed", lastError, checkedAt: new Date() },
        });
        await this.waitForSoNovelRecovery();
      }
    }
    await prisma.referenceDownloadJob.update({
      where: { id: job.id },
      data: { status: "failed", progress: 100, currentStage: "下载失败", lastError, finishedAt: new Date() },
    });
    return true;
  }

  async reconcileLegacyBooks(): Promise<void> {
    const books = await this.soNovel.listLocalBooks();
    for (const item of books.filter((book) => book.name.toLowerCase().endsWith(".epub"))) {
      const match = item.name.match(/^(.*)\(([^()]*)\)\.epub$/i);
      if (!match) continue;
      const [, title, author] = match;
      const book = await prisma.referenceBook.upsert({
        where: {
          normalizedAuthor_normalizedTitle: {
            normalizedAuthor: normalizeReferenceIdentity(author),
            normalizedTitle: normalizeReferenceIdentity(title),
          },
        },
        create: {
          author,
          normalizedAuthor: normalizeReferenceIdentity(author),
          title,
          normalizedTitle: normalizeReferenceIdentity(title),
          fileStatus: "staging",
          importStatus: "pending",
        },
        update: {},
      });
      await prisma.referenceBookSource.upsert({
        where: { bookId_url: { bookId: book.id, url: `legacy://${encodeURIComponent(item.name)}` } },
        create: { bookId: book.id, sourceId: 0, sourceName: "历史下载", url: `legacy://${encodeURIComponent(item.name)}`, priority: 999, checkedAt: new Date() },
        update: {},
      });
      if (book.fileStatus !== "available") {
        try {
          await this.storeAndImport(book.id, item.name, `legacy-${book.id}`);
        } catch (error) {
          console.error(`[reference-library] failed to import legacy EPUB ${item.name}`, error);
        }
      }
    }
  }

  private mapSearchJob(job: {
    id: string; authorsJson: string; status: string; progress: number; processedAuthors: number; totalAuthors: number;
    resultJson: string; lastError: string | null; expiresAt: Date; createdAt: Date; updatedAt: Date;
  }): ReferenceSearchJobDto {
    const fanqieRequest = this.tryParseFanqieSearchRequest(job.authorsJson);
    const authors = fanqieRequest ? [this.describeFanqieRankRequest(fanqieRequest)] : parseJson(job.authorsJson, []);
    return {
      id: job.id,
      authors,
      queryType: fanqieRequest ? "fanqie_rank" : "authors",
      queryLabel: fanqieRequest ? this.describeFanqieRankRequest(fanqieRequest) : null,
      status: job.status as ReferenceSearchJobDto["status"],
      progress: job.progress,
      processedAuthors: job.processedAuthors,
      totalAuthors: job.totalAuthors,
      results: parseJson(job.resultJson, []),
      lastError: job.lastError,
      expiresAt: job.expiresAt.toISOString(),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private async searchAuthor(
    author: string,
    onProgress?: (progress: number, candidates: ReferenceBookCandidate[]) => Promise<void>,
  ): Promise<ReferenceBookCandidate[]> {
    const expectedAuthor = normalizeReferenceIdentity(author);
    const results = (await this.soNovel.search(author)).filter(
      (item) => normalizeReferenceIdentity(cleanAuthorName(item.author ?? "")) === expectedAuthor,
    );
    const groups = new Map<string, SoNovelSearchResult[]>();
    for (const item of results) {
      const titleKey = normalizeReferenceIdentity(item.bookName);
      if (!titleKey) continue;
      const group = groups.get(titleKey) ?? [];
      group.push(item);
      groups.set(titleKey, group);
    }

    const candidates: ReferenceBookCandidate[] = [];
    const titleGroups = [...groups.entries()];
    if (titleGroups.length === 0) await onProgress?.(100, candidates);
    for (const [titleIndex, [, group]] of titleGroups.entries()) {
      const candidate = await this.buildCandidateFromResults(author, group[0].bookName, group, {
        sourceType: "author_search",
      });
      if (candidate) candidates.push(candidate);
      await onProgress?.(Math.round(((titleIndex + 1) / titleGroups.length) * 100), [...candidates]);
    }
    return candidates.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  }

  private async buildCandidateFromResults(
    author: string,
    title: string,
    results: SoNovelSearchResult[],
    options: {
      sourceType: "author_search" | "fanqie_rank";
      sourceLabel?: string | null;
      fallbackCategory?: string | null;
      fallbackIntro?: string | null;
      fallbackLatestChapter?: string | null;
      fallbackPublicationStatus?: string | null;
      fallbackWordCount?: string | null;
    },
  ): Promise<ReferenceBookCandidate | null> {
    if (results.length === 0) return null;
    const normalizedAuthor = normalizeReferenceIdentity(author);
    const normalizedTitle = normalizeReferenceIdentity(title);
    const sourcesById = new Map<number, Array<{ source: SoNovelSearchResult; priority: number }>>();
    results.forEach((source, priority) => {
      const entries = sourcesById.get(source.sourceId) ?? [];
      entries.push({ source, priority });
      sourcesById.set(source.sourceId, entries);
    });
    const checkedSources = await mapWithConcurrency(
      [...sourcesById.values()],
      SEARCH_VALIDATION_CONCURRENCY,
      async (sourceEntries) => {
        for (const { source, priority } of sourceEntries) {
          try {
            const checked = await this.soNovel.check(source.url);
            const checkedAuthor = normalizeReferenceIdentity(cleanAuthorName(checked.author));
            const checkedTitle = normalizeReferenceIdentity(source.bookName);
            if (checkedAuthor !== normalizedAuthor || checkedTitle !== normalizedTitle) continue;
            return {
              metadata: { ...source, ...checked },
              candidate: {
                sourceId: source.sourceId,
                sourceName: source.sourceName,
                url: source.url,
                chapterCount: checked.chapterCount,
                priority,
              } satisfies ReferenceBookSourceCandidate,
            };
          } catch {
            // Try the next URL from the same source before discarding that source.
          }
        }
        return null;
      },
    );
    const availableSources = checkedSources.filter((item): item is NonNullable<typeof item> => item !== null);
    const verified = availableSources
      .map((item) => item.candidate)
      .sort((left, right) => left.priority - right.priority);
    if (verified.length === 0) return null;
    const metadata = availableSources
      .sort((left, right) => left.candidate.priority - right.candidate.priority)[0]?.metadata ?? results[0];
    let chapterCount = 0;
    for (const source of verified) chapterCount = Math.max(chapterCount, source.chapterCount);
    return {
      id: buildCandidateId(author, metadata.bookName),
      author: cleanAuthorName(author),
      normalizedAuthor,
      title: metadata.bookName,
      normalizedTitle,
      sourceType: options.sourceType,
      sourceLabel: options.sourceLabel ?? null,
      category: nullable(metadata.category) ?? options.fallbackCategory ?? null,
      intro: nullable(metadata.intro) ?? options.fallbackIntro ?? null,
      latestChapter: nullable(metadata.latestChapter) ?? options.fallbackLatestChapter ?? null,
      publicationStatus: nullable(metadata.status) ?? options.fallbackPublicationStatus ?? null,
      wordCount: nullable(metadata.wordCount) ?? options.fallbackWordCount ?? null,
      chapterCount,
      sources: verified,
    };
  }

  private async storeAndImport(bookId: string, stagedFileName: string, taskId: string): Promise<void> {
    const existingBook = await prisma.referenceBook.findUnique({ where: { id: bookId } });
    if (!existingBook) throw new Error("书籍不存在。");
    await fs.promises.mkdir(this.libraryRoot, { recursive: true });
    const free = await fs.promises.statfs(this.libraryRoot);
    if (free.bavail * free.bsize < MIN_FREE_BYTES) throw new Error("磁盘可用空间不足 2GB，下载已停止。");
    const targetPath = path.join(this.libraryRoot, `${bookId}.epub`);
    const tempPath = `${targetPath}.${taskId}.tmp`;
    await fs.promises.rm(tempPath, { force: true });
    await this.soNovel.downloadStagedFile(stagedFileName, tempPath);
    const stat = await fs.promises.stat(tempPath);
    if (stat.size <= 0 || stat.size > MAX_FILE_SIZE) {
      await fs.promises.rm(tempPath, { force: true });
      throw new Error("EPUB 文件大小异常。");
    }
    const checksum = await sha256File(tempPath);
    const shouldImport = checksum !== existingBook.fileChecksum
      || !existingBook.knowledgeDocumentId
      || existingBook.importStatus !== "ready";
    await fs.promises.rename(tempPath, targetPath);
    await prisma.referenceBook.update({
      where: { id: bookId },
      data: {
        fileStatus: "available",
        fileName: stagedFileName,
        filePath: targetPath,
        fileSize: stat.size,
        fileChecksum: checksum,
        fileRemovedAt: null,
        importStatus: shouldImport ? "importing" : "ready",
      },
    });
    await this.soNovel.deleteStagedFile(stagedFileName).catch(() => undefined);
    if (shouldImport) await this.importBook(bookId, targetPath, stagedFileName);
  }

  private async importBook(bookId: string, filePath: string, fileName: string): Promise<void> {
    try {
      const book = await prisma.referenceBook.findUnique({ where: { id: bookId } });
      if (!book) throw new Error("书籍不存在。");
      const chapters = extractEpubChapters(filePath);
      const content = chapters
        .map((chapter) => `${chapter.title}\n\n${chapter.content}`)
        .filter((item) => item.trim().length > 0)
        .join("\n\n");
      if (content.length < 100) throw new Error("EPUB 未解析出有效正文。");
      const detail = book.knowledgeDocumentId
        ? await this.knowledgeService.createDocumentVersion(book.knowledgeDocumentId, { fileName, content })
        : await this.knowledgeService.createDocument({ title: `${book.title}（${book.author}）`, fileName, content, kind: "reference_import" });
      await prisma.referenceBook.update({
        where: { id: bookId },
        data: { importStatus: "ready", knowledgeDocumentId: detail.id },
      });
    } catch (error) {
      await prisma.referenceBook.update({ where: { id: bookId }, data: { importStatus: "failed" } });
      throw error;
    }
  }

  private async waitForSoNovelRecovery(): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await this.soNovel.health()) return;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

export const referenceLibraryService = new ReferenceLibraryService();
