export type ReferenceJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ReferenceBookSourceCandidate {
  sourceId: number;
  sourceName: string;
  url: string;
  chapterCount: number;
  priority: number;
}

export interface ReferenceBookCandidate {
  id: string;
  author: string;
  normalizedAuthor: string;
  title: string;
  normalizedTitle: string;
  sourceType?: "author_search" | "fanqie_rank";
  sourceLabel?: string | null;
  category?: string | null;
  intro?: string | null;
  latestChapter?: string | null;
  publicationStatus?: string | null;
  wordCount?: string | null;
  chapterCount: number;
  sources: ReferenceBookSourceCandidate[];
}

export interface ReferenceSearchJob {
  id: string;
  authors: string[];
  queryType?: "authors" | "fanqie_rank";
  queryLabel?: string | null;
  status: ReferenceJobStatus;
  progress: number;
  processedAuthors: number;
  totalAuthors: number;
  results: ReferenceBookCandidate[];
  lastError?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FanqieRankCategory {
  id: string;
  name: string;
}

export interface FanqieRankOptionGroup {
  gender: "male" | "female";
  genderLabel: string;
  lists: Array<{
    id: "read" | "new";
    label: string;
    categories: FanqieRankCategory[];
  }>;
}

export interface FanqieRankOptions {
  genders: FanqieRankOptionGroup[];
}

export interface FanqieRankSearchRequest {
  gender: "male" | "female";
  list: "read" | "new";
  categoryId: string;
  limit?: number;
}

export interface ReferenceBookSource {
  id: string;
  sourceId: number;
  sourceName: string;
  url: string;
  priority: number;
  availabilityStatus: string;
  chapterCount?: number | null;
  checkedAt?: string | null;
  lastError?: string | null;
}

export interface ReferenceBook {
  id: string;
  author: string;
  title: string;
  category?: string | null;
  latestChapter?: string | null;
  publicationStatus?: string | null;
  wordCount?: string | null;
  chapterCount?: number | null;
  fileStatus: string;
  importStatus: string;
  fileName?: string | null;
  fileSize?: number | null;
  knowledgeDocumentId?: string | null;
  sources: ReferenceBookSource[];
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceDownloadJob {
  id: string;
  bookId: string;
  searchJobId?: string | null;
  status: ReferenceJobStatus;
  progress: number;
  currentStage?: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string | null;
  book: Pick<ReferenceBook, "id" | "author" | "title" | "fileStatus" | "importStatus">;
  currentSource?: Pick<ReferenceBookSource, "id" | "sourceName" | "url"> | null;
  createdAt: string;
  updatedAt: string;
}
