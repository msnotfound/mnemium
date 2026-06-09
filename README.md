<div align="center">

# Mnemium

**Your AI chats, with memory — 100% on your device.**

A Chrome extension + local helper daemon that gives every AI chat provider
(ChatGPT, Claude, Gemini, Grok, DeepSeek) a shared, private, on-device
second brain. Capture what you discuss → distill it into typed memories
→ pull the right context into whichever provider you're using next.

**Nothing leaves your device unless you decide it does.**

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Configure](#configure) · [Privacy](#privacy)

</div>

---

## Quickstart

> Mnemium ships as two pieces: a **browser extension** (Chrome / Edge / any
> Chromium) and a **helper daemon** (`mnemiumd`) that does the
> distillation + embedding + vector search outside Chrome's sandbox.

### 1 — Install the daemon

**Windows** (PowerShell):
```powershell
irm https://github.com/msnotfound/mnemium/releases/latest/download/install.ps1 | iex
```

**macOS / Linux**:
```bash
curl -fsSL https://github.com/msnotfound/mnemium/releases/latest/download/install.sh | sh
```

Both installers fetch the matching binary for your OS/arch from the latest
GitHub release, verify the sha256, and drop it on your `PATH`.

### 2 — Start the daemon

```
mnemiumd serve
```

This prints a one-time **pairing string** like `mn:53412:abc...xyz`. Copy it.

### 3 — Install the extension

Download the extension bundle from the
[latest release](https://github.com/msnotfound/mnemium/releases/latest)
(`mnemium-extension.zip`), unzip it, then in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**, pick the unzipped folder

> *Chrome Web Store listing coming in v0.0.2 — for now it's "load unpacked"
> from a release zip.*

### 4 — Pair + pick your brain

The Mnemium tab opens automatically on install. Walk through:

1. Paste the pairing string
2. Pick **Recommended** (default: llama.cpp + Qwen2.5-1.5B + nomic-embed-text)
3. Watch the setup feed install `llama-server`, fetch the two GGUF models,
   and turn the status dot green

You're done. Open `chatgpt.com` (or any of the four others), have a chat,
then press **Alt+Shift+M** in a different provider to pull the relevant
memory in.

---

## How it works

```
                ┌──────────────────────────────────────────────┐
                │   Chrome / Edge / Chromium browser           │
                │  ┌────────────────────────────────────────┐  │
                │  │  Mnemium extension (MV3)                │  │
                │  │  • Site adapters per provider           │  │
                │  │  • Capture pipeline → daemon            │  │
                │  │  • Alt+Shift+M → retrieval → injection  │  │
                │  └─────────────────┬──────────────────────┘  │
                └────────────────────│─────────────────────────┘
                                     │ HTTP loopback (127.0.0.1)
                                     │ Authorization: Bearer <token>
                                     ▼
                ┌──────────────────────────────────────────────┐
                │  mnemiumd  (your machine, your control)      │
                │  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
                │  │ distill  │  │  embed   │  │    vec     │  │
                │  │ llama.cpp│  │ llama.cpp│  │   sqlite   │  │
                │  │  ollama  │  │  ollama  │  │ sqlite-vec │  │
                │  │  openai  │  │          │  │            │  │
                │  │  ...     │  │          │  │            │  │
                │  └──────────┘  └──────────┘  └────────────┘  │
                │      ↓               ↓             ↓         │
                │   model GGUFs    embeddings    vectors.db    │
                │   <data>/models  <runtime>     <data>/       │
                └──────────────────────────────────────────────┘
```

- **Capture**: each provider has a `SiteAdapter` that watches the page
  and emits an `Exchange` (user turn + assistant turn + thread id) when
  a response finishes streaming. No keystroke logging, no idle capture.
- **Distill**: `mnemiumd` runs your chosen LLM (local or hosted) to
  extract durable, typed memories (`preference`, `fact`, `goal`,
  `constraint`, etc.) with a confidence score and entity links.
- **Embed + store**: nomic-embed-text turns each memory into a 768-d
  vector; the daemon's sqlite vec store keeps them with a per-thread
  scope tag.
- **Retrieve**: in any provider, type a draft and hit **Alt+Shift+M**.
  Your draft is embedded, the vec store returns top-k matches
  (with scope/type filtering), the extension surfaces chunks with
  ✓/✖ inject controls. The audit ledger records what you actually
  inject.

The hybrid moat: anything brittle or evolving (LLM, embedder, vector
store, model files, providers) lives behind a swappable interface.
Swap llama.cpp for Ollama in Settings → the daemon reconfigures in
place, no restart, no migration.

## Configure

### Default — everything local (recommended)

The onboarding "Recommended" preset gives you:

| Layer | Default |
|---|---|
| Distillation | `llama.cpp` running Qwen2.5-1.5B-Instruct (auto-fetched) |
| Embedding | `llama.cpp` running nomic-embed-text-v1.5 (auto-fetched) |
| Vector store | `sqlite` (pure-Go, no cgo, no external service) |

Daemon auto-installs `llama-server` from llama.cpp's GitHub releases
(CPU build, ~15 MB) on first run. Models live in
`~/.local/share/mnemium/models/` (Linux), `~/Library/Application Support/mnemium/models/` (macOS),
or `%LOCALAPPDATA%\mnemium\models\` (Windows).

### Power-user — Ollama / OpenAI / custom

Settings → switch any of `distill`, `embed`, `vec` to a different kind:

| Kind | What it does |
|---|---|
| `llama-cpp` | daemon-managed local subprocess (the default) |
| `ollama` | proxy through a local Ollama install. Daemon can install Ollama for you if missing |
| `openai` | OpenAI-compatible chat completions — works with OpenAI, OpenRouter, Together, Anthropic, etc. (any endpoint speaking the OpenAI shape) |
| `sqlite` | pure-Go sqlite vec store (default) |
| `disabled` | no-op, useful for offline-only / capture-only modes |

Config is at `~/.config/mnemium/config.toml`. Live-reload via PUT
to the daemon's `/config` endpoint — no restart needed.

GPU users: drop your own `llama-server` build anywhere and point
`MNEMIUM_LLAMA_SERVER=/path/to/llama-server` — daemon prefers it over
the auto-installed CPU build.

## Privacy

- **No telemetry.** The extension doesn't phone home. The daemon
  doesn't either.
- **Local-first by default.** Capture, distill, embed, store, search —
  all on your machine. The default Recommended preset uses no external
  APIs.
- **API-key backends are opt-in.** If you switch distill to `openai`,
  your text leaves your machine — but only to the endpoint you
  configured, using your own key.
- **No content scripts inject ads / trackers.** The capture script
  reads the DOM of supported chat providers; that's it.
- **Loopback auth.** The daemon binds to `127.0.0.1` and requires
  a bearer token (rotated per install) on every request. Random
  pages can't poke it.

The architecture leaves *you* in control of where the brain lives. Local
by default, swap to a hosted model only if you want.

## Privacy goes both ways

Mnemium can read whatever's on the DOM of a supported chat site —
your messages, the assistant's responses, system prompts visible in
the UI. That's the price of cross-provider memory. The code that does
this is in `src/adapters/<provider>.ts`, ~100-200 lines per provider,
auditable.

Daemon is similar — it's the one with disk access, network access
to its configured backends (Ollama, OpenAI), and the vector store.
Code is in `daemon/internal/`. Pure Go, no cgo, single binary, easy
to audit.

## Develop

```bash
# Repo bootstrap
git clone https://github.com/msnotfound/mnemium ~/src/mnemium
cd ~/src/mnemium
pnpm install            # extension deps
cd daemon && go mod download && cd ..

# Day-to-day
pnpm dev                # WXT watch + build extension into .output/chrome-mv3/
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest
cd daemon && go test ./...

# Build a release-style binary
cd daemon && go build -o bin/mnemiumd ./cmd/mnemiumd
```

Architecture deep-dive: `DESIGN-SPEC-v1.md` (canonical) and
`docs/MNEMIUMD-PROTOCOL.md` (the HTTP contract between extension and
daemon). `daemon/README.md` covers the daemon in isolation.

## Roadmap

- **v0.0.x** — install flow polish, Chrome Web Store listing,
  GoReleaser CI, sha256-pinned model registry
- **v0.1** — cgo-linked `sqlite-vec` for the vector store (replaces
  the brute-force scan), GPU llama.cpp variant detection
- **v0.2** — opt-in encrypted backup (per-device key), more
  providers (Perplexity, Mistral chat), Firefox build
- **v1.0** — Chrome Web Store stable channel, signed installers
  per platform, plugin API for community-contributed providers
  and backends

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). For
security-impacting issues, see [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE).
