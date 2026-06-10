import { computeEagerEdges } from "./edges";
import { analyzeSalience } from "./salience";
import { validateDraft } from "./validate";
import type { Embedder, MemoryModel, MemoryRepo, VectorIndex } from "@shared/interfaces";
import type { Chunk, ClaimStatus, Document, DraftMemory, Edge, Entity, Exchange, Memory } from "@shared/types";

export interface CapturePipelineDeps {
  documents: {
    insert(doc: Document): Promise<void>;
    insertChunks(chunks: Chunk[]): Promise<void>;
  };
  memories: MemoryRepo;
  embedder: Embedder;
  vectorIndex: VectorIndex;
  memoryModel: MemoryModel;
  /** When false, distillation writes memory rows but skips embedding +
   *  vector index. Browser builds set this to false until the embedder is
   *  vendored locally. Node tests pass true (sqlite-vec works in Node). */
  useEmbedder?: boolean;
  onEdges?(edges: Edge[]): Promise<void> | void;
  onError?(error: unknown): void;
  now?(): number;
}

export class CapturePipeline {
  constructor(private readonly deps: CapturePipelineDeps) {}

  async captureExchange(ex: Exchange): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    const document = documentForExchange(ex, now);
    const chunks = chunksForExchange(ex, document.id);
    await this.deps.documents.insert(document);
    await this.deps.documents.insertChunks(chunks);

    // Salience filter. Casual chat (short replies, questions) gets dropped
    // here so we don't spam the distill backend with low-value exchanges.
    // Log the decision and reasons so the user can see why a capture
    // didn't produce memories.
    const decision = analyzeSalience(ex);
    console.info(
      "[mnemium/capture] salience",
      decision.salient ? "PASS" : "SKIP",
      `score=${decision.score.toFixed(2)}`,
      `reasons=[${decision.reasons.join(",")}]`,
    );
    if (decision.salient) {
      queueMicrotask(() => {
        void this.distillAndStore(ex, document, chunks).catch((error: unknown) => {
          console.error("[mnemium/capture] distillAndStore threw", error);
          this.deps.onError?.(error);
        });
      });
    }
  }

  private async distillAndStore(ex: Exchange, document: Document, chunks: Chunk[]): Promise<void> {
    console.info("[mnemium/capture] distilling", `${ex.provider}::${ex.threadId}`);
    const started = Date.now();
    const result = await this.deps.memoryModel.distill(ex);
    const took = Date.now() - started;
    console.info(
      "[mnemium/capture] distill result",
      `memories=${result.memories.length}`,
      `entities=${result.entities.length}`,
      `took=${took}ms`,
    );
    // Trust gate: every candidate runs through the deterministic validator.
    // Valid claims become memory rows; dropped ones are logged AND persisted
    // to memory_rejection so the user can audit what the model tried to claim.
    const source = { userText: ex.userText, assistantText: ex.assistantText };
    const accepted: Array<{ draft: DraftMemory; index: number; claimStatus: ClaimStatus }> = [];
    for (let index = 0; index < result.memories.length; index += 1) {
      const draft = result.memories[index];
      if (draft === undefined) continue;
      const verdict = validateDraft(draft, source);
      if (verdict.ok) {
        accepted.push({ draft, index, claimStatus: verdict.claimStatus });
        continue;
      }
      console.warn(`[mnemium/validate] dropped ${verdict.reason}`, JSON.stringify(draft.content));
      await this.deps.memories.recordRejection({
        id: `rej:${ex.provider}:${ex.threadId}:${ex.messageId}:${index}`,
        scopeUri: document.scopeUri,
        provider: ex.provider,
        threadId: ex.threadId,
        messageId: ex.messageId,
        type: String(draft.type),
        content: draft.content,
        evidence: draft.evidence,
        speaker: draft.speaker,
        supportKind: draft.supportKind,
        reason: verdict.reason,
        createdAt: this.deps.now?.() ?? Date.now(),
      });
    }
    if (accepted.length !== result.memories.length) {
      console.info(
        "[mnemium/validate] gate result",
        `accepted=${accepted.length}`,
        `rejected=${result.memories.length - accepted.length}`,
      );
    }
    const memories = accepted.map(({ draft, index, claimStatus }) =>
      memoryFromDraft(draft, ex, index, this.deps.now?.() ?? Date.now(), claimStatus),
    );
    if (memories.length === 0) {
      return;
    }

    const primaryChunk = chunks[0];
    const existing = await this.deps.memories.byScope(document.scopeUri, { limit: 50 });

    // v0.1: embedder + vector index disabled (MV3 CSP forbids transformers.js's
    // remote ESM load). Memories are written by content only; retrieval falls
    // back to FTS5. The embed/upsert path is restored when the embedder is
    // vendored locally — see Extension-Architecture-Analysis-for-Vector-Load.md.
    const useEmbedder = this.deps.useEmbedder ?? false;
    const vectors = useEmbedder
      ? await this.deps.embedder.embed(memories.map((memory) => memory.content))
      : memories.map(() => new Float32Array());

    for (let i = 0; i < memories.length; i += 1) {
      const memory = memories[i];
      if (memory === undefined || primaryChunk === undefined) {
        continue;
      }
      await this.deps.memories.upsert(memory);
      await this.deps.memories.linkSource({
        memoryId: memory.id,
        chunkId: primaryChunk.id,
        documentId: document.id,
        relevance: 1,
      });
      if (useEmbedder) {
        const vector = vectors[i];
        if (vector !== undefined && vector.length > 0) {
          await this.deps.vectorIndex.upsert(this.deps.embedder.id, [{ id: memory.id, vec: vector }]);
        }
      }
    }

    const eager = computeEagerEdges({
      memories,
      entities: result.entities,
      candidates: existing,
      vectors: new Map(memories.map((memory, index) => [memory.id, vectors[index] ?? new Float32Array()])),
    });
    for (const supersession of eager.supersedes) {
      await this.deps.memories.supersede(supersession.oldMemoryId, supersession.next);
    }
    await this.deps.onEdges?.(eager.edges);
  }
}

