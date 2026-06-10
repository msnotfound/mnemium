// Deterministic claim validator — the trust gate between the distill model
// and the memory table. Cheap models (qwen2.5-1.5b) produce CANDIDATE
// claims; nothing enters the active memory set unless its evidence span
// exists verbatim in the source exchange, the speaker attribution is
// correct, and the claim class is allowed for its memory type.
//
// Design rule: this module is pure and synchronous. No model calls, no IO.
// Every rejection carries a machine-readable reason that is logged as
// `[mnemium/validate] dropped <reason>` and persisted to memory_rejection
// for later audit. See CODEX_REVIEW.md §L for the failure modes this kills.

import {
  isMemoryType,
  isSpeaker,
  isSupportKind,
  type ClaimStatus,
  type DraftMemory,
} from "@shared/types";

/** Bump when validation rules change, so stored rejections stay interpretable. */
export const VALIDATOR_VERSION = 1;

export interface ValidationSource {
  userText: string;
  assistantText: string;
}

export type ValidationVerdict =
  | { ok: true; claimStatus: Extract<ClaimStatus, "active" | "pending_review">; warnings: string[] }
  | { ok: false; reason: string };

/** Hypothetical / hedging phrases (CODEX_REVIEW §L.3). A durable claim that
 *  needs a hedge isn't a durable claim — brainstorming must not become fact. */
const HEDGING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bmaybe\b/i,
  /\bcould\b/i,
  /\bmight\b/i,
  /\bperhaps\b/i,
  /\bprobably\b/i,
  /\bshould we\b/i,
  /\bwhat if\b/i,
  /\bone option\b/i,
  /\bthinking about\b/i, // covers "I'm thinking about", "the user is thinking about"
];

/** Second-person advice markers. Assistant-spoken evidence may only back
 *  claims ABOUT the user, never advice TO the user. */
const SECOND_PERSON = /\byou\b|\byours?\b/i;
const ABOUT_USER = /\b(?:the\s+)?user(?:'s)?\b/i;

/** Memory types allowed to rest on inferred (beyond-the-evidence) support.
 *  Preferences / identity / facts must be exact or paraphrase — a model
 *  guessing someone's identity is exactly the hallucination class we gate. */
const INFERRABLE_TYPES: ReadonlySet<string> = new Set(["task", "episode"]);

export function validateDraft(draft: DraftMemory, source: ValidationSource): ValidationVerdict {
  const content = (draft.content ?? "").trim();
  if (content.length === 0) {
    return reject("empty_content");
  }
  if (!isMemoryType(String(draft.type))) {
    return reject(`invalid_type:${String(draft.type)}`);
  }

  const evidence = (draft.evidence ?? "").trim();
  if (evidence.length === 0) {
    return reject("missing_evidence");
  }

  const speaker = String(draft.speaker ?? "");
  if (!isSpeaker(speaker)) {
    return reject(`invalid_speaker:${speaker || "(none)"}`);
  }

  const supportKind = String(draft.supportKind ?? "");
  if (!isSupportKind(supportKind)) {
    return reject(`invalid_support_kind:${supportKind || "(none)"}`);
  }

  // Evidence must exist verbatim in the source (case-insensitive, trimmed).
  // This is THE grounding check: a model cannot fabricate support without
  // also fabricating a span that happens to literally occur in the chat.
  const needle = evidence.toLowerCase();
  const combined = `${source.userText}\n\n${source.assistantText}`.toLowerCase();
  if (!combined.includes(needle)) {
    return reject("evidence_not_in_source");
  }

  // Speaker attribution: the span must occur in the text of whoever the
  // model claims said it. Catches "assistant suggestion → user fact" flips.
  const speakerText = (speaker === "user" ? source.userText : source.assistantText).toLowerCase();
  if (!speakerText.includes(needle)) {
    return reject(`speaker_mismatch:${speaker}`);
  }

  // Claim-class policy: only tasks/episodes may be inferred. Durable traits
  // (preference / identity / fact) need direct textual support.
  if (supportKind === "inferred" && !INFERRABLE_TYPES.has(draft.type)) {
    return reject(`inferred_${draft.type}_not_allowed`);
  }

  // Hedged content is not a durable claim, regardless of evidence.
  for (const pattern of HEDGING_PATTERNS) {
    if (pattern.test(content)) {
      return reject(`hedged_content:${pattern.source}`);
    }
  }

  // Assistant-spoken evidence: claim must describe the user, not advise them.
  if (speaker === "assistant") {
    if (SECOND_PERSON.test(content)) {
      return reject("assistant_second_person_advice");
    }
    if (!ABOUT_USER.test(content)) {
      return reject("assistant_claim_not_about_user");
    }
  }

  // Inferred tasks/episodes pass, but quarantined: pending_review is kept
  // out of retrieval until a review surface exists (claim_status filter).
  const warnings: string[] = [];
  if (supportKind === "inferred") {
    warnings.push("inferred_support");
  }
  return {
    ok: true,
    claimStatus: warnings.length > 0 ? "pending_review" : "active",
    warnings,
  };
}

function reject(reason: string): ValidationVerdict {
  return { ok: false, reason };
}
