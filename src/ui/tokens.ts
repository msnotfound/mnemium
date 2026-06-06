// Mnemium design tokens — extracted from the locked Stitch design system
// ("Quiet Luxury — Local Memory") and the exported screen HTML. FROZEN CONTRACT
// for all UI (popup, sidepanel, in-page Shadow-DOM block). Mirror in tailwind.config.

export const tokens = {
  font: {
    headline: "Geist", // also "display"
    body: "Inter", // also "label"
    mono: "Geist Mono, ui-monospace, monospace",
  },
  color: {
    // base (dark-first; light mirrors with neutral-50/900 swaps)
    bg: "#0A0A0A", // neutral-950
    surface: "#171717", // neutral-900
    surfaceMuted: "rgba(23,23,23,0.30)",
    border: "#262626", // neutral-800
    borderSubtle: "rgba(38,38,38,0.50)",
    text: "#E5E5E5", // neutral-200
    textDim: "#A3A3A3", // neutral-400
    textFaint: "#737373", // neutral-500
    // the ONE accent — primary/active only
    accent: "#5B5BD6", // deep indigo
    accentSoft: "rgba(91,91,214,0.12)",
    // SACRED: injected-memory content is always muted gray, subordinate to host white
    memory: "#8A8A8F",
    online: "#10B981", // emerald-500 (local/on-device dot)
  },
  // per memory-type tag colors (soft fill + border, from the exported popup)
  typeTag: {
    fact: "#38BDF8", // sky
    preference: "#818CF8", // indigo
    episode: "#FB7185", // rose
    task: "#FBBF24", // amber
    identity: "#34D399", // emerald
  },
  radius: { sm: "4px", md: "8px", lg: "12px", xl: "16px", full: "9999px" },
  shadow: { soft: "0 4px 24px rgba(0,0,0,0.25)" },
  motion: {
    fast: "120ms",
    base: "180ms",
    slow: "220ms",
    ease: "cubic-bezier(0.16, 1, 0.3, 1)", // ease-out
  },
} as const;

export type Tokens = typeof tokens;
