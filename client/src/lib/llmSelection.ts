import type { APIKeyStatus, LLMSelectionSettings } from "@/api/settings";
import type { LLMProvider } from "@ai-novel/shared/types/llm";

export interface LLMSelectionValue {
  provider: LLMProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export function sanitizeModelList(models: unknown): string[] {
  if (!Array.isArray(models)) {
    return [];
  }
  return Array.from(
    new Set(
      models
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

export function resolveModel(currentModel: string, models: string[]): string {
  const normalizedCurrent = currentModel.trim();
  if (normalizedCurrent && !isLikelyEmbeddingModel(normalizedCurrent)) {
    return normalizedCurrent;
  }
  return sanitizeModelList(models).filter((model) => !isLikelyEmbeddingModel(model))[0] ?? "";
}

export function isLikelyEmbeddingModel(model: string): boolean {
  return /embedding|embed|text-embedding|bge|gte|e5|arctic|\bm3e\b|minilm/i.test(model.trim());
}

export function getProviderSelectionModels(config: APIKeyStatus): string[] {
  return sanitizeModelList([config.currentModel, ...(config.models ?? [])])
    .filter((model) => !isLikelyEmbeddingModel(model));
}

export function isRunnableProviderConfig(config: APIKeyStatus): boolean {
  return (
    config.isConfigured
    && config.isActive
    && !isLikelyEmbeddingModel(config.currentModel)
    && getProviderSelectionModels(config).length > 0
  );
}

export function resolvePreferredLLMSelection(
  preferred: LLMSelectionSettings | LLMSelectionValue | null | undefined,
  providerConfigs: APIKeyStatus[],
  fallback?: Pick<LLMSelectionValue, "temperature" | "maxTokens">,
): LLMSelectionSettings | null {
  const runnableProviders = providerConfigs.filter(isRunnableProviderConfig);
  if (runnableProviders.length === 0) {
    return null;
  }

  const preferredProvider = preferred?.provider;
  const matchedConfig = preferredProvider
    ? runnableProviders.find((item) => item.provider === preferredProvider)
    : undefined;
  const selectedConfig = matchedConfig ?? runnableProviders[0];
  const selectedModel = matchedConfig ? preferred?.model ?? "" : "";
  const model = resolveModel(selectedModel, getProviderSelectionModels(selectedConfig));
  if (!model) {
    return null;
  }

  return {
    provider: selectedConfig.provider,
    model,
    temperature: preferred?.temperature ?? fallback?.temperature ?? 0.7,
    ...(preferred?.maxTokens !== undefined
      ? { maxTokens: preferred.maxTokens }
      : fallback?.maxTokens !== undefined
        ? { maxTokens: fallback.maxTokens }
        : {}),
  };
}
