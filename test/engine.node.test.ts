import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openNode, type Database, type SqlRow } from "../src/core/storage/db";
import { createDocumentRepo, createMemoryRepo } from "../src/core/storage/repos";
import { createVectorIndex } from "../src/core/vector-index";
import { hybridSearchWithCandidates } from "../src/core/retrieval";
import type { Embedder } from "@shared/interfaces";
import type { Document, Memory } from "@shared/types";

const MODEL_ID = "test-embedder";

describe("engine core", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openNode();
  });

  afterEach(async () => {
    await db.close();
  });

  test("hybrid search returns expected top-k and exposes raw candidates", async () => {
    const docs = createDocumentRepo(db);
    const memories = createMemoryRepo(db);
    const vectors = createVectorIndex(db);
    const embedder = new FakeEmbedder();
    const now = Date.now();

    await docs.insert(doc("doc-1", "personal::chatgpt::thread-a", now, "Chat about Rust projects"));
    await docs.insertChunks([{ id: "chunk-1", documentId: "doc-1", ord: 0, text: "Rust CLI project notes" }]);

    await memories.upsert(memory("m-rust", "preference", "Prefers Rust for local CLI tools", now));
    await memories.upsert(memory("m-bread", "fact", "Enjoys sourdough bread", now));
    await memories.linkSource({ memoryId: "m-rust", chunkId: "chunk-1", documentId: "doc-1", relevance: 1 });
    await vectors.upsert(MODEL_ID, [
      { id: "m-rust", vec: embedder.vectorFor("rust cli tool") },
      { id: "m-bread", vec: embedder.vectorFor("bread baking") },
    ]);

    const result = await hybridSearchWithCandidates(db, vectors, embedder, "rust cli", {
      scopePrefix: "personal::chatgpt",
      type: ["preference", "fact"],
      k: 2,
    });

    expect(result.chunks[0]?.memoryId).toBe("m-rust");
    expect(result.chunks[0]?.sourceLabel).toContain("Chatgpt");
    expect(result.candidates[0]?.memoryId).toBe("m-rust");
    expect(result.candidates[0]?.denseScore).toBeGreaterThan(0);
  });

  test("provider-wide retrieval includes other threads and boosts the current thread", async () => {
    const docs = createDocumentRepo(db);
    const memories = createMemoryRepo(db);
    const vectors = createVectorIndex(db);
    const embedder = new FakeEmbedder();
    const now = Date.now();
    const currentScope = "personal::chatgpt::thread-b";

    await docs.insert(doc("doc-a", "personal::chatgpt::thread-a", now, "Old poha preference"));
    await docs.insert(doc("doc-b", currentScope, now, "Current poha preference"));
    await docs.insertChunks([
      { id: "chunk-a", documentId: "doc-a", ord: 0, text: "Prefers poha for breakfast" },
      { id: "chunk-b", documentId: "doc-b", ord: 0, text: "Prefers poha for breakfast" },
    ]);

    await memories.upsert(memory("m-a", "preference", "Prefers poha for breakfast", now, "personal::chatgpt::thread-a"));
    await memories.upsert(memory("m-b", "preference", "Prefers poha for breakfast", now, currentScope));
    await memories.linkSource({ memoryId: "m-a", chunkId: "chunk-a", documentId: "doc-a", relevance: 1 });
    await memories.linkSource({ memoryId: "m-b", chunkId: "chunk-b", documentId: "doc-b", relevance: 1 });
    await vectors.upsert(MODEL_ID, [
      { id: "m-a", vec: embedder.vectorFor("poha breakfast") },
      { id: "m-b", vec: embedder.vectorFor("poha breakfast") },
    ]);

    const result = await hybridSearchWithCandidates(db, vectors, embedder, "poha breakfast", {
      scopePrefix: "personal::chatgpt",
      currentScopePrefix: currentScope,
      type: ["preference"],
      k: 2,
    });

    expect(result.chunks.map((chunk) => chunk.memoryId)).toEqual(["m-b", "m-a"]);
    expect(result.chunks[0]?.provenance).toEqual({ scopeUri: currentScope, sameThread: true });
    expect(result.chunks[1]?.provenance).toEqual({ scopeUri: "personal::chatgpt::thread-a", sameThread: false });
  });

  test("supersede flips old memory latest flag and advances the version chain", async () => {
    const repo = createMemoryRepo(db);
    const now = Date.now();
    await repo.upsert(memory("m-old", "fact", "Uses Vim", now));

    await repo.supersede("m-old", memory("m-new", "fact", "Uses Neovim", now + 1));

    const rows = await db.prepare(
      "SELECT id, version, is_latest, parent_memory_id, root_memory_id FROM memory ORDER BY version",
    ).all<VersionRow>();

    expect(rows).toEqual([
      { id: "m-old", version: 1, is_latest: 0, parent_memory_id: null, root_memory_id: null },
      { id: "m-new", version: 2, is_latest: 1, parent_memory_id: "m-old", root_memory_id: "m-old" },
    ]);
  });

  test("sweepExpired marks expired active memories forgotten", async () => {
    const repo = createMemoryRepo(db);
    const now = Date.now();
    await repo.upsert({ ...memory("m-expired", "task", "Temporary task", now), forgetAfter: now - 1 });
    await repo.upsert({ ...memory("m-active", "task", "Future task", now), forgetAfter: now + 10_000 });

    expect(await repo.sweepExpired(now)).toBe(1);

    const visible = await repo.byScope("personal::chatgpt", { type: ["task"], limit: 10 });
    expect(visible.map((item) => item.id)).toEqual(["m-active"]);
  });

  test("vector drop allows embedder swap re-upsert on a new model table", async () => {
    const repo = createMemoryRepo(db);
    const vectors = createVectorIndex(db);
    const now = Date.now();
    await repo.upsert(memory("m-one", "identity", "Lives in Pune", now));

    await vectors.upsert(MODEL_ID, [{ id: "m-one", vec: new Float32Array([1, 0, 0, 0]) }]);
    await vectors.drop(MODEL_ID);
    await vectors.upsert("replacement-model", [{ id: "m-one", vec: new Float32Array([1, 0]) }]);

    const found = await vectors.search("replacement-model", new Float32Array([1, 0]), 1);
    expect(found[0]?.id).toBe("m-one");
  });
});

interface VersionRow extends SqlRow {
  id: string;
  version: number;
  is_latest: number;
  parent_memory_id: string | null;
  root_memory_id: string | null;
}

class FakeEmbedder implements Embedder {
  readonly id = MODEL_ID;
  readonly dim = 4;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vectorFor(text));
  }

  vectorFor(text: string): Float32Array {
    const lower = text.toLowerCase();
    const vec = new Float32Array([
      lower.includes("rust") || lower.includes("cli") ? 1 : 0,
      lower.includes("bread") || lower.includes("baking") ? 1 : 0,
      lower.includes("pune") ? 1 : 0,
      0.1,
    ]);
    return normalize(vec);
  }
}

function doc(id: string, scopeUri: string, capturedAt: number, rawContent: string): Document {
  return {
    id,
    sourceType: "chat_turn",
    provider: "chatgpt",
    scopeUri,
    capturedAt,
    rawContent,
  };
}

function memory(
  id: string,
  type: Memory["type"],
  content: string,
  createdAt: number,
  scopeUri = "personal::chatgpt::thread-a",
): Memory {
  return {
    id,
    type,
    content,
    scopeUri,
    version: 1,
    isLatest: true,
    isStatic: type !== "task",
    isInference: false,
    confidence: 0.9,
    isForgotten: false,
    reuseCount: 0,
    sourceCount: 1,
    createdAt,
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
