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

/** Who actually said the evidence span backing a claim. */
export const SPEAKERS = ["user", "assistant"] as const;
export type Speaker = (typeof SPEAKERS)[number];

export function isSpeaker(value: string): value is Speaker {
  return (SPEAKERS as readonly string[]).includes(value);
}

/** How much interpretation went into deriving content from its evidence. */
export const SUPPORT_KINDS = ["exact", "paraphrase", "inferred"] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number];

export function isSupportKind(value: string): value is SupportKind {
  return (SUPPORT_KINDS as readonly string[]).includes(value);
}

/** Trust lifecycle of a claim. Only "active" claims are retrievable. */
export const CLAIM_STATUSES = ["active", "pending_review", "rejected"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

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
  // trust (v2): evidence-bound extraction
  evidence?: string; // verbatim source span backing the claim
  speaker?: Speaker; // who said the evidence
  supportKind?: SupportKind;
  /** Lifecycle gate — retrieval only surfaces "active". Optional for
   *  legacy rows / fixtures; persisted as "active" when omitted. */
  claimStatus?: ClaimStatus;
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

/** Audit row for a candidate the validator dropped. Lives in its own table
 *  (memory_rejection), never in memory — rejected claims must be structurally
 *  unable to leak into retrieval. */
export interface MemoryRejection {
  id: string;
  scopeUri: string;
  provider?: Provider;
  threadId?: string;
  messageId?: string;
  type?: string;
  content: string;
  evidence?: string;
  speaker?: string;
  supportKind?: string;
  reason: string;
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

/** Output of MemoryModel.distill before persistence — a CANDIDATE claim.
 *  Candidates only become Memory rows after passing the deterministic
 *  validator (src/core/validate.ts), which checks the evidence span exists
 *  verbatim in the source and the speaker attribution is correct. */
export interface DraftMemory {
  type: MemoryType;
  content: string;
  /** Exact substring of the source userText/assistantText supporting the claim. */
  evidence?: string;
  /** Who actually said the evidence span. */
  speaker?: Speaker;
  /** exact | paraphrase | inferred — interpretation distance from evidence. */
  supportKind?: SupportKind;
  isStatic?: boolean;
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
  /** Which retrieval mode produced this hit (dominant contributor). */
  matchKind?: "semantic" | "lexical";
  /** Raw score of the winning mode (cosine for semantic, normalized bm25 for lexical). */
  matchScore?: number;
  /** Verbatim source quote that grounded this memory at extraction time. */
  evidence?: string;
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
