import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { APIKeyStatus, ProviderBalanceStatus } from "@/api/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";
import { isLikelyEmbeddingModel } from "@/lib/llmSelection";
import { ProviderRequestLimitSummary } from "./ProviderRequestLimitFields";
import { formatBalanceAmount, formatBalanceTime } from "../settingsFormatters";

export interface ProviderCardViewModel {
  provider: APIKeyStatus;
  balance?: ProviderBalanceStatus;
  isBalanceLoading: boolean;
  isBalanceRefreshing: boolean;
  canRefreshBalance: boolean;
  isReasoningUpdating: boolean;
  isActiveUpdating: boolean;
  isTesting: boolean;
  testResult?: string;
}

function getBalanceSummary(input: {
  provider: APIKeyStatus;
  balance?: ProviderBalanceStatus;
  isBalanceLoading: boolean;
}) {
  const { provider, balance, isBalanceLoading } = input;
  if (provider.kind === "custom") {
    return "自定义厂商暂不接入余额查询。";
  }
  if (isBalanceLoading) {
    return "正在查询余额...";
  }
  if (balance?.status === "available") {
    return `余额 ${formatBalanceAmount(balance.availableBalance, balance.currency)}`;
  }
  return balance?.error ?? balance?.message ?? (provider.isConfigured ? "当前暂未获取余额信息。" : "请先配置 API Key。");
}

type ProviderConnectionState = "unconfigured" | "inactive" | "enabled" | "testing" | "connected" | "failed";

function resolveConnectionState(input: {
  provider: APIKeyStatus;
  isTesting: boolean;
  testResult?: string;
}): ProviderConnectionState {
  const { provider, isTesting, testResult } = input;
  if (!provider.isConfigured || !provider.currentModel) {
    return "unconfigured";
  }
  if (!provider.isActive) {
    return "inactive";
  }
  if (isTesting) {
    return "testing";
  }
  if (!testResult) {
    return "enabled";
  }
  return testResult.startsWith("连接成功") ? "connected" : "failed";
}

function getConnectionBadgeLabel(state: ProviderConnectionState): string {
  switch (state) {
    case "connected":
      return "连接正常";
    case "failed":
      return "连接失败";
    case "testing":
      return "测试中";
    case "enabled":
      return "已启用";
    case "inactive":
      return "未启用";
    case "unconfigured":
      return "未配置";
  }
}

function getConnectionDescription(state: ProviderConnectionState): string {
  switch (state) {
    case "connected":
      return "连接测试通过，可用于对应创作任务。";
    case "failed":
      return "连接测试失败，请检查模型、地址、密钥或本地服务。";
    case "testing":
      return "正在测试模型服务连通性。";
    case "enabled":
      return "配置已启用；点击测试连接确认服务是否可达。";
    case "inactive":
      return "配置已保存但未启用。";
    case "unconfigured":
      return "完成配置后可用于创作任务。";
  }
}

function getConnectionBadgeClass(state: ProviderConnectionState): string {
  if (state === "connected") {
    return "bg-emerald-600 text-white hover:bg-emerald-600";
  }
  if (state === "failed") {
    return "bg-red-600 text-white hover:bg-red-600";
  }
  if (state === "enabled" || state === "testing") {
    return "bg-sky-600 text-white hover:bg-sky-600";
  }
  return "";
}

function getCardStateClass(state: ProviderConnectionState): string {
  if (state === "connected") {
    return "border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-950/20";
  }
  if (state === "failed") {
    return "border-red-500/40 bg-red-50/50 dark:bg-red-950/20";
  }
  if (state === "enabled" || state === "testing") {
    return "border-sky-500/35 bg-sky-50/40 dark:bg-sky-950/15";
  }
  return "border-border";
}

