# Contributing to Mnemium

PRs welcome. The project moves fast — small, focused changes ship faster
than 10-feature rewrites.

## Setup

```bash
git clone https://github.com/msnotfound/mnemium ~/src/mnemium
cd ~/src/mnemium
pnpm install
cd daemon && go mod download && cd ..
```

## Day-to-day

```bash
# Extension
pnpm dev        # WXT watch + build into .output/chrome-mv3/
pnpm typecheck
pnpm test       # Vitest

# Daemon
cd daemon
go test ./...
go build ./cmd/mnemiumd
```

## Architecture in one screen

- **`src/`** — Chrome extension (WXT + React + Preact)
  - `src/adapters/<provider>.ts` — per-provider DOM capture
  - `src/core/` — engine logic (capture pipeline, retrieval, ranking)
  - `src/entrypoints/{background,offscreen,content,...}` — MV3 entry points
  - `src/shared/` — frozen interfaces (RPC contract, types, config shape)
- **`daemon/`** — Go helper binary `mnemiumd`
  - `daemon/cmd/mnemiumd/` — CLI entry
  - `daemon/internal/server/` — HTTP API (auth, routing)
  - `daemon/internal/backends/{distill,embed,vec}/` — swappable backends
  - `daemon/internal/runtime/` — dependency lifecycle (llama-server fetch,
    Ollama install/pull)
  - `daemon/internal/models/` — HTTP+Range model downloader
- **`docs/MNEMIUMD-PROTOCOL.md`** — the HTTP contract between extension
  and daemon. **Do not change shape without bumping the version.**
- **`DESIGN-SPEC-v1.md`** — canonical design.

## Adding a new chat provider

1. Add `src/adapters/<name>.ts` implementing `SiteAdapter` from
   `src/shared/interfaces.ts`.
2. Register it in `src/adapters/registry.ts`.
3. Add the URL pattern to `wxt.config.ts` (`host_permissions` +
   the content-script `matches`).
4. Reload the extension and verify capture in the console.

## Adding a new distill / embed / vec backend

1. Create `daemon/internal/backends/<kind>/<name>.go` implementing the
   `Backend` interface from `<kind>.go`.
2. Add a case to `daemon/internal/backends/resolver.go`.
3. If it needs a model file at a fixed URL, add it to
   `src/shared/model-registry.ts`.
4. If it needs an external binary (llama-server-style), extend
   `daemon/internal/runtime/orchestrator.go` with a new install job
   type.

## Tests

- **Extension**: Vitest. Engine code runs headless via better-sqlite3
  + sqlite-vec.
- **Daemon**: `go test ./...`. Pure-Go; no extra setup.

Smoke-testing the end-to-end pairing + capture flow requires a real
browser — see the manual test plan referenced in PRs.

## Commit style

- Conventional-style prefix (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`) — soft preference, not enforced.
- Short subject (≤ 70 chars); details in the body.
- Atomic commits — one logical change per commit. Bigger PRs are
  easier to review when each commit makes sense alone.

## Security

If you find a security-impacting bug, please **don't** open a public
issue. See [SECURITY.md](./SECURITY.md).

## License

Contributions are licensed under the same MIT license as the project.
By submitting a PR you assert you have the right to license your
contribution that way.
