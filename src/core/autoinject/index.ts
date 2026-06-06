import { createBandit, loadBandit, saveBandit, type LogisticBandit, type MetaStore } from "./bandit";
import { gateWithFeatures } from "./relevance-gate";
import { SemanticDeltaGate } from "./semantic-delta";
import { selectMmr } from "./mmr";
import { hybridSearchWithCandidates } from "@/core/retrieval";
import type { Database } from "@/core/storage/db";
import type { Embedder, VectorIndex } from "@shared/interfaces";
import type { BanditFeatures, MemoryType, SurfacedChunk } from "@shared/types";

export interface AutoInjectRequest {
  draft: string;
  visibleContext: string;
  scopePrefix?: string;
  type?: MemoryType[];
  k: number;
}

export interface AutoInjectDeps {
  embedder: Embedder;
  epsilon: number;
  floor: number;
  retrieve?: (query: string, opts: { scopePrefix?: string; type?: MemoryType[]; k: number }) => Promise<SurfacedChunk[]>;
  db?: Database;
  vectorIndex?: VectorIndex;
  bandit?: LogisticBandit;
  meta?: MetaStore;
  mmrLambda?: number;
}

export class AutoInjector {
  private readonly delta: SemanticDeltaGate;
  private readonly bandit: LogisticBandit;

  constructor(private readonly deps: AutoInjectDeps) {
    this.delta = new SemanticDeltaGate(deps.embedder, deps.epsilon);
    this.bandit = deps.bandit ?? createBandit();
  }

  async loadPolicy(): Promise<void> {
    if (this.deps.meta === undefined) {
      return;
    }
    const loaded = await loadBandit(this.deps.meta);
    this.bandit.load(loaded.serialize());
  }

  async surface(request: AutoInjectRequest): Promise<SurfacedChunk[]> {
    if (request.draft.trim().length === 0) {
      return [];
    }
    const delta = await this.delta.check(request.draft);
    if (!delta.shouldSearch) {
      return delta.cached;
    }

    const retrieved = await this.retrieve(request);
    const gated = gateWithFeatures(retrieved, {
      floor: this.deps.floor,
      visibleContext: request.visibleContext,
    });
    const selected = selectMmr(gated.map((item) => item.chunk), {
      lambda: this.deps.mmrLambda ?? 0.7,
      limit: request.k,
    });
    const featuresById = new Map(gated.map((item) => [item.chunk.memoryId, item.features]));
    const surfaced = selected.filter((chunk) => {
      const features = featuresById.get(chunk.memoryId);
      return features === undefined ? false : this.bandit.shouldInject(features);
    });
    this.delta.remember(delta.vector, surfaced);
    return surfaced;
  }

  async feedback(features: BanditFeatures, accepted: boolean): Promise<void> {
    this.bandit.update(features, accepted);
    if (this.deps.meta !== undefined) {
      await saveBandit(this.deps.meta, this.bandit);
    }
  }

  private async retrieve(request: AutoInjectRequest): Promise<SurfacedChunk[]> {
    if (this.deps.retrieve !== undefined) {
      return this.deps.retrieve(request.draft, {
        scopePrefix: request.scopePrefix,
        type: request.type,
        k: request.k * 3,
      });
    }
    if (this.deps.db === undefined || this.deps.vectorIndex === undefined) {
      throw new Error("AutoInjector requires either retrieve() or db + vectorIndex");
    }
    const result = await hybridSearchWithCandidates(
      this.deps.db,
      this.deps.vectorIndex,
      this.deps.embedder,
      request.draft,
      {
        scopePrefix: request.scopePrefix,
        type: request.type,
        k: request.k * 3,
      },
    );
    return result.chunks;
  }
}
