import type { Embedder } from "@shared/interfaces";
import { DaemonClient, DaemonUnavailableError } from "./daemon-client";

/** Embedder that calls mnemiumd's /embed endpoint. The model id and
 *  dimension come from the daemon's /status report at construction time
 *  so vectorIndex.upsert can validate dims locally. */
export class DaemonEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;

  constructor(private readonly client: DaemonClient, model: string, dim: number) {
    this.id = `daemon:${model}`;
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    try {
      const response = await this.client.embed(texts);
      if (response.dim !== this.dim) {
        throw new Error(
          `daemon embedder dim drift: expected ${this.dim}, got ${response.dim}. ` +
            `Switch backends or wipe the vector index after embedder changes.`,
        );
      }
      return response.vectors.map((vec) => Float32Array.from(vec));
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        console.warn("[mnemium/daemon] embed unavailable:", error.code, error.message);
        throw error;
      }
      throw error;
    }
  }
}
