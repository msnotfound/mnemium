import type { RpcEnvelope, RpcResponse } from "@shared/rpc";

const offscreenTarget = "mnemium-offscreen";
let creatingOffscreen: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }

  if (creatingOffscreen !== null) {
    return creatingOffscreen;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "local memory engine",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

export async function routeRpc(envelope: RpcEnvelope): Promise<RpcResponse> {
  await ensureOffscreen();
  const routedEnvelope: RpcEnvelope & { target: typeof offscreenTarget } = {
    ...envelope,
    target: offscreenTarget,
  };
  const response = await chrome.runtime.sendMessage<typeof routedEnvelope, RpcResponse>(routedEnvelope);
  if (!isRpcResponse(response) || response.reqId !== envelope.reqId) {
    return { reqId: envelope.reqId, ok: false, error: "Invalid offscreen RPC response" };
  }
  return response;
}

function isRpcResponse(value: unknown): value is RpcResponse {
  return (
    isRecord(value) &&
    typeof value.reqId === "string" &&
    typeof value.ok === "boolean" &&
    (value.ok || typeof value.error === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
