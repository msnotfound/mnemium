import type { VectorIndex } from "@shared/interfaces";
import type { MemoryType } from "@shared/types";
import { DaemonClient, DaemonUnavailableError } from "./daemon-client";

/** VectorIndex backed by mnemiumd's /vec/* endpoints (sqlite-vec under
 *  the hood). The daemon owns the vector DB on disk; the browser only
 *  passes IDs + vectors. */
export class DaemonVectorIndex implements VectorIndex {
  constructor(private readonly client: DaemonClient) {}

  async upsert(modelId: string, rows: { id: string; vec: Float32Array }[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      // Daemon needs scope + type to support pre-filtered HNSW. The capture
      // pipeline currently doesn't pass these to upsert(), so we leave them
      // blank — the daemon falls back to post-filter. When wiring metadata
      // through, this is the seam to extend.
      await this.client.vecUpsert(
        modelId,
        rows.map((row) => ({
          id: row.id,
          scope: "",
          type: "fact" as MemoryType,
          vec: Array.from(row.vec),
        })),
      );
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        console.warn("[mnemium/daemon] vec.upsert unavailable:", error.code, error.message);
        return;
      }
      throw error;
    }
  }

  async search(
    modelId: string,
    q: Float32Array,
    k: number,
    filter?: { scopePrefix?: string; type?: MemoryType[] },
  ): Promise<Array<{ id: string; score: number }>> {
    if (k <= 0) return [];
    try {
      const response = await this.client.vecSearch(modelId, Array.from(q), k, filter);
      return response.hits;
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        console.warn("[mnemium/daemon] vec.search unavailable:", error.code, error.message);
        return [];
      }
      throw error;
    }
  }

  async drop(modelId: string): Promise<void> {
    try {
      await this.client.vecDrop(modelId);
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        console.warn("[mnemium/daemon] vec.drop unavailable:", error.code, error.message);
        return;
      }
      throw error;
    }
  }
}
