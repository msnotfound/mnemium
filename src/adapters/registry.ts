import type { SiteAdapter } from "@/shared/interfaces";
import { chatgptAdapter, chatgptNetworkConfig } from "@/adapters/chatgpt";
import { claudeAdapter, claudeNetworkConfig } from "@/adapters/claude";
import { deepseekAdapter, deepseekNetworkConfig } from "@/adapters/deepseek";
import { geminiAdapter, geminiNetworkConfig } from "@/adapters/gemini";
import { grokAdapter, grokNetworkConfig } from "@/adapters/grok";

export const adapters: readonly SiteAdapter[] = [
  chatgptAdapter,
  claudeAdapter,
  geminiAdapter,
  grokAdapter,
  deepseekAdapter,
];

export const networkCaptureConfigs = [
  chatgptNetworkConfig,
  claudeNetworkConfig,
  geminiNetworkConfig,
  grokNetworkConfig,
  deepseekNetworkConfig,
] as const;

export function resolveAdapter(url: string): SiteAdapter | null {
  return adapters.find((adapter) => adapter.matches(url)) ?? null;
}
