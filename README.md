# Mnemium

A zero-install Chrome extension that gives your AI chats a private, **on-device** second brain. It captures what you discuss across ChatGPT, Claude, Gemini, Grok and DeepSeek, distills it into typed memories locally (WASM SQLite + sqlite-vec + an on-device SLM), and lets you inject the right context back into any chat — with per-chunk control. **Nothing leaves your device.**

## Status

V1 in active build. Design + implementation spec is **locked**.

- **`DESIGN-SPEC-v1.md`** — the canonical spec. Part A = design/decisions; **Part B = technical implementation reference** (interfaces, RPC, manifest, algorithms, build order).
- **`UI-BRIEF-for-Stitch.md`** + **`stitch-export/`** — the UI contract (6 generated screens as HTML) and the Stitch→module map.
- **`stitch-screens/`** — screen renders.
- **`research/`** — competitive analysis of Supermemory (the wedge: lighter, local-first, retrieval-first).

## Architecture (one line)

Pure MV3 extension: a thin service-worker **orchestrator** → a persistent **offscreen document** hosting the engine (WASM SQLite on OPFS + sqlite-vec + Embedder + on-device SLM). Every brittle/evolving layer is behind a swappable seam: `VectorIndex`, `SiteAdapter`, `MemoryModel`, `Embedder`. See `src/shared/` for the frozen contracts.

## Dev

```bash
pnpm install
pnpm dev          # WXT dev (Chrome)
pnpm test         # Vitest (engine runs headless via better-sqlite3 + sqlite-vec)
pnpm typecheck
```
