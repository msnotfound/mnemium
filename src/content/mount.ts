import type { CaptureHooks, SiteAdapter, Unsubscribe } from "@/shared/interfaces";
import type { BanditFeatures, SurfacedChunk } from "@/shared/types";
import { resolveAdapter } from "@/adapters/registry";
import { forwardExchangeToRuntime, sendRpc, subscribeRouteChanges } from "@/content/bridge";
import { copyToClipboard } from "@/adapters/strategies/inject";
import { mountInPageUI } from "@/ui/inpage";

export interface MountedMnemiumContent {
  adapter: SiteAdapter;
  unmount(): void;
}

/** Reason the UI block has no chunks to show. Drives the empty-state copy
 *  so users aren't staring at a blank box wondering if Mnemium is broken. */
export type PullState =
  | { kind: "initial" } // UI mounted but no pull triggered yet — hidden
  | { kind: "no-composer" } // adapter couldn't find the chat input — actionable
  | { kind: "empty-draft" } // composer empty when hotkey pressed
  | { kind: "no-matches"; scope: string; draftLen: number } // searched, found nothing
  | { kind: "results" }; // chunks present — InPageUI renders the list

interface RetrieveResponse {
  chunks?: SurfacedChunk[];
}

const hostId = "mnemium-inpage-host";
const shadowRootMode: ShadowRootMode = "open";

export function mountMnemiumContent(): MountedMnemiumContent | null {
  const adapter = resolveAdapter(location.href);
  if (adapter === null) {
    return null;
  }

  const subscriptions: Unsubscribe[] = [];
  const hooks: CaptureHooks = {
    onExchange(exchange) {
      void forwardExchangeToRuntime(exchange);
    },
    onError(error) {
      console.warn("[Mnemium] capture error", error);
    },
  };

  subscriptions.push(adapter.captureStream(hooks));

  const mountState = createMountState(adapter);
  mountState.anchor();

  subscriptions.push(subscribeRouteChanges(() => {
    mountState.anchor();
  }));

  subscriptions.push(listenForRuntimePull(() => {
    void mountState.pullMemory();
  }));

  subscriptions.push(listenForComposerHotkey(adapter, () => {
    void mountState.pullMemory();
  }));

  return {
    adapter,
    unmount() {
      for (const unsubscribe of subscriptions.splice(0)) {
        unsubscribe();
      }
      mountState.unmount();
    },
  };
}

function createMountState(adapter: SiteAdapter): {
  anchor(): void;
  pullMemory(): Promise<void>;
  unmount(): void;
} {
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let uiDispose: (() => void) | null = null;
  let chunks: SurfacedChunk[] = [];
  let pullState: PullState = { kind: "initial" };
  let currentThreadId: string | null = adapter.currentThreadId();

  return {
    anchor(): void {
      const composer = adapter.locateComposer();
      if (composer === null) {
        return;
      }

      if (host === null) {
        host = document.createElement("mnemium-inpage");
        host.id = hostId;
        host.style.display = "block";
        host.style.margin = "8px 0";
        shadow = host.attachShadow({ mode: shadowRootMode });
      }

      if (!host.isConnected) {
        composer.before(host);
      }

      renderUi();
    },

    async pullMemory(): Promise<void> {
      const composer = adapter.locateComposer();
      const draft = composerText(composer);
      const threadId = adapter.currentThreadId() ?? "unknown";
      currentThreadId = threadId === "unknown" ? null : threadId;
      const scope = `personal::${adapter.provider}`;
      const currentScope = threadId === "unknown" ? undefined : `${scope}::${threadId}`;
      console.info(
        "[mnemium/content] pull-memory →",
        `provider=${adapter.provider}`,
        `thread=${threadId}`,
        `composer=${composer === null ? "MISSING" : "found"}`,
        `draftLen=${draft.length}`,
      );
      if (composer === null) {
        pullState = { kind: "no-composer" };
        chunks = [];
        this.anchor();
        console.warn("[mnemium/content] adapter could not locate composer — pulling skipped");
        return;
      }
      if (draft.length === 0) {
        pullState = { kind: "empty-draft" };
        chunks = [];
        this.anchor();
        console.info("[mnemium/content] composer empty — pulling skipped");
        return;
      }
      const started = Date.now();
      const response = await sendRpc({
        t: "retrieve",
        draft,
        scope,
        currentScope,
        k: 6,
      });
      chunks = retrieveChunks(response);
      pullState = chunks.length > 0 ? { kind: "results" } : { kind: "no-matches", scope, draftLen: draft.length };
      console.info(
        "[mnemium/content] pull-memory ←",
        `chunks=${chunks.length}`,
        `took=${Date.now() - started}ms`,
        `scope=${scope}`,
        `currentScope=${currentScope ?? "(none)"}`,
      );
      this.anchor();
    },

    unmount(): void {
      uiDispose?.();
      uiDispose = null;
      host?.remove();
      host = null;
      shadow = null;
    },
  };

  function renderUi(): void {
    if (shadow === null) {
      return;
    }

    const container = ensureUiContainer(shadow);
    uiDispose?.();
    if (chunks.length === 0) {
      container.replaceChildren();
      uiDispose = null;
      return;
    }

    const threadId = currentThreadId ?? adapter.currentThreadId() ?? "unknown";
    const scopeUri = threadId === "unknown" ? `personal::${adapter.provider}` : `personal::${adapter.provider}::${threadId}`;
    const dispose = mountInPageUI(container, {
      chunks,
      scopeUri,
      threadId,
      async onInject(text) {
        const injected = await adapter.injectContext(text);
        if (!injected) {
          await copyToClipboard(text);
        }
        return injected;
      },
    });

    uiDispose = typeof dispose === "function" ? dispose : null;
  }
}

