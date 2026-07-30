CREATE TABLE "ReferenceSearchJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "authorsJson" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "processedAuthors" INTEGER NOT NULL DEFAULT 0,
  "totalAuthors" INTEGER NOT NULL,
  "resultJson" TEXT NOT NULL DEFAULT '[]',
  "lastError" TEXT,
  "heartbeatAt" DATETIME,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ReferenceBook" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "author" TEXT NOT NULL,
  "normalizedAuthor" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "normalizedTitle" TEXT NOT NULL,
  "category" TEXT,
  "intro" TEXT,
  "latestChapter" TEXT,
  "publicationStatus" TEXT,
  "wordCount" TEXT,
  "chapterCount" INTEGER,
  "fileStatus" TEXT NOT NULL DEFAULT 'missing',
  "importStatus" TEXT NOT NULL DEFAULT 'pending',
  "fileName" TEXT,
  "filePath" TEXT,
  "fileSize" INTEGER,
  "fileChecksum" TEXT,
  "knowledgeDocumentId" TEXT,
  "fileRemovedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ReferenceBook_knowledgeDocumentId_fkey" FOREIGN KEY ("knowledgeDocumentId") REFERENCES "KnowledgeDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ReferenceBookSource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bookId" TEXT NOT NULL,
  "sourceId" INTEGER NOT NULL,
  "sourceName" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "availabilityStatus" TEXT NOT NULL DEFAULT 'available',
  "chapterCount" INTEGER,
  "checkedAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ReferenceBookSource_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "ReferenceBook" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReferenceDownloadJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bookId" TEXT NOT NULL,
  "searchJobId" TEXT,
  "currentSourceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "currentStage" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "lastError" TEXT,
  "heartbeatAt" DATETIME,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ReferenceDownloadJob_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "ReferenceBook" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReferenceDownloadJob_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "ReferenceSearchJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ReferenceDownloadJob_currentSourceId_fkey" FOREIGN KEY ("currentSourceId") REFERENCES "ReferenceBookSource" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReferenceBook_normalizedAuthor_normalizedTitle_key" ON "ReferenceBook"("normalizedAuthor", "normalizedTitle");
CREATE UNIQUE INDEX "ReferenceBookSource_bookId_url_key" ON "ReferenceBookSource"("bookId", "url");
CREATE INDEX "ReferenceSearchJob_status_updatedAt_idx" ON "ReferenceSearchJob"("status", "updatedAt");
CREATE INDEX "ReferenceSearchJob_expiresAt_idx" ON "ReferenceSearchJob"("expiresAt");
CREATE INDEX "ReferenceBook_author_updatedAt_idx" ON "ReferenceBook"("author", "updatedAt");
CREATE INDEX "ReferenceBook_fileStatus_importStatus_idx" ON "ReferenceBook"("fileStatus", "importStatus");
CREATE INDEX "ReferenceBook_knowledgeDocumentId_idx" ON "ReferenceBook"("knowledgeDocumentId");
CREATE INDEX "ReferenceBookSource_bookId_priority_idx" ON "ReferenceBookSource"("bookId", "priority");
CREATE INDEX "ReferenceBookSource_sourceId_availabilityStatus_idx" ON "ReferenceBookSource"("sourceId", "availabilityStatus");
CREATE INDEX "ReferenceDownloadJob_status_createdAt_idx" ON "ReferenceDownloadJob"("status", "createdAt");
CREATE INDEX "ReferenceDownloadJob_bookId_createdAt_idx" ON "ReferenceDownloadJob"("bookId", "createdAt");
CREATE INDEX "ReferenceDownloadJob_searchJobId_idx" ON "ReferenceDownloadJob"("searchJobId");
