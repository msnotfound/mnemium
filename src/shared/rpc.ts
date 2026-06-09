// Mnemium RPC contract — FROZEN. content-script ↔ service-worker(orchestrator) ↔ offscreen.
// The SW ensures the offscreen doc exists (mutex), then routes these messages.

import type { Exchange, SurfacedChunk, BanditFeatures, LedgerEntry, Memory } from "./types";
import type { Config } from "./config";

export type Rpc =
  // capture → engine (persist + maybe distill)
  | { t: "capture.exchange"; payload: Exchange }
  // retrieval (content → engine → content)
  | { t: "retrieve"; draft: string; scope: string; k: number }
  | { t: "retrieve.result"; reqId: string; chunks: SurfacedChunk[] }
  // ✓/✖ per-chunk feedback → bandit
  | { t: "inject.feedback"; memoryId: string; accepted: boolean; ctx: BanditFeatures }
  // ledger
  | { t: "ledger.add"; entry: LedgerEntry }
  // popup / sidepanel trust UI
  | { t: "ui.list"; scopePrefix?: string; limit?: number }
  | { t: "ui.list.result"; reqId: string; memories: Memory[] }
  | { t: "ui.search"; query: string }
  | { t: "ui.delete"; memoryId: string }
  | { t: "ui.export" } // → triggers .sqlite download
  // settings
  | { t: "settings.get" }
  | { t: "settings.result"; reqId: string; config: Config }
  | { t: "settings.update"; patch: Partial<Config> }
  // daemon (mnemiumd helper) — uses the running config's daemon.{port,token}.
  // Each call constructs a fresh DaemonClient so user pairing takes effect
  // without an engine restart. See docs/MNEMIUMD-PROTOCOL.md.
  | { t: "daemon.status" }
  | { t: "daemon.modelDownload"; name: string; url: string; sha256?: string }
  | { t: "daemon.modelProgress" }
  | { t: "daemon.modelDelete"; name: string }
  | { t: "daemon.runtimeEnsure" }
  | { t: "daemon.installOllama" }
  | { t: "daemon.putConfig"; patch: unknown };

/** Envelope every message is wrapped in for request/response correlation. */
export interface RpcEnvelope {
  reqId: string;
  msg: Rpc;
}

export type RpcResponse = { reqId: string; ok: true; data?: unknown } | { reqId: string; ok: false; error: string };
