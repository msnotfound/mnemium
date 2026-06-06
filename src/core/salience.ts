import type { Exchange } from "@shared/types";

export interface SalienceDecision {
  salient: boolean;
  score: number;
  reasons: string[];
}

export interface SalienceOptions {
  minChars?: number;
  threshold?: number;
}

const DEFAULT_MIN_CHARS = 48;
const DEFAULT_THRESHOLD = 0.55;

const LOW_VALUE_PATTERNS = [
  /^(thanks?|thank you|ok(?:ay)?|got it|cool|great|nice|yep|yes|no)[.!?]*$/i,
  /^(can you|could you|please|what|why|how|when|where|who)\b/i,
];

const HIGH_SIGNAL_PATTERNS = [
  /\b(i|we)\s+(prefer|like|use|work with|live in|am|are|need|want|plan|decided|switched|moved)\b/i,
  /\b(my|our)\s+(project|company|team|stack|preference|goal|deadline|address|email|name)\b/i,
  /\b(always|never|usually|currently|now|latest|from now on)\b/i,
  /\b(deadline|due|todo|task|follow up|remember|note that)\b/i,
];

const ENTITY_LITE_PATTERN = /\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,3}\b/g;

export function salience(input: Exchange | string, options: SalienceOptions = {}): boolean {
  return analyzeSalience(input, options).salient;
}

export function analyzeSalience(input: Exchange | string, options: SalienceOptions = {}): SalienceDecision {
  const text = typeof input === "string" ? input : `${input.userText}\n${input.assistantText}`;
  const normalized = text.replace(/\s+/g, " ").trim();
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const reasons: string[] = [];
  let score = 0;

  if (normalized.length >= minChars) {
    score += 0.2;
    reasons.push("length");
  }
  if (HIGH_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    score += 0.45;
    reasons.push("intent");
  }
  const entityCount = new Set([...normalized.matchAll(ENTITY_LITE_PATTERN)].map((match) => match[0])).size;
  if (entityCount > 0) {
    score += Math.min(0.25, entityCount * 0.08);
    reasons.push("entity");
  }
  if (/\b(is|are|was|were|has|have|will|uses?|prefers?|likes?|needs?)\b/i.test(normalized)) {
    score += 0.15;
    reasons.push("declarative");
  }
  if (LOW_VALUE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    score -= 0.45;
    reasons.push("low_value");
  }

  const clamped = clamp01(score);
  return {
    salient: clamped >= threshold,
    score: clamped,
    reasons,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
