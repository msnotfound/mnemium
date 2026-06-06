import { defineBackground } from "wxt/utils/define-background";
import { routeRpc } from "@/runtime/orchestrator";
import { isRpcEnvelope } from "@/runtime/rpc";

export default defineBackground(() => {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "pull-memory") {
      void triggerActiveTabPull();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse): true | undefined => {
    if (!isRpcEnvelope(message) || isTargetedEnvelope(message)) {
      return undefined;
    }

    void routeRpc(message).then(sendResponse);
    return true;
  });
});

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
