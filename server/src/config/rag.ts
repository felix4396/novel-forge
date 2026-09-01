import {
  LLM_PROVIDERS,
  isBuiltinLLMProvider,
  type LLMProvider,
} from "@ai-novel/shared/types/llm";

export type EmbeddingProvider = LLMProvider;

const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProvider = "openai";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export function asEmbeddingProvider(rawValue: string | undefined): EmbeddingProvider {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return DEFAULT_EMBEDDING_PROVIDER;
  }

  const normalizedBuiltin = trimmed.toLowerCase();
  if (isBuiltinLLMProvider(normalizedBuiltin)) {
    return normalizedBuiltin;
  }

  return trimmed;
}

export interface RagContextScope {
  tenantId?: string;
  novelId?: string;
  worldId?: string;
  ownerTypes?: string[];
}

export const ragConfig = {
  enabled: true,
  verboseLog: false,
  defaultTenantId: "default",
  embeddingProvider: DEFAULT_EMBEDDING_PROVIDER,
  embeddingModel: DEFAULT_EMBEDDING_MODEL,
  embeddingVersion: 1,
  embeddingBatchSize: 64,
  embeddingConcurrency: 4,
  embeddingTimeoutMs: 30000,
  embeddingMaxRetries: 2,
  embeddingRetryBaseMs: 500,
  qdrantUrl: "http://127.0.0.1:6333",
  qdrantApiKey: "",
  qdrantCollection: "ai_novel_chunks_v1",
  qdrantTimeoutMs: 30000,
  qdrantUpsertMaxBytes: 24 * 1024 * 1024,
  qdrantUpsertConcurrency: 3,
  chunkSize: 800,
  chunkOverlap: 120,
  vectorCandidates: 40,
  keywordCandidates: 40,
  finalTopK: 8,
  workerPollMs: 2500,
  workerMaxAttempts: 5,
  workerRetryBaseMs: 5000,
  httpTimeoutMs: 30000,
  retrievalTraceSampleRate: 1,
  retrievalTraceRetentionDays: 14,
  retrievalTraceQueryPersistMode: "preview" as "digest_only" | "preview" | "full",
  rerankerEnabled: false,
  rerankerEndpoint: "",
  rerankerApiKey: "",
  rerankerModel: "bge-reranker-v2-m3",
  rerankerTimeoutMs: 10000,
  rerankerCandidateLimit: 0,
  contextualRetrievalEnabled: false,
  contextualRetrievalVersion: 1,
  contextualRetrievalTimeoutMs: 15000,
  contextualRetrievalConcurrency: 2,
  providerPriority: [...LLM_PROVIDERS] as EmbeddingProvider[],
};
