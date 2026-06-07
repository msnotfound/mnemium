import { fileURLToPath } from "node:url";

import { defineConfig } from "wxt";

// Mnemium MV3 config. Entrypoints (background, content scripts, popup, sidepanel,
// offscreen) live under src/entrypoints/ and are added by the runtime/UI agents.
// This file freezes the manifest-level contract: permissions, host access, the
// MAIN-world capture script's matches, commands, side panel, and WAR for wasm/models.
export default defineConfig({
  srcDir: "src",
  alias: {
    "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
    "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
  },
  manifest: {
    name: "Mnemium",
    description: "Local-first, on-device memory for your AI chats.",
    permissions: ["storage", "unlimitedStorage", "offscreen", "scripting", "sidePanel"],
    host_permissions: [
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://claude.ai/*",
      "https://gemini.google.com/*",
      "https://grok.com/*",
      "https://x.com/i/grok*",
      "https://chat.deepseek.com/*",
    ],
    commands: {
      "pull-memory": {
        suggested_key: { default: "Ctrl+J", mac: "Command+J" },
        description: "Pull relevant memory into the current chat",
      },
    },
    side_panel: { default_path: "sidepanel.html" },
    web_accessible_resources: [
      {
        resources: ["wasm/*", "models/*", "offscreen.html"],
        matches: [
          "https://chatgpt.com/*",
          "https://chat.openai.com/*",
          "https://claude.ai/*",
          "https://gemini.google.com/*",
          "https://grok.com/*",
          "https://x.com/*",
          "https://chat.deepseek.com/*",
        ],
      },
    ],
  },
});
