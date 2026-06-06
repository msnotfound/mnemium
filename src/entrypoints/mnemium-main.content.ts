import { networkCaptureConfigs } from "@/adapters/registry";
import { installHistoryRouteCapture, installNetworkCapture } from "@/adapters/strategies/network";

export default defineContentScript({
  matches: [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*",
    "https://grok.com/*",
    "https://x.com/i/grok*",
    "https://chat.deepseek.com/*",
  ],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installNetworkCapture([...networkCaptureConfigs]);
    installHistoryRouteCapture();
  },
});