export default function ProviderStatusCard(props: {
  item: ProviderCardViewModel;
  onOpenConfig: (provider: LLMProvider) => void;
  onTest: (provider: APIKeyStatus) => void;
  onRefreshModels: (provider: LLMProvider) => void;
  onRefreshBalance: (provider: LLMProvider) => void;
  onToggleReasoning: (provider: LLMProvider, reasoningEnabled: boolean) => void;
  onToggleActive: (provider: LLMProvider, isActive: boolean) => void;
  isRefreshingModels: boolean;
}) {
  const {
    item,
    onOpenConfig,
    onTest,
    onRefreshModels,
    onRefreshBalance,
    onToggleReasoning,
    onToggleActive,
    isRefreshingModels,
  } = props;
  const { provider, balance } = item;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const imageModelLabel = provider.supportsImageGeneration
    ? provider.currentImageModel || provider.defaultImageModel || "未设置"
    : "不支持图像生成";
  const visibleModels = modelsOpen ? provider.models : provider.models.slice(0, 8);
  const isEmbeddingModel = isLikelyEmbeddingModel(provider.currentModel);
  const connectionState = resolveConnectionState({
    provider,
    isTesting: item.isTesting,
    testResult: item.testResult,
  });
  const isConfigured = connectionState !== "unconfigured";
  const testDisabledReason = !provider.isConfigured
    ? "配置 API Key 后可以测试连接。"
    : isEmbeddingModel
      ? "当前是向量模型，请在知识库向量设置中检查 embedding 连通性。"
      : "";
  const refreshDisabledReason = provider.isConfigured ? "" : "配置 API Key 后可以刷新模型列表。";
  const activeToggleDisabled = item.isActiveUpdating || (!provider.isConfigured && !provider.isActive);
  const activeToggleTitle = !provider.isConfigured && !provider.isActive
    ? "请先完成厂商配置。"
    : provider.isActive
      ? "停用后不会作为普通模型厂商参与选择。"
      : "启用后可作为普通模型厂商参与选择。";
  const connectionDescription = isEmbeddingModel
    ? "当前模型是向量模型；请在知识库向量设置中检查 embedding 连通性。"
    : getConnectionDescription(connectionState);

  return (
    <div
      className={cn(
        "min-w-0 rounded-md border p-3 transition-colors",
        getCardStateClass(connectionState),
      )}
    >
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className={`font-medium ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>{provider.name}</div>
            {provider.kind === "custom" ? <Badge variant="outline">自定义</Badge> : null}
          </div>
          <div className={`text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            {connectionDescription}
          </div>
        </div>
        <Badge
          variant={isConfigured ? "default" : "outline"}
          className={getConnectionBadgeClass(connectionState)}
        >
          {getConnectionBadgeLabel(connectionState)}
        </Badge>
      </div>

      <div className="mb-3 flex flex-col gap-2 rounded-md border bg-background/70 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">厂商启用</div>
          <div className={`text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            {provider.isActive ? "当前配置已启用。" : "当前配置未启用，不会作为普通模型厂商参与选择。"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2" title={activeToggleTitle}>
          <span className="text-xs text-muted-foreground">{provider.isActive ? "已启用" : "未启用"}</span>
          <Switch
            checked={provider.isActive}
            disabled={activeToggleDisabled}
            onCheckedChange={(checked) => onToggleActive(provider.provider, checked)}
          />
        </div>
      </div>

      <div className="mb-3 grid min-w-0 gap-2 text-sm md:grid-cols-2">
        <div className="min-w-0 rounded-md border bg-background/70 p-2">
          <div className="text-xs text-muted-foreground">文本模型</div>
          <div className={`mt-1 font-medium ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            {provider.currentModel || "-"}
          </div>
        </div>
        <div className="min-w-0 rounded-md border bg-background/70 p-2">
          <div className="text-xs text-muted-foreground">图像模型</div>
          <div className={`mt-1 font-medium ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            {imageModelLabel}
          </div>
        </div>
      </div>

      <div className={`mb-3 rounded-md border border-dashed bg-background/70 p-3 text-sm text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
        {getBalanceSummary({
          provider,
          balance,
          isBalanceLoading: item.isBalanceLoading,
        })}
      </div>

      {item.testResult ? (
        <div className={`mb-3 rounded-md border bg-background/70 p-3 text-sm text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
          {item.testResult}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button size="sm" className="w-full sm:w-auto" onClick={() => onOpenConfig(provider.provider)}>
          {provider.kind === "custom" ? "编辑" : "配置"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="w-full sm:w-auto"
          title={testDisabledReason}
          onClick={() => onTest(provider)}
          disabled={!provider.isConfigured || isEmbeddingModel || item.isTesting}
        >
          {item.isTesting ? "测试中..." : "测试连接"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="w-full sm:w-auto"
          title={refreshDisabledReason}
          onClick={() => onRefreshModels(provider.provider)}
          disabled={!provider.isConfigured || isRefreshingModels}
        >
          {isRefreshingModels ? "刷新中..." : "刷新模型"}
        </Button>
        {provider.kind === "builtin" ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            title={item.canRefreshBalance ? "" : "当前厂商不能直接刷新余额。"}
            onClick={() => onRefreshBalance(provider.provider)}
            disabled={!item.canRefreshBalance || item.isBalanceRefreshing}
          >
            {item.isBalanceRefreshing ? "余额刷新中..." : "刷新余额"}
          </Button>
        ) : null}
      </div>

      <div className="mt-3 border-t pt-3">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium text-primary"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          <span>高级详情</span>
          <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", advancedOpen ? "rotate-180" : "")} />
        </button>
      </div>

      {advancedOpen ? (
        <div className="mt-3 space-y-3">
          <div className={`text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            API 地址：{provider.currentBaseURL || "-"}
          </div>
          <ProviderRequestLimitSummary
            concurrencyLimit={provider.concurrencyLimit}
            requestIntervalMs={provider.requestIntervalMs}
          />
          <div className="flex flex-col gap-3 rounded-md border bg-background/60 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-medium text-muted-foreground">思考功能</div>
              <div className={`text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
                {provider.reasoningEnabled
                  ? "当前会返回并展示模型思考内容。"
                  : "当前会隐藏思考内容；MiniMax 会自动清洗正文里的 thinking 内容。"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">{provider.reasoningEnabled ? "已开启" : "已关闭"}</span>
              <Switch
                checked={provider.reasoningEnabled}
                disabled={item.isReasoningUpdating}
                onCheckedChange={(checked) => onToggleReasoning(provider.provider, checked)}
              />
            </div>
          </div>

          <div className="rounded-md border border-dashed bg-background/60 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">余额明细</div>
              {balance?.status === "available" ? (
                <Badge variant="outline">最近刷新 {formatBalanceTime(balance.fetchedAt)}</Badge>
              ) : null}
            </div>
            {provider.kind === "custom" ? (
              <div className={`text-sm text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
                自定义 OpenAI 兼容厂商暂不接入余额查询。
              </div>
            ) : balance?.status === "available" ? (
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                {balance.cashBalance !== null ? <div>现金余额：{formatBalanceAmount(balance.cashBalance, balance.currency)}</div> : null}
                {balance.voucherBalance !== null ? <div>代金券余额：{formatBalanceAmount(balance.voucherBalance, balance.currency)}</div> : null}
                {balance.chargeBalance !== null ? <div>充值余额：{formatBalanceAmount(balance.chargeBalance, balance.currency)}</div> : null}
                {balance.toppedUpBalance !== null ? <div>累计充值：{formatBalanceAmount(balance.toppedUpBalance, balance.currency)}</div> : null}
                {balance.grantedBalance !== null ? <div>赠送额度：{formatBalanceAmount(balance.grantedBalance, balance.currency)}</div> : null}
              </div>
            ) : (
              <div className={`text-sm text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
                {balance?.error ?? balance?.message ?? (provider.isConfigured ? "当前暂未获取余额信息。" : "请先配置 API Key。")}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex min-w-0 flex-wrap gap-1">
              {visibleModels.map((model) => (
                <Badge
                  key={model}
                  variant={model === provider.currentModel ? "default" : "outline"}
                  className={model === provider.currentModel
                    ? "max-w-full whitespace-normal break-words bg-primary text-left [overflow-wrap:anywhere]"
                    : "max-w-full whitespace-normal break-words text-left [overflow-wrap:anywhere]"}
                >
                  {model}
                </Badge>
              ))}
            </div>
            {provider.models.length > 8 ? (
              <button
                type="button"
                className="text-xs font-medium text-primary transition-opacity hover:opacity-80"
                onClick={() => setModelsOpen((prev) => !prev)}
              >
                {modelsOpen ? "收起模型列表" : `展开全部 ${provider.models.length} 个模型`}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
