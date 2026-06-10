# Trust-loop notes (v0.0.14 / `feat/trust-loop`)

Scope: close the trust loop per CODEX_REVIEW.md §L / §C / §F.3 / §O — cheap
models emit *candidate claims*; a deterministic validator gates entry into the
active memory set; retrieval explains itself.

## 1. Evidence-bound extraction

**Diagnosis.** `DraftMemory` had no link back to the source text. A qwen2.5-1.5b
hallucination was indistinguishable from a grounded claim — `confidence` was
model-asserted, i.e. worthless as a trust signal.

**Decision.** Every candidate now carries `evidence` (verbatim source span),
`speaker` (`user|assistant`), `supportKind` (`exact|paraphrase|inferred`).
The daemon normalizes casing/whitespace but does **not** gate — the extension
validator is the single enforcement point, because only the extension still
holds the source exchange at write time (one gate, not two half-gates).

**GBNF (working-agreement item 4).** I did not wait to observe qwen failing the
prompt — a 1.5B model will not reliably emit a 9-field schema with three enums
from instructions alone, and shape failures are silent (memories just stop
appearing). The llama.cpp backend now sends a GBNF `grammar` on
`/v1/chat/completions` that pins field order and the `type`/`speaker`/
`supportKind` enums, **replacing** `response_format: json_object` (llama-server
implements json_object as its own grammar; sending both conflicts). Grammar
guarantees shape; the validator guarantees content. Ollama keeps `format:
"json"` + prompt — Ollama's structured-output schema param only landed in
v0.5.x and erroring older installs over it isn't worth the risk this branch;
flagged as follow-up. Cloud backends follow instructions fine.

