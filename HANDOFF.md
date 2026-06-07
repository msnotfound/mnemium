# Mnemium — Handoff

Resume doc for a fresh session. Everything below is current as of the last commit on `main`.

---

## 1. What Mnemium is

A zero-install Chrome/Chromium extension that gives AI chats a **private, on-device "second brain."** It captures what you discuss across **ChatGPT, Claude, Gemini, Grok, DeepSeek**, distills it into typed memories **locally** (WASM SQLite + sqlite-vec + an on-device SLM/embedder), and lets you inject the right context back into any chat with per-chunk control. **Nothing leaves the device.**

Positioning vs. Supermemory: lighter, retrieval-first, local-first — the axis their cloud engine structurally can't follow. Full rationale + the locked design is in **`DESIGN-SPEC-v1.md`** (Part A = design/decisions, **Part B = implementation reference**: interfaces, RPC, manifest, algorithms, build order).

## 2. Current status (TL;DR)

| Aspect | State |
|---|---|
| `pnpm typecheck` | ✅ 0 errors |
| `pnpm test` | ✅ 7/7 (engine + auto-inject) |
| `pnpm build` | ✅ green, Tailwind compiled, ~290 kB |
| Loads in browser | ✅ popup + Settings render and are fully styled |
| **End-to-end runtime** | ❌ **NOT wired** — popup shows **mock data**; UI→engine RPC is still a stub. Capture/distill/retrieve/inject has not run live. |
| GitHub | `github.com/msnotfound/mnemium` (private), clean history, author `msnotfound <gca1245@gmail.com>`, **0 AI attribution** |

**The #1 next task is wiring the UI→engine RPC so real memories flow.** See §6.

## 3. Where things are

- **Local repo:** `/home/mayamint/mnemium` (symlink, no spaces) → `/mnt/WindowsData/Users/MAYANK SAHU/Desktop/LinuxFiles/supermemory`. Use the symlink path for tooling (the real path has spaces).
- **Build output:** `.output/chrome-mv3/` (prod) / `.output/chrome-mv3-dev/` (dev). Load unpacked from there.
- **Reference:** `DESIGN-SPEC-v1.md`, `docs/build/*.md` (per-module build guides used by the agents), `UI-BRIEF-for-Stitch.md`, `stitch-export/` (the HTML mockups the UI was built from + `README.md` mapping screens→modules), `stitch-screens/` (PNG renders), `research/` (Supermemory competitive analysis).

## 4. Architecture (locked)

Pure MV3. A thin **service-worker orchestrator** lazily (re)creates a persistent **offscreen document** that hosts the engine. Every brittle/evolving layer sits behind a **swappable seam** (frozen in `src/shared/`):

```
AI chat tab ──content scripts── ⇄ ──service worker (orchestrator, createDocument mutex)── ⇄ ──OFFSCREEN DOC (engine)
  • mnemium.content.ts (ISOLATED): mount UI                                                   • WASM SQLite on OPFS + sqlite-vec
  • mnemium-main.content.ts (MAIN): patch fetch/XHR/WS + history (network capture)            • Embedder (bge-small) + MemoryModel (SLM)
                                                                                              • hybrid retrieval, capture pipeline, auto-inject
```

**Frozen contracts (do NOT change shapes without migrating all consumers):**
`src/shared/types.ts` (domain model), `src/shared/interfaces.ts` (VectorIndex, Embedder, MemoryModel, SiteAdapter, repos), `src/shared/rpc.ts` (the `Rpc` union), `src/shared/config.ts`, `src/core/storage/schema.sql` (6 tables + FTS5; vec tables created at runtime), `src/ui/tokens.ts` (design tokens).

## 5. Module map (what's where)

Built by 5 parallel codex agents, then integrated. Each owns a directory:

| Area | Path | Notes |
|---|---|---|
| **Engine core** | `src/core/storage/{db,repos}.ts`, `src/core/{vector-index,embedder,retrieval}.ts` | SQLite (OPFS in browser, better-sqlite3 in Node tests), sqlite-vec, bge-small, hybrid search. Node-tested. |
| **Distill + auto-inject** | `src/core/{memory-model,capture,edges,salience}.ts`, `src/core/autoinject/*` | SLM distillation (WebLLM) + salience gate + capture pipeline + semantic-delta gate + relevance gate + MMR + contextual bandit. Node-tested. |
| **Runtime** | `src/entrypoints/background.ts`, `src/entrypoints/offscreen/*`, `src/runtime/{orchestrator,rpc}.ts` | SW orchestrator (offscreen mutex), offscreen engine host, RPC client/server. |
| **Capture + adapters** | `src/adapters/*` (5 site adapters + `registry.ts` + `strategies/{network,dom,inject}.ts`), `src/content/{mount,bridge}.ts`, `src/entrypoints/*.content.ts` | network-primary capture + semantic-DOM fallback + inject strategies. |
| **UI** | `src/ui/{components,inpage,popup,sidepanel,onboarding,settings,palette}/*`, `src/entrypoints/{popup,sidepanel}/*`, `src/ui/tailwind.config.ts` | Preact for in-page block; React+Tailwind for popup/sidepanel/settings. Built to match `stitch-export/`. |

## 6. Next tasks (priority order)

