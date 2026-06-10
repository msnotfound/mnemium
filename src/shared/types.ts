// Mnemium domain model — FROZEN CONTRACT. Do not change shapes without bumping
// the schema migration + notifying all module owners. Every agent imports from here.

export type Provider = "chatgpt" | "claude" | "gemini" | "grok" | "deepseek";

/** Typed memory states (richer than Supermemory's 3-relation model). */
export const MEMORY_TYPES = ["fact", "preference", "episode", "task", "identity"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

/**
 * Typed edges. Free (eager, no LLM): about, co_occurs, supersedes(eager guess).
 * Lazy (LLM, deferred off the write path): supersedes(confirm), invalidates, derives.
 */
export type EdgeType = "about" | "co_occurs" | "supersedes" | "invalidates" | "derives";

export type ComputedBy = "eager" | "lazy" | "llm";
export type SourceType = "chat_turn" | "web" | "selection";

/** Raw captured source. One per conversation thread (turns become chunks). */
export interface Document {
  id: string;
  sourceType: SourceType;
  provider?: Provider;
  uri?: string;
  title?: string;
  scopeUri: string; // e.g. "personal::chatgpt::<thread-id>"
  capturedAt: number; // epoch ms
  rawContent: string;
}

/** Raw payload slice. Embedded in vec_chunks. Kept separate from Memory (M:N). */
export interface Chunk {
  id: string;
  documentId: string;
  ord: number;
  text: string;
}

/** Atomic, disambiguated memory — the searchable index unit. */
export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  scopeUri: string;
  // version chain (contradiction resolution / history)
  version: number;
  isLatest: boolean;
  parentMemoryId?: string;
  rootMemoryId?: string;
  // flags
  isStatic: boolean; // stable trait vs dynamic activity
  isInference: boolean;
  confidence: number; // 0..1
  // bi-temporal
  eventDate?: number;
  documentDate?: number;
  validFrom?: number;
  validTo?: number;
  // forgetting
  forgetAfter?: number;
  forgetReason?: string;
  isForgotten: boolean;
  // signals
  reuseCount: number;
  sourceCount: number;
  createdAt: number;
}

/** M:N link: a memory is corroborated by 1..n chunks/documents. */
export interface MemorySource {
  memoryId: string;
  chunkId: string;
  documentId: string;
  relevance: number;
}

export interface Entity {
  id: string;
  type: string; // person | place | project | concept | org | ...
  name: string;
  normalizedName: string;
  scopeUri: string;
}

export interface Edge {
  id: string;
  srcMemoryId: string;
  dstMemoryId: string;
  type: EdgeType;
  weight: number;
  computedBy: ComputedBy;
  confidence: number;
}

/** Audit row. References only — no duplicated text. Anchored to provider message id. */
export interface LedgerEntry {
  id: string;
  memoryId: string;
  scopeUri: string;
  threadId: string;
  messageId: string;
  injectedAt: number;
}

// ---- transient / pipeline types (not persisted as-is) ----

/** A finalized turn pair, emitted by SiteAdapter.captureStream after stream completes. */
export interface Exchange {
  provider: Provider;
  threadId: string;
  messageId: string; // provider's stable server-side id for the assistant message
  userText: string;
  assistantText: string;
  ts: number;
}

/** Output of MemoryModel.distill before persistence. */
export interface DraftMemory {
  type: MemoryType;
  content: string;
  isStatic: boolean;
  isInference?: boolean;
  confidence?: number;
  entities: string[]; // normalized names
  eventDate?: number;
}

/** A memory surfaced to the user for per-chunk ✓/✖ injection. */
export interface SurfacedChunk {
  memoryId: string;
  content: string;
  type: MemoryType;
  sourceLabel: string; // "Claude · 3d"
  score: number;
  provenance?: {
    scopeUri: string;
    sameThread: boolean;
  };
}

/** Feature vector for the contextual-bandit inject/skip decision. */
export interface BanditFeatures {
  sim: number;
  distinctiveness: number;
  noveltyVsContext: number;
  recency: number;
  reuseCount: number;
  confidence: number;
  type: MemoryType;
  scopeMatch: number;
}
