import type { SiteAdapter } from "@/shared/interfaces";
import { createSiteAdapter } from "@/adapters/factory";
import type { NetworkCaptureConfig } from "@/adapters/strategies/network";
import { createGenericProviderParser } from "@/adapters/strategies/network";

export const claudeAdapter: SiteAdapter = createSiteAdapter({
  provider: "claude",
  hostPatterns: [/^https:\/\/claude\.ai\//],
  threadIdPatterns: [/\/chat\/([A-Za-z0-9_-]+)/, /chat_conversations\/([A-Za-z0-9_-]+)/],
  composerSelectors: [
    "div.ProseMirror[contenteditable='true']",
    "[contenteditable='true'][data-testid*='chat-input']",
    "[role='textbox'][contenteditable='true']",
    "textarea",
  ],
  capability: { transport: "sse", editor: "prosemirror" },
});

export const claudeNetworkConfig: NetworkCaptureConfig = {
  provider: "claude",
  urlPatterns: [
    /claude\.ai\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion/,
    /claude\.ai\/api\/append_message/,
    /claude\.ai\/api\/chat_conversations/,
  ],
  parse: createGenericProviderParser("claude"),
};
