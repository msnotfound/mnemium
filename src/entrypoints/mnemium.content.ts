import { mountMnemiumContent } from "@/content/mount";

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
  runAt: "document_idle",
  main() {
    mountMnemiumContent();
  },
});
