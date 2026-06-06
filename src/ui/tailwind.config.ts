import type { Config } from "tailwindcss";

import { tokens } from "./tokens";

const config: Config = {
  darkMode: "class",
  content: ["./src/ui/**/*.{ts,tsx}", "./src/entrypoints/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: tokens.color.bg,
        surface: tokens.color.surface,
        "surface-muted": tokens.color.surfaceMuted,
        border: tokens.color.border,
        "border-subtle": tokens.color.borderSubtle,
        text: tokens.color.text,
        "text-dim": tokens.color.textDim,
        "text-faint": tokens.color.textFaint,
        accent: tokens.color.accent,
        "accent-soft": tokens.color.accentSoft,
        memory: tokens.color.memory,
        online: tokens.color.online,
        "tag-fact": tokens.typeTag.fact,
        "tag-preference": tokens.typeTag.preference,
        "tag-episode": tokens.typeTag.episode,
        "tag-task": tokens.typeTag.task,
        "tag-identity": tokens.typeTag.identity,
      },
      borderRadius: {
        sm: tokens.radius.sm,
        DEFAULT: tokens.radius.md,
        md: tokens.radius.md,
        lg: tokens.radius.lg,
        xl: tokens.radius.xl,
        full: tokens.radius.full,
      },
      boxShadow: {
        soft: tokens.shadow.soft,
      },
      fontFamily: {
        headline: [tokens.font.headline, "sans-serif"],
        display: [tokens.font.headline, "sans-serif"],
        body: [tokens.font.body, "sans-serif"],
        label: [tokens.font.body, "sans-serif"],
        mono: [tokens.font.mono],
      },
      transitionDuration: {
        fast: tokens.motion.fast,
        base: tokens.motion.base,
        slow: tokens.motion.slow,
      },
      transitionTimingFunction: {
        mnem: tokens.motion.ease,
      },
    },
  },
};

export default config;
