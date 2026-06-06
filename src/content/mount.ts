import type { CaptureHooks, SiteAdapter, Unsubscribe } from "@/shared/interfaces";
import type { BanditFeatures, SurfacedChunk } from "@/shared/types";
import { resolveAdapter } from "@/adapters/registry";
import { forwardExchangeToRuntime, sendRpc, subscribeRouteChanges } from "@/content/bridge";
import { copyToClipboard } from "@/adapters/strategies/inject";

export interface MountedMnemiumContent {
  adapter: SiteAdapter;
  unmount(): void;
}

interface InPageUiProps {
  chunks: SurfacedChunk[];
  onAccept(chunk: SurfacedChunk): void | Promise<void>;
  onReject(chunk: SurfacedChunk): void | Promise<void>;
  onInject(text: string): void | Promise<void>;
}

type MountInPageUI = (container: HTMLElement, props: InPageUiProps) => void | (() => void);

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
      const draft = composerText(adapter.locateComposer());
      const threadId = adapter.currentThreadId() ?? "unknown";
      const response = await sendRpc({
        t: "retrieve",
        draft,
        scope: `personal::${adapter.provider}::${threadId}`,
        k: 6,
      });

      chunks = retrieveChunks(response);
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
    void loadMountInPageUI().then((mountInPageUI) => {
      uiDispose?.();
      const dispose = mountInPageUI(container, {
        chunks,
        onAccept(chunk) {
          void sendRpc({ t: "inject.feedback", memoryId: chunk.memoryId, accepted: true, ctx: defaultBanditFeatures(chunk) });
        },
        onReject(chunk) {
          void sendRpc({ t: "inject.feedback", memoryId: chunk.memoryId, accepted: false, ctx: defaultBanditFeatures(chunk) });
        },
        async onInject(text) {
          const injected = await adapter.injectContext(text);
          if (!injected) {
            await copyToClipboard(text);
          }
        },
      });

      uiDispose = typeof dispose === "function" ? dispose : null;
    });
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

async function loadMountInPageUI(): Promise<MountInPageUI> {
  try {
    // TODO(ui): replace the placeholder path once "@/ui/inpage" is present in the merged tree.
    // Dynamic import keeps this content script type-checkable before the UI agent's files exist.
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<unknown>;
    const module = await dynamicImport("@/ui/inpage");
    if (isRecord(module) && typeof module.mountInPageUI === "function") {
      return module.mountInPageUI as MountInPageUI;
    }
  } catch {
    // UI module is owned by another build agent; use the minimal placeholder below.
  }

  return mountPlaceholderInPageUI;
}

function mountPlaceholderInPageUI(container: HTMLElement, props: InPageUiProps): () => void {
  container.replaceChildren();

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .mnemium-block {
      border: 1px solid #d8d8d8;
      background: #f4f4f5;
      color: #343434;
      font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 8px;
    }
    .mnemium-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
    button {
      border: 1px solid #c8c8c8;
      background: white;
      color: #222;
      cursor: pointer;
      font: inherit;
      padding: 2px 6px;
    }
  `;

  const block = document.createElement("div");
  block.className = "mnemium-block";
  block.textContent = props.chunks.length === 0 ? "Mnemium" : "Mnemium memory";

  for (const chunk of props.chunks) {
    const row = document.createElement("div");
    row.className = "mnemium-row";

    const text = document.createElement("span");
    text.textContent = chunk.content;
    text.style.flex = "1";

    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "✓";
    accept.title = "Inject this memory";
    accept.addEventListener("click", () => {
      void props.onAccept(chunk);
      void props.onInject(chunk.content);
    });

    const reject = document.createElement("button");
    reject.type = "button";
    reject.textContent = "✕";
    reject.title = "Drop this memory";
    reject.addEventListener("click", () => {
      void props.onReject(chunk);
    });

    row.append(text, accept, reject);
    block.append(row);
  }

  container.append(style, block);
  return () => container.replaceChildren();
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

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    return composer.value;
  }

  const control = composer.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input[type='text'], input:not([type])");
  if (control !== null) {
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
    scopeMatch: 1,
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
