import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type {
  ModelRouteReasoningEffort,
  ModelRouteRequestProtocol,
  ModelRouteStructuredResponseFormat,
  ModelRouteTaskType,
} from "@ai-novel/shared/types/novel";
import { getLLM, resolveLLMClientOptions } from "./factory";
import {
  MODEL_ROUTE_TASK_TYPES,
  resolveModel,
  toStructuredOutputStrategy,
} from "./modelRouter";
import { invokeStructuredLlmDetailed, summarizeStructuredOutputFailure } from "./structuredInvoke";
import { getStructuredFallbackSettings } from "./structuredFallbackSettings";
import {
  resolveStructuredOutputProfile,
  selectStructuredOutputStrategy,
  type StructuredOutputStrategy,
} from "./structuredOutput";
import { ragServices } from "../services/rag";
import { getRagEmbeddingSettings } from "../services/settings/RagSettingsService";

export type ConnectivityProbeMode = "plain" | "structured" | "both";

const STRUCTURED_PROBE_SCHEMA = z.object({
  status: z.literal("ok"),
});

export interface ConnectivityProbeStatus {
  ok: boolean;
  latency: number | null;
  error: string | null;
  requestProtocol: ModelRouteRequestProtocol | null;
}

export interface StructuredConnectivityProbeStatus extends ConnectivityProbeStatus {
  strategy: string | null;
  reasoningForcedOff: boolean;
  fallbackAvailable: boolean;
  fallbackUsed: boolean;
  errorCategory: string | null;
  nativeJsonObject: boolean;
  nativeJsonSchema: boolean;
  profileFamily: string | null;
}

export interface LLMConnectivityStatus extends ConnectivityProbeStatus {
  provider: LLMProvider;
  model: string;
  plain: ConnectivityProbeStatus | null;
  structured: StructuredConnectivityProbeStatus | null;
}

export interface ModelRouteConnectivityStatus extends LLMConnectivityStatus {
  taskType: ModelRouteTaskType;
}

export interface RagEmbeddingConnectivityStatus {
  ok: boolean;
  latency: number | null;
  error: string | null;
  provider: LLMProvider;
  model: string;
  vectorSize: number | null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    if (/Cannot read properties of undefined \(reading ['"]message['"]\)/.test(error.message)) {
      return "模型服务返回了非标准或空的 OpenAI Chat Completions 响应，系统无法解析 assistant message。请检查模型 ID、API 地址是否为 /v1，或换用兼容 OpenAI Chat Completions 的模型。";
    }
    return error.message.trim();
  }
  return "连接测试失败。";
}

function getMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("")
    .trim();
}

function getProtocolCandidates(input: {
  provider: LLMProvider;
  preferred?: ModelRouteRequestProtocol;
}): ModelRouteRequestProtocol[] {
  const { provider, preferred } = input;
  if (preferred === "openai_compatible" || preferred === "anthropic") {
    return [preferred];
  }
  return provider === "anthropic" ? ["anthropic"] : ["openai_compatible"];
}

function getStructuredFormatCandidates(input: {
  provider: LLMProvider;
  model?: string;
  baseURL?: string;
  requestProtocol: ModelRouteRequestProtocol;
  preferred?: ModelRouteStructuredResponseFormat;
}): ModelRouteStructuredResponseFormat[] {
  if (input.requestProtocol === "anthropic") {
    return ["prompt_json"];
  }
  const profile = resolveStructuredOutputProfile({
    provider: input.provider,
    model: input.model,
    baseURL: input.baseURL,
    requestProtocol: input.requestProtocol,
    executionMode: "structured",
  });
  const profileFirst = selectStructuredOutputStrategy(profile, STRUCTURED_PROBE_SCHEMA);
  const fallbackOrder: StructuredOutputStrategy[] = profileFirst === "json_schema"
    ? ["json_schema", "json_object", "prompt_json"]
    : profileFirst === "json_object"
      ? ["json_object", "prompt_json", "json_schema"]
      : ["prompt_json", "json_object", "json_schema"];
  const preferred = input.preferred;
  if (preferred === "json_schema" || preferred === "json_object" || preferred === "prompt_json") {
    return [preferred, ...fallbackOrder].filter((value, index, array) => array.indexOf(value) === index);
  }
  return fallbackOrder;
}

async function resolveStructuredFallbackAvailability(input: {
  provider: LLMProvider;
  model: string;
}): Promise<boolean> {
  const settings = await getStructuredFallbackSettings();
  return Boolean(
    settings.enabled
      && settings.model.trim().length > 0
      && !(
        settings.provider === input.provider
        && settings.model === input.model
      ),
  );
}