**Kept `isStatic`** (the brief's new shape dropped it). The `memory.is_static`
column and `memoryFromDraft` depend on it; removing it is schema churn outside
this branch's purpose. It's now optional with a type-derived default.

Files: `daemon/internal/backends/distill/{distill,prompt,llamacpp,openai}.go`,
`daemon/internal/backends/distill/prompt_test.go`, `src/shared/types.ts`,
`src/core/memory-model.ts` (heuristic fallback now splits user/assistant text so
speaker is correct by construction, and only emits sentences that survive a
verbatim-substring check against the raw source), `src/core/capture.ts` (compat).
`src/core/daemon-client.ts` needed nothing — it already types against the shared
`DraftMemory`.

Verify: `cd daemon && go build ./... && go vet ./... && go test ./internal/backends/distill/`

## 2. Deterministic validator

**Decision.** `src/core/validate.ts` — pure, synchronous, no IO. Rules, in
order: non-empty content → valid `type` → evidence present → valid `speaker` →
valid `supportKind` → evidence is a literal substring of
`${userText}\n\n${assistantText}` (case-insensitive, trimmed) → evidence occurs
in the claimed speaker's own text → `inferred` only allowed for `task`/`episode`
→ no hedging language (`maybe|could|might|perhaps|probably|should we|what if|
one option|thinking about`, §L.3) → assistant-spoken evidence may only back
claims *about the user* (rejects second-person advice, requires "the user" in
content).

Two deliberate strictness calls:
- **Unknown `speaker`/`supportKind` are rejected**, not defaulted. Defaulting
  re-opens the door the field exists to close.
- **`inferred` tasks/episodes pass but enter as `pending_review`**, which the
  retrieval filter excludes. Until a review UI exists (out of scope) they're
  quarantined, not surfaced. That follows §L's storage policy ("inference:
  pending review") at the cost of hiding some real tasks — recall is the
  cheaper thing to lose right now.

Drops are logged `[mnemium/validate] dropped <reason>` and persisted (below).
`VALIDATOR_VERSION = 1` is exported so stored rejections stay interpretable
when rules change.

Files: `src/core/validate.ts` (new), `src/core/capture.ts` (gate between
distill and upsert), `test/validate.node.test.ts` (new — 10 unit tests + the
required pipeline fixture: 3 qwen candidates, 1 ungrounded, asserts the drop
log and the audit row), `test/capture.node.test.ts` (fixtures updated to carry
evidence — required, since draft shape changed).

Verify: `pnpm vitest run test/validate.node.test.ts test/capture.node.test.ts`

## 3. Schema additions

**Decision: separate `memory_rejection` table, not `claim_status='rejected'`
rows in `memory`.** Rejected candidates in `memory` would mean every current
and future read path (retrieval, export, supersede chains, FTS triggers,
dedupe) must remember to exclude them — one missed filter and a hallucination
leaks, which is the exact failure mode this branch exists to kill. A separate
append-only table is fail-safe by construction. Consequence: `claim_status` on
`memory` only ever holds `active|pending_review`; the `rejected` value from the
brief lives implicitly in `memory_rejection`.

- `memory` + `evidence`, `speaker`, `support_kind`, `claim_status TEXT NOT NULL
  DEFAULT 'active'` (+ `idx_memory_claim`).
- `memory_rejection`: id, scope/provider/thread/message, the candidate's
  content/evidence/speaker/support_kind, `reason`, `created_at`.
- `SCHEMA_VERSION` 1 → 2; `initialize()` now runs `MIGRATE_V1_TO_V2` (pure
  `ALTER TABLE ADD COLUMN` — instant in SQLite; existing rows grandfather to
  `claim_status='active'`, which is correct: pre-trust-loop memories stay
  retrievable rather than being mass-quarantined).
- All retrieval paths filter `claim_status = 'active'`: `repos.byScope`,
  `repos.search`, `retrieval.lexicalSearch`, and `retrieval.fetchSurfaced`
  (the safety net for dense hits, since the vector index only returns ids).

Files: `src/core/storage/{schema.sql,db.ts,repos.ts}`, `src/shared/types.ts`
(`Memory` trust fields, `MemoryRejection`), `src/shared/interfaces.ts`
(`MemoryRepo.recordRejection` — contract bump, all fakes updated).

Verify: `pnpm vitest run test/engine.node.test.ts` (exercises the real schema).

## 4. "Why this matched" in retrieval

`SurfacedChunk` gains `matchKind` (`semantic|lexical`), `matchScore`, and
`evidence`. The fields are optional — autoinject fixtures and legacy responses
don't carry them, and the UI degrades by omission.

- Hybrid path: `matchKind` = the mode with the larger *weighted* contribution
  (dense ×0.65 vs lexical ×0.35 — same weights as `mergeCandidates`);
  `matchScore` = that mode's **raw** score so the UI shows "0.82 semantic"
  rather than an uninterpretable blend.
- FTS fallback (no daemon): `matchKind: "lexical"`, `matchScore` =
  `memory.confidence` (no bm25 rank survives `repos.search`; honest follow-up:
  thread the rank through).
- In-page panel: a mono reason line per chunk —
  `preference · 0.82 semantic · same thread · view evidence` — where
  "view evidence" is a native-`title` hover showing the verbatim source quote.
  Dependency-free, works inside the shadow root.
- `src/ui/components/rpc.ts` needed no change — it consumes `SurfacedChunk`
  structurally and the new fields flow through the RPC envelope untouched.

Files: `src/shared/types.ts`, `src/core/retrieval.ts`,
`src/entrypoints/offscreen/main.ts`, `src/ui/inpage/index.tsx`.

Verify: `pnpm typecheck && pnpm build`, then Alt+Shift+M on a chatgpt thread.

## Verification summary

- `pnpm typecheck` — clean
- `pnpm test` (vitest run) — 7 files, 29 tests, all green (was 18)
- `pnpm build` — chrome-mv3 builds clean
- `cd daemon && go build ./... && go vet ./... && go test ./internal/backends/distill/` — clean

## Departures from the brief (with reasons)

1. **Rejections in `memory_rejection`, not `claim_status='rejected'`** — see §3.
2. **Kept `isStatic` on `DraftMemory`** (optional) — see §1.
3. **GBNF shipped proactively** rather than after observing prompt failure —
   shape failures are silent and unobservable in the field; see §1.
4. **`pending_review` is excluded from retrieval entirely** rather than shown
   with a warning — there is no review UI in scope to make "shown but
   uncertain" meaningful.
5. **Daemon does not gate on trust fields** — single enforcement point in the
   extension, which holds the source text. The daemon only normalizes.

## Pre-existing bugs noticed (NOT fixed here)

- `retrieval.lexicalSearch` passes the raw draft to `fts_memory MATCH ?` with
  no sanitization — FTS5 operators in user text (quotes, `-`, `:`) throw and
  knock the hybrid path down to its catch-all. `repos.search` already has
  `toFtsPrefixQuery`; the retriever should reuse it.
- `db.ts` `WorkerDatabaseAdapter.prepare().run()` hardcodes `changes: 0`, so
  `sweepExpired`'s return value is always 0 in the browser build.
- `ollama.go` `Ready()` is unconditionally `true`, so `/status` lies when
  ollama isn't running.

## Follow-ups this sets up

- Review UI over `claim_status='pending_review'` + `memory_rejection`
  (lifecycle controls, §O item 5).
- Binary verifier pass for `paraphrase` claims (§L verifier step).
- System-side confidence computation from validator signals (§L confidence
  policy) — model confidence is still stored as-is.
- Export currently includes only active memories and not `memory_rejection`.