function listenForRuntimePull(onPull: () => void): Unsubscribe {
  const listener = (message: unknown): void => {
    if (isRecord(message) && (message.t === "pull-memory" || message.command === "pull-memory")) {
      onPull();
    }
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

function listenForComposerHotkey(adapter: SiteAdapter, onPull: () => void): Unsubscribe {
  const listener = (event: KeyboardEvent): void => {
    const isPull = event.key.toLowerCase() === "j" && (event.metaKey || event.ctrlKey);
    if (!isPull) {
      return;
    }

    const composer = adapter.locateComposer();
    if (composer === null || !composer.contains(document.activeElement)) {
      return;
    }

    event.preventDefault();
    onPull();
  };

  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}

function ensureUiContainer(shadow: ShadowRoot): HTMLElement {
  const existing = shadow.querySelector<HTMLElement>("[data-mnemium-ui]");
  if (existing !== null) {
    return existing;
  }

  const container = document.createElement("div");
  container.setAttribute("data-mnemium-ui", "true");
  shadow.append(container);
  return container;
}

function composerText(composer: HTMLElement | null): string {
  if (composer === null) {
    return "";
  }

  // Modern chat editors (ProseMirror in ChatGPT, Lexical in Claude,
  // rich-textarea in Gemini) are contenteditable divs. Many sites keep a
  // hidden <textarea> alongside the editor for accessibility/form submit
  // — that textarea's `.value` is always "" because the user actually
  // types in the contenteditable. If our adapter happened to match the
  // hidden textarea first (chatgpt's old layout had `textarea[data-id='root']`
  // which now matches the a11y mirror), composer.value would be "" and we'd
  // skip distill with "composer empty" even though the user typed text.
  //
  // Resolution order:
  //   1. composer is itself contenteditable → its textContent
  //   2. composer contains a contenteditable descendant → that's textContent
  //   3. composer is a textarea/input with a non-empty value → that value
  //   4. composer contains a textarea/input with a non-empty value
  //   5. composer.textContent as last resort
  if (composer instanceof HTMLElement && composer.isContentEditable) {
    const text = (composer.textContent ?? "").trim();
    if (text.length > 0) return text;
  }

  const editable = composer.querySelector<HTMLElement>("[contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']");
  if (editable !== null) {
    const text = (editable.textContent ?? "").trim();
    if (text.length > 0) return text;
  }

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    if (composer.value.length > 0) return composer.value;
  }

  const control = composer.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    "textarea, input[type='text'], input:not([type])",
  );
  if (control !== null && control.value.length > 0) {
    return control.value;
  }

  return composer.textContent ?? "";
}

function defaultBanditFeatures(chunk: SurfacedChunk): BanditFeatures {
  return {
    sim: chunk.score,
    distinctiveness: 0,
    noveltyVsContext: 0,
    recency: 0,
    reuseCount: 0,
    confidence: Math.max(0, Math.min(1, chunk.score)),
    type: chunk.type,
    scopeMatch: chunk.provenance?.sameThread === false ? 0 : 1,
  };
}

function retrieveChunks(response: unknown): SurfacedChunk[] {
  if (isRetrieveResponse(response) && Array.isArray(response.chunks)) {
    return response.chunks;
  }

  if (isRecord(response) && isRetrieveResponse(response.data) && Array.isArray(response.data.chunks)) {
    return response.data.chunks;
  }

  if (isRecord(response) && isRetrieveResponse(response.msg) && Array.isArray(response.msg.chunks)) {
    return response.msg.chunks;
  }

  return [];
}

function isRetrieveResponse(value: unknown): value is RetrieveResponse {
  return isRecord(value) && (!("chunks" in value) || Array.isArray(value.chunks));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
