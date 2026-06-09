import { defineBackground } from "wxt/utils/define-background";
import type { Config } from "@shared/config";
import { DEFAULT_CONFIG, mergeConfig } from "@shared/config";
import type { Rpc, RpcEnvelope, RpcResponse } from "@shared/rpc";
import { ensureOffscreen, routeRpc } from "@/runtime/orchestrator";
import { isRpcEnvelope } from "@/runtime/rpc";

interface StoredSettings {
  config?: Partial<Config>;
}

export default defineBackground(() => {
  console.info("[mnemium/bg] service worker booted", new Date().toISOString());

  chrome.runtime.onInstalled.addListener((details) => {
    console.info("[mnemium/bg] onInstalled", details.reason);
    void ensureOffscreen().catch((error: unknown) => {
      console.error("[mnemium/bg] ensureOffscreen failed on install", error);
    });
    // First install (not update / re-enable) → open the onboarding tab.
    // Without this, users have no idea pairing / model setup even exists —
    // the popup just shows an empty Recent list with no CTA.
    if (details.reason === "install") {
      void chrome.tabs
        .create({ url: chrome.runtime.getURL("onboarding.html") })
        .catch((error: unknown) => {
          console.error("[mnemium/bg] failed to open onboarding tab", error);
        });
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    console.info("[mnemium/bg] onStartup");
    void ensureOffscreen().catch((error: unknown) => {
      console.error("[mnemium/bg] ensureOffscreen failed on startup", error);
    });
  });

  chrome.commands.onCommand.addListener((command) => {
    console.info("[mnemium/bg] command", command);
    if (command === "pull-memory") {
      void triggerActiveTabPull();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse): true | undefined => {
    if (!isRpcEnvelope(message) || isTargetedEnvelope(message)) {
      return undefined;
    }

    if (isSettingsLocal(message.msg)) {
      console.info("[mnemium/bg] settings", message.msg.t, message.reqId);
      void handleSettingsLocal(message)
        .then((response) => {
          console.info("[mnemium/bg] settings done", message.msg.t, response.ok ? "ok" : `err: ${response.ok ? "" : response.error}`);
          sendResponse(response);
        })
        .catch((error: unknown) => {
          console.error("[mnemium/bg] settings threw", message.msg.t, error);
          sendResponse({ reqId: message.reqId, ok: false, error: String(error) });
        });
      return true;
    }

    console.info("[mnemium/bg] route", message.msg.t, message.reqId);
    void routeRpc(message)
      .then((response) => {
        console.info("[mnemium/bg] route done", message.msg.t, response.ok ? "ok" : `err: ${response.ok ? "" : response.error}`);
        sendResponse(response);
      })
      .catch((error: unknown) => {
        console.error("[mnemium/bg] route threw", message.msg.t, error);
        sendResponse({ reqId: message.reqId, ok: false, error: String(error) });
      });
    return true;
  });
});

function isSettingsLocal(msg: Rpc): msg is Extract<Rpc, { t: "settings.get" | "settings.update" }> {
  return msg.t === "settings.get" || msg.t === "settings.update";
}

async function handleSettingsLocal(envelope: RpcEnvelope): Promise<RpcResponse> {
  try {
    if (envelope.msg.t === "settings.get") {
      const config = await readStoredConfig();
      return { reqId: envelope.reqId, ok: true, data: { config } };
    }
    if (envelope.msg.t === "settings.update") {
      const current = await readStoredConfig();
      const next = mergeConfig(current, envelope.msg.patch);
      await chrome.storage.local.set({ config: next });
      return { reqId: envelope.reqId, ok: true, data: { config: next } };
    }
    return { reqId: envelope.reqId, ok: false, error: "Unsupported settings RPC" };
  } catch (error) {
    return { reqId: envelope.reqId, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readStoredConfig(): Promise<Config> {
  const stored = (await chrome.storage.local.get("config")) as StoredSettings;
  return mergeConfig(DEFAULT_CONFIG, stored.config ?? {});
}

async function triggerActiveTabPull(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { t: "pull-memory" });
  } catch {
    // Content scripts are not present on every tab; command routing is best-effort.
  }
}

function isTargetedEnvelope(message: unknown): boolean {
  return isRecord(message) && typeof message.target === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
