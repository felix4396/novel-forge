import { getRagEmbeddingSettings } from "./RagSettingsService";
import { getRagRuntimeSettings } from "./RagRuntimeSettingsService";

interface RagCompatibilityBootstrapReport {
  importedSettingKeys: string[];
  importedProviderRecords: string[];
}

export async function initializeRagSettingsCompatibility(): Promise<RagCompatibilityBootstrapReport> {
  await getRagEmbeddingSettings();
  await getRagRuntimeSettings();

  return {
    importedSettingKeys: [],
    importedProviderRecords: [],
  };
}
