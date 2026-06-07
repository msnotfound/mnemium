import type { Rpc, RpcEnvelope, RpcResponse } from "@shared/rpc";

export type RpcHandler = (msg: Rpc, envelope: RpcEnvelope) => Promise<unknown> | unknown;
export type RpcHandlers = {
  [T in Rpc["t"]]?: (msg: Extract<Rpc, { t: T }>, envelope: RpcEnvelope) => Promise<unknown> | unknown;
};

export interface ServeOptions {
  target?: string;
}

export async function sendRpc<T = unknown>(msg: Rpc): Promise<T> {
  const reqId = crypto.randomUUID();
  console.info("[mnemium/rpc] →", msg.t, reqId);
  let response: RpcResponse | undefined;
  try {
    response = await chrome.runtime.sendMessage<RpcEnvelope, RpcResponse>({
      reqId,
      msg,
    });
  } catch (error) {
    console.error("[mnemium/rpc] sendMessage threw", msg.t, error);
    throw error;
  }

  if (!isRpcResponse(response) || response.reqId !== reqId) {
    console.error("[mnemium/rpc] invalid response", msg.t, response);
    throw new Error("Invalid RPC response");
  }

  if (!response.ok) {
    console.error("[mnemium/rpc] ←✗", msg.t, response.error);
    throw new Error(response.error);
  }

  console.info("[mnemium/rpc] ←✓", msg.t);
  return response.data as T;
}

export function serve(handlers: RpcHandlers, options: ServeOptions = {}): () => void {
  const listener = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): true | undefined => {
    if (!isRpcEnvelope(message) || !matchesTarget(message, options.target)) {
      return undefined;
    }

    void handleEnvelope(message, handlers).then(sendResponse);
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

function matchesTarget(envelope: RpcEnvelope, target: string | undefined): boolean {
  if (target === undefined) {
    return true;
  }
  return isRecord(envelope) && envelope.target === target;
}

async function handleEnvelope(envelope: RpcEnvelope, handlers: RpcHandlers): Promise<RpcResponse> {
  const handler = handlers[envelope.msg.t] as RpcHandler | undefined;
  if (handler === undefined) {
    return { reqId: envelope.reqId, ok: false, error: `Unhandled RPC message: ${envelope.msg.t}` };
  }

  try {
    const data = await handler(envelope.msg, envelope);
    return { reqId: envelope.reqId, ok: true, data };
  } catch (error) {
    return { reqId: envelope.reqId, ok: false, error: errorMessage(error) };
  }
}

export function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  return (
    isRecord(value) &&
    typeof value.reqId === "string" &&
    isRecord(value.msg) &&
    typeof value.msg.t === "string"
  );
}

function isRpcResponse(value: unknown): value is RpcResponse {
  return (
    isRecord(value) &&
    typeof value.reqId === "string" &&
    typeof value.ok === "boolean" &&
    (value.ok || typeof value.error === "string")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
