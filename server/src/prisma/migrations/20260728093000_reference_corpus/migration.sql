ALTER TYPE "RagOwnerType" ADD VALUE IF NOT EXISTS 'reference_corpus';

CREATE TABLE "reference_corpora" (
    "id" TEXT NOT NULL,
    "novelId" TEXT,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'text_import',
    "status" TEXT NOT NULL DEFAULT 'active',
    "fileName" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "summary" TEXT,
    "extractionJson" TEXT NOT NULL DEFAULT '{}',
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "latestIndexStatus" "KnowledgeIndexStatus" NOT NULL DEFAULT 'idle',
    "lastIndexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_corpora_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reference_chunks" (
    "id" TEXT NOT NULL,
    "corpusId" TEXT NOT NULL,
    "chunkType" TEXT NOT NULL,
    "chapterIndex" INTEGER,
    "paragraphIndex" INTEGER,
    "chunkOrder" INTEGER NOT NULL,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "summary" TEXT,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "charCount" INTEGER NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "extractionJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reference_corpora_novelId_updatedAt_idx" ON "reference_corpora"("novelId", "updatedAt");
CREATE INDEX "reference_corpora_sourceType_status_idx" ON "reference_corpora"("sourceType", "status");
CREATE INDEX "reference_corpora_contentHash_idx" ON "reference_corpora"("contentHash");
CREATE UNIQUE INDEX "reference_chunks_corpusId_chunkOrder_key" ON "reference_chunks"("corpusId", "chunkOrder");
CREATE INDEX "reference_chunks_corpusId_chunkType_idx" ON "reference_chunks"("corpusId", "chunkType");
CREATE INDEX "reference_chunks_corpusId_chapterIndex_idx" ON "reference_chunks"("corpusId", "chapterIndex");

ALTER TABLE "reference_corpora" ADD CONSTRAINT "reference_corpora_novelId_fkey"
    FOREIGN KEY ("novelId") REFERENCES "Novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reference_chunks" ADD CONSTRAINT "reference_chunks_corpusId_fkey"
    FOREIGN KEY ("corpusId") REFERENCES "reference_corpora"("id") ON DELETE CASCADE ON UPDATE CASCADE;
