import type { Rpc } from "@/shared/rpc";
import type { Exchange } from "@/shared/types";
import { sendRpc as runtimeSendRpc } from "@/runtime/rpc";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
