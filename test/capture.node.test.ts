import { describe, expect, test } from "vitest";
import { CapturePipeline } from "@/core/capture";
import type { Embedder, MemoryModel, MemoryRepo, VectorIndex } from "@/shared/interfaces";
import type { Chunk, Document, DraftMemory, Edge, Entity, Exchange, Memory, MemoryRejection, MemorySource } from "@/shared/types";

describe("capture pipeline", () => {
  test("drops distilled memories whose type is not in the MemoryType enum", async () => {
    const stored: Memory[] = [];
    const pipeline = new CapturePipeline({
      documents: {
        async insert(_doc: Document) {},
        async insertChunks(_chunks: Chunk[]) {},
      },
      memories: new FakeMemoryRepo(stored),
      embedder: new FakeEmbedder(),
      vectorIndex: new FakeVectorIndex(),
      memoryModel: new FakeMemoryModel([
        {
          type: "preference|fact|skill|goal|constraint|context",
          content: "The user prefers poha for breakfast.",
          evidence: "poha for breakfast",
          speaker: "user",
          supportKind: "paraphrase",
          isStatic: true,
          confidence: 0.8,
          entities: [],
        } as unknown as DraftMemory,
        {
          type: "preference",
          content: "The user prefers historical places.",
          evidence: "I prefer historical places",
          speaker: "user",
          supportKind: "paraphrase",
          isStatic: true,
          confidence: 0.9,
          entities: [],
        },
      ]),
      now: () => 1,
    });

    await pipeline.captureExchange(exchange());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored.map((memory) => memory.type)).toEqual(["preference"]);
    expect(stored.map((memory) => memory.content)).toEqual(["The user prefers historical places."]);
  });
});

class FakeMemoryRepo implements MemoryRepo {
  readonly rejections: MemoryRejection[] = [];
  constructor(private readonly stored: Memory[]) {}
  async upsert(memory: Memory): Promise<void> {
    this.stored.push(memory);
  }
  async linkSource(_link: MemorySource): Promise<void> {}
  async recordRejection(rejection: MemoryRejection): Promise<void> {
    this.rejections.push(rejection);
  }
  async supersede(_oldId: string, _next: Memory): Promise<void> {}
  async byScope(): Promise<Memory[]> {
    return [];
  }
  async search(): Promise<Memory[]> {
    return [];
  }
  async delete(): Promise<void> {}
  async sweepExpired(): Promise<number> {
    return 0;
  }
  async bumpReuse(): Promise<void> {}
}

class FakeEmbedder implements Embedder {
  readonly id = "fake";
  readonly dim = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array());
  }
}

class FakeVectorIndex implements VectorIndex {
  async upsert(): Promise<void> {}
  async search(): Promise<Array<{ id: string; score: number }>> {
    return [];
  }
  async drop(): Promise<void> {}
}

class FakeMemoryModel implements MemoryModel {
  readonly id = "fake";
  constructor(private readonly memories: DraftMemory[]) {}
  async distill(): Promise<{ memories: DraftMemory[]; entities: Entity[] }> {
    return { memories: this.memories, entities: [] };
  }
  async classifyRelations(): Promise<Edge[]> {
    return [];
  }
}

function exchange(): Exchange {
  return {
    provider: "chatgpt",
    threadId: "thread-a",
    messageId: "message-a",
    userText: "I prefer historical places and poha for breakfast.",
    assistantText: "Got it, I will remember those durable preferences.",
    ts: 1,
  };
}
