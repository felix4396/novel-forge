import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const settingsDir = dirname(fileURLToPath(import.meta.url));

function readSettingsSource(relativePath) {
  return readFileSync(join(settingsDir, relativePath), "utf8");
}

test("provider cards distinguish saved configuration from live connectivity", () => {
  const source = readSettingsSource("components/ProviderStatusCard.tsx");

  assert.match(source, /return "已启用";/, "enabled provider state should be labeled as saved/enabled config");
  assert.match(source, /return "连接正常";/, "successful tests should get a distinct live connectivity label");
  assert.match(source, /return "连接失败";/, "failed tests should get a distinct live connectivity label");
  assert.doesNotMatch(source, /return "可用";/, "provider cards should not call untested configuration usable");
});

test("provider cards expose activation separately from connection testing", () => {
  const source = readSettingsSource("components/ProviderStatusCard.tsx");

  assert.match(source, /厂商启用/, "provider cards should expose an explicit activation control");
  assert.match(source, /onToggleActive\(provider\.provider, checked\)/, "activation switch should call the provider active handler");
  assert.match(
    source,
    /isEmbeddingModel[\s\S]*disabled=\{!provider\.isConfigured \|\| isEmbeddingModel \|\| item\.isTesting\}/,
    "embedding models should not use the text-model connectivity test",
  );
});

test("settings page only shows pending provider actions while mutations are pending", () => {
  const source = readSettingsSource("SettingsPage.tsx");

  assert.match(
    source,
    /testingProvider=\{testMutation\.isPending \? testMutation\.variables\?\.provider : undefined\}/,
    "test buttons should not remain stuck after a failed or completed mutation",
  );
  assert.match(
    source,
    /activeProvider=\{toggleActiveMutation\.isPending \? toggleActiveMutation\.variables\?\.provider : undefined\}/,
    "activation switches should not remain stuck after completion",
  );
});

test("provider activation cache updates immediately and rolls back on failure", () => {
  const source = readSettingsSource("SettingsPage.tsx");

  assert.match(
    source,
    /onMutate: async \(variables\)[\s\S]*patchProviderInCache\(variables\.provider, \{ isActive: variables\.isActive \}\)/,
    "activation switches should update cached provider state before the refetch returns",
  );
  assert.match(
    source,
    /context\?\.previousApiKeys[\s\S]*queryClient\.setQueryData\(queryKeys\.settings\.apiKeys, context\.previousApiKeys\)/,
    "failed activation updates should restore the previous provider cache",
  );
  assert.match(
    source,
    /syncProviderSaveResponseInCache\(response\)/,
    "successful activation updates should reconcile the provider cache with the backend response",
  );
  assert.match(
    source,
    /refreshProviderQueriesInBackground\(\)/,
    "activation updates should refresh dependent provider state without blocking the switch",
  );
  assert.doesNotMatch(
    source,
    /onSuccess: async \(response, variables\)[\s\S]*await invalidateProviderQueries\(\)/,
    "activation updates should not stay pending while slow route connectivity checks refetch",
  );
});

test("connection test failures stay inline instead of global error toasts", () => {
  const source = readSettingsSource("../../api/settings.ts");

  assert.match(
    source,
    /"\/llm\/test", payload, \{ silentErrorStatuses: \[400\] \}/,
    "expected connection-test failures should be handled by the settings UI, not the global axios toast",
  );
});

