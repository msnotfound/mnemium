import type { MemoryModel } from "@shared/interfaces";
import type { DraftMemory, Edge, Entity, Exchange, Memory } from "@shared/types";
import { DaemonClient, DaemonUnavailableError } from "./daemon-client";

/** MemoryModel implementation that proxies distillation to mnemiumd.
 *  Returns empty drafts on transport failure so the capture pipeline
 *  doesn't crash if the daemon is offline. */
export class DaemonMemoryModel implements MemoryModel {
  readonly id: string;

  constructor(private readonly client: DaemonClient, modelLabel: string) {
    this.id = `daemon:${modelLabel}`;
  }

  async distill(exchange: Exchange): Promise<{ memories: DraftMemory[]; entities: Entity[] }> {
    try {
      return await this.client.distill(exchange);
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        console.warn("[mnemium/daemon] distill unavailable:", error.code, error.message);
        return { memories: [], entities: [] };
      }
      throw error;
    }
  }

  async classifyRelations(_m: Memory, _candidates: Memory[]): Promise<Edge[]> {
    // Lazy edge classification is deferred (see DESIGN-SPEC §lazy edges).
    return [];
  }
}
