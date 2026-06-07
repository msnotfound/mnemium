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
    // MV3: only 'self' + 'wasm-unsafe-eval' in script-src; remote hosts in
    // connect-src OK for fetches. The hybrid extension only talks to the
    // local mnemiumd helper over loopback, so connect-src is tight.
    // API-key backends (OpenAI/Anthropic/OpenRouter) live behind the daemon
    // so the extension never opens an external connection itself.
    content_security_policy: {
      extension_pages: [
        "script-src 'self' 'wasm-unsafe-eval';",
        "connect-src 'self' http://127.0.0.1:* http://localhost:*;",
        "object-src 'self';",
      ].join(" "),
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
