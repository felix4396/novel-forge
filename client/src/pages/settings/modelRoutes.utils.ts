import type {
  APIKeyStatus,
  ModelRouteConnectivityStatus,
  ModelRoutesResponse,
  RagEmbeddingConnectivityStatus,
} from "@/api/settings";
import type {
  ModelRouteReasoningEffort,
  ModelRouteRequestProtocol,
  ModelRouteStructuredResponseFormat,
  ModelRouteTaskType,
} from "@ai-novel/shared/types/novel";

export interface RouteDraft {
  provider: string;
  model: string;
  temperature: string;
  maxTokens: string;
  reasoningEffort: ModelRouteReasoningEffort;
  requestProtocol: ModelRouteRequestProtocol;
  structuredResponseFormat: ModelRouteStructuredResponseFormat;
}

export interface StructuredFallbackDraft extends RouteDraft {
  enabled: boolean;
  maxRepairAttempts: string;
}

export type ConnectivityState = "idle" | "checking" | "healthy" | "failed";
type SavedModelRoute = ModelRoutesResponse["routes"][number];

export interface RouteSavePayload {
  taskType: ModelRouteTaskType;
  provider: string;
  model: string;
  temperature: number;
  maxTokens?: number | null;
  reasoningEffort: ModelRouteReasoningEffort;
  requestProtocol: ModelRouteRequestProtocol;
  structuredResponseFormat: ModelRouteStructuredResponseFormat;
}

export function getProviderConfig(providerConfigs: APIKeyStatus[], provider: string) {
  return providerConfigs.find((item) => item.provider === provider);
}

export function getProviderDisplayName(providerConfigs: APIKeyStatus[], provider: string): string {
  const config = getProviderConfig(providerConfigs, provider);
  return config?.displayName ?? config?.name ?? provider;
}

export function getPreferredModel(config: APIKeyStatus | undefined): string {
  return config?.currentModel || config?.models?.[0] || "";
}

export function getModelOptions(providerConfigs: APIKeyStatus[], provider: string, currentModel: string): string[] {
  const config = getProviderConfig(providerConfigs, provider);
  const models = config?.models ?? [];
  return [...new Set([currentModel, ...models].filter(Boolean))];
}

export function getStructuredResponseFormatOptions(
  requestProtocol: ModelRouteRequestProtocol,
): ModelRouteStructuredResponseFormat[] {
  return requestProtocol === "anthropic"
    ? ["prompt_json"]
    : ["auto", "json_schema", "json_object", "prompt_json"];
}

export function formatRequestProtocolLabel(protocol?: string | null): string {
  if (protocol === "openai_compatible") {
    return "OpenAI 兼容";
  }
  if (protocol === "anthropic") {
    return "Anthropic";
  }
  return "自动选择";
}

export function formatStructuredResponseFormatLabel(format?: string | null): string {
  if (format === "json_schema") {
    return "JSON Schema";
  }
  if (format === "json_object") {
    return "JSON Object";
  }
  if (format === "prompt_json") {
    return "Prompt JSON";
  }
  return "自动选择";
}

export function formatReasoningEffortLabel(effort?: string | null): string {
  if (effort === "none") {
    return "无推理";
  }
  if (effort === "minimal") {
    return "最小";
  }
  if (effort === "low") {
    return "低";
  }
  if (effort === "medium") {
    return "中";
  }
  if (effort === "high") {
    return "高";
  }
  if (effort === "xhigh") {
    return "极高";
  }
  return "自动选择";
}

export const MODEL_ROUTE_REASONING_EFFORT_OPTIONS: Array<{
  value: ModelRouteReasoningEffort;
  label: string;
}> = [
  { value: "auto", label: "自动选择" },
  { value: "none", label: "无推理" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

function parseTemperature(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMaxTokens(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

export function buildRouteSavePayload(taskType: ModelRouteTaskType, draft: RouteDraft): RouteSavePayload {
  return {
    taskType,
    provider: draft.provider,
    model: draft.model,
    temperature: parseTemperature(draft.temperature, 0.7),
    maxTokens: parseMaxTokens(draft.maxTokens),
    reasoningEffort: draft.reasoningEffort,
    requestProtocol: draft.requestProtocol,
    structuredResponseFormat: draft.structuredResponseFormat,
  };
}

export function isSameRouteDraft(draft: RouteDraft, route: SavedModelRoute | undefined): boolean {
  if (!route) {
    return false;
  }
  return draft.provider === route.provider
    && draft.model.trim() === route.model
    && parseTemperature(draft.temperature, 0.7) === route.temperature
    && parseMaxTokens(draft.maxTokens) === route.maxTokens
    && draft.reasoningEffort === (route.reasoningEffort ?? "auto")
    && draft.requestProtocol === route.requestProtocol
    && draft.structuredResponseFormat === route.structuredResponseFormat;
}

export function formatStructuredStatus(status: ModelRouteConnectivityStatus["structured"]): string {
  if (!status) {
    return "结构化诊断：未执行";
  }
  if (status.ok) {
    return `结构化检测正常 · 实际协议 ${formatRequestProtocolLabel(status.requestProtocol)} · 实际策略 ${formatStructuredResponseFormatLabel(status.strategy)}${status.reasoningForcedOff ? " · 会关闭 thinking" : ""}`;
  }
  return `结构化异常 · ${status.errorCategory ?? "unknown"} · ${status.error ?? "未知错误"}`;
}

export function formatConnectivityStatus(status?: ModelRouteConnectivityStatus | null): string {
  if (!status) {
    return "尚未检测生效路由。";
  }
  const parts: string[] = [];
  if (status.plain) {
    parts.push(
      status.plain.ok
        ? `普通连通正常${status.plain.latency != null ? ` · ${status.plain.latency}ms` : ""}`
        : `普通连通失败 · ${status.plain.error ?? "未知错误"}`,
    );
  }
  parts.push(formatStructuredStatus(status.structured));
  return `${status.provider} / ${status.model} · ${parts.join(" · ")}`;
}

export function formatRagEmbeddingStatus(status?: RagEmbeddingConnectivityStatus | null): string {
  if (!status) {
    return "RAG 向量尚未检测。";
  }
  if (status.ok) {
    return `${status.provider} / ${status.model} · 向量正常${status.vectorSize ? ` · ${status.vectorSize} 维` : ""}${status.latency != null ? ` · ${status.latency}ms` : ""}`;
  }
  return `${status.provider} / ${status.model} · 向量异常 · ${status.error ?? "未知错误"}`;
}

export function resolveConnectivityState(
  status: ModelRouteConnectivityStatus | undefined,
  checking: boolean,
): ConnectivityState {
  if (checking) {
    return "checking";
  }
  if (!status) {
    return "idle";
  }
  if ((status.plain && !status.plain.ok) || (status.structured && !status.structured.ok)) {
    return "failed";
  }
  if (status.plain?.ok || status.structured?.ok) {
    return "healthy";
  }
  return "idle";
}
