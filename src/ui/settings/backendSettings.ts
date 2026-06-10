import type {
  ApiKeyTarget,
  DaemonConfig,
  DistillBackend,
  DistillKind,
  EmbedBackend,
  EmbedKind,
  VecBackend,
  VecKind,
} from "@shared/config";

import type { DaemonStatusEnvelope } from "../components/rpc";

export type DaemonStatusTone = "success" | "warning" | "neutral";

const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";

export const DISTILL_OLLAMA_DEFAULT = {
  endpoint: DEFAULT_OLLAMA_ENDPOINT,
  model: "qwen2.5:1.5b",
};

export const DISTILL_API_KEY_DEFAULT: ApiKeyTarget = {
  provider: "openai",
  apiKey: "",
  model: "gpt-4o-mini",
};

export const EMBED_OLLAMA_DEFAULT = {
  endpoint: DEFAULT_OLLAMA_ENDPOINT,
  model: "nomic-embed-text",
};

export const EMBED_API_KEY_DEFAULT = {
  provider: "openai" as const,
  apiKey: "",
  model: "text-embedding-3-small",
};

export function distillBackendForKind(current: DistillBackend, kind: DistillKind): DistillBackend {
  if (kind === "ollama") {
    return { kind, ollama: current.ollama ?? DISTILL_OLLAMA_DEFAULT };
  }
  if (kind === "apiKey") {
    return { kind, apiKey: current.apiKey ?? DISTILL_API_KEY_DEFAULT };
  }
  return { kind };
}

export function embedBackendForKind(current: EmbedBackend, kind: EmbedKind): EmbedBackend {
  if (kind === "ollama") {
    return { kind, ollama: current.ollama ?? EMBED_OLLAMA_DEFAULT };
  }
  if (kind === "apiKey") {
    return { kind, apiKey: current.apiKey ?? EMBED_API_KEY_DEFAULT };
  }
  return { kind };
}

export function vecBackendForKind(kind: VecKind): VecBackend {
  return { kind };
}

export function isPaired(daemon: DaemonConfig): boolean {
  return daemon.port !== undefined && daemon.token !== undefined && daemon.token.length > 0;
}

export function daemonStatusSummary(status: DaemonStatusEnvelope | null): { label: string; tone: DaemonStatusTone } {
  if (status === null || !status.paired) {
    return { label: "Not paired", tone: "neutral" };
  }
  if (!status.reachable || status.status === null) {
    return { label: "Configured but unreachable", tone: "warning" };
  }
  const distill = status.status.backends.distill;
  const model = distill.model ?? "daemon";
  // Prefer the new tri-state lifecycle when the daemon reports it (v0.0.10+);
  // older daemons only expose `ready: bool` so we fall back to that.
  const state = distill.state ?? (distill.ready ? "ready" : "idle");
  switch (state) {
    case "ready":
      return { label: `Reachable (${model} ready)`, tone: "success" };
    case "warming":
      return {
        label: distill.message ? `Starting ${model} — ${distill.message}` : `Starting ${model}…`,
        tone: "warning",
      };
    case "failed":
      return {
        label: distill.message ? `${model} failed: ${distill.message}` : `${model} failed to start`,
        tone: "warning",
      };
    default:
      return { label: `Reachable (${model} idle)`, tone: "neutral" };
  }
}
