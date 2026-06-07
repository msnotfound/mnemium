// Browser-side VectorIndex backed by EdgeVec (HNSW + IndexedDB persistence).
// This file is the browser counterpart to vector-index.ts (which uses sqlite-vec
// in Node). Both implement the same VectorIndex contract from @shared/interfaces.
//
// EdgeVec gives us per-model HNSW indices with metadata filtering. Our memory_id
// (string) is stored as metadata on each vector; EdgeVec's own numeric vector_id
// is opaque to callers. The memory_id ↔ vector_id map is persisted in a small
// IndexedDB key-value store next to each index so upserts (delete-then-insert)
// can find the previous vector to remove.

import type { VectorIndex } from "@shared/interfaces";
import type { MemoryType } from "@shared/types";

const SOFT_DELETE_MAX_RATIO = 0.25;
const FILTER_OVERSAMPLE = 3;

interface ModelState {
  index: import("edgevec/index.js").EdgeVecIndex;
  dim: number;
  // memory_id → EdgeVec vector_id (numeric handle)
  memoryToVector: Map<string, number>;
  // Track soft-delete pressure so we know when to compact.
  deletedCount: number;
  totalAdded: number;
}

interface VectorMapStore {
  get(modelId: string): Promise<Array<[string, number]>>;
  put(modelId: string, entries: Array<[string, number]>): Promise<void>;
  delete(modelId: string): Promise<void>;
}

export class EdgeVecVectorIndex implements VectorIndex {
  private readonly models = new Map<string, ModelState>();
  private readonly loadPromises = new Map<string, Promise<ModelState>>();

  constructor(
    private readonly mapStore: VectorMapStore,
    private readonly indexNameFor: (modelId: string) => string = defaultIndexName,
  ) {}

  async upsert(modelId: string, rows: { id: string; vec: Float32Array }[]): Promise<void> {
    if (rows.length === 0) return;
    const dim = rows[0]?.vec.length;
    if (dim === undefined || dim === 0) {
      throw new Error("Cannot upsert empty vectors");
    }
    for (const row of rows) {
      if (row.vec.length !== dim) {
        throw new Error(`Vector ${row.id} dim ${row.vec.length} does not match batch dim ${dim}`);
      }
    }
    const state = await this.ensureModel(modelId, dim);

    for (const row of rows) {
      const existing = state.memoryToVector.get(row.id);
      if (existing !== undefined) {
        state.index.delete(existing);
        state.deletedCount += 1;
      }
      const vectorId = state.index.add(row.vec, { memory_id: row.id });
      state.memoryToVector.set(row.id, vectorId);
      state.totalAdded += 1;
    }

    await this.persist(modelId, state);
  }

  async search(
    modelId: string,
    q: Float32Array,
    k: number,
    filter?: { scopePrefix?: string; type?: MemoryType[] },
  ): Promise<Array<{ id: string; score: number }>> {
    if (k <= 0) return [];
    const state = this.models.get(modelId) ?? (await this.tryLoad(modelId, q.length));
    if (state === undefined || state.index.size === 0) return [];
    if (state.dim !== q.length) {
      throw new Error(`Query vector dim ${q.length} does not match ${modelId} dim ${state.dim}`);
    }

    const requested = filter !== undefined ? Math.max(k * FILTER_OVERSAMPLE, k) : k;
    const results = await state.index.search(q, requested, { includeMetadata: true });
    const filtered: Array<{ id: string; score: number }> = [];
    for (const result of results) {
      const memoryId = readMemoryId(result.metadata);
      if (memoryId === undefined) continue;
      filtered.push({ id: memoryId, score: distanceToScore(result.score) });
      if (filtered.length >= k) break;
    }
    // Caller-side scope/type filtering is layered on top by the retriever via
    // the SQL JOIN against the memory table — vec-index only narrows ANN.
    void filter;
    return filtered;
  }

  async drop(modelId: string): Promise<void> {
    this.models.delete(modelId);
    this.loadPromises.delete(modelId);
    try {
      // EdgeVec persisted indices are removed by saving an empty index, or by
      // deleting the underlying IndexedDB database. We just clear our map; the
      // EdgeVec database remains until the user clears storage. Acceptable for
      // an MVP — the contents are orphaned but harmless.
      await this.mapStore.delete(modelId);
    } catch (error) {
      console.warn("[mnemium/edgevec] drop map failed", error);
    }
  }

