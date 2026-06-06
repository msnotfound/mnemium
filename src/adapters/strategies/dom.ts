import type { CaptureHooks, Unsubscribe } from "@/shared/interfaces";
import type { Exchange, Provider } from "@/shared/types";

export interface SemanticDomCaptureOptions {
  provider: Provider;
  currentThreadId: () => string | null;
  networkRecentlyCaptured: () => boolean;
  fallbackAfterMs: number;
}

interface SemanticMessage {
  role: "user" | "assistant";
  text: string;
  id: string;
}

export function startSemanticDomCapture(
  hooks: CaptureHooks,
  options: SemanticDomCaptureOptions,
): Unsubscribe {
  let timeout: number | undefined;
  let lastExchangeKey: string | null = null;
  let disposed = false;

  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  scheduleScan();

  return () => {
    disposed = true;
    observer.disconnect();
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
    }
  };

  function scheduleScan(): void {
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
    }

    timeout = window.setTimeout(() => {
      timeout = undefined;
      if (disposed || options.networkRecentlyCaptured()) {
        return;
      }

      const exchange = latestDomExchange(options);
      if (exchange === null) {
        return;
      }

      const key = `${exchange.threadId}:${exchange.messageId}:${exchange.assistantText}`;
      if (key === lastExchangeKey) {
        return;
      }

      lastExchangeKey = key;
      hooks.onExchange(exchange);
    }, options.fallbackAfterMs);
  }
}

export function latestDomExchange(options: SemanticDomCaptureOptions): Exchange | null {
  const messages = semanticMessages();
  const assistantIndex = findLastIndex(messages, (message) => message.role === "assistant" && message.text.length > 0);
  if (assistantIndex < 1) {
    return null;
  }

  const assistant = messages[assistantIndex];
  const user = findLastBefore(messages, assistantIndex, (message) => message.role === "user" && message.text.length > 0);
  if (assistant === undefined || user === null) {
    return null;
  }

  const threadId = options.currentThreadId() ?? fallbackThreadId();
  return {
    provider: options.provider,
    threadId,
    messageId: assistant.id,
    userText: user.text,
    assistantText: assistant.text,
    ts: Date.now(),
  };
}

export function semanticMessages(root: ParentNode = document): SemanticMessage[] {
  const selector = [
    "[data-message-author-role]",
    "[data-testid*='conversation-turn']",
    "[data-testid*='chat-message']",
    "[data-testid*='message']",
    "[role='article']",
    "article",
  ].join(",");

  const seen = new Set<Element>();
  const messages: SemanticMessage[] = [];

  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    if (seen.has(element)) {
      continue;
    }

    const role = inferRole(element);
    if (role === null) {
      continue;
    }

    const text = visibleText(element);
    if (text.length === 0) {
      continue;
    }

    seen.add(element);
    messages.push({ role, text, id: semanticMessageId(element, role, text) });
  }

  return compactNestedMessages(messages);
}

function inferRole(element: HTMLElement): SemanticMessage["role"] | null {
  const markers = [
    element.getAttribute("data-message-author-role"),
    element.getAttribute("data-testid"),
    element.getAttribute("aria-label"),
    element.getAttribute("aria-roledescription"),
    element.closest("[data-message-author-role]")?.getAttribute("data-message-author-role") ?? null,
  ]
    .filter((marker): marker is string => marker !== null)
    .join(" ")
    .toLowerCase();

  if (/\b(user|human|you)\b/.test(markers)) {
    return "user";
  }

  if (/\b(assistant|ai|model|claude|chatgpt|gemini|grok|deepseek)\b/.test(markers)) {
    return "assistant";
  }

  const roleElement = element.querySelector<HTMLElement>("[aria-label], [data-message-author-role], [data-testid]");
  if (roleElement !== null && roleElement !== element) {
    return inferRole(roleElement);
  }

  return null;
}

function compactNestedMessages(messages: SemanticMessage[]): SemanticMessage[] {
  const compacted: SemanticMessage[] = [];
  for (const message of messages) {
    const previous = compacted.at(-1);
    if (previous?.role === message.role && previous.text.includes(message.text)) {
      continue;
    }
    compacted.push(message);
  }

  return compacted;
}

function visibleText(element: HTMLElement): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent === null) {
        return NodeFilter.FILTER_REJECT;
      }

      const style = window.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const parts: string[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const text = node.textContent?.trim();
    if (text !== undefined && text.length > 0) {
      parts.push(text);
    }
    node = walker.nextNode();
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function semanticMessageId(element: HTMLElement, role: SemanticMessage["role"], text: string): string {
  const explicit =
    element.getAttribute("data-message-id") ??
    element.getAttribute("data-testid") ??
    element.id;
  if (explicit.length > 0) {
    return explicit;
  }

  return `dom:${role}:${hashText(text)}`;
}

function fallbackThreadId(): string {
  const path = `${location.hostname}${location.pathname}`;
  return `dom:${hashText(path)}`;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function findLastBefore<T>(values: T[], before: number, predicate: (value: T) => boolean): T | null {
  for (let index = before - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) {
      return value;
    }
  }

  return null;
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) {
      return index;
    }
  }

  return -1;
}
