import { afterEach, describe, expect, test, vi } from "vitest";
import { CapturePipeline } from "@/core/capture";
import { validateDraft } from "@/core/validate";
import type { Embedder, MemoryModel, MemoryRepo, VectorIndex } from "@/shared/interfaces";
import type {
  Chunk,
  Document,
  DraftMemory,
  Edge,
  Entity,
  Exchange,
  Memory,
  MemoryRejection,
  MemorySource,
} from "@/shared/types";

const SOURCE = {
  userText: "I prefer local-first tools. I need to finish the migration script by Friday.",
  assistantText: "Noted — the user prefers local-first tools. You could use SQLite for this.",
};

describe("validateDraft", () => {
  test("accepts a grounded user-spoken claim as active", () => {
    const verdict = validateDraft(
      draft({ evidence: "I prefer local-first tools", speaker: "user", supportKind: "paraphrase" }),
      SOURCE,
    );
    expect(verdict).toEqual({ ok: true, claimStatus: "active", warnings: [] });
  });

  test("evidence substring check is case-insensitive and trimmed", () => {
    const verdict = validateDraft(
      draft({ evidence: "  i PREFER local-first TOOLS  ", speaker: "user", supportKind: "exact" }),
      SOURCE,
    );
    expect(verdict.ok).toBe(true);
  });

  test("rejects when evidence is not a literal substring of the source", () => {
    const verdict = validateDraft(
      draft({ evidence: "I love local-first software", speaker: "user", supportKind: "exact" }),
      SOURCE,
    );
    expect(verdict).toEqual({ ok: false, reason: "evidence_not_in_source" });
  });

  test("rejects missing evidence", () => {
    const verdict = validateDraft(draft({ speaker: "user", supportKind: "exact" }), SOURCE);
    expect(verdict).toEqual({ ok: false, reason: "missing_evidence" });
  });

  test("rejects speaker mismatch — assistant words attributed to the user", () => {
    const verdict = validateDraft(
      draft({ evidence: "You could use SQLite for this", speaker: "user", supportKind: "paraphrase" }),
      SOURCE,
    );
    expect(verdict).toEqual({ ok: false, reason: "speaker_mismatch:user" });
  });

  test("rejects invalid memory type", () => {
    const verdict = validateDraft(
      draft({ type: "vibe" as never, evidence: "I prefer local-first tools", speaker: "user", supportKind: "exact" }),
      SOURCE,
    );
    expect(verdict).toEqual({ ok: false, reason: "invalid_type:vibe" });
  });

  test("rejects inferred support for preference/identity/fact", () => {
    const verdict = validateDraft(
      draft({ evidence: "I prefer local-first tools", speaker: "user", supportKind: "inferred" }),
      SOURCE,
    );
    expect(verdict).toEqual({ ok: false, reason: "inferred_preference_not_allowed" });
  });

  test("quarantines inferred tasks as pending_review", () => {
    const verdict = validateDraft(
      draft({
        type: "task",
        content: "The user must finish the migration script.",
        evidence: "I need to finish the migration script by Friday",
        speaker: "user",
        supportKind: "inferred",
      }),
      SOURCE,
    );
    expect(verdict).toEqual({ ok: true, claimStatus: "pending_review", warnings: ["inferred_support"] });
  });

  test("rejects hedged content", () => {
    const verdict = validateDraft(
      draft({
        content: "The user might prefer local-first tools.",
        evidence: "I prefer local-first tools",
        speaker: "user",
        supportKind: "paraphrase",
      }),
      SOURCE,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/^hedged_content:/);
  });

  test("allows assistant-spoken evidence only when content describes the user", () => {
    const ok = validateDraft(
      draft({
        evidence: "the user prefers local-first tools",
        speaker: "assistant",
        supportKind: "exact",
      }),
      SOURCE,
    );
    expect(ok.ok).toBe(true);

    const advice = validateDraft(
      draft({
        type: "task",
        content: "You should use SQLite for this.",
        evidence: "You could use SQLite for this",
        speaker: "assistant",
        supportKind: "exact",
      }),
      SOURCE,
    );
    expect(advice).toEqual({ ok: false, reason: "assistant_second_person_advice" });
  });
});

describe("capture pipeline trust gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("qwen returns 3 candidates, validator stores 2 and drops the ungrounded one with a log + audit row", async () => {
    const warn = vi.spyOn(console, "warn");
    const stored: Memory[] = [];
    const repo = new FakeMemoryRepo(stored);
    const pipeline = new CapturePipeline({
      documents: {
        async insert(_doc: Document) {},
        async insertChunks(_chunks: Chunk[]) {},
      },
      memories: repo,
      embedder: new FakeEmbedder(),
      vectorIndex: new FakeVectorIndex(),
      memoryModel: new FakeMemoryModel([
        {
          type: "preference",
          content: "The user prefers local-first tools.",
          evidence: "I prefer local-first tools",
          speaker: "user",
          supportKind: "exact",
          isStatic: true,
          confidence: 0.9,
          entities: [],
        },
        {
          // Hallucinated: this span appears nowhere in the exchange.
          type: "fact",
          content: "The user uses PostgreSQL in production.",
          evidence: "I use PostgreSQL in production",
          speaker: "user",
          supportKind: "exact",
          isStatic: true,
          confidence: 0.8,
          entities: [],
        },
        {
          type: "task",
          content: "The user needs to finish the migration script by Friday.",
          evidence: "I need to finish the migration script by Friday",
          speaker: "user",
          supportKind: "exact",
          isStatic: false,
          confidence: 0.85,
          entities: [],
        },
      ]),
      now: () => 1,
    });

    await pipeline.captureExchange(exchange());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 2 grounded memories stored, all active.
    expect(stored.map((memory) => memory.content)).toEqual([
      "The user prefers local-first tools.",
      "The user needs to finish the migration script by Friday.",
    ]);
    expect(stored.every((memory) => memory.claimStatus === "active")).toBe(true);
    expect(stored[0]?.evidence).toBe("I prefer local-first tools");
    expect(stored[0]?.speaker).toBe("user");

    // The hallucinated one was dropped, logged, and persisted for audit.
    const dropLogs = warn.mock.calls.filter((call) => String(call[0]).startsWith("[mnemium/validate] dropped"));
    expect(dropLogs).toHaveLength(1);
    expect(String(dropLogs[0]?.[0])).toContain("evidence_not_in_source");
    expect(repo.rejections).toHaveLength(1);
    expect(repo.rejections[0]).toMatchObject({
      content: "The user uses PostgreSQL in production.",
      reason: "evidence_not_in_source",
      threadId: "thread-a",
    });
  });
});

function draft(overrides: Partial<DraftMemory>): DraftMemory {
  return {
    type: "preference",
    content: "The user prefers local-first tools.",
    isStatic: true,
    confidence: 0.9,
    entities: [],
    ...overrides,
  };
}

function exchange(): Exchange {
  return {
    provider: "chatgpt",
    threadId: "thread-a",
    messageId: "message-a",
    userText: SOURCE.userText,
    assistantText: SOURCE.assistantText,
    ts: 1,
  };
}

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
