# mnemiumd

Local helper binary for the [Mnemium](https://github.com/msnotfound/mnemium)
browser extension. Owns the brain layer (distillation, embeddings,
vector search) that the extension can't run inside Chrome's MV3 sandbox.

**v0.0 scaffolding** — HTTP server, pairing flow, and protocol envelopes
are real. Compute backends (llama-cpp / sqlite-vec / model downloader)
return `503 backend_unavailable` until they land. The extension can
already pair against it today and see status reflect the right shape.

## Install from source

```bash
git clone https://github.com/msnotfound/mnemium ~/src/mnemium
cd ~/src/mnemium/daemon
go install ./cmd/mnemiumd
```

That writes the binary to `$(go env GOPATH)/bin`. Make sure that's on
`PATH`.

## Quickstart

```bash
mnemiumd serve
```

Prints:

```
mnemiumd listening on 127.0.0.1:53412
pairing string:
    mn:53412:<base64-token>
paste it into Mnemium → Settings → System → Daemon pairing
```

Open the Mnemium extension. Settings → System → Daemon pairing card →
paste the `mn:53412:…` string → Pair. The Memory tab's daemon dot
turns green.

`Ctrl-C` to stop the daemon. The pairing token is persisted so the
extension keeps working across daemon restarts on the same port.

## Where things live

| Concept | Linux | macOS | Windows |
|---|---|---|---|
| Config | `~/.config/mnemium/` | `~/Library/Application Support/mnemium/` | `%APPDATA%\mnemium\` |
| Data | `~/.local/share/mnemium/` | `~/Library/Application Support/mnemium/` | `%LOCALAPPDATA%\mnemium\` |
| Models | `<data>/models/` | `<data>/models/` | `<data>\models\` |
| Vectors | `<data>/vectors.db` | `<data>/vectors.db` | `<data>\vectors.db` |
| Port file | `<data>/port` | … | … |
| Token file | `<data>/mnemium-token` (0600) | … | … |

Override every path with one env var: `MNEMIUM_HOME=/path/to/dir`. Same
pattern as fleetorch.

`mnemiumd config show` prints the resolved paths and current backend
selection.

## Config

`~/.config/mnemium/config.toml` is written on first run. Default:

```toml
listen = "127.0.0.1:0"   # 0 = pick a free port at boot

[backends.distill]
kind = "disabled"

[backends.embed]
kind = "disabled"

[backends.vec]
kind = "disabled"
```

Once real backends ship, swap in:

```toml
[backends.distill]
kind = "llama-cpp"
model = "qwen2.5-1.5b-instruct-q4_k_m"
ctx = 4096
n_threads = 0   # 0 = auto

[backends.embed]
kind = "llama-cpp"
model = "nomic-embed-text-v1.5"
n_threads = 0

[backends.vec]
kind = "sqlite-vec"
path = "~/.local/share/mnemium/vectors.db"
```

Or Ollama:

```toml
[backends.distill]
kind = "ollama"
endpoint = "http://localhost:11434"
model = "qwen2.5:1.5b"

[backends.embed]
kind = "ollama"
endpoint = "http://localhost:11434"
model = "nomic-embed-text"
```

Or an API key:

```toml
[backends.distill]
kind = "openai"
api_key_env = "OPENAI_API_KEY"
model = "gpt-4o-mini"
```

## Protocol

All endpoints documented in
[`docs/MNEMIUMD-PROTOCOL.md`](../docs/MNEMIUMD-PROTOCOL.md) in the
mnemium repo. Auth is `Authorization: Bearer <token>` over loopback
HTTP. Server emits `X-Mnemiumd-Version` on every response.

In v0.0:

| Endpoint | v0.0 behavior |
|---|---|
| `GET /status` | Returns the real shape with `ready: false` everywhere |
| `POST /distill` | `503 backend_unavailable` |
| `POST /embed` | `503 backend_unavailable` |
| `POST /vec/{upsert,search,drop}` | `503 backend_unavailable` |
| `GET /config` | Returns parsed config.toml |
| `PUT /config` | `501 not_implemented` (edit + restart for now) |
| `POST /model/download` | `501 not_implemented` |
| `GET /model/progress` | Returns `{ "downloads": [] }` |
| `DELETE /model/{name}` | `501 not_implemented` |

## What's next (build order)

1. **llama-cpp distill backend** — spawn `llama-server` subprocess,
   POST JSON to its `/v1/chat/completions`, parse the response into
   `[]distill.Memory`. Lifecycle (start, healthcheck, restart) inside
   `internal/backends/distill/llamacpp.go`.
2. **llama-cpp embed backend** — same wrapper, run `llama-server`
   with `--embedding`. POST to `/embedding`.
3. **sqlite-vec backend** — cgo bindings (`mattn/go-sqlite3` +
   statically linked `vec0` extension). `internal/backends/vec/sqlitevec.go`.
4. **Model download manager** — HTTP fetcher with Range support,
   SHA-256 verification, atomic rename, JSON progress channel.
5. **GoReleaser** — six-target builds (linux/macos/windows x amd64/arm64),
   sha256-verified install scripts. Match fleetorch's release pipeline.
6. **`PUT /config`** — accept config updates over RPC, rebuild backends
   in-place (or restart child llama-server processes if model changed).
7. **Ollama and API-key backends** — these are pure HTTP clients with
   no model bundling concerns, can land any time.

## Constraints (same as the extension)

- Author = `msnotfound <gca1245@gmail.com>` only. No AI co-author trailers.
- Pre-v1: protocol shape can change but bump the version field every time.
- Single static binary, no runtime deps (matches fleetorch).
