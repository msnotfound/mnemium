# `mnemiumd` ↔ extension protocol — v0

Integration contract between the Mnemium Chrome extension and the local
`mnemiumd` helper binary. **Locked once agreed; bump the version field
before changing shape.** This is the spec both sides build against.

## Identity

- Transport: HTTP/1.1 over `127.0.0.1`.
- Port: chosen by `mnemiumd` on first start; written to
  `${XDG_RUNTIME_DIR:-~/.local/share/mnemium}/port`. Extension reads
  this file via a tiny stub mechanism (see "discovery") or accepts a
  manual override in Settings.
- Auth: bearer token also written to `mnemium-token` next to the port
  file. Extension sends `Authorization: Bearer <token>`. Token rotated
  per daemon start. Anything talking to the daemon over localhost must
  read the token file — prevents random page scripts from poking the
  daemon.
- Content-Type: `application/json; charset=utf-8` on both directions
  unless noted.
- Error shape: `{ "error": { "code": "<machine_string>", "message": "<human>" } }` with HTTP 4xx/5xx status.

## Discovery (extension side)

1. On extension start, `DaemonClient.detect()`:
   - Reads candidate port from `chrome.storage.local["daemon.port"]` if user
     manually configured.
   - Else falls back to a small probe range (`8442, 8443, 8444, 8445`).
   - For each candidate, sends `GET /status` with the token (extension
     keeps it in `chrome.storage.local["daemon.token"]`, populated by
     onboarding step).
2. First responder with `{ "ok": true, "service": "mnemiumd" }` wins.
3. Status surfaces in Settings → "Compute Engine" as a green dot or red
   "Daemon not detected — install or configure manually".

Onboarding flow (when no daemon detected) instructs the user to run the
one-liner installer, which:
- Installs `mnemiumd` to `~/.local/bin/`.
- Starts it via `mnemiumd serve --daemonize`.
- Writes `port` + `mnemium-token` files.
- Tells the user to paste a one-time pairing string into the extension
  ("`mnemium pair <token>`" command prints it; the extension's Settings
  page has a "Paste pairing string" field). This avoids the extension
  trying to read arbitrary local files.

## Endpoints

### `GET /status`

Health + capabilities. No body.

```json
{
  "ok": true,
  "service": "mnemiumd",
  "version": "0.1.0",
  "backends": {
    "distill": { "kind": "llama-cpp", "model": "qwen2.5-1.5b-instruct-q4_k_m", "ready": true },
    "embed":   { "kind": "llama-cpp", "model": "nomic-embed-text-v1.5",       "ready": true, "dim": 768 },
    "vec":     { "kind": "sqlite-vec", "count": 1234 }
  },
  "models": {
    "available": ["qwen2.5-1.5b-instruct-q4_k_m", "phi-3-mini-q4_k_m", "nomic-embed-text-v1.5"],
    "downloading": []
  }
}
```

`ready: false` means the backend exists but its model isn't downloaded
yet. UI shows a "Download model" CTA that hits `/model/download`.

### `POST /distill`

Distill an exchange into structured memories. Mirrors
`MemoryModel.distill()`.

Request:
```json
{
  "exchange": {
    "provider": "chatgpt",
    "threadId": "thread-abc",
    "messageId": "msg-123",
    "userText": "...",
    "assistantText": "...",
    "ts": 1780833451348
  }
}
```

Response (200):
```json
{
  "memories": [
    { "type": "preference", "content": "...", "isStatic": true, "isInference": false, "confidence": 0.82, "entities": ["typescript"] }
  ],
  "entities": [
    { "id": "entity:personal::chatgpt::thread-abc:typescript", "type": "concept", "name": "TypeScript", "normalizedName": "typescript", "scopeUri": "personal::chatgpt::thread-abc" }
  ]
}
```

If the backend is disabled or its model isn't ready, return 503 with
`error.code = "backend_unavailable"`. Extension catches and falls
through to its no-op path (no memories materialized).

### `POST /embed`

Batch embed a list of texts. Mirrors `Embedder.embed()`.

Request:
```json
{ "texts": ["how do i use asyncio", "prefers typescript strict mode"] }
```

Response (200):
```json
{
  "model": "nomic-embed-text-v1.5",
  "dim": 768,
  "vectors": [
    [0.12, -0.08, ...],
    [0.04, 0.15, ...]
  ]
}
```

Vectors are returned as plain `number[]` arrays (JSON). If we ever need
to optimize, switch this one endpoint to a binary float32 response with
`Content-Type: application/octet-stream`. Not v0.

### `POST /vec/upsert`

Insert or update vectors. Mirrors `VectorIndex.upsert()`.

