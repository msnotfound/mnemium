import { computeEagerEdges } from "./edges";
import { salience } from "./salience";
import type { Embedder, MemoryModel, MemoryRepo, VectorIndex } from "@shared/interfaces";
import type { Chunk, Document, Edge, Entity, Exchange, Memory } from "@shared/types";

export interface CapturePipelineDeps {
  documents: {
    insert(doc: Document): Promise<void>;
    insertChunks(chunks: Chunk[]): Promise<void>;
  };
  memories: MemoryRepo;
  embedder: Embedder;
  vectorIndex: VectorIndex;
  memoryModel: MemoryModel;
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

    if (salience(ex)) {
      queueMicrotask(() => {
        void this.distillAndStore(ex, document, chunks).catch((error: unknown) => this.deps.onError?.(error));
      });
    }
  }

  private async distillAndStore(ex: Exchange, document: Document, chunks: Chunk[]): Promise<void> {
    const result = await this.deps.memoryModel.distill(ex);
    const memories = result.memories.map((draft, index) => memoryFromDraft(draft, ex, index, this.deps.now?.() ?? Date.now()));
    if (memories.length === 0) {
      return;
    }

    const existing = await this.deps.memories.byScope(document.scopeUri, { limit: 50 });
    const vectors = await this.deps.embedder.embed(memories.map((memory) => memory.content));
    const primaryChunk = chunks[0];

    for (let i = 0; i < memories.length; i += 1) {
      const memory = memories[i];
      const vector = vectors[i];
      if (memory === undefined || vector === undefined || primaryChunk === undefined) {
        continue;
      }
      await this.deps.memories.upsert(memory);
      await this.deps.memories.linkSource({
        memoryId: memory.id,
        chunkId: primaryChunk.id,
        documentId: document.id,
        relevance: 1,
      });
      await this.deps.vectorIndex.upsert(this.deps.embedder.id, [{ id: memory.id, vec: vector }]);
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
  draft: {
    type: Memory["type"];
    content: string;
    isStatic: boolean;
    isInference?: boolean;
    confidence?: number;
    eventDate?: number;
  },
  ex: Exchange,
  index: number,
  now: number,
): Memory {
  return {
    id: `mem:${ex.provider}:${ex.threadId}:${ex.messageId}:${index}`,
    type: draft.type,
    content: draft.content,
    scopeUri: scopeForExchange(ex),
    version: 1,
    isLatest: true,
    isStatic: draft.isStatic,
    isInference: draft.isInference ?? false,
    confidence: draft.confidence ?? 0.7,
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
