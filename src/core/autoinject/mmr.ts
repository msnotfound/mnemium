import type { SurfacedChunk } from "@shared/types";

export interface MmrOptions {
  lambda?: number;
  limit: number;
}

export function selectMmr(candidates: SurfacedChunk[], options: MmrOptions): SurfacedChunk[] {
  const lambda = options.lambda ?? 0.7;
  const selected: SurfacedChunk[] = [];
  const remaining = [...candidates];

  while (remaining.length > 0 && selected.length < options.limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (candidate === undefined) continue;
      const redundancy = Math.max(0, ...selected.map((item) => lexicalSimilarity(candidate.content, item.content)));
      const score = lambda * candidate.score - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    if (next !== undefined) {
      selected.push(next);
    }
  }

  return selected;
}

function lexicalSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(left.size * right.size);
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}
