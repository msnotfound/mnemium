// Mnemium settings schema — FROZEN CONTRACT.

import type { Provider } from "./types";

export interface Config {
  memoryModel:
    | { kind: "bundled"; model: string }
    | { kind: "localServer"; endpoint: string; model?: string }
    | { kind: "apiKey"; provider: "openai" | "anthropic" | "openrouter"; apiKey: string; model?: string };
  embedder: { id: string }; // change → triggers background re-embed migration
  autoInject: {
    enabled: boolean; // OFF by default
    epsilon: number; // semantic-delta gate threshold (cosine)
    floor: number; // relevance-gate absolute similarity floor
    sensitivity: number; // 0..1, maps to floor/epsilon adjustment
  };
  sites: Record<Provider, boolean>;
  hotkey: string;
  theme: "system" | "light" | "dark";
}

export const DEFAULT_CONFIG: Config = {
  memoryModel: { kind: "bundled", model: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC" },
  embedder: { id: "bge-small-en-v1.5" },
  autoInject: { enabled: false, epsilon: 0.12, floor: 0.72, sensitivity: 0.5 },
  sites: { chatgpt: true, claude: true, gemini: true, grok: true, deepseek: true },
  hotkey: "Ctrl+J",
  theme: "system",
};
