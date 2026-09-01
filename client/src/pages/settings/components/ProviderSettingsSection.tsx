import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { APIKeyStatus, ProviderBalanceStatus } from "@/api/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";
import ProviderStatusCard, { type ProviderCardViewModel } from "./ProviderStatusCard";

export default function ProviderSettingsSection(props: {
  providers: APIKeyStatus[];
  balances: ProviderBalanceStatus[];
  isBalanceLoading: boolean;
  testingProvider?: string;
  providerTestResults: Record<string, string>;
  refreshingModelProvider?: string;
  refreshingBalanceProvider?: string;
  reasoningProvider?: string;
  activeProvider?: string;
  onCreateCustomProvider: () => void;
  onOpenConfig: (provider: LLMProvider) => void;
  onTest: (provider: APIKeyStatus) => void;
  onRefreshModels: (provider: LLMProvider) => void;
  onRefreshBalance: (provider: LLMProvider) => void;
  onToggleReasoning: (provider: LLMProvider, reasoningEnabled: boolean) => void;
  onToggleActive: (provider: LLMProvider, isActive: boolean) => void;
}) {
  const {
    providers,
    balances,
    isBalanceLoading,
    testingProvider,
    providerTestResults,
    refreshingModelProvider,
    refreshingBalanceProvider,
    reasoningProvider,
    activeProvider,
    onCreateCustomProvider,
    onOpenConfig,
    onTest,
    onRefreshModels,
    onRefreshBalance,
    onToggleReasoning,
    onToggleActive,
  } = props;
  const balanceMap = new Map(balances.map((item) => [item.provider, item]));
  const viewModels: ProviderCardViewModel[] = providers.map((provider) => {
    const balance = balanceMap.get(provider.provider);
    const canRefreshBalance = Boolean(
      provider.kind === "builtin"
      && provider.isConfigured
      && (balance?.canRefresh ?? (provider.provider === "deepseek" || provider.provider === "siliconflow" || provider.provider === "kimi")),
    );
    return {
      provider,
      balance,
      isBalanceLoading: isBalanceLoading && !balance,
      isBalanceRefreshing: refreshingBalanceProvider === provider.provider,
      canRefreshBalance,
      isReasoningUpdating: reasoningProvider === provider.provider,
      isActiveUpdating: activeProvider === provider.provider,
      isTesting: testingProvider === provider.provider,
      testResult: providerTestResults[provider.provider],
    };
  });

  return (
    <Card id="settings-provider-section" className="min-w-0 scroll-mt-20 overflow-hidden">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle>模型厂商</CardTitle>
          <CardDescription className={AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}>
            先配置并启用至少一个文本模型；真实连通性请通过“测试连接”确认。
          </CardDescription>
        </div>
        <Button className={AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction} onClick={onCreateCustomProvider}>
          新增自定义厂商
        </Button>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3 md:grid-cols-2">
        {viewModels.map((item) => (
          <ProviderStatusCard
            key={item.provider.provider}
            item={item}
            onOpenConfig={onOpenConfig}
            onTest={onTest}
            onRefreshModels={onRefreshModels}
            onRefreshBalance={onRefreshBalance}
            onToggleReasoning={onToggleReasoning}
            onToggleActive={onToggleActive}
            isRefreshingModels={refreshingModelProvider === item.provider.provider}
          />
        ))}
      </CardContent>
    </Card>
  );
}
