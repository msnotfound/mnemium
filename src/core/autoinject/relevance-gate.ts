import type { BanditFeatures, SurfacedChunk } from "@shared/types";

export interface RelevanceGateOptions {
  floor: number;
  visibleContext: string;
  now?: number;
  minMargin?: number;
}

export interface GatedChunk {
  chunk: SurfacedChunk;
  features: BanditFeatures;
  value: number;
}

const DEFAULT_MIN_MARGIN = 0.03;

export function relevanceGate(candidates: SurfacedChunk[], options: RelevanceGateOptions): SurfacedChunk[] {
  return gateWithFeatures(candidates, options).map((item) => item.chunk);
}

export function gateWithFeatures(candidates: SurfacedChunk[], options: RelevanceGateOptions): GatedChunk[] {
  if (candidates.length === 0) {
    return [];
  }
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const margin = sorted.length <= 1 ? 1 : (sorted[0]?.score ?? 0) - (sorted[1]?.score ?? 0);
  const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
  const marginOk = margin >= minMargin;

  return sorted
    .filter((candidate) => candidate.score >= options.floor)
    .filter((candidate, index) => index > 0 || marginOk)
    .map((candidate) => {
      const noveltyVsContext = novelty(candidate.content, options.visibleContext);
      const confidence = confidenceFromScore(candidate.score);
      const recency = recencyFromSource(candidate.sourceLabel, options.now ?? Date.now());
      const reuseCount = reuseFromSource(candidate.sourceLabel);
      const distinctiveness = Math.max(0, Math.min(1, margin));
      const features: BanditFeatures = {
        sim: candidate.score,
        distinctiveness,
        noveltyVsContext,
        recency,
        reuseCount,
        confidence,
        type: candidate.type,
        scopeMatch: 1,
      };
      return {
        chunk: candidate,
        features,
        value: candidate.score * confidence * recency * (1 + reuseCount) * noveltyVsContext,
      };
    })
    .filter((item) => item.features.noveltyVsContext >= 0.35)
    .sort((a, b) => b.value - a.value);
}

function novelty(content: string, visibleContext: string): number {
  const contentTokens = tokens(content);
  if (contentTokens.size === 0) {
    return 0;
  }
  const visibleTokens = tokens(visibleContext);
  let overlap = 0;
  for (const token of contentTokens) {
    if (visibleTokens.has(token)) overlap += 1;
  }
  return 1 - overlap / contentTokens.size;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

function confidenceFromScore(score: number): number {
  return Math.max(0.1, Math.min(1, score));
}

function recencyFromSource(sourceLabel: string, _now: number): number {
  const dayMatch = /·\s*(\d+)d\b/i.exec(sourceLabel);
  if (dayMatch?.[1] !== undefined) {
    const days = Number.parseInt(dayMatch[1], 10);
    return Math.exp(-days / 90);
  }
  const monthMatch = /·\s*(\d+)mo\b/i.exec(sourceLabel);
  if (monthMatch?.[1] !== undefined) {
    const months = Number.parseInt(monthMatch[1], 10);
    return Math.exp(-(months * 30) / 90);
  }
  const yearMatch = /·\s*(\d+)y\b/i.exec(sourceLabel);
  if (yearMatch?.[1] !== undefined) {
    const years = Number.parseInt(yearMatch[1], 10);
    return Math.exp(-(years * 365) / 90);
  }
  return 1;
}

function reuseFromSource(sourceLabel: string): number {
  const match = /\breused\s+(\d+)/i.exec(sourceLabel);
  return match?.[1] === undefined ? 0 : Math.min(1, Number.parseInt(match[1], 10) / 10);
}
