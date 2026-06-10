import type { SiteAdapter } from "@/shared/interfaces";
import { createSiteAdapter } from "@/adapters/factory";
import type { NetworkCaptureConfig } from "@/adapters/strategies/network";
import { createGenericProviderParser } from "@/adapters/strategies/network";

export const chatgptAdapter: SiteAdapter = createSiteAdapter({
  provider: "chatgpt",
  hostPatterns: [/^https:\/\/chatgpt\.com\//, /^https:\/\/chat\.openai\.com\//],
  threadIdPatterns: [/\/c\/([A-Za-z0-9_-]+)/, /conversation\/([A-Za-z0-9_-]+)/],
  // ChatGPT has used ProseMirror for the composer since early 2024; the
  // <textarea> selectors that ship in here were for the pre-2024 layout
  // and now match a hidden a11y textarea whose .value is always "". Put
  // contenteditable first so locateComposer returns the actual editor.
  composerSelectors: [
    "div.ProseMirror[contenteditable='true']",
    "[contenteditable='true'][data-lexical-editor='true']",
    "[role='textbox'][contenteditable='true']",
    "textarea[data-id='root']",
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
