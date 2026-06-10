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
    console.info(
      "[mnemium/daemon] distill RPC →",
      `${exchange.provider}::${exchange.threadId}`,
      `textlen=${(exchange.userText?.length ?? 0) + (exchange.assistantText?.length ?? 0)}`,
    );
    const started = Date.now();
    try {
      const result = await this.client.distill(exchange);
      console.info(
        "[mnemium/daemon] distill RPC ←",
        `memories=${result.memories.length}`,
        `entities=${result.entities.length}`,
        `took=${Date.now() - started}ms`,
      );
      return result;
    } catch (error) {
      const took = Date.now() - started;
      if (error instanceof DaemonUnavailableError) {
        console.warn("[mnemium/daemon] distill unavailable:", error.code, error.message, `took=${took}ms`);
        return { memories: [], entities: [] };
      }
      console.error("[mnemium/daemon] distill threw", error, `took=${took}ms`);
      throw error;
    }
  }

  async classifyRelations(_m: Memory, _candidates: Memory[]): Promise<Edge[]> {
    // Lazy edge classification is deferred (see DESIGN-SPEC §lazy edges).
    return [];
  }
}
