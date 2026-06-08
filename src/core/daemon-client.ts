// Typed HTTP client for the local mnemiumd helper binary.
// Protocol spec: docs/MNEMIUMD-PROTOCOL.md
//
// All RPCs go through this single client. The three engine adapters
// (DaemonMemoryModel, DaemonEmbedder, DaemonVectorIndex) sit on top of it.

import type { DraftMemory, Entity, Exchange, MemoryType } from "@shared/types";

export interface BackendSpec {
  kind: string;
  model?: string;
  endpoint?: string;
  apiKeyEnv?: string;
  path?: string;
  threads?: number;
  ctx?: number;
}

export interface DaemonStatus {
  ok: boolean;
  service: string;
  version: string;
  backends: {
    distill: { kind: string; model?: string; ready: boolean };
    embed: { kind: string; model?: string; ready: boolean; dim?: number };
    vec: { kind: string; count?: number; ready?: boolean };
  };
  models: {
    available: string[];
    downloading: string[];
  };
}

export interface DaemonConfigShape {
  listen?: string;
  distill: BackendSpec;
  embed: BackendSpec;
  vec: BackendSpec;
}

export interface ModelProgressEntry {
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

export interface DaemonCredentials {
  port: number;
  token: string;
}

export class DaemonUnavailableError extends Error {
  readonly code: string;
  constructor(message: string, code = "daemon_unavailable") {
    super(message);
    this.code = code;
    this.name = "DaemonUnavailableError";
  }
}

export class DaemonClient {
  constructor(private readonly creds: DaemonCredentials) {}

  static fromConfig(config: { daemon?: { port?: number; token?: string } }): DaemonClient | null {
    const port = config.daemon?.port;
    const token = config.daemon?.token;
    if (typeof port !== "number" || typeof token !== "string" || token.length === 0) {
      return null;
    }
    return new DaemonClient({ port, token });
  }

  async status(timeoutMs = 2000): Promise<DaemonStatus> {
    return this.request<DaemonStatus>("GET", "/status", undefined, timeoutMs);
  }

  async distill(exchange: Exchange): Promise<{ memories: DraftMemory[]; entities: Entity[] }> {
    // Daemon decodes the body directly into its Exchange struct — send it flat.
    return this.request("POST", "/distill", exchange, 30000);
  }

  async embed(texts: string[]): Promise<{ model: string; dim: number; vectors: number[][] }> {
    return this.request("POST", "/embed", { texts }, 10000);
  }

  async vecUpsert(
    modelId: string,
    rows: Array<{ id: string; scope: string; type: MemoryType; vec: number[] }>,
  ): Promise<{ upserted: number }> {
    return this.request("POST", "/vec/upsert", { modelId, rows }, 5000);
  }

  async vecSearch(
    modelId: string,
    query: number[],
    k: number,
    filter?: { scopePrefix?: string; type?: MemoryType[] },
  ): Promise<{ hits: Array<{ id: string; score: number }> }> {
    return this.request("POST", "/vec/search", { modelId, query, k, filter }, 5000);
  }

  async vecDrop(modelId: string): Promise<{ dropped: boolean }> {
    return this.request("POST", "/vec/drop", { modelId }, 5000);
  }

  async getConfig(): Promise<DaemonConfigShape> {
    return this.request("GET", "/config", undefined, 2000);
  }

  async putConfig(patch: Partial<DaemonConfigShape> & { backends?: Partial<{ distill: BackendSpec; embed: BackendSpec; vec: BackendSpec }> }): Promise<DaemonConfigShape> {
    return this.request("PUT", "/config", patch, 5000);
  }

  /** Kick off a download. Name is the basename written under daemon's
   *  models dir; url is the HTTPS source; sha256 is optional verification. */
  async modelDownload(name: string, url: string, sha256?: string): Promise<ModelProgressEntry> {
    return this.request("POST", "/model/download", { name, url, sha256 }, 5000);
  }

  async modelProgress(): Promise<{ downloads: ModelProgressEntry[] }> {
    return this.request("GET", "/model/progress", undefined, 2000);
  }

  async modelDelete(name: string): Promise<{ ok: boolean; name: string }> {
    return this.request("DELETE", `/model/${encodeURIComponent(name)}`, undefined, 5000);
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${this.creds.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.creds.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        // Extensions: do not include cookies / credentials from the page origin.
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
      });
      if (response.status === 503) {
        const detail = await safeJson(response);
        throw new DaemonUnavailableError(
          (isErrorEnvelope(detail) ? detail.error.message : `daemon backend unavailable`),
          "backend_unavailable",
        );
      }
      if (!response.ok) {
        const detail = await safeJson(response);
        throw new DaemonUnavailableError(
          isErrorEnvelope(detail) ? detail.error.message : `daemon HTTP ${response.status}`,
          isErrorEnvelope(detail) ? detail.error.code : `http_${response.status}`,
        );
      }
      // 204 No Content — modelDelete style. Return an empty object cast.
      if (response.status === 204) {
        return {} as T;
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof DaemonUnavailableError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new DaemonUnavailableError(`daemon timeout after ${timeoutMs}ms`, "timeout");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonUnavailableError(`daemon fetch failed: ${message}`, "fetch_failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const env = (value as { error?: unknown }).error;
  if (typeof env !== "object" || env === null) return false;
  const e = env as Record<string, unknown>;
  return typeof e.code === "string" && typeof e.message === "string";
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
