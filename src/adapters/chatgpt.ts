import type { SiteAdapter } from "@/shared/interfaces";
import { createSiteAdapter } from "@/adapters/factory";
import type { NetworkCaptureConfig, NetworkPayload } from "@/adapters/strategies/network";
import { createGenericProviderParser } from "@/adapters/strategies/network";
import type { Exchange } from "@/shared/types";

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
    /chatgpt\.com\/backend-api\/(?:f\/)?conversation(?:[/?#]|$)/,
    /chat\.openai\.com\/backend-api\/(?:f\/)?conversation(?:[/?#]|$)/,
  ],
  parse: parseChatGptNetworkPayload,
};

const genericChatGptParser = createGenericProviderParser("chatgpt");

function parseChatGptNetworkPayload(payload: NetworkPayload): Exchange[] {
  if (payload.method.toUpperCase() === "GET" || !isConversationTurnUrl(payload.url)) {
    return [];
  }

  const activeThreadId = currentThreadIdFromLocation();
  return genericChatGptParser(payload).filter((exchange) => {
    if (!isLikelyChatGptThreadId(exchange.threadId)) {
      return false;
    }

    return activeThreadId === undefined || activeThreadId === exchange.threadId;
  });
}

function isConversationTurnUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url, location.origin);
    return /^\/backend-api\/(?:f\/)?conversation(?:\/|$)/.test(pathname);
  } catch {
    return false;
  }
}

function currentThreadIdFromLocation(): string | undefined {
  const active = /\/c\/([A-Za-z0-9_-]{8,})/.exec(location.pathname)?.[1];
  return active !== undefined && isLikelyChatGptThreadId(active) ? active : undefined;
}

function isLikelyChatGptThreadId(threadId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId);
}