  private async ensureModel(modelId: string, dim: number): Promise<ModelState> {
    const cached = this.models.get(modelId);
    if (cached !== undefined) {
      if (cached.dim !== dim) {
        throw new Error(`Index for ${modelId} has dim ${cached.dim}; cannot upsert dim ${dim}`);
      }
      return cached;
    }
    const loaded = await this.tryLoad(modelId, dim);
    if (loaded !== undefined) {
      if (loaded.dim !== dim) {
        throw new Error(`Index for ${modelId} has dim ${loaded.dim}; cannot upsert dim ${dim}`);
      }
      return loaded;
    }
    return this.createModel(modelId, dim);
  }

  private async tryLoad(modelId: string, dim: number): Promise<ModelState | undefined> {
    const existingPromise = this.loadPromises.get(modelId);
    if (existingPromise !== undefined) {
      return existingPromise;
    }
    const loadPromise = (async (): Promise<ModelState | undefined> => {
      const { EdgeVecIndex } = await import("edgevec/index.js");
      let index: import("edgevec/index.js").EdgeVecIndex;
      try {
        index = await EdgeVecIndex.load(this.indexNameFor(modelId));
      } catch {
        return undefined;
      }
      if (index.dimensions !== dim) {
        return undefined;
      }
      const entries = await this.mapStore.get(modelId);
      const state: ModelState = {
        index,
        dim: index.dimensions,
        memoryToVector: new Map(entries),
        deletedCount: 0,
        totalAdded: entries.length,
      };
      this.models.set(modelId, state);
      console.info(
        "[mnemium/edgevec] loaded persisted index",
        modelId,
        "vectors=",
        index.size,
        "mappings=",
        entries.length,
      );
      return state;
    })();
    this.loadPromises.set(modelId, loadPromise as Promise<ModelState>);
    try {
      return await loadPromise;
    } finally {
      this.loadPromises.delete(modelId);
    }
  }

  private async createModel(modelId: string, dim: number): Promise<ModelState> {
    const { EdgeVecIndex } = await import("edgevec/index.js");
    const index = new EdgeVecIndex({ dimensions: dim });
    const state: ModelState = {
      index,
      dim,
      memoryToVector: new Map(),
      deletedCount: 0,
      totalAdded: 0,
    };
    this.models.set(modelId, state);
    console.info("[mnemium/edgevec] created fresh index", modelId, "dim=", dim);
    return state;
  }

  private async persist(modelId: string, state: ModelState): Promise<void> {
    try {
      await state.index.save(this.indexNameFor(modelId));
      await this.mapStore.put(modelId, Array.from(state.memoryToVector.entries()));
    } catch (error) {
      console.error("[mnemium/edgevec] persist failed", modelId, error);
      throw error;
    }
    if (
      state.totalAdded > 50 &&
      state.deletedCount / Math.max(1, state.totalAdded) > SOFT_DELETE_MAX_RATIO
    ) {
      console.info("[mnemium/edgevec] soft-delete pressure high; compaction TODO", modelId);
      // EdgeVec doesn't expose a compact() at the public API yet; soft-deleted
      // vectors stay in the HNSW graph but are filtered from results. When the
      // ratio crosses the threshold we'd rebuild the index from `memoryToVector`.
      // Deferred until we know it matters in practice.
    }
  }
}

export function createEdgeVecVectorIndex(mapStore: VectorMapStore): EdgeVecVectorIndex {
  return new EdgeVecVectorIndex(mapStore);
}

/** Default IndexedDB-backed mapping store. */
export function createIndexedDbMapStore(databaseName = "mnemium-vec-map"): VectorMapStore {
  const STORE = "map";
  const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("idb open failed"));
    });

  return {
    async get(modelId) {
      const db = await openDb();
      try {
        return await new Promise<Array<[string, number]>>((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(modelId);
          req.onsuccess = () => {
            const value = req.result as Array<[string, number]> | undefined;
            resolve(value ?? []);
          };
          req.onerror = () => reject(req.error ?? new Error("idb get failed"));
        });
      } finally {
        db.close();
      }
    },
    async put(modelId, entries) {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(entries, modelId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("idb put failed"));
        });
      } finally {
        db.close();
      }
    },
    async delete(modelId) {
      const db = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(modelId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("idb delete failed"));
        });
      } finally {
        db.close();
      }
    },
  };
}

function defaultIndexName(modelId: string): string {
  const sanitized = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `mnemium-vec-${sanitized.length === 0 ? "model" : sanitized}`;
}

function readMemoryId(metadata: Record<string, unknown> | undefined): string | undefined {
  if (metadata === undefined) return undefined;
  const raw = metadata.memory_id;
  return typeof raw === "string" ? raw : undefined;
}

function distanceToScore(distance: number): number {
  return 1 / (1 + Math.max(0, distance));
}
