import type { Config } from "@shared/config";
import type { Rpc, RpcResponse } from "@shared/rpc";
import type { LedgerEntry, Memory, SurfacedChunk } from "@shared/types";

export type RpcMessage = Rpc;

export async function sendRpc(msg: RpcMessage): Promise<RpcResponse> {
  void msg;
  // TODO(runtime-rpc): replace this stub by importing sendRpc from @shared/rpc
  // once the runtime bridge exports it. UI surfaces must not talk to the engine
  // through any other path.
  return { reqId: crypto.randomUUID(), ok: true };
}

export async function listMemories(scopePrefix?: string, limit = 25): Promise<Memory[]> {
  await sendRpc({ t: "ui.list", scopePrefix, limit });
  return demoMemories.slice(0, limit);
}

export async function searchMemories(query: string): Promise<Memory[]> {
  await sendRpc({ t: "ui.search", query });
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return demoMemories;
  return demoMemories.filter((memory) => memory.content.toLowerCase().includes(normalized));
}

export async function deleteMemory(memoryId: string): Promise<void> {
  await sendRpc({ t: "ui.delete", memoryId });
}

export async function exportVault(): Promise<void> {
  await sendRpc({ t: "ui.export" });
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

const now = Date.now();

export const demoMemories: Memory[] = [
  memory("mem-1", "preference", "Prefers TypeScript with strict mode", "personal::claude::architecture", 0.96, now - 3 * 86400000, 5),
  memory("mem-2", "task", "Working on a local-first Chrome extension", "personal::chatgpt::extension", 0.91, now - 7 * 86400000, 3),
  memory("mem-3", "episode", "Has an exam on Friday", "personal::claude::planning", 0.82, now - 86400000, 1),
  memory("mem-4", "fact", "Lives in San Francisco", "personal::claude::profile", 0.88, now - 5 * 86400000, 2),
  memory("mem-5", "preference", "Likes concise, direct answers", "personal::chatgpt::style", 0.94, now - 14 * 86400000, 8),
  memory("mem-6", "identity", "Builds privacy-preserving local software", "personal::gemini::identity", 0.86, now - 2 * 86400000, 2),
];

export const demoChunks: SurfacedChunk[] = demoMemories.slice(0, 3).map((memoryItem) => ({
  memoryId: memoryItem.id,
  content: memoryItem.content,
  type: memoryItem.type,
  sourceLabel: sourceLabel(memoryItem.scopeUri, memoryItem.createdAt),
  score: memoryItem.confidence,
}));

export const demoLedger: Array<LedgerEntry & { content: string; source: string; threadTitle: string; type: Memory["type"] }> = [
  {
    id: "ledger-1",
    memoryId: "mem-1",
    scopeUri: "personal::chatgpt::architecture",
    threadId: "thread-architecture",
    messageId: "msg-1422",
    injectedAt: now - 1200000,
    content: "User prefers modular architecture using ES6 modules.",
    source: "ChatGPT",
    threadTitle: "Background script architecture",
    type: "preference",
  },
  {
    id: "ledger-2",
    memoryId: "mem-2",
    scopeUri: "personal::chatgpt::architecture",
    threadId: "thread-architecture",
    messageId: "msg-1418",
    injectedAt: now - 1440000,
    content: "Stored snippet containing the customized service worker injection process.",
    source: "ChatGPT",
    threadTitle: "Background script architecture",
    type: "task",
  },
  {
    id: "ledger-3",
    memoryId: "mem-4",
    scopeUri: "personal::claude::trip",
    threadId: "thread-trip",
    messageId: "msg-0910",
    injectedAt: now - 86400000,
    content: "User is traveling to Tokyo next October and prefers quiet boutique hotels.",
    source: "Claude",
    threadTitle: "Trip planning",
    type: "fact",
  },
];

function memory(
  id: string,
  type: Memory["type"],
  content: string,
  scopeUri: string,
  confidence: number,
  createdAt: number,
  reuseCount: number,
): Memory {
  return {
    id,
    type,
    content,
    scopeUri,
    version: 1,
    isLatest: true,
    isStatic: type === "identity" || type === "preference" || type === "fact",
    isInference: false,
    confidence,
    isForgotten: false,
    reuseCount,
    sourceCount: 1,
    createdAt,
  };
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
