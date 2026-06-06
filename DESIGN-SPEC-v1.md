# Local-First Memory Extension — V1 Design Spec

**Status:** Locked (v1 scope)
**Date:** 2026-06-06
**Name:** Mnemium
**One-liner:** A zero-install Chrome extension that gives your AI chats a private, on-device "second brain" — it captures what you discuss across ChatGPT/Claude/Gemini/Grok/DeepSeek, distills it into typed memories locally, and lets you inject the right context back into any chat. Nothing leaves your device.

---

## 1. Positioning — why this beats Supermemory

Three independent codebase analyses (ChatGPT, Gemini, Claude) converged on one verdict: **Supermemory's moat is operational, not intellectual.** There is no novel algorithm — it's a clean assembly of 2024-era techniques (Contextual-Retrieval-style atomic memories, a simplified Zep `updates/extends/derives` ontology, bi-temporal stamps, RAG-fusion rewrite, `bge-reranker-base`, exact-string dedup) behind a low-latency cloud API. Its soft underbelly is **heavy ingestion** (multiple LLM calls per chunk), and its structural blind spot is that the whole engine assumes **cloud + server-side extraction + text-first**.

The 2026 research frontier (ENGRAM, MemMachine, LiCoMemory) independently validates the thesis: **lighter beats heavier** — retrieval-stage optimization dominates ingestion-stage complexity, and careful memory typing + simple dense retrieval matches SOTA at ~1% of the tokens.

**Our wedge:** the local-first consumer "second brain" on the axis they conceded. We win on: nothing-leaves-the-device privacy, zero-install distribution, robustness (network-layer capture vs. their brittle DOM scraping), and a leaner engine that pushes intelligence from ingest → retrieval.

We do **not** compete on the developer memory API (their fortress) or benchmark theater.

## 2. Goals / Non-goals

**V1 goals**
- Pure Chrome extension, zero-install, works after a one-time first-run model fetch.
- Capture + distill + store + retrieve + inject, fully on-device.
- 5 providers: ChatGPT, Claude, Gemini, Grok, DeepSeek.
- Genuine atomic distillation (on-device SLM), not raw-chat search.
- Robust against the rendering/transport diversity of AI chat sites.
- Transparent + user-controlled (per-chunk curation + audit ledger + export).

**Explicitly deferred (schema supports them; not built in v1)**
- Complex LLM relation edges (`derives`, `invalidates`) — populate lazily later.
- Multi-device sync, the V2 native daemon, the memory-graph visualization, voice ingestion, providers beyond the five.
- Command palette (later nicety — pure UI shell over existing retrieval/injection plumbing).

## 3. Architecture principle — everything brittle lives behind a swappable seam

The unifying discipline: every layer that evolves or is provider-specific is isolated behind a stable interface, so a change is a *local* fix, never an architecture rewrite.

| Seam | Interface | Implementations |
|---|---|---|
| `VectorIndex` | `upsert(id, vec, meta)` / `search(vec, filter, k)` | sqlite-vec (v1) → hnswlib-wasm/voy at scale |
| `SiteAdapter` | `captureStream()` / `injectContext()` | one per provider (×5) |
| `MemoryModel` | `distill(exchange) → {facts, entities}` | bundled on-device SLM (default) / user's local model / local server (Ollama, LM Studio) / BYO API key |
| `Embedder` | `embed(text) → vec`, `id`, `dim` | bge-small (default) / other ONNX / BYO-key endpoints |
| Storage | SQLite (portable) | OPFS now → libSQL/cr-sqlite for sync later, schema unchanged |

## 4. Runtime topology (Manifest V3)

```
AI chat tab ──content script (world:ISOLATED + world:MAIN)── ⇄ ──service worker (orchestrator)── ⇄ ──OFFSCREEN DOCUMENT (the brain)
  • capture (network+DOM)                                       • ephemeral, disposable             persistent worker hosts:
  • inject chips + gray block (Shadow DOM)                      • createDocument() mutex            • WASM SQLite on OPFS (unlimitedStorage)
  • MAIN-world patches: fetch/XHR/WebSocket, history API        • routes RPC                        • sqlite-vec (VectorIndex) + FTS5
                                                                 • Cache-API model hydration         • Embedder + MemoryModel (WebGPU)
```