1. **Wire UI → engine RPC (the blocker).** The popup shows mock data because the UI talks to a stub. Connect:
   - `src/ui/components/rpc.ts` (UI's stub `sendRpc`) → the real `src/runtime/rpc.ts` (content/UI → SW → offscreen).
   - Confirm `src/entrypoints/offscreen/main.ts` implements the server side of every `Rpc` variant (ui.list/search/delete/export, retrieve, settings.*, capture.exchange, inject.feedback, ledger.add) against the real engine instances.
   - Confirm `src/entrypoints/background.ts` `routeRpc` relays envelopes correctly.
   - Goal: popup shows the **real** (initially empty) store, not the mock list. Also remove the hardcoded sample memories in the UI.
2. **Verify the offscreen engine boots** in-browser: SQLite OPFS init, schema load, embedder model fetch (WebGPU). Inspect via `chrome://extensions` → Mnemium → *Inspect views: offscreen* and *service worker*.
3. **Test capture:** have a ChatGPT exchange → confirm a `document`/`chunk`/`memory` row appears (network-capture parser in `src/adapters/chatgpt.ts` + `strategies/network.ts`). Repeat per provider.
4. **Test inject:** `Ctrl+Shift+M` → does the gray Shadow-DOM block appear by the composer with candidates + ✓/✖? (`src/content/mount.ts` + `src/ui/inpage/index.tsx`).
5. **Model assets:** the SLM (Qwen2.5-1.5B via WebLLM) + embedder (bge-small via transformers.js) fetch on first run via WebGPU — untested; may need `web_accessible_resources` / CDN config.
6. **Deferred by design:** lazy LLM edges (`derives`/`invalidates`), multi-device sync, command palette polish.
7. **Cosmetic:** the Settings UI code still shows the "Private Intelligence" tagline (the Stitch rename only touched the mockups, not the built components).

## 7. Gotchas already fixed (don't reintroduce)

- **sqlite-vec `vec0` rowid must bind as `BigInt`**, not a JS `number` ("Only integers are allowed for primary key values"). See `src/core/vector-index.ts`.
- **`new Function("…import…")` is CSP-blocked under MV3** (and breaks vitest). Use `import(/* @vite-ignore */ specifier)` for node-only deps; direct `await import("…")` for bundled ones. See `src/core/storage/db.ts`.
- **WXT/Vite needs `@core`/`@shared` aliases registered in `wxt.config.ts`** (tsconfig paths alone don't reach the bundler). Already added.
- **Tailwind is v3** + `postcss.config.mjs` (points at `src/ui/tailwind.config.ts`). Do **not** bump to v4 (breaking).
- **WXT auto-imports** (`defineBackground`/`defineContentScript`) are imported explicitly from `wxt/utils/*` so standalone `tsc` resolves them.
- **`package.json` must not pin a nonexistent `packageManager`** (corepack 404'd on `pnpm@11.10.1`; real pnpm is 10.33). Field removed.
- **`Ctrl+J` is reserved by Chrome (Downloads)** → hotkey is now **`Ctrl+Shift+M`**. If it doesn't auto-bind, set it at `chrome://extensions/shortcuts`.
- **`better-sqlite3` native build** is gated by pnpm; `package.json` has `pnpm.onlyBuiltDependencies: ["better-sqlite3","esbuild"]`. After a fresh `pnpm install`, run `pnpm rebuild better-sqlite3` if the binding is missing (needed only for Node tests, not the extension).

## 8. Dev environment

- **Linux Mint (native, primary OS)** — NOT WSL/Windows. The repo is on a mounted Windows partition only for disk space. Use native Linux Chrome paths.
- Browser: **Thorium** (Chromium fork) — loads extensions like Chrome.
- Toolchain: **node 22, pnpm 10.33 (no bun)**. WXT 0.20.26, Vite, TypeScript strict.
- **Loading the extension:** `pnpm build` → `chrome://extensions` → Developer mode → **Load unpacked** → `.output/chrome-mv3`. (`pnpm dev` auto-launch needs `CHROME_PATH=/usr/bin/google-chrome` or similar; manual load is simplest.)

## 9. Constraints (hard rules)

- **NO AI attribution, ever** — no `Co-Authored-By: Claude`, no "Generated with…". Commit **author = `msnotfound <gca1245@gmail.com>`** only. (Enforced in global `~/.claude/CLAUDE.md` + memory.)
- Commit/push only when asked. Keep history clean.

## 10. Commands

```bash
cd /home/mayamint/mnemium
pnpm install            # postinstall runs `wxt prepare`
pnpm dev                # dev server + HMR (needs CHROME_PATH to auto-launch)
pnpm build              # → .output/chrome-mv3  (load unpacked)
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest (engine + auto-inject). needs better-sqlite3 built.
```

## 11. The orcha build (for context)

Built via the orcha parallel-agent harness (`~/agents/ORCHA.md`): 5 **codex** agents (OpenAI credits intact; Claude API exhausted → Claude only via Pro, used sparingly) in isolated git worktrees off frozen contracts, merged with zero conflicts. Worktrees still exist at `~/agents/worktrees/mnem-*` — clean up with `orch-kill mnem-engine` (etc.) when done. Per-module prompts are in `docs/build/0N-*.md`.

---

**Start the next session with:** open `/home/mayamint/mnemium`, read this file + `DESIGN-SPEC-v1.md` Part B §B4 (RPC), and tackle §6 task 1 (wire UI→engine RPC). Bring the first service-worker/offscreen console errors.