async function testPlainConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  reasoningEffort?: ModelRouteReasoningEffort;
  requestProtocol?: ModelRouteRequestProtocol;
}): Promise<LLMConnectivityStatus> {
  try {
    const resolved = await resolveLLMClientOptions(input.provider, {
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      model: input.model,
      temperature: 0.1,
      maxTokens: 16,
      reasoningEffort: input.reasoningEffort,
      requestProtocol: input.requestProtocol,
    });
    const llm = await getLLM(input.provider, {
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      model: resolved.model,
      temperature: 0.1,
      maxTokens: 16,
      reasoningEffort: resolved.reasoningEffort,
      requestProtocol: resolved.requestProtocol,
    });
    const start = Date.now();
    const message = await llm.invoke([new HumanMessage("请只回复 ok")]);
    if (!getMessageText(message)) {
      throw new Error("模型服务返回了空内容，无法确认普通对话连通性。请检查模型 ID 或供应商响应格式。");
    }
    const plain = {
      ok: true,
      latency: Date.now() - start,
      error: null,
      requestProtocol: resolved.requestProtocol,
    };
    return {
      provider: resolved.provider,
      model: resolved.model,
      ok: plain.ok,
      latency: plain.latency,
      error: plain.error,
      requestProtocol: plain.requestProtocol,
      plain,
      structured: null,
    };
  } catch (error) {
    const plain = {
      ok: false,
      latency: null,
      error: toErrorMessage(error),
      requestProtocol: input.requestProtocol ?? null,
    };
    return {
      provider: input.provider,
      model: input.model?.trim() || "",
      ok: plain.ok,
      latency: plain.latency,
      error: plain.error,
      requestProtocol: plain.requestProtocol,
      plain,
      structured: null,
    };
  }
}

async function testStructuredConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  reasoningEffort?: ModelRouteReasoningEffort;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredResponseFormat?: ModelRouteStructuredResponseFormat;
}): Promise<LLMConnectivityStatus> {
  let resolved: Awaited<ReturnType<typeof resolveLLMClientOptions>> | null = null;
  let fallbackAvailable = false;
  try {
    resolved = await resolveLLMClientOptions(input.provider, {
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      model: input.model,
      temperature: 0.2,
      maxTokens: 256,
      reasoningEffort: input.reasoningEffort,
      requestProtocol: input.requestProtocol,
      structuredStrategy: toStructuredOutputStrategy(input.structuredResponseFormat ?? "auto") ?? undefined,
      executionMode: "plain",
    });
    fallbackAvailable = await resolveStructuredFallbackAvailability({
      provider: resolved.provider,
      model: resolved.model,
    });
    const startedAt = Date.now();
    const result = await invokeStructuredLlmDetailed({
      provider: resolved.provider,
      model: resolved.model,
      apiKey: input.apiKey,
      baseURL: input.baseURL ?? resolved.baseURL,
      temperature: 0.2,
      maxTokens: 256,
      reasoningEffort: resolved.reasoningEffort,
      taskType: "planner",
      requestProtocol: resolved.requestProtocol,
      structuredStrategy: toStructuredOutputStrategy(input.structuredResponseFormat ?? "auto") ?? undefined,
      label: "llm.connectivity.structured_probe",
      schema: STRUCTURED_PROBE_SCHEMA,
      messages: [
        new SystemMessage("你正在执行结构化输出兼容性探针。必须只输出合法 JSON。"),
        new HumanMessage("请输出一个 JSON 对象，字段 status 的值必须是 ok。"),
      ],
      maxRepairAttempts: 1,
      disableFallbackModel: true,
    });
    const structured: StructuredConnectivityProbeStatus = {
      ok: true,
      latency: Date.now() - startedAt,
      error: null,
      requestProtocol: resolved.requestProtocol,
      strategy: result.diagnostics.strategy,
      reasoningForcedOff: result.diagnostics.reasoningForcedOff,
      fallbackAvailable,
      fallbackUsed: result.diagnostics.fallbackUsed,
      errorCategory: null,
      nativeJsonObject: result.diagnostics.profile.nativeJsonObject,
      nativeJsonSchema: result.diagnostics.profile.nativeJsonSchema,
      profileFamily: result.diagnostics.profile.family,
    };
    return {
      provider: resolved.provider,
      model: resolved.model,
      ok: structured.ok,
      latency: structured.latency,
      error: structured.error,
      requestProtocol: structured.requestProtocol,
      plain: null,
      structured,
    };
  } catch (error) {
    const summary = summarizeStructuredOutputFailure({
      error,
      fallbackAvailable,
    });
    const structured: StructuredConnectivityProbeStatus = {
      ok: false,
      latency: null,
      error: toErrorMessage(error),
      requestProtocol: input.requestProtocol ?? resolved?.requestProtocol ?? null,
      strategy: null,
      reasoningForcedOff: false,
      fallbackAvailable,
      fallbackUsed: false,
      errorCategory: summary.category,
      nativeJsonObject: false,
      nativeJsonSchema: false,
      profileFamily: null,
    };
    return {
      provider: resolved?.provider ?? input.provider,
      model: resolved?.model ?? input.model?.trim() ?? "",
      ok: structured.ok,
      latency: structured.latency,
      error: structured.error,
      requestProtocol: structured.requestProtocol,
      plain: null,
      structured,
    };
  }
}

