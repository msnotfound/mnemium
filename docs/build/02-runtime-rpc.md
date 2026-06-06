# Build guide — MV3 runtime + RPC (codex)

Read `docs/build/00-agent-common.md` first. Implements DESIGN-SPEC §B4 (RPC), §B6 (orchestrator), §B8-M2.

## Owns (create only these)
```
src/entrypoints/background.ts        # WXT background (service worker). The ORCHESTRATOR.
src/entrypoints/offscreen/index.html # offscreen document host page
src/entrypoints/offscreen/main.ts    # boots the engine inside the offscreen doc
src/runtime/orchestrator.ts          # ensureOffscreen() + createDocument mutex + RPC routing
src/runtime/rpc.ts                   # typed send/receive helpers over chrome.runtime messaging (uses @shared/rpc)
```

## What to build
1. **orchestrator.ts** — `ensureOffscreen()`: if `await chrome.offscreen.hasDocument()` return; guard `chrome.offscreen.createDocument({url:'offscreen.html', reasons:['WORKERS'], justification:'local memory engine'})` behind a **single in-flight promise** so concurrent callers await the same instantiation (spec §B6 mutex — this is mandatory; without it you get "Only a single offscreen document" crashes). Then route an `RpcEnvelope` to the offscreen doc and return its `RpcResponse`.
2. **background.ts** — register `chrome.commands.onCommand` ("pull-memory") → message the active tab's content script to trigger a pull. Relay `chrome.runtime.onMessage` envelopes from content/UI → `ensureOffscreen()` → offscreen, and responses back. The SW is a **thin, disposable router**; hold no engine state.
3. **offscreen/main.ts** — the engine host. Import engine core (`@core/storage/db`, `repos`, `vector-index`, `embedder`) and (when available) the distillation/capture/autoinject modules, instantiate them once, and implement the **server** side of every `Rpc` variant in `@shared/rpc` (capture.exchange → persist+distill; retrieve → hybridSearch; ui.* → repos; settings.* → chrome.storage; ledger.add → LedgerRepo; inject.feedback → bandit). Use `chrome.runtime.onMessage` keyed by `reqId`.
4. **rpc.ts** — `sendRpc(msg): Promise<data>` (used by content/UI) and a `serve(handlers)` helper (used by offscreen). Correlate by `reqId` (crypto.randomUUID).

## Gotchas
- The SW dies after ~30s idle — that's fine; `ensureOffscreen()` recreates on demand. Do NOT try to keep the SW alive.
- Offscreen `SyncAccessHandle` (OPFS) is worker-only — engine DB work runs in a Worker spawned by `offscreen/main.ts` (or the engine's `openOpfs` handles the worker internally; coordinate via the Embedder/db API — don't reach into engine internals).
- Cache-API-hydrate the embedding/SLM model so offscreen cold-start is fast (the model modules own download; you just don't block on it).
- You depend on engine-core + distill modules via their exported classes/interfaces. If a module isn't merged yet, import its interface from `@shared/interfaces` and leave a clearly-marked `// TODO(integration): wire <Module>` where you instantiate — the integrator connects them.

## Test
A light unit test of the mutex (concurrent `ensureOffscreen()` calls trigger exactly one `createDocument`) using a mocked `chrome.offscreen`.