**Key MV3 decisions**
- The DB + models live in a **`chrome.offscreen` document** (persistent worker, OPFS `SyncAccessHandle` access, WebGPU), **not** the service worker (which Chrome reaps after ~30s idle).
- The **service worker is a stateful orchestrator**: on each RPC it checks `hasDocument()`, lazily (re)creates the offscreen doc, then routes.
- **createDocument() mutex:** a single in-flight creation promise so concurrent RPCs during a cold start all `await` the same instantiation (avoids "only one offscreen document" crashes).
- We do **not** use a silent-audio keep-alive hack — the orchestrator recreates on demand; the Cache-API-hydrated model makes recreation ~100–300ms.
- OPFS + the extension `unlimitedStorage` permission → no quota caps, no eviction. (Uninstall still wipes OPFS → **export/backup is a v1 feature.**)

## 5. Storage engine & schema

WASM SQLite on OPFS + sqlite-vec (behind `VectorIndex`) + FTS5. One embedded engine gives relational model + dense vector search + lexical BM25 in the same transaction — native hybrid search, no extra infra.

```
document  (id, source_type, uri, title, scope_uri, captured_at, raw_content)        -- provenance
chunk     (id, document_id, ord, text, embedding⟶vec_chunks)                         -- raw PAYLOAD (kept separate)
memory    (id, type, content, scope_uri,                                            -- atomic INDEXED unit
           version, is_latest, parent_memory_id, root_memory_id,
           is_static, is_inference, confidence,
           event_date, document_date, valid_from, valid_to,
           forget_after, forget_reason, is_forgotten,
           reuse_count, source_count, created_at)
memory_source (memory_id, chunk_id, document_id, relevance)                          -- M:N link (load-bearing)
entity    (id, type, name, normalized_name, scope_uri)
edge      (id, src_memory_id, dst_memory_id, type, weight, computed_by, confidence)  -- ontology graph
ledger    (id, memory_id, scope_uri, thread_id, message_id, injected_at)             -- audit, references only
vec_memories / vec_chunks   (sqlite-vec, fixed-dim, tagged by embedding_model_id)
fts_memory  / fts_chunk      (FTS5)
```