Request:
```json
{
  "modelId": "nomic-embed-text-v1.5",
  "rows": [
    { "id": "mem:gemini:url:abc:net:def:0", "scope": "personal::gemini::abc", "type": "preference", "vec": [0.12, ...] }
  ]
}
```

Response (200): `{ "upserted": 1 }`.

Extension-side: memory_id is the string ID we already write to SQLite.
Daemon keeps a mapping from `memory_id` → its own vector_id internally.

### `POST /vec/search`

k-NN search with optional scope/type filter. Mirrors `VectorIndex.search()`.

Request:
```json
{
  "modelId": "nomic-embed-text-v1.5",
  "query": [0.12, ...],
  "k": 12,
  "filter": { "scopePrefix": "personal::chatgpt::", "type": ["preference", "fact"] }
}
```

Response (200):
```json
{
  "hits": [
    { "id": "mem:chatgpt:thread-abc:0", "score": 0.93 },
    { "id": "mem:chatgpt:thread-abc:7", "score": 0.81 }
  ]
}
```

Score is cosine similarity normalized to [0, 1]. Extension hydrates the
memory rows from its own SQLite using the returned IDs.

### `POST /vec/drop`

Wipe an index (e.g., when the embedder changes). `{ "modelId": "..." }`
→ `{ "dropped": true }`.

### `GET /config` / `PUT /config`

Read or replace the daemon's backend config without restart.

`GET /config` →
```json
{
  "distill": { "kind": "llama-cpp", "model": "qwen2.5-1.5b-instruct-q4_k_m" },
  "embed":   { "kind": "llama-cpp", "model": "nomic-embed-text-v1.5" },
  "vec":     { "kind": "sqlite-vec" }
}
```

`PUT /config` accepts the same shape and switches backends in-place.
Useful for the Settings UI's "Switch backend" dropdowns.

### `POST /model/download`

Download a model by name.

Request: `{ "name": "phi-3-mini-q4_k_m" }`.

Response (202 Accepted):
```json
{
  "name": "phi-3-mini-q4_k_m",
  "url": "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf",
  "size_bytes": 2393232128,
  "sha256": "abc123...",
  "started_at": "2026-06-07T19:00:00Z"
}
```

Daemon writes to `~/.local/share/mnemium/models/<name>.gguf.downloading`
then atomically renames on completion. Resumable via HTTP Range
requests. SHA-256 verified before rename.

### `GET /model/progress`

Poll download progress.

```json
{
  "downloads": [
    { "name": "phi-3-mini-q4_k_m", "bytes_done": 524288000, "bytes_total": 2393232128, "rate_bps": 12500000, "eta_seconds": 149 }
  ]
}
```

Extension polls every 1s while a download is active.

### `DELETE /model/{name}`

Remove a downloaded model. 204 on success.

## TOML config (daemon-owned)

`~/.config/mnemium/config.toml`:

```toml
listen = "127.0.0.1:0"      # 0 = auto-pick

[backends.distill]
kind = "llama-cpp"
model = "qwen2.5-1.5b-instruct-q4_k_m"
ctx = 4096
n_threads = 0               # 0 = auto

[backends.embed]
kind = "llama-cpp"
model = "nomic-embed-text-v1.5"
n_threads = 0

[backends.vec]
kind = "sqlite-vec"
path = "~/.local/share/mnemium/vectors.db"

# Alternates (uncomment to use):

# [backends.distill]
# kind = "ollama"
# endpoint = "http://localhost:11434"
# model = "qwen2.5:1.5b"

# [backends.distill]
# kind = "openai"
# api_key_env = "OPENAI_API_KEY"
# model = "gpt-4o-mini"
```

Plugin pattern (later): drop `~/.config/mnemium/plugins/*.toml` to add
new backend kinds without recompiling — same shape as fleetorch's
agent TOMLs.

## Versioning

Every response includes `X-Mnemiumd-Version: 0.1.0`. Extension checks
`major.minor` compatibility on first call. If incompatible, show
"Daemon out of date; please run `mnemiumd upgrade`."

## What the extension does when no daemon is reachable

- `MemoryModel.distill()` → no-op, returns `{ memories: [], entities: [] }`. No memory rows written.
- `Embedder.embed()` → throws `BackendUnavailable`. Caller catches and skips vec upsert.
- `VectorIndex.search()` → returns `[]`. Retriever falls back to FTS5 over `memory.content` (which will be empty if there are no memories — but the chunks table still has the captures, and a `chunks.search` would still return raw transcript hits).

The extension stays usable in "capture-and-search-raw-transcripts" mode
even with the daemon offline. The hybrid moat is real and the fallback
is graceful.
