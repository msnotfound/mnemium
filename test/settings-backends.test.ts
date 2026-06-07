import { describe, expect, test } from "vitest";

import {
  daemonStatusSummary,
  distillBackendForKind,
  embedBackendForKind,
  vecBackendForKind,
} from "../src/ui/settings/backendSettings";

describe("settings backend helpers", () => {
  test("builds distillation backend shapes with defaults", () => {
    expect(distillBackendForKind({ kind: "daemon" }, "ollama")).toEqual({
      kind: "ollama",
      ollama: { endpoint: "http://localhost:11434", model: "qwen2.5:1.5b" },
    });

    expect(distillBackendForKind({ kind: "daemon" }, "apiKey")).toEqual({
      kind: "apiKey",
      apiKey: { provider: "openai", apiKey: "", model: "gpt-4o-mini" },
    });
  });

  test("builds embedding backend shapes with defaults", () => {
    expect(embedBackendForKind({ kind: "daemon" }, "ollama")).toEqual({
      kind: "ollama",
      ollama: { endpoint: "http://localhost:11434", model: "nomic-embed-text" },
    });

    expect(embedBackendForKind({ kind: "daemon" }, "apiKey")).toEqual({
      kind: "apiKey",
      apiKey: { provider: "openai", apiKey: "", model: "text-embedding-3-small" },
    });
  });

  test("preserves existing backend target details when switching kinds", () => {
    expect(
      distillBackendForKind(
        {
          kind: "daemon",
          ollama: { endpoint: "http://127.0.0.1:11434", model: "phi3" },
          apiKey: { provider: "anthropic", apiKey: "sk-test", model: "claude-3-5-haiku" },
        },
        "apiKey",
      ),
    ).toEqual({
      kind: "apiKey",
      apiKey: { provider: "anthropic", apiKey: "sk-test", model: "claude-3-5-haiku" },
    });
  });

  test("summarizes daemon pairing and reachability", () => {
    expect(daemonStatusSummary({ paired: false, reachable: false, status: null })).toEqual({
      label: "Not paired",
      tone: "neutral",
    });

    expect(daemonStatusSummary({ paired: true, reachable: false, status: null })).toEqual({
      label: "Configured but unreachable",
      tone: "warning",
    });

    expect(
      daemonStatusSummary({
        paired: true,
        reachable: true,
        status: {
          ok: true,
          service: "mnemiumd",
          version: "0.1.0",
          backends: {
            distill: { kind: "llama-cpp", model: "qwen2.5-1.5b", ready: true },
            embed: { kind: "llama-cpp", model: "nomic-embed-text", ready: true },
            vec: { kind: "sqlite-vec" },
          },
          models: { available: [], downloading: [] },
        },
      }),
    ).toEqual({
      label: "Reachable (qwen2.5-1.5b ready)",
      tone: "success",
    });
  });

  test("builds vector backend kinds", () => {
    expect(vecBackendForKind("edgevec")).toEqual({ kind: "edgevec" });
  });
});
