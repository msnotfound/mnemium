import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { modelsByKind } from "@/shared/model-registry";

const sourcePath = fileURLToPath(new URL("../src/ui/onboarding/OnboardingApp.tsx", import.meta.url));

describe("onboarding flow copy", () => {
  test("includes daemon pairing, installer commands, and model choices", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("Your AI chats, with memory — 100% on your device.");
    expect(source).toContain("curl -fsSL https://raw.githubusercontent.com/msnotfound/mnemium/main/scripts/install.sh | sh");
    expect(source).toContain("irm https://raw.githubusercontent.com/msnotfound/mnemium/main/scripts/install.ps1 | iex");
    expect(source).toContain("Paste the pairing string `mnemiumd serve` printed.");
    expect(source).toContain("KNOWN_MODELS");
    expect(source).toContain("Your private second brain is live.");

    expect(modelsByKind("distill").map((model) => model.name)).toEqual(
      expect.arrayContaining([
        "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        "Phi-3-mini-4k-instruct-q4.gguf",
      ]),
    );
    expect(modelsByKind("embed").map((model) => model.name)).toContain("nomic-embed-text-v1.5.Q4_K_M.gguf");
  });
});
