# Stitch export → implementation map (Mnemium V1)

These `.html` files are the **Stitch-generated static mockups** (Tailwind CDN + dummy data). They are the **exact UI contract** — open any in a browser to see the target pixel-for-pixel. They are **not** production code: no framework state, no engine wiring, no Shadow-DOM isolation, no MV3 plumbing. Use them as the visual spec; build the real components per `DESIGN-SPEC-v1.md` **Part B**.

**Design system:** `assets/11148319493045181307` — DARK, **Geist** (headline) / **Inter** (body), indigo **#5B5BD6**, 12px radii, muted-gray (#8A8A8F) for injected memory. Tokens are encoded directly in each file's Tailwind classes / CSS vars.

| File | Surface | Target module (spec §B2) | Engine wiring still to build |
|------|---------|--------------------------|------------------------------|
| `01-hero.html` | In-page injection block (gray block, per-chunk ✓/✖, ⌘J badge) | `content/ui/` (Preact, Shadow DOM) | retrieval → relevance gate → `SiteAdapter.injectContext()`; ✓/✖ → bandit feedback |
| `02-popup.html` | Popup Trust UI (search, memory list, export) | `ui/popup/` (React+shadcn) | `MemoryRepo` list/search/delete; export `.sqlite` |
| `03-onboarding.html` | First-run consent + model download | onboarding flow | host-permission grant; SLM first-run fetch+cache progress |
| `04-settings.html` | Settings (model / embedder / auto-inject / sites / data) | `ui/` settings | `Config` schema (§B7); embedder swap → re-embed migration |
| `05-ledger.html` | Per-session injection audit | `ui/sidepanel/` (Ledger tab) | `ledger` table (references only); anchor to provider `message_id` |
| `06-command-palette.html` | ⌘K semantic memory search → inject | `content/ui/` or side-panel overlay | reuse `Embedder` + `VectorIndex` + FTS retrieval + injection path |

**The two halves of "just follow the directions":**
- **UI layer** → these HTML files (translate into the Preact/React components above).
- **Engine + wiring** → `DESIGN-SPEC-v1.md` Part B (interfaces B3, RPC B4, manifest B5, algorithms B6, config B7, build order B8).

Stitch covers the first half. The brain (OPFS SQLite + sqlite-vec, on-device SLM distillation, capture adapters, relevance gate + contextual bandit, MV3 offscreen orchestration) is the second half — real engineering, fully specced in Part B.
