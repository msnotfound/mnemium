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
    // MV3 default CSP rejects WebAssembly.instantiate(); 'wasm-unsafe-eval' is the
    // documented opt-in for sqlite-wasm, WebLLM, and transformers.js.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
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
        // Ctrl+Shift+M is taken by Thorium/Chrome profile menu; Alt+Shift+M is safe.
        suggested_key: { default: "Alt+Shift+M" },
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
