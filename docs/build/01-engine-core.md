# Build guide — Engine core (codex)

Read `docs/build/00-agent-common.md` first. Implements DESIGN-SPEC §B5, §B6 (hybrid retrieval), §B8-M1.

## Owns (create only these)
```
src/core/storage/db.ts          # open SQLite (sqlite-wasm OPFS in ext; better-sqlite3 in Node tests), load schema.sql, run migrations (PRAGMA user_version)
src/core/storage/repos.ts       # implement DocumentRepo, MemoryRepo, LedgerRepo from @shared/interfaces
src/core/vector-index.ts        # implement VectorIndex via sqlite-vec
src/core/embedder.ts            # implement Embedder (bge-small-en-v1.5 via @huggingface/transformers, WebGPU→wasm)
src/core/retrieval.ts           # hybrid search: vec + FTS5 bm25 + typed/scope filter → ranked SurfacedChunk[]
test/engine.node.test.ts        # vitest, runs headless on better-sqlite3 + sqlite-vec node binding
```

## What to build
1. **db.ts** — a `Database` abstraction with one method surface used by repos. Provide two backends behind one factory: `openOpfs()` (sqlite-wasm + OPFS SAH-pool VFS, for the extension/offscreen) and `openNode(path?)` (better-sqlite3, for tests). Load and execute `src/core/storage/schema.sql` on open; honor `PRAGMA user_version` for forward migrations.
2. **repos.ts** — implement the three repo interfaces exactly as declared in `@shared/interfaces`. `MemoryRepo.supersede` bumps the version chain (`parent_memory_id`, `root_memory_id`, flips old `is_latest=0`). `sweepExpired` deletes/flags rows past `forget_after`. Use prepared statements.
3. **vector-index.ts** — implement `VectorIndex`. Create a sqlite-vec `vec0` virtual table **per embedding model** named `vec_<modelId-sanitized>` with the model's dim (passed on first upsert or via a small `meta` lookup). Map vec rows to memory ids (vec0 with a TEXT primary key, or a side mapping table you create — your call, keep it inside vector-index). `search()` applies `scopePrefix`/`type` by joining to `memory` (filter then KNN, or KNN then filter — pick the correct sqlite-vec pattern). Brute-force is fine (document the O(N) ceiling per spec).
4. **embedder.ts** — `bge-small-en-v1.5`, dim 384, mean-pooled + normalized. Lazy-load the model; expose `id`/`dim`. WebGPU with wasm fallback (transformers.js `device` option).
5. **retrieval.ts** — `hybridSearch(query, {scopePrefix, type, k})`: embed query → `VectorIndex.search` (dense) UNION FTS5 `bm25` (lexical) → merge/dedupe by memory_id → fetch memory + payload (top-k join to `memory_source`/`chunk`) → return ranked `SurfacedChunk[]`. Expose the raw scored candidates too (the auto-inject module layers its relevance gate on top — do NOT implement the gate here).

## Gotchas
- sqlite-vec is **brute-force** (no ANN). Keep `VectorIndex` swappable; don't leak sqlite-vec specifics past the interface.
- Embedder swap ⇒ different vector space. `meta` stores the active embedder id; re-embed/migration is a separate concern (expose `VectorIndex.drop(modelId)` + `upsert(newId, …)` so the integrator can run it).
- Node test backend must exercise the SAME SQL as the extension (only the driver differs).

## Test (test/engine.node.test.ts)
Insert ~1–5k synthetic memories+chunks+vectors; assert hybrid query returns expected top-k; assert version-chain supersede flips `is_latest`; assert `sweepExpired`. Target < 50ms/query at 10k.
