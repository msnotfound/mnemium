import { describe, expect, test } from "vitest";
import { AutoInjector } from "../src/core/autoinject/index";
import { createBandit } from "../src/core/autoinject/bandit";
import { relevanceGate } from "../src/core/autoinject/relevance-gate";
import type { Embedder } from "@shared/interfaces";
import type { SurfacedChunk } from "@shared/types";

describe("auto-inject", () => {
  test("does not search when the draft embedding has not moved past epsilon", async () => {
    const embedder = new FakeEmbedder();
    let searches = 0;
    const injector = new AutoInjector({
      embedder,
      epsilon: 0.12,
      floor: 0.5,
      retrieve: async () => {
        searches += 1;
        return [chunk("m-rust", "Prefers Rust for local CLI tools", 0.91)];
      },
    });

    const first = await injector.surface({
      draft: "rust cli",
      visibleContext: "",
      scopePrefix: "personal::chatgpt",
      k: 3,
    });
    const second = await injector.surface({
      draft: "rust cli",
      visibleContext: "",
      scopePrefix: "personal::chatgpt",
      k: 3,
    });

    expect(searches).toBe(1);
    expect(second).toEqual(first);
  });

  test("filters below-floor candidates and suppresses already-visible memories", () => {
    const kept = relevanceGate(
      [
        chunk("m-low", "Prefers Rust for local CLI tools", 0.4),
        chunk("m-visible", "Keeps project notes in Obsidian", 0.93),
        chunk("m-new", "Uses SQLite for local-first prototypes", 0.88),
      ],
      {
        floor: 0.72,
        visibleContext: "The user already says they keep project notes in Obsidian.",
        now: Date.UTC(2026, 0, 1),
      },
    );

    expect(kept.map((item) => item.memoryId)).toEqual(["m-new"]);
  });

  test("bandit shifts toward rejection after repeated negative feedback", () => {
    const bandit = createBandit({ explorationScale: 0 });
    const features = {
      sim: 0.9,
      distinctiveness: 0.4,
      noveltyVsContext: 0.9,
      recency: 0.9,
      reuseCount: 0.2,
      confidence: 0.9,
      type: "fact" as const,
      scopeMatch: 1,
    };

    const before = bandit.score(features);
    for (let i = 0; i < 20; i += 1) {
      bandit.update(features, false);
    }

    expect(bandit.score(features)).toBeLessThan(before);
    expect(bandit.shouldInject(features)).toBe(false);
  });
});

class FakeEmbedder implements Embedder {
  readonly id = "fake";
  readonly dim = 3;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vectorFor(text));
  }

  private vectorFor(text: string): Float32Array {
    const lower = text.toLowerCase();
    return normalize(new Float32Array([
      lower.includes("rust") ? 1 : 0,
      lower.includes("sqlite") ? 1 : 0,
      0.1,
    ]));
  }
}

function chunk(memoryId: string, content: string, score: number): SurfacedChunk {
  return {
    memoryId,
    content,
    type: "fact",
    sourceLabel: "Chatgpt · today",
    score,
  };
}

function normalize(vec: Float32Array): Float32Array {
  let normSq = 0;
  for (const value of vec) {
    normSq += value * value;
  }
  const norm = Math.sqrt(normSq);
  return vec.map((value) => value / norm);
}