test("custom provider status exposes cached or upstream model lists", () => {
  const source = readSettingsSource("../../../../server/src/routes/settings.ts");

  assert.match(
    source,
    /async function buildCustomProviderStatus/,
    "custom provider status needs async model lookup instead of a one-model static fallback",
  );
  assert.match(
    source,
    /await getProviderModels\(item\.provider,[\s\S]*fallbackModels: \[currentModel\]/,
    "custom provider status should reuse cached/upstream models with current model only as fallback",
  );
  assert.doesNotMatch(
    source,
    /const models = currentModel \? \[currentModel\] : \[\];/,
    "custom provider status should not collapse model choices to only the saved current model",
  );
});

test("model route saves do not stay pending while compatibility detection refreshes", () => {
  const source = readSettingsSource("ModelRoutesPage.tsx");

  assert.match(
    source,
    /function refreshConnectivityInBackground\(\)[\s\S]*void queryClient\.invalidateQueries\(\{ queryKey: queryKeys\.settings\.modelRouteConnectivity \}\)/,
    "model route compatibility checks should refresh in the background after saves",
  );
  assert.match(
    source,
    /setActionResult\(`?保存完成[\s\S]*后台重新检测生效路由/,
    "save completion copy should distinguish saved state from background compatibility detection",
  );
  assert.doesNotMatch(
    source,
    /onSuccess: async[\s\S]*queryKeys\.settings\.modelRouteConnectivity/,
    "save mutations should not await slow model route compatibility detection",
  );
  assert.match(
    source,
    /clearSavedRouteDrafts\(payloads\.map\(\(payload\) => payload\.taskType\)\)/,
    "bulk saves should clear saved route drafts so the pending count drops immediately",
  );
});

test("model route cards separate saved preferences from detected execution strategy", () => {
  const pageSource = readSettingsSource("ModelRoutesPage.tsx");
  const utilsSource = readSettingsSource("modelRoutes.utils.ts");

  assert.match(
    pageSource,
    /保存配置[\s\S]*检测实际/,
    "route cards should show saved preferences separately from detected runtime strategy",
  );
  assert.match(
    pageSource,
    /formatStructuredResponseFormatLabel\(draft\.structuredResponseFormat\)/,
    "route cards should display the saved structured-format preference, including auto",
  );
  assert.match(
    pageSource,
    /formatStructuredResponseFormatLabel\(detectedStructuredStrategy\)/,
    "route cards should label detected strategy as runtime output, not saved configuration",
  );
  assert.match(
    utilsSource,
    /结构化检测正常 · 实际协议/,
    "connectivity summary should identify protocol and strategy as detected runtime values",
  );
});

test("model route settings expose and persist reasoning effort separately from temperature", () => {
  const fieldsSource = readSettingsSource("ModelRouteFields.tsx");
  const pageSource = readSettingsSource("ModelRoutesPage.tsx");
  const utilsSource = readSettingsSource("modelRoutes.utils.ts");
  const factorySource = readSettingsSource("../../../../server/src/llm/factory.ts");
  const reasoningSource = readSettingsSource("../../../../server/src/llm/reasoning.ts");

  assert.match(fieldsSource, /推理强度/, "route fields should expose reasoning effort next to temperature");
  assert.match(fieldsSource, /控制随机性，不是推理强度/, "temperature copy should not imply reasoning control");
  assert.match(utilsSource, /reasoningEffort: draft\.reasoningEffort/, "route saves should include reasoning effort");
  assert.match(pageSource, /推理强度 \{formatReasoningEffortLabel\(draft\.reasoningEffort\)\}/, "saved route copy should display reasoning effort");
  assert.match(factorySource, /reasoningEffort: resolved\.reasoningEffort/, "structured and plain clients should receive resolved reasoning effort");
  assert.match(reasoningSource, /reasoning_effort: openAIReasoningEffort/, "OpenAI reasoning models should receive reasoning effort through model kwargs");
});

test("structured fallback UI only exposes persisted fallback controls", () => {
  const source = readSettingsSource("ModelRoutesPage.tsx");

  assert.match(
    source,
    /queryClient\.setQueryData<ApiResponse<StructuredFallbackSettings>>\(\s*queryKeys\.settings\.structuredFallback,\s*response,\s*\)/,
    "saving structured fallback settings should immediately update the cached saved configuration",
  );
  assert.match(
    source,
    /<CardTitle>结构化备用模型<\/CardTitle>[\s\S]*showProtocolFields=\{false\}/,
    "structured fallback model settings should not show unsaved protocol or structured-format controls",
  );
  assert.match(
    source,
    /备用模型的请求协议和结构化格式由系统自动选择/,
    "structured fallback copy should explain where protocol and JSON strategy are controlled",
  );
  assert.match(
    source,
    /调用当前结构化执行模型修复/,
    "repair retry copy should describe the actual repair model behavior",
  );
  assert.match(
    source,
    /structuredFallbackAvailableForRoute/,
    "route cards should derive fallback status from saved structured fallback settings",
  );
  assert.match(
    source,
    /备用模型已启用/,
    "route cards should show enabled fallback status without waiting for stale connectivity results",
  );
  assert.doesNotMatch(
    source,
    /connectivity\.structured\.fallbackAvailable \? "备用模型可用" : "备用模型未启用"/,
    "route card fallback status should not rely only on the last connectivity probe result",
  );
});

test("model route connectivity is read-only and reports fallback availability separately", () => {
  const source = readSettingsSource("../../../../server/src/llm/connectivity.ts");

  assert.match(
    source,
    /getStructuredFallbackSettings/,
    "connectivity probes should read saved structured fallback settings for status copy",
  );
  assert.match(
    source,
    /disableFallbackModel: true/,
    "route compatibility probes should not let fallback models mask primary route failures",
  );
  assert.match(
    source,
    /fallbackAvailable = await resolveStructuredFallbackAvailability/,
    "fallback availability should be reported from saved settings even when fallback execution is disabled for the probe",
  );
  assert.doesNotMatch(
    source,
    /shouldPersistProbeResult|await upsertModelRouteConfig/,
    "connectivity detection should not overwrite saved auto protocol or structured-format preferences",
  );
});

test("settings readiness avoids calling provider configuration live usable", () => {
  const source = readSettingsSource("components/SettingsReadinessCard.tsx");

  assert.match(source, /return "已就绪";/, "ready readiness items should use a neutral checked label");
  assert.match(
    source,
    /真实连通性以测试连接和模型路由检测为准/,
    "model readiness copy should direct users to live connectivity checks",
  );
  assert.doesNotMatch(source, /return "可用";/, "readiness badges should not use ambiguous usable wording");
});
