# Build guide — UI surfaces (codex)

Read `docs/build/00-agent-common.md` first. Implements DESIGN-SPEC §12; translate `stitch-export/*.html` into components. Tokens are FROZEN in `src/ui/tokens.ts` — import them, don't hardcode hexes.

## Owns (create only these)
```
src/ui/tailwind.config.ts          # tailwind theme mapped from src/ui/tokens.ts (do NOT edit tokens.ts)
src/ui/styles.css                  # base + font imports (Geist, Inter)
src/ui/components/*                 # shared primitives (MemoryRow, TypeTag, Toggle, SearchField, Badge, …)
src/ui/inpage/index.tsx            # export mountInPageUI(container, props) — the in-page gray block + ✓/✖ chips + badge (Preact, Shadow-DOM friendly)
src/ui/popup/*                     # popup Trust UI  (from stitch-export/02-popup.html)
src/ui/sidepanel/*                 # Memories + Ledger tabs (from 05-ledger.html)
src/ui/onboarding/*                # consent + model-download (from 03-onboarding.html)
src/ui/settings/*                  # model/embedder/auto-inject/sites/data (from 04-settings.html)
src/ui/palette/*                   # command palette (from 06-command-palette.html)
src/entrypoints/popup/index.html + main.tsx       # mounts src/ui/popup
src/entrypoints/sidepanel.html + sidepanel/main.tsx # mounts src/ui/sidepanel (+ onboarding/settings routes)
```

## What to build
- **Pixel-match the exported HTML** (`stitch-export/`) — it is the visual contract (open the files). Reproduce layout, the muted-gray memory treatment, type-tag colors, the ⌘J badge, the per-chunk ✓/✖, the Ledger timeline, the OFF-by-default auto-inject toggle + sensitivity slider, the model picker (Built-in / Local server / BYO-key).
- **In-page block (`src/ui/inpage`)** uses **Preact** (small footprint, mounts into a Shadow root the content script provides). Everything else (popup/sidepanel/onboarding/settings/palette) uses **React 19 + Tailwind**.
- Talk to the engine ONLY via `sendRpc` from `@/runtime/rpc` (ui.list/ui.search/ui.delete/ui.export, settings.get/update, retrieve, inject.feedback, ledger.add). If `@/runtime/rpc` isn't merged yet, import the `Rpc` types from `@shared/rpc` and stub `sendRpc` with a TODO so you type-check.
- Wire interactions: ✓ = accept chunk (calls inject + emits `inject.feedback {accepted:true}` + `ledger.add`); ✖ = dismiss (`inject.feedback {accepted:false}`). Settings writes via `settings.update`. Export triggers `ui.export`.

## Boundary
You own all visuals incl. the in-page block component. The capture agent mounts it (calls your `mountInPageUI`). The runtime agent provides `sendRpc`. Don't create content scripts, adapters, or engine files.

## Gotchas
- The in-page block must be **muted gray, collapsed-by-default, expandable**, visually subordinate to host white text (the sacred rule — token `color.memory`). It lives pre-send; post-send it's recorded in the Ledger (don't try to persist it in the host thread).
- Keep motion GPU-cheap (transform/opacity), 120–220ms, per `tokens.motion`.
- No network calls from UI; all data via RPC.
