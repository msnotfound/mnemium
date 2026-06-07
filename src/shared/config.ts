// Mnemium settings schema — FROZEN CONTRACT.
// v0.1 hybrid: backends pluggable per layer (distill / embed / vec).
// Defaults route to the local mnemiumd helper binary; user can swap each
// layer independently to Ollama, an API key, or disable it.

import type { Provider } from "./types";

export type DistillKind = "daemon" | "ollama" | "apiKey" | "disabled";
export type EmbedKind = "daemon" | "ollama" | "apiKey" | "disabled";
export type VecKind = "daemon" | "edgevec" | "disabled";

export interface OllamaTarget {
  endpoint: string;
  model: string;
}

export interface ApiKeyTarget {
  provider: "openai" | "anthropic" | "openrouter";
  apiKey: string;
  model: string;
}

export interface DistillBackend {
  kind: DistillKind;
  ollama?: OllamaTarget;
  apiKey?: ApiKeyTarget;
}

export interface EmbedBackend {
  kind: EmbedKind;
  ollama?: OllamaTarget;
  apiKey?: { provider: "openai"; apiKey: string; model: string };
}

export interface VecBackend {
  kind: VecKind;
}

export interface DaemonConfig {
  /** Localhost port mnemiumd listens on. Discovered via the pairing string. */
  port?: number;
  /** Bearer token from the pairing string; redacted in UI. */
  token?: string;
}

export interface Config {
  backends: {
    distill: DistillBackend;
    embed: EmbedBackend;
    vec: VecBackend;
  };
  daemon: DaemonConfig;
  autoInject: {
    enabled: boolean;
    epsilon: number;
    floor: number;
    sensitivity: number;
  };
  sites: Record<Provider, boolean>;
  hotkey: string;
  theme: "system" | "light" | "dark";
}

export const DEFAULT_CONFIG: Config = {
  backends: {
    distill: { kind: "daemon" },
    embed: { kind: "daemon" },
    vec: { kind: "daemon" },
  },
  daemon: {},
  autoInject: { enabled: false, epsilon: 0.12, floor: 0.72, sensitivity: 0.5 },
  sites: { chatgpt: true, claude: true, gemini: true, grok: true, deepseek: true },
  hotkey: "Alt+Shift+M",
  theme: "system",
};

export function mergeConfig(base: Config, patch: Partial<Config>): Config {
  return {
    ...base,
    ...patch,
    backends: {
      distill: { ...base.backends.distill, ...patch.backends?.distill },
      embed: { ...base.backends.embed, ...patch.backends?.embed },
      vec: { ...base.backends.vec, ...patch.backends?.vec },
    },
    daemon: { ...base.daemon, ...patch.daemon },
    autoInject: { ...base.autoInject, ...patch.autoInject },
    sites: { ...base.sites, ...patch.sites },
  };
}