async function mergeProbeStatuses(input: {
  provider: LLMProvider;
  model?: string;
  plain: LLMConnectivityStatus | null;
  structured: LLMConnectivityStatus | null;
}): Promise<LLMConnectivityStatus> {
  const provider = input.plain?.provider ?? input.structured?.provider ?? input.provider;
  const model = input.plain?.model ?? input.structured?.model ?? input.model?.trim() ?? "";
  const top = input.plain?.plain ?? input.structured?.structured ?? {
    ok: false,
    latency: null,
    error: "连接测试失败。",
    requestProtocol: null,
  };
  return {
    provider,
    model,
    ok: top.ok,
    latency: top.latency,
    error: top.error,
    requestProtocol: top.requestProtocol,
    plain: input.plain?.plain ?? null,
    structured: input.structured?.structured ?? null,
  };
}

async function testConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  probeMode?: ConnectivityProbeMode;
  reasoningEffort?: ModelRouteReasoningEffort;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredResponseFormat?: ModelRouteStructuredResponseFormat;
}): Promise<LLMConnectivityStatus> {
  const probeMode = input.probeMode ?? "both";
  let plain: LLMConnectivityStatus | null = null;
  let structured: LLMConnectivityStatus | null = null;
  if (probeMode === "plain" || probeMode === "both") {
    for (const requestProtocol of getProtocolCandidates({ provider: input.provider, preferred: input.requestProtocol })) {
      plain = await testPlainConnection({ ...input, requestProtocol });
      if (plain.ok) {
        break;
      }
    }
  }
  if (probeMode === "structured" || probeMode === "both") {
    for (const requestProtocol of getProtocolCandidates({ provider: input.provider, preferred: input.requestProtocol })) {
      for (const structuredResponseFormat of getStructuredFormatCandidates({
        provider: input.provider,
        model: input.model,
        baseURL: input.baseURL,
        requestProtocol,
        preferred: input.structuredResponseFormat,
      })) {
        structured = await testStructuredConnection({ ...input, requestProtocol, structuredResponseFormat });
        if (structured.ok) {
          break;
        }
      }
      if (structured?.ok) {
        break;
      }
    }
  }
  return mergeProbeStatuses({
    provider: input.provider,
    model: input.model,
    plain,
    structured,
  });
}

async function testRagEmbeddingConnectivity(): Promise<RagEmbeddingConnectivityStatus> {
  const settings = await getRagEmbeddingSettings();
  const startedAt = Date.now();
  try {
    const result = await ragServices.embeddingService.embedTexts([
      "RAG embedding connectivity probe for Reference Corpus semantic indexing.",
    ]);
    const vectorSize = result.vectors[0]?.length ?? 0;
    return {
      ok: vectorSize > 0,
      latency: Date.now() - startedAt,
      error: vectorSize > 0 ? null : "Embedding 响应未返回向量。",
      provider: result.provider,
      model: result.model,
      vectorSize: vectorSize > 0 ? vectorSize : null,
    };
  } catch (error) {
    return {
      ok: false,
      latency: null,
      error: toErrorMessage(error),
      provider: settings.embeddingProvider,
      model: settings.embeddingModel,
      vectorSize: null,
    };
  }
}

async function testModelRoutes(taskTypes: readonly ModelRouteTaskType[] = MODEL_ROUTE_TASK_TYPES): Promise<{
  testedAt: string;
  statuses: ModelRouteConnectivityStatus[];
  ragEmbedding: RagEmbeddingConnectivityStatus;
}> {
  const resolvedRoutes = await Promise.all(taskTypes.map(async (taskType) => ({
    taskType,
    ...(await resolveModel(taskType)),
  })));
  const ragEmbeddingPromise = testRagEmbeddingConnectivity();

  const dedupedChecks = new Map<string, Promise<LLMConnectivityStatus>>();
  for (const route of resolvedRoutes) {
    const key = [
      route.provider,
      route.model,
      route.reasoningEffort,
      route.requestProtocol,
      route.structuredResponseFormat,
    ].join("::");
    if (!dedupedChecks.has(key)) {
      dedupedChecks.set(key, testConnection({
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        requestProtocol: route.requestProtocol,
        structuredResponseFormat: route.structuredResponseFormat,
        probeMode: "both",
      }));
    }
  }

  const statuses = await Promise.all(resolvedRoutes.map(async (route) => {
    const key = [
      route.provider,
      route.model,
      route.reasoningEffort,
      route.requestProtocol,
      route.structuredResponseFormat,
    ].join("::");
    const result = await dedupedChecks.get(key)!;
    return {
      taskType: route.taskType,
      provider: route.provider,
      model: route.model,
      ok: result.ok,
      latency: result.latency,
      error: result.error,
      requestProtocol: result.requestProtocol,
      plain: result.plain,
      structured: result.structured,
    };
  }));

  return {
    testedAt: new Date().toISOString(),
    statuses,
    ragEmbedding: await ragEmbeddingPromise,
  };
}

export const llmConnectivityService = {
  testConnection,
  testModelRoutes,
  testRagEmbeddingConnectivity,
};
