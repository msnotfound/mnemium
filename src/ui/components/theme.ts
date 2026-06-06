import type { CSSProperties } from "react";

import { tokens } from "../tokens";

export type TokenStyle = CSSProperties & Record<`--mnem-${string}`, string>;

export const tokenStyle: TokenStyle = {
  "--mnem-font-headline": `${tokens.font.headline}, ui-sans-serif, system-ui, sans-serif`,
  "--mnem-font-body": `${tokens.font.body}, ui-sans-serif, system-ui, sans-serif`,
  "--mnem-font-mono": tokens.font.mono,
  "--mnem-bg": tokens.color.bg,
  "--mnem-surface": tokens.color.surface,
  "--mnem-surface-muted": tokens.color.surfaceMuted,
  "--mnem-border": tokens.color.border,
  "--mnem-border-subtle": tokens.color.borderSubtle,
  "--mnem-text": tokens.color.text,
  "--mnem-text-dim": tokens.color.textDim,
  "--mnem-text-faint": tokens.color.textFaint,
  "--mnem-accent": tokens.color.accent,
  "--mnem-accent-soft": tokens.color.accentSoft,
  "--mnem-memory": tokens.color.memory,
  "--mnem-online": tokens.color.online,
  "--mnem-tag-fact": tokens.typeTag.fact,
  "--mnem-tag-preference": tokens.typeTag.preference,
  "--mnem-tag-episode": tokens.typeTag.episode,
  "--mnem-tag-task": tokens.typeTag.task,
  "--mnem-tag-identity": tokens.typeTag.identity,
  "--mnem-radius-sm": tokens.radius.sm,
  "--mnem-radius-md": tokens.radius.md,
  "--mnem-radius-lg": tokens.radius.lg,
  "--mnem-radius-xl": tokens.radius.xl,
  "--mnem-radius-full": tokens.radius.full,
  "--mnem-shadow-soft": tokens.shadow.soft,
  "--mnem-motion-fast": tokens.motion.fast,
  "--mnem-motion-base": tokens.motion.base,
  "--mnem-motion-slow": tokens.motion.slow,
  "--mnem-motion-ease": tokens.motion.ease,
};

export const memoryTypeVar = {
  fact: "var(--mnem-tag-fact)",
  preference: "var(--mnem-tag-preference)",
  episode: "var(--mnem-tag-episode)",
  task: "var(--mnem-tag-task)",
  identity: "var(--mnem-tag-identity)",
} as const;
