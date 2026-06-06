# Build guide — Distillation + auto-injection (codex)

Read `docs/build/00-agent-common.md` first. Implements DESIGN-SPEC §6 (ontology), §7 (salience), §8 (distillation), §10 (adaptive auto-inject), §B6. Depend on engine core ONLY via `@shared/interfaces` (Embedder, VectorIndex, MemoryRepo, etc.) — do not edit engine files.

## Owns (create only these)
```
src/core/salience.ts             # cheap gate: regex + NER-lite + length + intent → distill? (boolean)
src/core/memory-model.ts         # MemoryModel impls: bundled SLM (WebLLM), localServer (Ollama), apiKey (BYO)
src/core/capture.ts              # pipeline: Exchange → persist doc/chunks → salience → distill → upsert memories + EAGER edges
src/core/edges.ts                # eager edge computation (about via entities, co_occurs via cosine+proximity, supersedes via entity+predicate collision)
src/core/autoinject/semantic-delta.ts  # rolling centroid + ε-gate (search only on semantic change)
src/core/autoinject/relevance-gate.ts  # floor + distinctiveness + novelty-vs-visible-context + value rank
src/core/autoinject/mmr.ts             # maximal marginal relevance set selection
src/core/autoinject/bandit.ts          # online logistic + Thompson; cold-start from heuristic prior; persists weights in `meta`
src/core/autoinject/index.ts           # orchestrates delta→retrieve→gate→mmr→bandit → SurfacedChunk[]
test/autoinject.node.test.ts
```

## What to build
1. **memory-model.ts** — implement `MemoryModel`. `bundled`: WebLLM (`@mlc-ai/web-llm`) running `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`, loaded lazily in the offscreen worker, **background queue** (never blocks). `localServer`: POST to an Ollama-style endpoint. `apiKey`: OpenAI/Anthropic/OpenRouter. `distill(Exchange)` → atomic `DraftMemory[]` + `Entity[]` using a coreference-resolving prompt (atomic-fact extraction). `classifyRelations` is **lazy/optional** — leave a stub that the integrator can enable.
2. **capture.ts** — the write pipeline (called by the offscreen RPC handler for `capture.exchange`): persist `Document` + `Chunk[]` ALWAYS (cheap, full-text payload); run `salience()`; if salient, enqueue distill (low-priority) → on result, upsert `Memory` rows (+ `memory_source`, `memory_entity`) and compute **eager edges** via `edges.ts`. Never run the LLM on the hot path; never block the caller.
3. **edges.ts** — only the FREE edges (no LLM): `about` (memory→entity), `co_occurs` (embedding cosine + temporal proximity), `supersedes` (eager structural guess: same entity + predicate collision → flip prior `is_latest`). Lazy edges (`invalidates`, `derives`, LLM-confirmed `supersedes`) are deferred — leave clearly-marked hooks.
4. **autoinject/** — exactly per spec §10: `semantic-delta` (don't search unless draft embedding moved ≥ ε from last-searched; reuse cache otherwise); `relevance-gate` (absolute floor from config; distinctiveness margin; **suppress memories already present in visible context**; rank by `sim×confidence×recency×reuseCount`); `mmr` (diverse set, λ≈0.7); `bandit` (online logistic over `BanditFeatures`; Thompson sampling; **cold-start = heuristic weights as prior**; update from `inject.feedback` ✓/✖; persist weights in `meta`). `index.ts` ties them together → `SurfacedChunk[]` for the gray block. "Auto" = auto-**surface**, never auto-send.

## Gotchas
- This module is pure logic over interfaces — fully **Node-testable** (mock Embedder/VectorIndex/repo). Do it.
- Reuse the engine's `retrieval.hybridSearch` raw scored candidates; the relevance gate layers on top (don't re-implement hybrid search).
- Keep the SLM optional/degradable: if no WebGPU and no key, distillation falls back to a light heuristic (chunk→candidate memory) so the product still works (spec §8 fallback).

## Test (test/autoinject.node.test.ts)
Assert: no search when draft unchanged (ε-gate); nothing surfaced below floor; redundant (already-visible) memory suppressed; bandit shifts after repeated ✖. Use mocked interfaces.
