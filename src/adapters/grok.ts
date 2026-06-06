import type { SiteAdapter } from "@/shared/interfaces";
import { createSiteAdapter } from "@/adapters/factory";
import type { NetworkCaptureConfig } from "@/adapters/strategies/network";
import { createGenericProviderParser } from "@/adapters/strategies/network";

export const grokAdapter: SiteAdapter = createSiteAdapter({
  provider: "grok",
  hostPatterns: [/^https:\/\/grok\.com\//, /^https:\/\/x\.com\/i\/grok/],
  threadIdPatterns: [/\/chat\/([A-Za-z0-9_-]+)/, /conversation[s]?\/([A-Za-z0-9_-]+)/],
  composerSelectors: [
    "textarea",
    "[role='textbox'][contenteditable='true']",
    "[data-testid*='chat-input']",
    "[contenteditable='true']",
  ],
  capability: { transport: "json", editor: "textarea" },
});

export const grokNetworkConfig: NetworkCaptureConfig = {
  provider: "grok",
  urlPatterns: [
    /grok\.com\/rest\/app-chat\/conversations/,
    /grok\.com\/rest\/app-chat\/responses/,
    /x\.com\/i\/api\/grok/,
  ],
  parse: createGenericProviderParser("grok"),
};
