import type { Config } from "@shared/config";
import type { Rpc } from "@shared/rpc";
import type { Memory, SurfacedChunk } from "@shared/types";

import { sendRpc as runtimeSendRpc } from "@/runtime/rpc";

export type RpcMessage = Rpc;

export async function sendRpc<T = unknown>(msg: RpcMessage): Promise<T> {
  return runtimeSendRpc<T>(msg);
}

export async function listMemories(scopePrefix?: string, limit = 25): Promise<Memory[]> {
  const result = await sendRpc<{ memories: Memory[] }>({ t: "ui.list", scopePrefix, limit });
  return result?.memories ?? [];
}

export async function searchMemories(query: string): Promise<Memory[]> {
  const result = await sendRpc<{ memories: Memory[] }>({ t: "ui.search", query });
  return result?.memories ?? [];
}

export async function deleteMemory(memoryId: string): Promise<void> {
  await sendRpc({ t: "ui.delete", memoryId });
}

export async function exportVault(): Promise<void> {
  const result = await sendRpc<{ filename: string; content: string }>({ t: "ui.export" });
  if (result === undefined || typeof result.content !== "string") {
    console.warn("[mnemium/rpc] export returned no payload");
    return;
  }
  const blob = new Blob([result.content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename ?? "mnemium-export.json";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function getSettings(): Promise<Config | undefined> {
  const result = await sendRpc<{ config: Config }>({ t: "settings.get" });
  return result?.config;
}

export async function updateSettings(patch: Partial<Config>): Promise<void> {
  await sendRpc({ t: "settings.update", patch });
}

export async function acceptChunk(chunk: SurfacedChunk, context: InjectionContext): Promise<void> {
  await sendRpc({
    t: "inject.feedback",
    memoryId: chunk.memoryId,
    accepted: true,
    ctx: {
      sim: chunk.score,
      distinctiveness: 0.5,
      noveltyVsContext: 0.5,
      recency: 0.8,
      reuseCount: 0,
      confidence: Math.min(1, Math.max(0, chunk.score)),
      type: chunk.type,
      scopeMatch: 1,
    },
  });
  await sendRpc({
    t: "ledger.add",
    entry: {
      id: crypto.randomUUID(),
      memoryId: chunk.memoryId,
      scopeUri: context.scopeUri,
      threadId: context.threadId,
      messageId: context.messageId,
      injectedAt: Date.now(),
    },
  });
}

export async function dismissChunk(chunk: SurfacedChunk): Promise<void> {
  await sendRpc({
    t: "inject.feedback",
    memoryId: chunk.memoryId,
    accepted: false,
    ctx: {
      sim: chunk.score,
      distinctiveness: 0.5,
      noveltyVsContext: 0.5,
      recency: 0.8,
      reuseCount: 0,
      confidence: Math.min(1, Math.max(0, chunk.score)),
      type: chunk.type,
      scopeMatch: 1,
    },
  });
}

export interface InjectionContext {
  scopeUri: string;
  threadId: string;
  messageId: string;
}

export function sourceLabel(scopeUri: string, createdAt: number): string {
  const provider = scopeUri.split("::")[1] ?? "local";
  return `${provider[0]?.toUpperCase() ?? "L"}${provider.slice(1)} · ${relativeAge(createdAt)}`;
}

export function relativeAge(ts: number): string {
  const days = Math.max(0, Math.round((Date.now() - ts) / 86400000));
  if (days === 0) return "today";
  if (days === 1) return "1d";
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}
