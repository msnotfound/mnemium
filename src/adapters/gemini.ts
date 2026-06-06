import type { SiteAdapter } from "@/shared/interfaces";
import { createSiteAdapter } from "@/adapters/factory";
import type { NetworkCaptureConfig } from "@/adapters/strategies/network";
import { createGenericProviderParser } from "@/adapters/strategies/network";

export const geminiAdapter: SiteAdapter = createSiteAdapter({
  provider: "gemini",
  hostPatterns: [/^https:\/\/gemini\.google\.com\//],
  threadIdPatterns: [/\/app\/([A-Za-z0-9_-]+)/, /conversation_id=([A-Za-z0-9_-]+)/],
  composerSelectors: [
    "rich-textarea [contenteditable='true']",
    "div[contenteditable='true'][role='textbox']",
    "[aria-label*='Enter a prompt']",
    "textarea",
  ],
  capability: { transport: "json", editor: "contenteditable" },
});

export const geminiNetworkConfig: NetworkCaptureConfig = {
  provider: "gemini",
  urlPatterns: [
    /gemini\.google\.com\/_\//,
    /BardFrontendService\/StreamGenerate/,
    /assistant\.lamda\.BardFrontendService/,
  ],
  parse: createGenericProviderParser("gemini"),
};
