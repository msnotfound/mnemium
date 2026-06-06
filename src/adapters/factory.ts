import type { CaptureHooks, SiteAdapter, Unsubscribe } from "@/shared/interfaces";
import type { Provider } from "@/shared/types";
import { subscribeMainExchanges } from "@/content/bridge";
import { startSemanticDomCapture } from "@/adapters/strategies/dom";
import { injectIntoComposer } from "@/adapters/strategies/inject";

export interface SiteAdapterConfig {
  provider: Provider;
  hostPatterns: RegExp[];
  threadIdPatterns: RegExp[];
  composerSelectors: string[];
  capability: SiteAdapter["capability"];
}

const fallbackAfterMs = 12_000;

export function createSiteAdapter(config: SiteAdapterConfig): SiteAdapter {
  let lastNetworkCaptureAt = 0;

  return {
    provider: config.provider,
    capability: config.capability,

    matches(url: string): boolean {
      return config.hostPatterns.some((pattern) => pattern.test(url));
    },

    captureStream(hooks: CaptureHooks): Unsubscribe {
      const stopNetwork = subscribeMainExchanges((exchange) => {
        if (exchange.provider !== config.provider) {
          return;
        }

        lastNetworkCaptureAt = Date.now();
        hooks.onExchange(exchange);
      });

      const stopDom = startSemanticDomCapture(hooks, {
        provider: config.provider,
        currentThreadId: () => this.currentThreadId(),
        networkRecentlyCaptured: () => Date.now() - lastNetworkCaptureAt < fallbackAfterMs,
        fallbackAfterMs,
      });

      return () => {
        stopNetwork();
        stopDom();
      };
    },

    async injectContext(text: string): Promise<boolean> {
      return injectIntoComposer(text, () => this.locateComposer(), config.capability.editor);
    },

    locateComposer(): HTMLElement | null {
      for (const selector of config.composerSelectors) {
        const element = deepQuerySelector(document, selector);
        if (element !== null) {
          return element;
        }
      }

      return null;
    },

    currentThreadId(): string | null {
      const url = location.href;
      for (const pattern of config.threadIdPatterns) {
        const match = pattern.exec(url);
        if (match?.[1] !== undefined) {
          return match[1];
        }
      }

      return null;
    },
  };
}

function deepQuerySelector(root: Document | ShadowRoot | Element, selector: string): HTMLElement | null {
  const direct = root.querySelector<HTMLElement>(selector);
  if (direct !== null) {
    return direct;
  }

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.shadowRoot !== null) {
      const nested = deepQuerySelector(element.shadowRoot, selector);
      if (nested !== null) {
        return nested;
      }
    }
  }

  return null;
}
