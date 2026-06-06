# UI Brief — for Google Stitch (or any AI UI tool)

**How to use:** paste the "Global style" block once, then paste each "SCREEN" prompt to generate that screen. Keep the gray/muted-vs-white distinction sacred across all of them.

---

## Product context (1 paragraph — paste as preamble)

A privacy-first Chrome extension that gives AI chats a local "second brain." It runs entirely on the user's device — it quietly remembers what you discuss across ChatGPT, Claude, Gemini, Grok and DeepSeek, and lets you inject the right past context back into any chat with a tap. The brand feel is **calm, premium, and trustworthy** — it sits *on top of* other AI apps, so it must feel like a refined, unobtrusive layer, never a loud overlay.

## Global style (paste once)

- **Aesthetic:** premium-minimal, "quiet luxury." Generous whitespace, soft depth, restraint. Lightweight, never heavy or skeuomorphic.
- **Light + dark mode**, both first-class. Default to system.
- **Palette:** near-neutral base (off-white `#FAFAF9` / near-black `#0E0E10`). ONE restrained accent (deep indigo `#5B5BD6` or a muted teal) used sparingly for active/primary. **Injected-memory content is always muted gray** (`#8A8A8F`-ish) — deliberately subordinate to the host's white conversation text.
- **Type:** Inter / Geist. Tight, confident hierarchy. Small-but-legible (this is a utility layer). Numeric/meta in a mono (Geist Mono) for stats/IDs.
- **Shape & depth:** 10–12px radii, hairline 1px borders, very soft shadows (single low-opacity layer), subtle glassmorphism only where it overlays host content.
- **Density:** airy but efficient — this is a power tool, not a marketing page. No wasted vertical space.
- **Motion:** subtle and fast (120–220ms), `ease-out` / spring; micro-interactions on hover and ✓/✖. Everything must feel instant and *lightweight* — no bouncy, attention-grabbing, or CPU-heavy effects.

---

## SCREEN 1 — In-page injection block (the hero). Shown overlaid above an AI chat composer.

Design a compact, Shadow-DOM-isolated UI that floats just above a chat input box (show it composited over a faint ChatGPT-like chat for context). Three states, side by side:

1. **Idle + badge:** a small, subtle pill/indicator near the composer with a soft glowing dot meaning "relevant memory available." Unobtrusive. A tiny "✦ Memory" affordance + hotkey hint (⌘J).
2. **Expanded (the gray block):** a collapsed-by-default, now-expanded **muted-gray** panel titled "Memory context" with 2–4 candidate memory chunks listed. **Each chunk is one line with a ✓ and a ✖ button** (accept/drop this chunk). A subtle "source" tag per chunk (e.g. "from ChatGPT · 3 days ago"). The whole panel is visually quieter/grayer than the surrounding white conversation. A collapse chevron.
3. **Injected:** the block collapses to a slim gray summary chip ("3 memories added") that the user can re-expand; the composer below shows the merged text.

Premium, calm, minimal. The gray panel must read as "assistant scaffolding," clearly distinct from real conversation.

## SCREEN 2 — Extension popup (Trust UI). 360–400px wide.

Design a compact extension popup. Top: small logo + a one-line status ("Local · 1,240 memories · synced 0"). A **search field** (semantic + keyword). Below: a scrollable list of recent memories — each row shows the memory text (one or two lines), a type tag (fact/preference/episode/task), source + date (mono, muted), and a hover-revealed delete. Footer: tiny stats, an "Export backup" button, and a gear → Settings. Calm, dense-but-airy, premium.

## SCREEN 3 — Side panel + Ledger. Full-height browser side panel.

Design a full-height side panel with two tabs: **Memories** (a richer browser of the popup list — filter by type, scope, date) and **Ledger** (an audit trail). The Ledger shows, grouped by chat session, a timeline of "injections": each entry = the injected memory (referenced, gray), a link "jump to message," and a timestamp. Clean, inspectable, trustworthy — an audit log that feels premium, not technical.

## SCREEN 4 — First-run onboarding. Centered, 2–3 steps.

Design a calm 3-step first-run flow: (1) a warm value statement ("Your AI chats, with memory — 100% on your device"), (2) a **privacy/consent** step (plain-language: nothing leaves your device; grant access to 5 AI sites — show their logos), (3) a **"Setting up your local memory…"** step with an elegant determinate progress bar for the on-device model download (~600MB) and a reassuring subline. Premium, reassuring, minimal.

## SCREEN 5 — Settings.

Design a settings screen (works as popup-expanded or side-panel). Sections: **Memory model** (radio: Built-in on-device model / Local server (Ollama) / Bring your own API key — with a key field that appears conditionally), **Embedding model** (dropdown, with a note that changing it re-indexes in the background), **Auto-injection** (a prominent toggle, OFF by default, with a short explainer + sensitivity slider revealed when on), **Sites** (per-site on/off toggles with logos for the 5 providers), **Data** (export backup, clear all). Clean, grouped, premium toggles and selects.

## SCREEN 6 — Command palette (LATER — design but mark v2).

A ⌘K centered overlay (glassy, dark-friendly) to search all memories semantically and inject on select. Minimal, fast, keyboard-first.

---

## Component inventory (for a design system)

Badge/indicator (glowing dot), memory-chunk row (with ✓/✖), gray collapsed/expanded panel, summary chip, search field, memory list row, type tag, source/date meta, toggle, segmented radio, progress bar, side-panel tabs, ledger entry, settings group, primary/ghost buttons.

## Motion spec

- Panel expand/collapse: height + opacity, 180ms ease-out.
- ✓/✖: 120ms scale+color micro-bounce; on ✓ the chunk slides up and out (accepted), on ✖ it fades.
- Badge "memory available": one slow soft pulse (do not loop aggressively).
- Hover: 1–2px lift + border-brighten, 120ms.
- Everything GPU-cheap (transform/opacity only) — this runs alongside heavy host apps.

---

## Stitch project (for resuming)

- **Project ID:** `11259229774853847776` (title: "Local Memory — AI Chat Second Brain (V1)")
- **Design system asset:** `assets/11148319493045181307` ("Quiet Luxury — Local Memory": DARK, Geist/Inter, indigo `#5B5BD6`, 12px radii, TONAL_SPOT)
- **Screens generated (4/6):**
  - `a10c66fcf8e44261b6f832a71c33bbf7` — Hero / in-page injection block ✅
  - `f5b4b4abe40945baad468e88dece10fa` — Popup Trust UI ✅
  - `45d05350befa4c5c998651c4fb86d12f` — Onboarding / privacy-consent ✅
  - `0923177f3688480c937fb9df7a3497e0` — Settings ✅
  - Ledger side-panel — ⏳ pending (Stitch backend timeouts on regen)
  - Command palette (v2) — ⏳ pending
- Local PNGs in `stitch-screens/`. **Product name: Mnemium** (locked) — applied across screens via `edit_screens`.
