import type { SiteAdapter } from "@/shared/interfaces";
import { createSiteAdapter } from "@/adapters/factory";
import type { NetworkCaptureConfig } from "@/adapters/strategies/network";
import { createGenericProviderParser } from "@/adapters/strategies/network";

export const deepseekAdapter: SiteAdapter = createSiteAdapter({
  provider: "deepseek",
  hostPatterns: [/^https:\/\/chat\.deepseek\.com\//],
  threadIdPatterns: [/\/a\/chat\/s\/([A-Za-z0-9_-]+)/, /chat_session_id=([A-Za-z0-9_-]+)/],
  composerSelectors: [
    "textarea",
    "[role='textbox'][contenteditable='true']",
    "[contenteditable='true']",
    "[data-testid*='chat-input']",
  ],
  capability: { transport: "sse", editor: "textarea" },
});

export const deepseekNetworkConfig: NetworkCaptureConfig = {
  provider: "deepseek",
  urlPatterns: [
    /chat\.deepseek\.com\/api\/v0\/chat\/completion/,
    /chat\.deepseek\.com\/api\/v0\/chat_session/,
  ],
  parse: createGenericProviderParser("deepseek"),
};
