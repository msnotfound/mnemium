import type { Rpc } from "@/shared/rpc";
import type { Exchange } from "@/shared/types";

export type ExchangeListener = (exchange: Exchange) => void;
export type RouteListener = () => void;

interface MainBridgeExchangeMessage {
  source: "mnemium-main";
  type: "exchange";
  payload: Exchange;
}

interface MainBridgeRouteMessage {
  source: "mnemium-main";
  type: "route";
}

type MainBridgeMessage = MainBridgeExchangeMessage | MainBridgeRouteMessage;
type RuntimeSendRpc = (msg: Rpc) => Promise<unknown>;

export function subscribeMainExchanges(listener: ExchangeListener): () => void {
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== window || !isMainBridgeMessage(event.data) || event.data.type !== "exchange") {
      return;
    }

    listener(event.data.payload);
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

export function subscribeRouteChanges(listener: RouteListener): () => void {
  const onMainMessage = (event: MessageEvent<unknown>): void => {
    if (event.source === window && isMainBridgeMessage(event.data) && event.data.type === "route") {
      listener();
    }
  };

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  const onPopState = (): void => listener();

  history.pushState = (...args) => {
    const result = originalPushState(...args);
    listener();
    return result;
  };

  history.replaceState = (...args) => {
    const result = originalReplaceState(...args);
    listener();
    return result;
  };

  window.addEventListener("message", onMainMessage);
  window.addEventListener("popstate", onPopState);

  return () => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener("message", onMainMessage);
    window.removeEventListener("popstate", onPopState);
  };
}

export async function forwardExchangeToRuntime(exchange: Exchange): Promise<void> {
  await sendRpc({ t: "capture.exchange", payload: exchange });
}

export async function sendRpc(msg: Rpc): Promise<unknown> {
  const runtimeSendRpc = await loadRuntimeSendRpc();
  return runtimeSendRpc(msg);
}

function isMainBridgeMessage(value: unknown): value is MainBridgeMessage {
  if (!isRecord(value) || value.source !== "mnemium-main") {
    return false;
  }

  if (value.type === "route") {
    return true;
  }

  return value.type === "exchange" && isRecord(value.payload);
}

async function loadRuntimeSendRpc(): Promise<RuntimeSendRpc> {
  try {
    // TODO(runtime): replace this fallback once "@/runtime/rpc" is present in the merged tree.
    // Dynamic import keeps this module loadable while the runtime agent owns that path.
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<unknown>;
    const module = await dynamicImport("@/runtime/rpc");
    if (isRecord(module) && typeof module.sendRpc === "function") {
      return module.sendRpc as RuntimeSendRpc;
    }
  } catch {
    // Runtime module is owned by another build agent; fall back to direct extension messaging.
  }

  return async (msg: Rpc): Promise<unknown> => {
    const reqId = crypto.randomUUID();
    return chrome.runtime.sendMessage({ reqId, msg });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
