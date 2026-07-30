import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

interface SoNovelEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface SoNovelSearchResult {
  sourceId: number;
  sourceName: string;
  url: string;
  bookName: string;
  author?: string;
  intro?: string;
  category?: string;
  latestChapter?: string;
  lastUpdateTime?: string;
  status?: string;
  wordCount?: string;
}

export interface SoNovelBookCheck {
  sourceId: number;
  url: string;
  bookName: string;
  author: string;
  category?: string;
  intro?: string;
  status?: string;
  latestChapter?: string;
  chapterCount: number;
  sampledChapters: number;
  available: boolean;
}

export interface SoNovelLocalBook {
  name: string;
  size: number;
  timestamp: number;
}

export class SoNovelClient {
  private readonly baseUrl = (process.env.SONOVEL_BASE_URL ?? "http://127.0.0.1:7765").replace(/\/$/, "");

  private async json<T>(path: string, timeoutMs: number): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    const payload = await response.json() as SoNovelEnvelope<T>;
    if (!response.ok || payload.code !== 200) {
      throw new Error(payload.message || `SoNovel request failed (${response.status})`);
    }
    return payload.data;
  }

  async health(): Promise<boolean> {
    try {
      await this.json<unknown>("/config", 5_000);
      return true;
    } catch {
      return false;
    }
  }

  search(keyword: string): Promise<SoNovelSearchResult[]> {
    return this.json(`/search/aggregated?kw=${encodeURIComponent(keyword)}`, 90_000);
  }

  check(url: string): Promise<SoNovelBookCheck> {
    return this.json(`/book-check?url=${encodeURIComponent(url)}`, 90_000);
  }

  download(url: string, taskId: string): Promise<{ fileName: string; bookName: string; author: string }> {
    const query = new URLSearchParams({ url, taskId, format: "epub", language: "zh-CN" });
    return this.json(`/book-fetch?${query.toString()}`, 30 * 60_000);
  }

  listLocalBooks(): Promise<SoNovelLocalBook[]> {
    return this.json("/local-books", 10_000);
  }

  async downloadStagedFile(fileName: string, targetPath: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/book-download?filename=${encodeURIComponent(fileName)}`, {
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`无法读取 SoNovel 暂存文件 (${response.status})`);
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 200 * 1024 * 1024) {
      throw new Error("EPUB 超过 200MB 安全限制");
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(targetPath));
  }

  async deleteStagedFile(fileName: string): Promise<void> {
    await this.json(`/book-delete?filename=${encodeURIComponent(fileName)}`, 10_000);
  }
}
