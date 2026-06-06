import type { Embedder } from "@shared/interfaces";
import type { SurfacedChunk } from "@shared/types";

export interface SemanticDeltaResult {
  shouldSearch: boolean;
  vector: Float32Array;
  cached: SurfacedChunk[];
  delta: number;
}

export class SemanticDeltaGate {
  private lastSearched?: Float32Array;
  private cached: SurfacedChunk[] = [];

  constructor(private readonly embedder: Embedder, private readonly epsilon: number) {}

  async check(draft: string): Promise<SemanticDeltaResult> {
    const [vector] = await this.embedder.embed([draft]);
    if (vector === undefined) {
      return { shouldSearch: false, vector: new Float32Array(), cached: this.cached, delta: 0 };
    }
    if (this.lastSearched === undefined) {
      return { shouldSearch: true, vector, cached: this.cached, delta: 1 };
    }
    const similarity = cosine(vector, this.lastSearched);
    const delta = 1 - similarity;
    return {
      shouldSearch: delta >= this.epsilon,
      vector,
      cached: this.cached,
      delta,
    };
  }

  remember(vector: Float32Array, surfaced: SurfacedChunk[]): void {
    this.lastSearched = vector;
    this.cached = surfaced;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  return aNorm === 0 || bNorm === 0 ? 0 : dot / Math.sqrt(aNorm * bNorm);
}
