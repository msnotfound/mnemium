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

export interface DaemonStatusEnvelope {
  paired: boolean;
  reachable: boolean;
  status: {
    ok: boolean;
    service: string;
    version: string;
    backends: {
      distill: { kind: string; model?: string; ready: boolean };
      embed: { kind: string; model?: string; ready: boolean; dim?: number };
      vec: { kind: string; count?: number; ready?: boolean };
    };
    models: { available: string[]; downloading: string[] };
  } | null;
  error?: string;
}

export async function getDaemonStatus(): Promise<DaemonStatusEnvelope> {
  const result = await sendRpc<DaemonStatusEnvelope>({ t: "daemon.status" });
  return result ?? { paired: false, reachable: false, status: null };
}

/** Snapshot of one download job — matches mnemiumd's Snapshot exactly. */
export interface DaemonProgressEntry {
  name: string;
  url: string;
  total: number;
  downloaded: number;
  percent: number;
  status: "running" | "done" | "failed";
  error?: string;
  startedAt: number;
  finishedAt?: number;
  bytesPerSec?: number;
}

export interface DaemonModelDownloadResult {
  ok: boolean;
  entry?: DaemonProgressEntry;
  error?: string;
}

export async function startModelDownload(
  name: string,
  url: string,
  sha256?: string,
): Promise<DaemonModelDownloadResult> {
  const result = await sendRpc<DaemonModelDownloadResult>({
    t: "daemon.modelDownload",
    name,
    url,
    sha256,
  });
  return result ?? { ok: false, error: "no response" };
}

export interface DaemonProgressEnvelope {
  ok: boolean;
  downloads: DaemonProgressEntry[];
  error?: string;
}

export async function getModelProgress(): Promise<DaemonProgressEnvelope> {
  const result = await sendRpc<DaemonProgressEnvelope>({ t: "daemon.modelProgress" });
  return result ?? { ok: false, downloads: [] };
}

export async function deleteModel(name: string): Promise<{ ok: boolean; error?: string }> {
  const result = await sendRpc<{ ok: boolean; error?: string }>({ t: "daemon.modelDelete", name });
  return result ?? { ok: false, error: "no response" };
}

/** Parses a pairing string of the form `mn:<port>:<token>` (printed by
 *  `mnemiumd serve` on first boot). Returns null if the string isn't valid.
 *  Callers pass the result through `updateSettings({ daemon: { port, token } })`. */
export function parsePairingString(input: string): { port: number; token: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("mn:")) return null;
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  const port = Number.parseInt(parts[1] ?? "", 10);
  const token = parts.slice(2).join(":");
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  if (token.length === 0) return null;
  return { port, token };
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
