import type { SiteAdapter } from "@/shared/interfaces";
import { createSiteAdapter } from "@/adapters/factory";
import type { NetworkCaptureConfig } from "@/adapters/strategies/network";
import { createGenericProviderParser } from "@/adapters/strategies/network";

export const chatgptAdapter: SiteAdapter = createSiteAdapter({
  provider: "chatgpt",
  hostPatterns: [/^https:\/\/chatgpt\.com\//, /^https:\/\/chat\.openai\.com\//],
  threadIdPatterns: [/\/c\/([A-Za-z0-9_-]+)/, /conversation\/([A-Za-z0-9_-]+)/],
  composerSelectors: [
    "textarea[data-id='root']",
    "textarea[placeholder]",
    "div.ProseMirror[contenteditable='true']",
    "[contenteditable='true'][data-lexical-editor='true']",
    "[role='textbox'][contenteditable='true']",
  ],
  capability: { transport: "sse", editor: "prosemirror" },
});

export const chatgptNetworkConfig: NetworkCaptureConfig = {
  provider: "chatgpt",
  urlPatterns: [
    /chatgpt\.com\/backend-api\/conversation/,
    /chat\.openai\.com\/backend-api\/conversation/,
    /chatgpt\.com\/backend-api\/f\/conversation/,
    /chat\.openai\.com\/backend-api\/f\/conversation/,
  ],
  parse: createGenericProviderParser("chatgpt"),
};
