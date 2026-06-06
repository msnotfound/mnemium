# Build guide — Capture + site adapters (codex)

Read `docs/build/00-agent-common.md` first. Implements DESIGN-SPEC §7 (capture), §9 (inject mechanics), §13 (resilience), §B8-M3/M7.

## Owns (create only these)
```
src/entrypoints/mnemium.content.ts      # WXT content script (ISOLATED world): mount + route to SW
src/entrypoints/mnemium-main.content.ts # WXT content script with world:'MAIN': patch fetch/XHR/WebSocket + history
src/content/mount.ts                     # find composer, mount in-page UI container (calls UI module's mountInPageUI), wire triggers/hotkey
src/content/bridge.ts                    # MAIN↔ISOLATED bridge (window.postMessage), forwards captured payloads
src/adapters/registry.ts                 # provider → SiteAdapter resolver (matches(url))
src/adapters/{chatgpt,claude,gemini,grok,deepseek}.ts  # one SiteAdapter each
src/adapters/strategies/network.ts       # generic fetch/XHR/WS interception + per-provider stream parsers
src/adapters/strategies/dom.ts           # semantic-DOM fallback (ARIA/data-testid/structure + MutationObserver)
src/adapters/strategies/inject.ts        # textarea (native setter+InputEvent), prosemirror/lexical (execCommand/paste), clipboard fallback
test/adapters/*.fixture.test.ts          # golden-fixture parser tests
```

## What to build
1. Implement `SiteAdapter` (from `@shared/interfaces`) for all 5 providers. Each declares its `capability` and wires the shared strategies. **Capture is network-primary**: patch `fetch`/`XMLHttpRequest`/`WebSocket` in the MAIN world, recognize the provider's chat stream, and on stream-complete assemble an `Exchange` (with the provider's stable `messageId`/`threadId`) → post to ISOLATED via `bridge.ts` → `onExchange`. **Fallback** to semantic-DOM capture if no recognized payload appears for N turns (self-heal flag).
2. **We never forge requests** — only observe the user's own. Don't add auth, don't replay.
3. **Inject** (`injectContext`): per editor type, insert text into the composer using the correct technique (textarea: native value setter + `InputEvent`; ProseMirror/Lexical: `execCommand('insertText')` or synthetic paste). Return `false` on failure so caller uses clipboard fallback. **Inject is visible/pre-send** — you place text in the composer; you do NOT auto-send.
4. **mount.ts** — locate the composer (per adapter), mount the in-page UI container, and import `mountInPageUI` from the UI module (`@/ui/inpage`) to render the gray block + chips. Wire the hotkey (listen for the SW "pull-memory" relay) and the button. Re-anchor on SPA route change (patch `history.pushState/replaceState` + `popstate`, NOT polling). Use a Shadow root for isolation.
5. **registry.ts** — `resolveAdapter(url): SiteAdapter | null`.

## Boundary with the UI agent
You own the **mounting + plumbing**; the UI agent owns the **visual components** (`src/ui/inpage/`). You import `mountInPageUI(container, { chunks, onAccept, onReject, onInject })` from them. If `@/ui/inpage` isn't merged yet, stub the import with a clearly-marked TODO and a placeholder render so your code type-checks.

## Gotchas
- MAIN-world script patches must be installed at `document_start`.
- Provider payload shapes differ wildly (OpenAI SSE, Anthropic events, Google batchexecute, etc.). Put each parser behind the adapter; record a real captured payload as a fixture and test the parser against it.
- Strict CSP: MAIN-world content scripts are browser-injected (CSP-safe) — don't inject inline `<script>`.

## Test
Golden-fixture parser tests: feed a recorded stream payload per provider, assert the assembled `Exchange` (user/assistant text, ids). No network.
