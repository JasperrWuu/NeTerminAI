import { ApiAiProvider } from "../providers/ApiAiProvider.ts";
import { ProcessAiProvider } from "../providers/ProcessAiProvider.ts";
import type { AiProvider, AiProviderConfig, AiProviderMode, AiProviderPreset } from "../providers/types.ts";

type ProviderConfigInput = AiProviderConfig | (Omit<AiProviderConfig, "mode" | "preset"> & { providerMode: AiProviderMode; providerPreset: AiProviderPreset });

export function createAiProvider(config: ProviderConfigInput, runtimeApiKey = ""): AiProvider {
  const normalized: AiProviderConfig = {
    ...config,
    mode: "mode" in config ? config.mode : config.providerMode,
    preset: "preset" in config ? config.preset : config.providerPreset,
  };
  if (normalized.mode === "process") return new ProcessAiProvider(normalized);
  return new ApiAiProvider({
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    temperature: normalized.temperature,
    timeoutMs: normalized.timeoutMs,
    ...(runtimeApiKey.trim() ? { apiKey: runtimeApiKey.trim() } : {}),
  });
}