export function createCapturePipeline(deps: CapturePipelineDeps): CapturePipeline {
  return new CapturePipeline(deps);
}

function documentForExchange(ex: Exchange, capturedAt: number): Document {
  return {
    id: `doc:${ex.provider}:${ex.threadId}`,
    sourceType: "chat_turn",
    provider: ex.provider,
    scopeUri: scopeForExchange(ex),
    capturedAt,
    rawContent: `${ex.userText}\n\n${ex.assistantText}`,
  };
}

function chunksForExchange(ex: Exchange, documentId: string): Chunk[] {
  return [
    {
      id: `chunk:${ex.provider}:${ex.threadId}:${ex.messageId}`,
      documentId,
      ord: 0,
      text: `${ex.userText}\n\n${ex.assistantText}`.trim(),
    },
  ];
}

function memoryFromDraft(
  draft: DraftMemory,
  ex: Exchange,
  index: number,
  now: number,
  claimStatus: ClaimStatus,
): Memory {
  return {
    id: `mem:${ex.provider}:${ex.threadId}:${ex.messageId}:${index}`,
    type: draft.type,
    content: draft.content,
    scopeUri: scopeForExchange(ex),
    version: 1,
    isLatest: true,
    isStatic: draft.isStatic ?? (draft.type !== "task" && draft.type !== "episode"),
    isInference: draft.isInference ?? false,
    confidence: draft.confidence ?? 0.7,
    evidence: draft.evidence,
    speaker: draft.speaker,
    supportKind: draft.supportKind,
    claimStatus,
    eventDate: draft.eventDate,
    documentDate: ex.ts,
    isForgotten: false,
    reuseCount: 0,
    sourceCount: 1,
    createdAt: now,
  };
}

function scopeForExchange(ex: Exchange): string {
  return `personal::${ex.provider}::${ex.threadId}`;
}
