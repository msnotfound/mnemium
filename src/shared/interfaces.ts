// Mnemium swappable seams — FROZEN CONTRACT. These interfaces are the boundaries
// between modules built in parallel. Implementations live in their owning dir;
// consumers depend ONLY on these signatures. Do not change without notifying owners.

import type {
  Edge, Entity, Exchange, Memory, MemoryType, DraftMemory, Provider,
  Document, Chunk, MemorySource, LedgerEntry,
} from "./types";

export type Unsubscribe = () => void;

/** Vector store. sqlite-vec impl now; hnswlib-wasm/voy possible later. Vectors are
 *  tagged by embedding model id so an embedder swap = background re-embed + cutover. */
export interface VectorIndex {
  upsert(modelId: string, rows: { id: string; vec: Float32Array }[]): Promise<void>;
  search(
    modelId: string,
    q: Float32Array,
    k: number,
    filter?: { scopePrefix?: string; type?: MemoryType[] },
  ): Promise<Array<{ id: string; score: number }>>;
  drop(modelId: string): Promise<void>;
}

/** Embedding model. Swappable; changing it invalidates existing vectors (re-embed). */
export interface Embedder {
  readonly id: string; // e.g. "bge-small-en-v1.5"
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Distillation model: bundled on-device SLM | local server (Ollama) | BYO API key. */
export interface MemoryModel {
  readonly id: string;
  distill(ex: Exchange): Promise<{ memories: DraftMemory[]; entities: Entity[] }>;
  /** Lazy/optional — never on the write hot path. */
  classifyRelations?(m: Memory, candidates: Memory[]): Promise<Edge[]>;
}

export interface CaptureHooks {
  /** Called once per finalized turn (after the assistant stream completes). */
  onExchange(ex: Exchange): void;
  onError?(err: unknown): void;
}

/** One per provider. Isolates ALL site-specific brittleness (capture + inject). */
export interface SiteAdapter {
  readonly provider: Provider;
  matches(url: string): boolean;
  /** Network-primary capture + semantic-DOM fallback live behind this. */
  captureStream(hooks: CaptureHooks): Unsubscribe;
  /** Returns false → caller falls back to clipboard ("copied — paste it"). */
  injectContext(text: string): Promise<boolean>;
  locateComposer(): HTMLElement | null;
  currentThreadId(): string | null;
  readonly capability: {
    transport: "sse" | "json" | "ws";
    editor: "textarea" | "prosemirror" | "lexical" | "contenteditable";
  };
}

// ---- storage repositories (thin, typed; impl in core/storage) ----

export interface DocumentRepo {
  insert(doc: Document): Promise<void>;
  insertChunks(chunks: Chunk[]): Promise<void>;
}

export interface MemoryRepo {
  upsert(m: Memory): Promise<void>;
  linkSource(link: MemorySource): Promise<void>;
  supersede(oldId: string, next: Memory): Promise<void>; // version-chain bump
  byScope(scopePrefix: string, opts?: { type?: MemoryType[]; limit?: number }): Promise<Memory[]>;
  search(query: string, opts: { scopePrefix?: string; type?: MemoryType[]; k: number }): Promise<Memory[]>;
  delete(id: string): Promise<void>;
  sweepExpired(now: number): Promise<number>;
  bumpReuse(id: string): Promise<void>;
}

export interface LedgerRepo {
  add(entry: LedgerEntry): Promise<void>;
  byThread(threadId: string): Promise<LedgerEntry[]>;
}