**Design rulings baked in**
- **`chunk` ≠ `memory` (kept separate).** Atomic-memory-as-index + raw-chunk-as-payload — the one pattern worth stealing. Retrieval hits the atomic `memory` index (high precision); a trivial top-k indexed join fetches payloads. M:N is real (one chunk → many memories; one memory ← many corroborating chunks via `source_count`).
- **Composite `scope_uri`** (e.g. `personal::chatgpt::<thread-id>`) with left-anchored prefix-scan indexing — replaces Supermemory's flat `containerTag`. Hierarchical mapping/closure table is YAGNI for single-user v1.
- **Versioned vectors:** every vector carries `embedding_model_id` (+dim). Different model/dim → its own vec table; queries route by current model. Enables embedder swaps via background re-embed (Supermemory's `embedding`+`embeddingNew` live-migration pattern).
- **Indexes:** `memory(scope_uri, type, is_latest)`, `memory(root_memory_id, version)`, `memory(scope_uri, is_latest, forget_after)`, `edge(src_memory_id, type)` + `edge(dst_memory_id, type)`, `entity(normalized_name)`.

## 6. Ontology (fresh design — not RDF/OWL/SPARQL)

Agent-tailored, schema-rich / population-lazy. The schema declares a rich edge vocabulary, but v1's **write path only populates the free edges**; expensive semantic edges accrete lazily (background batches or retrieval-time), never on the hot path. This is how we get "richer than `updates/extends/derives`" AND "lighter than Supermemory" at once.

- **Memory types:** `fact | preference | episode | task | identity`.
- **Free edges (eager, heuristic — no LLM):**
  - `about` — memory → entity (from NER).
  - `co_occurs` — embedding cosine + temporal proximity.
  - `supersedes` — *ordered* replacement, eager structural guess (same entity+predicate collision), lazily confirmed.
- **Lazy edges (LLM, deferred):**
  - `supersedes` (LLM-confirmed upgrade of the eager guess).
  - `invalidates` — *unordered* conflict needing resolution (neither is simply "newer").
  - `derives` — inferred/second-order fact.

(Supersession vs. contradiction are split by whether time-order resolves it — unambiguous to populate.)

## 7. Capture pipeline

- **Primary: network-layer capture.** MAIN-world content script patches `fetch`, `XMLHttpRequest`, and the `WebSocket` constructor; per-provider parser (in the `SiteAdapter`) reads the chat stream. API contracts evolve slower than CSS; anti-bot defenses (Turnstile/Datadome/PoW) are irrelevant because we **passively observe the user's own legitimately-issued requests** — we never forge requests.
- **Fallback: semantic-DOM capture.** ARIA roles / `data-testid` / structural nesting (not CSS hashes) via MutationObserver. Used when a provider's transport changes (e.g. goes binary/WebSocket-opaque). Self-heal: if an adapter sees 0 recognizable payloads for N turns, it fails over and flags itself.
- **Timing:** capture fires **after the assistant turn completes.** Stream chunks are queued; on stream-complete we **converge the full response**, then run the salience gate, then distill. Never distill partial output.
- **Voice-agnostic:** the model's output is text regardless of TTS/voice mode, so capture is unaffected.
- **Salience gate (gated distillation):** capture *all* turns as raw documents/chunks (cheap, gives full-text search), but only run the SLM on turns passing a cheap filter — regex + NER + length filter + lightweight intent classifier (distill declaratives/preferences; skip questions/commands/"thanks").
- **Scope:** `personal::<provider>::<thread-id>` by default; one `document` per conversation thread, turns = chunks.

## 8. Distillation (MemoryModel)

- **Default: on-device SLM** (e.g. Qwen2.5-1.5B-Instruct q4 via WebLLM/WebGPU), background queue, off the hot path. "In base" = **fetched once on first run from a pinned mirror, cached in OPFS/Cache API** (a 600–800MB model cannot live in the `.crx`; bundling would re-download on every extension update). No opt-in toggle — distillation is core.
- **Swappable / replaceable:** user can swap the bundled model, point at a local server (Ollama/LM Studio on `localhost`), or enter a **BYO API key** (OpenAI/Anthropic/OpenRouter) for frontier-grade extraction.
- **Rejected: session-hijack distillation** (firing background prompts through the user's provider session) — re-arms anti-bot, spends the user's quota invisibly, risks account suspension, violates ToS. We are a passive tap, never an automated client.
- **WebGPU fallback:** WASM backend if no WebGPU; if too slow, degrade gracefully to embedding-only / BYO-key (SLM disabled).

## 9. Retrieval & injection

**Retrieval:** hybrid — sqlite-vec dense + FTS5 lexical + typed/recency/scope filter. The relevance gate (below) decides what actually surfaces.

**Injection — visible/consented (locked).** Memory is surfaced in a **Shadow-DOM gray, collapsed-by-default, expandable block** anchored above the host composer — visually subordinate to the white conversation. Each candidate chunk carries **✓ (inject this chunk) / ✖ (drop this chunk)** for per-chunk curation. On send, the chosen text merges into the host's plain user bubble; the injection is recorded in the **Ledger**. We do NOT persist a custom block inside the host's rendered thread (brittle vs. their re-renders).

- **Inject mechanics (per-editor, in the adapter):** textarea → native value setter + `InputEvent`; ProseMirror/Lexical contenteditable → `execCommand('insertText')` / synthetic paste / `beforeinput`. **Clipboard fallback** ("copied — paste it") so injection never hard-breaks.
- **Triggers:** manual is default — **button** (in the chip UI) + **hotkey** (manifest `commands`, rebindable at `chrome://extensions/shortcuts`, fires in SW → messages content script; plus a focus-gated in-page `keydown` fallback for in-composer use) + a subtle **discoverability badge** when relevant memory exists.
- **Auto-injection (off-by-default toggle):** see §10.

**Consent model (two-tier):**
- *Compliance consent* — one-time, at first-run onboarding (privacy disclosure + host permissions). Not re-prompted.
- *Use-time* — not consent, it's curation: the per-chunk ✓/✖.

## 10. Adaptive auto-injection (off by default)

When enabled, automatic injection must search only on genuine semantic need and surface only genuinely-relevant, non-redundant memory — responsive without thrashing.

**Semantic-delta-gated retrieval (solves thrashing structurally):**
- Maintain a rolling draft/conversation centroid embedding.
- At each debounced checkpoint (~400ms pause, focus, Enter-intent), embed the current draft.
- If cosine delta from the last-searched embedding < ε → do nothing, reuse cache. If ≥ ε → run the search. Search frequency tracks *semantic change*, not keystrokes.

**Relevance gate (solves noise — the hard part):** a vector search always returns neighbors; results must clear:
1. **Absolute floor** (model-specific, ~0.72 for bge-small) — else surface nothing.
2. **Distinctiveness/margin** — top hit must stand out from a flat field of mediocre matches.
3. **Novelty vs. visible context** — suppress memories already present on-screen (biggest noise-killer).
4. **Value rank** — `similarity × confidence × recency × reuse_count`.

**Adaptive policy (contextual bandit):** the inject/skip decision is a contextual-bandit problem (Gittins is the right *family* but the wrong tool — our arms are contextual, non-stationary, and grow). Implementation: an **online logistic model** predicts `P(accept | φ)` over features `φ = [cosine_sim, distinctiveness, novelty_vs_context, recency, reuse_count, confidence, type, scope_match]`; decision rule `E[U] = P(accept)·benefit − P(reject)·cost > 0`; exploration via **Thompson Sampling / LinUCB**. **Cold-start:** the §10 heuristic weights are the Bayesian prior, so day-one behaves like the heuristic and tunes toward the user from the **✓/✖ feedback** (the curation UI *is* the reward signal). **MMR** selects a diverse chunk set (no near-duplicate injections). State (weights + counts per scope) lives in one SQLite row.

## 11. The Ledger (audit)

Per-session audit trail of injections, keeping the chat thread clean.
- Stores **references only** (`memory_id`, `thread_id`, `message_id`, `injected_at`) — zero text duplication; points into the existing memory store.
- Anchored to the provider's **stable server-side `message_id`** (captured off the network), not DOM coordinates → robust across re-renders/virtualization.
- Filterable per chat session/thread; click an entry to see exactly what was injected and where.

## 12. UI surfaces

- **In-page (content script, Shadow-DOM isolated):** the injection chip + the gray collapsed memory block (candidate chunks with ✓/✖) + the discoverability badge. This is the *only* in-page DOM footprint. Anchored to the composer via MutationObserver + bounding-box re-anchor; recursive shadow-root traversal where hosts encapsulate.
- **Popup (`chrome.action`):** the v1 Trust UI — memory list, search, delete, export `.sqlite`, settings entry, quick stats.
- **Side panel (`chrome.sidePanel`):** the scaling Trust UI — fuller memory browser + the Ledger view (added as it grows; not injected into host DOM, so zero collision).
- **Onboarding / first-run:** compliance consent + "setting up local memory…" model-download progress.
- **Settings:** model selection (bundled SLM / local server / BYO-key), embedder selection, auto-injection toggle, per-site toggles, export/backup.

## 13. Rendering/transport resilience

Diversity is the design assumption, all isolated behind `SiteAdapter`:
- **Composer variety** (textarea / ProseMirror / Lexical / custom contenteditable) → composable injection strategies.
- **Transport variety** (SSE-over-fetch / JSON / WebSocket / chunked / Google `batchexecute`) → patch fetch+XHR+WebSocket; per-adapter payload parser.
- **Message rendering** (markdown, virtualized lists, streaming) → irrelevant to network-primary capture; DOM fallback uses semantic anchors.
- **SPA routing** → patch `history.pushState/replaceState` + `popstate` (not 2s polling).
- **Shadow DOM / web components / strict CSP** → recursive shadow traversal; `world:"MAIN"` injection (CSP-safe).
- Adapter = a small declaration `{transport, editor, captureMode, parser}` composed from shared strategy modules → new site = config + maybe one parser; site change = one-adapter fix.
- **Honest boundary:** "prepared" = bounded, local, fallback-protected adaptation — not immunity. The one hard tail case is a site going fully-obfuscated-binary-transport AND stripping all semantic DOM simultaneously.

## 14. Error handling & resilience

- Offscreen-doc cold start → orchestrator recreates; Cache-API model hydration.
- Adapter degradation → network→DOM failover + self-flag.
- Injection failure → clipboard fallback.
- WebGPU absent → WASM → embedding-only/BYO-key.
- OPFS uninstall wipe → export/backup as a first-class feature.
- Embedder swap → background dual-write re-embed, cut over on completion.

## 15. Testing strategy

- **Headless engine tests:** the same SQLite + sqlite-vec runs in Node (`better-sqlite3` + sqlite-vec) → retrieval/ontology/ranking logic unit-tested off-browser (and parallelizable across orcha worktrees).
- **Adapter conformance:** golden-fixture tests — recorded real network payloads + DOM snapshots per provider; parsers tested against them; fast detection when a site changes.
- **Relevance-gate / bandit:** offline replay of labeled (draft, memory, accept/reject) traces.

## 16. Roadmap beyond v1

- **V2:** optional native companion (Tauri/Rust) — bigger models, local file ingestion, serve MCP to IDEs. The local store exports as one `.sqlite` file → drop-in.
- **V3:** multi-device sync via **cr-sqlite** (CRDT) or **libSQL/Turso** embedded replicas, E2E-encrypted changesets through a relay — schema unchanged.
- Later: memory-graph visualization, lazy LLM relation edges, command palette, voice ingestion, more providers.

## 17. Decision log (key forks, for posterity)

- Wedge = local-first second brain (not dev API). Core loop = inject-into-AI-chats. Engine runs fully in-browser.
- OPFS SQLite + sqlite-vec over IndexedDB (sync-ready schema, testable, native hybrid).
- sqlite-vec is brute-force (not ANN) → `VectorIndex` seam for future HNSW.
- Offscreen-doc + SW-orchestrator + mutex over SW keep-alive hacks.
- Extraction: cheap/lazy retrieval-first; on-device SLM distillation; reject heavy cloud ingest AND session-hijack.
- Ontology designed fresh (not SWG/RDF/OWL); schema-rich/population-lazy.
- Capture network-primary + semantic-DOM fallback (corrected the anti-bot category error).
- Inject visible/consented + per-chunk ✓/✖; Ledger over in-thread persistence.
- Auto-injection = semantic-delta gating + relevance gate + contextual bandit (not Gittins).
- All brittle/evolving layers behind swappable seams.

---

# Part B — Technical Implementation Reference

This half makes the spec buildable from cold. Sections 1–8 are the contract an implementer (or an orcha worktree agent) needs.

## B1. Tech stack & versions

- **Extension framework:** [WXT](https://wxt.dev) (MV3, multi-context, `world:'MAIN'` content scripts, offscreen support). *(Supermemory's own extension uses WXT — battle-tested for exactly this.)* Build via Vite.
- **Language:** TypeScript (strict). **Lint/format:** Biome.
- **Storage:** `@sqlite.org/sqlite-wasm` (OPFS SAH-pool VFS) + **sqlite-vec** (wasm build) loaded as a SQLite extension. FTS5 (built into the wasm).
- **Embeddings:** `@huggingface/transformers` (transformers.js, ONNX Runtime Web, WebGPU→WASM fallback). Default model `bge-small-en-v1.5` (384-dim, int8).
- **SLM (distillation):** `@mlc-ai/web-llm` (WebGPU). Default `Qwen2.5-1.5B-Instruct-q4f16`.
- **In-page UI (content script):** Preact + minimal CSS-in-Shadow (small footprint, no global React). **Popup/side-panel UI:** React 19 + shadcn/Radix + Tailwind.
- **Testing:** Vitest; Node engine tests via `better-sqlite3` + `sqlite-vec` node binding; Playwright for adapter smoke tests.
- **No backend in v1.** No telemetry, or local-only/opt-in.

## B2. Repository / module layout

```
src/
  background/        # service worker = orchestrator (offscreen lifecycle, RPC routing, commands)
    orchestrator.ts  #   hasDocument() check + createDocument() mutex
    commands.ts      #   chrome.commands → content script
  offscreen/         # the brain (persistent worker host)
    engine.ts        #   boots SQLite+sqlite-vec, Embedder, MemoryModel; owns the DB connection
    rpc-server.ts    #   handles messages from SW
  content/
    mount.ts         #   isolated-world: mounts Shadow-DOM UI, routes to SW
    main-world.ts    #   MAIN-world: patches fetch/XHR/WebSocket + history API
    ui/              #   Preact: badge, gray block, chunk rows (✓/✖), summary chip
  adapters/          # one SiteAdapter per provider
    chatgpt.ts  claude.ts  gemini.ts  grok.ts  deepseek.ts
    strategies/      #   shared: injection (textarea|prosemirror|lexical), transport parsers, capture modes
  core/              # PORTABLE, browser-agnostic (also runs in Node for tests)
    storage/         #   schema.sql, migrations, repositories
    vector-index.ts  #   VectorIndex (sqlite-vec impl)
    embedder.ts      #   Embedder
    memory-model.ts  #   MemoryModel (distill) + salience gate
    capture.ts       #   stream-queue → converge → gate → distill → persist
    retrieval.ts     #   hybrid search + relevance gate
    autoinject/      #   semantic-delta gate + contextual bandit + MMR
    ledger.ts
  ui/                # popup/ , sidepanel/ (React)
  shared/            # types.ts, rpc-contract.ts, scope.ts, config.ts
  manifest config (wxt.config.ts)
test/                # *.node.test.ts (engine), fixtures/<provider>/ (golden payloads + DOM snapshots)
```

**Rule:** everything in `core/` must be import-clean of `chrome.*`/DOM so it runs under Node for tests.

## B3. Seam interfaces (the contracts)

```ts
// VectorIndex — swap sqlite-vec → hnswlib-wasm later, no schema change
interface VectorIndex {
  upsert(modelId: string, rows: { id: string; vec: Float32Array; }[]): Promise<void>;
  search(modelId: string, q: Float32Array, k: number,
         filter?: { scopePrefix?: string; type?: MemoryType[]; }): Promise<{ id: string; score: number }[]>;
  drop(modelId: string): Promise<void>;
}

// Embedder — model swap forces background re-embed (versioned vectors)
interface Embedder { readonly id: string; readonly dim: number; embed(texts: string[]): Promise<Float32Array[]>; }

// MemoryModel — bundled SLM | local server | BYO key
interface MemoryModel {
  readonly id: string;
  distill(exchange: Exchange): Promise<{ memories: DraftMemory[]; entities: Entity[] }>;
  classifyRelations?(m: Memory, candidates: Memory[]): Promise<Edge[]>; // lazy/optional
}

// SiteAdapter — one per provider; isolates ALL site-specific brittleness
interface SiteAdapter {
  readonly provider: string;
  matches(url: string): boolean;
  // capture: yields finalized exchanges (network-primary, DOM fallback inside)
  captureStream(hooks: CaptureHooks): Unsubscribe;
  // inject: returns false → caller uses clipboard fallback
  injectContext(text: string): Promise<boolean>;
  // anchoring for our Shadow-DOM UI + ledger message ids
  locateComposer(): HTMLElement | null;
  currentThreadId(): string | null;
  capability: { transport: 'sse'|'json'|'ws'; editor: 'textarea'|'prosemirror'|'lexical'|'contenteditable'; };
}

// Storage repositories (thin, typed) over SQLite
interface MemoryRepo { /* add, supersede, search, forgetExpired, byScope, ... */ }
```

## B4. RPC contract (content ↔ SW ↔ offscreen)

Single typed message union; SW is a transparent router after ensuring the offscreen doc exists.

```ts
type Rpc =
  | { t: 'capture.exchange'; payload: Exchange }                 // content → engine (persist+distill)
  | { t: 'retrieve'; draft: string; scope: string; k: number }  // content → engine
  | { t: 'retrieve.result'; chunks: SurfacedChunk[] }           // engine → content
  | { t: 'inject.feedback'; memoryId: string; accepted: boolean; ctx: BanditFeatures } // ✓/✖ → bandit
  | { t: 'ledger.add'; entry: LedgerEntry }
  | { t: 'ui.list' | 'ui.search' | 'ui.delete' | 'ui.export'; /* ... */ }
  | { t: 'settings.update'; patch: Partial<Config> };
```

## B5. manifest (via wxt.config.ts) — shape

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage", "unlimitedStorage", "offscreen", "scripting", "sidePanel", "commands"],
  "host_permissions": [
    "https://chatgpt.com/*","https://chat.openai.com/*","https://claude.ai/*",
    "https://gemini.google.com/*","https://grok.com/*","https://x.com/i/grok*","https://chat.deepseek.com/*"
  ],
  "background": { "service_worker": "background/index.ts", "type": "module" },
  "content_scripts": [
    { "matches": ["<5 providers>"], "js": ["content/mount.ts"], "run_at": "document_idle" },
    { "matches": ["<5 providers>"], "js": ["content/main-world.ts"], "world": "MAIN", "run_at": "document_start" }
  ],
  "action": { "default_popup": "ui/popup/index.html" },
  "side_panel": { "default_path": "ui/sidepanel/index.html" },
  "commands": { "pull-memory": { "suggested_key": { "default": "Ctrl+J", "mac": "Command+J" } } },
  "web_accessible_resources": [{ "resources": ["wasm/*","models/*"], "matches": ["<5 providers>"] }]
}
```

## B6. Key algorithms (pseudocode)

```
# Offscreen orchestrator (service worker) — mutex critical
let creating: Promise<void> | null = null
async ensureOffscreen():
  if await chrome.offscreen.hasDocument(): return
  if creating: return await creating            # concurrent RPCs await the same instantiation
  creating = chrome.offscreen.createDocument({url, reasons:['WORKERS'], justification:'local memory engine'})
  try: await creating finally: creating = null

# Capture: queue stream → converge on complete → gate → distill
onStreamChunk(c): buffer.push(c)
onStreamComplete():
  exchange = { user, assistant: join(buffer), threadId, messageId, provider, ts }
  persistDocumentAndChunks(exchange)            # always (cheap; full-text payload)
  if salient(exchange.user) or salient(exchange.assistant):   # regex|NER|length|intent
     enqueueDistill(exchange)                   # low-priority background; SLM → DraftMemory[]
  buffer = []

# Hybrid retrieval (one SQL round-trip + vec)
candidates = UNION( vec_memories.search(qvec, k, {scopePrefix, type, is_latest}),
                    fts_memory.match(q) )      # then merge/dedupe by memory_id, fetch payload via memory_source join

# Relevance gate (auto-inject) — reject noise
keep = candidates.filter(c => c.score >= FLOOR[embedder.id])
keep = keep.filter(c => margin(c, candidates) >= MIN_MARGIN)
keep = keep.filter(c => maxCos(c.vec, visibleTurnVecs) < REDUNDANT)   # novelty vs on-screen
rank by similarity*confidence*recency*reuse_count

# Semantic-delta auto-inject loop (off by default)
on debounce(400ms | focus | enterIntent):
  dv = embed(draft)
  if cos(dv, lastSearched) >= 1-ε: return cached        # nothing moved
  lastSearched = dv; res = retrieve+gate(dv)
  surfaced = MMR(res, λ=0.7)                              # diverse set
  surfaced = surfaced.filter(c => bandit.shouldInject(features(c, ctx)))
  showGrayBlock(surfaced)                                 # still pre-send, ✓/✖ per chunk

# Contextual bandit (online logistic + Thompson), cold-start from heuristic prior
shouldInject(φ): w ~ posterior; p = sigmoid(w·φ); return p*BENEFIT - (1-p)*COST > 0
onFeedback(φ, accepted): bayesianLogisticUpdate(posterior, φ, accepted)   # ✓=1, ✖=0

# Embedder swap → background re-embed
migrate(newEmbedder):
  vectorIndex.create(newEmbedder.id)
  for batch in memories: vectorIndex.upsert(newEmbedder.id, embed(batch))   # dual-write
  setActiveEmbedder(newEmbedder.id); vectorIndex.drop(oldId)               # cut over on complete
```

## B7. Config / settings schema

```ts
interface Config {
  memoryModel: { kind: 'bundled'|'localServer'|'apiKey'; model?: string; endpoint?: string; apiKey?: string };
  embedder: { id: string };                 // change → triggers migrate()
  autoInject: { enabled: boolean; epsilon: number; floor: number; sensitivity: number };
  sites: Record<Provider, boolean>;
  hotkey: string;
  theme: 'system'|'light'|'dark';
}
```

## B8. Build order & acceptance criteria (milestones for parallel execution)

1. **Engine core (Node-testable):** schema+migrations, `VectorIndex`(sqlite-vec), `Embedder`(bge-small), hybrid `retrieval`. *Accept:* Node test inserts 10k memories, hybrid query returns correct top-k < 50ms; embedder swap migration passes.
2. **Offscreen + orchestrator:** boot engine in offscreen doc; SW mutex; RPC round-trip. *Accept:* survives SW reaping; concurrent cold-start RPCs don't throw; query from content script works.
3. **Capture (network):** MAIN-world patches + one adapter (ChatGPT) parser; stream-converge; persist. *Accept:* a full ChatGPT exchange is captured & stored without DOM scraping; golden-fixture parser test green.
4. **Distillation:** WebLLM SLM in offscreen, salience gate, background queue. *Accept:* salient turn → clean atomic memories; "thanks" → skipped; UI never blocks.
5. **Inject UI:** Shadow-DOM gray block + ✓/✖ + injection strategies + clipboard fallback + badge + hotkey/button. *Accept:* memory injects into ChatGPT + Claude composers; merges to plain text on send; clipboard fallback works when programmatic fails.
6. **Ledger + Trust UI (popup):** list/search/delete/export; ledger by reference anchored to message_id. *Accept:* export produces a valid `.sqlite`; ledger jumps to correct message.
7. **Remaining adapters:** Claude, Gemini, Grok, DeepSeek (parser + injection strategy + fixtures each).
8. **Auto-inject:** semantic-delta gate + relevance gate + bandit + MMR behind the off-by-default toggle. *Accept:* no search on same-topic typing; no injection below floor/when redundant; ✓/✖ updates policy.
9. **Onboarding + settings + side panel.** *Accept:* first-run consent + model download; model/embedder/site/auto-inject controls functional.

**Suggested parallelization (orcha):** M1 (engine), M3+M7 adapters (per-site, independent), M5 (inject UI), M6 (Trust UI) can proceed in parallel worktrees once interfaces in B3/B4 are frozen. M2 gates M3+. M4/M8 depend on M1. Freeze B3/B4 contracts first.

