import type { Config } from "@shared/config";
import { DEFAULT_CONFIG } from "@shared/config";
import type { Embedder, LedgerRepo, MemoryModel, MemoryRepo, VectorIndex } from "@shared/interfaces";
import type { Chunk, Document, Exchange, Memory, SurfacedChunk } from "@shared/types";
import type { Rpc, RpcEnvelope, RpcResponse } from "@shared/rpc";
import { openOpfs } from "@core/storage/db";
import type { Database } from "@core/storage/db";
import { createDocumentRepo, createLedgerRepo, createMemoryRepo } from "@core/storage/repos";
import { createEdgeVecVectorIndex, createIndexedDbMapStore } from "@core/vector-index-edgevec";
import { createHybridRetriever } from "@core/retrieval";
import type { HybridRetriever } from "@core/retrieval";
import { createMemoryModel, DisabledMemoryModel } from "@core/memory-model";
import { createCapturePipeline, type CapturePipeline } from "@core/capture";
import { DaemonClient, type DaemonStatus, type ModelProgressEntry } from "@core/daemon-client";
import { DaemonMemoryModel } from "@core/memory-model-daemon";
import { DaemonEmbedder } from "@core/embedder-daemon";
import { DaemonVectorIndex } from "@core/vector-index-daemon";
import { serve } from "@/runtime/rpc";

interface RuntimeEngine {
  db: Database;
  embedder: Embedder;
  vectorIndex: VectorIndex;
  memories: MemoryRepo;
  ledger: LedgerRepo;
  retriever: HybridRetriever;
  memoryModel: MemoryModel;
  capturePipeline: CapturePipeline;
}

let enginePromise: Promise<RuntimeEngine> | null = null;

console.info("[mnemium/off] offscreen booted", new Date().toISOString());

// Engine rebuild on daemon/backends config change is handled by the service
// worker (which is the only place chrome.storage works in MV3). The SW
// listens to chrome.storage.onChanged and sends us an `engine.reload` RPC
// when config.daemon or config.backends changes. The handler for that RPC
// (registered below in serve(...)) sets enginePromise = null.
{
  const g = globalThis as {
    FileSystemHandle?: unknown;
    FileSystemDirectoryHandle?: unknown;
    FileSystemFileHandle?: { prototype?: { createSyncAccessHandle?: unknown } };
  };
  const probe = [
    `FileSystemHandle=${typeof g.FileSystemHandle}`,
    `FileSystemDirectoryHandle=${typeof g.FileSystemDirectoryHandle}`,
    `FileSystemFileHandle=${typeof g.FileSystemFileHandle}`,
    `createSyncAccessHandle=${typeof g.FileSystemFileHandle?.prototype?.createSyncAccessHandle}`,
    `storage.getDirectory=${typeof navigator?.storage?.getDirectory}`,
    `isSecureContext=${globalThis.isSecureContext}`,
    `crossOriginIsolated=${globalThis.crossOriginIsolated}`,
  ].join(" | ");
  console.info("[mnemium/off] OPFS probe", probe);
  // Probe what getDirectory actually returns, since presence alone is not enough.
  if (typeof navigator?.storage?.getDirectory === "function") {
    void navigator.storage
      .getDirectory()
      .then((root) => {
        console.info("[mnemium/off] OPFS getDirectory ok", root?.name ?? "(no name)");
      })
      .catch((error: unknown) => {
        console.error("[mnemium/off] OPFS getDirectory rejected", error);
      });
  }
}

// settings.get / settings.update are intercepted by the service worker (offscreen
// documents do not have access to chrome.storage). They never reach this handler map.
serve(
  {
    "capture.exchange": async (msg) => {
      console.info("[mnemium/off] capture.exchange", msg.payload.provider, msg.payload.threadId);
      return handleCaptureExchange(msg);
    },
    retrieve: async (msg) => {
      console.info("[mnemium/off] retrieve", msg.scope, "k=", msg.k);
      return handleRetrieve(msg);
    },
    "inject.feedback": async (msg) => handleInjectFeedback(msg),
    "ledger.add": async (msg) => handleLedgerAdd(msg),
    "ui.list": async (msg) => {
      console.info("[mnemium/off] ui.list", msg.scopePrefix ?? "*", "limit=", msg.limit);
      return handleUiList(msg);
    },
    "ui.search": async (msg) => handleUiSearch(msg),
    "ui.delete": async (msg) => handleUiDelete(msg),
    "ui.export": async (msg, envelope) => handleUiExport(msg, envelope),
    "daemon.status": async () => handleDaemonStatus(),
    "daemon.modelDownload": async (msg) => handleDaemonModelDownload(msg),
    "daemon.modelProgress": async () => handleDaemonModelProgress(),
    "daemon.modelDelete": async (msg) => handleDaemonModelDelete(msg),
    "daemon.runtimeEnsure": async () => handleRuntimeEnsure(),
    "daemon.installOllama": async () => handleInstallOllama(),
    "daemon.putConfig": async (msg) => handlePutDaemonConfig(msg),
    "engine.reload": async () => {
      console.info("[mnemium/off] engine.reload — invalidating");
      enginePromise = null;
      // Touch the engine so it boots fresh and any backend init errors
      // surface in the caller's response.
      try {
        await engine();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  { target: "mnemium-offscreen" },
);

async function freshDaemonClient(): Promise<DaemonClient | null> {
  const config = await readConfig();
  return DaemonClient.fromConfig(config);
}

async function handleDaemonStatus(): Promise<{ paired: boolean; reachable: boolean; status: DaemonStatus | null; error?: string }> {
  const client = await freshDaemonClient();
  if (client === null) {
    return { paired: false, reachable: false, status: null };
  }
  try {
    const status = await client.status();
    return { paired: true, reachable: true, status };
  } catch (error) {
    return {
      paired: true,
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleDaemonModelDownload(
  msg: Extract<Rpc, { t: "daemon.modelDownload" }>,
): Promise<{ ok: boolean; entry?: ModelProgressEntry; error?: string }> {
  const client = await freshDaemonClient();
  if (client === null) {
    return { ok: false, error: "daemon not paired" };
  }
  try {
    const entry = await client.modelDownload(msg.name, msg.url, msg.sha256);
    return { ok: true, entry };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleDaemonModelProgress(): Promise<{ ok: boolean; downloads: ModelProgressEntry[]; error?: string }> {
  const client = await freshDaemonClient();
  if (client === null) {
    return { ok: false, downloads: [], error: "daemon not paired" };
  }
  try {
    const result = await client.modelProgress();
    return { ok: true, downloads: result.downloads };
  } catch (error) {
    return { ok: false, downloads: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleDaemonModelDelete(
  msg: Extract<Rpc, { t: "daemon.modelDelete" }>,
): Promise<{ ok: boolean; error?: string }> {
  const client = await freshDaemonClient();
  if (client === null) {
    return { ok: false, error: "daemon not paired" };
  }
  try {
    await client.modelDelete(msg.name);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleRuntimeEnsure(): Promise<{ ok: boolean; started?: ModelProgressEntry[]; error?: string }> {
  const client = await freshDaemonClient();
  if (client === null) {
    return { ok: false, error: "daemon not paired" };
  }
  try {
    const result = await client.runtimeEnsure();
    return { ok: true, started: result.started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleInstallOllama(): Promise<{ ok: boolean; entry?: ModelProgressEntry; error?: string }> {
  const client = await freshDaemonClient();
  if (client === null) {
    return { ok: false, error: "daemon not paired" };
  }
  try {
    const entry = await client.runtimeInstallOllama();
    return { ok: true, entry };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handlePutDaemonConfig(
  msg: Extract<Rpc, { t: "daemon.putConfig" }>,
): Promise<{ ok: boolean; config?: unknown; error?: string }> {
  const client = await freshDaemonClient();
  if (client === null) {
    return { ok: false, error: "daemon not paired" };
  }
  try {
    const config = await client.putConfig(msg.patch as Parameters<typeof client.putConfig>[0]);
    return { ok: true, config };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Pre-warm the engine so OPFS + schema init happens once, visibly, instead of
// silently on first RPC. Errors here surface in DevTools immediately.
void engine().then(
  () => console.info("[mnemium/off] engine ready"),
  (error: unknown) => console.error("[mnemium/off] engine boot failed", error),
);

async function engine(): Promise<RuntimeEngine> {
  if (enginePromise === null) {
    enginePromise = bootEngine().catch((error: unknown) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

async function bootEngine(): Promise<RuntimeEngine> {
  const config = await readConfig();
  const db = await openOpfs();
  const documentRepo = createDocumentRepo(db);
  const memories = createMemoryRepo(db);
  const ledger = createLedgerRepo(db);

  const daemon = DaemonClient.fromConfig(config);
  const daemonStatus = daemon ? await daemon.status().catch((error: unknown) => {
    console.warn("[mnemium/off] daemon status probe failed", error);
    return null;
  }) : null;
  if (daemonStatus !== null) {
    console.info(
      "[mnemium/off] daemon paired:",
      daemonStatus.service,
      daemonStatus.version,
      JSON.stringify(daemonStatus.backends),
    );
  } else if (daemon !== null) {
    console.info("[mnemium/off] daemon configured but not reachable");
  } else {
    console.info("[mnemium/off] no daemon paired; capture-only mode");
  }

  const embedder = resolveEmbedder(config, daemon, daemonStatus);
  const vectorIndex = resolveVectorIndex(config, daemon);
  const memoryModel = resolveMemoryModel(config, daemon, daemonStatus);

  const retriever = createHybridRetriever(db, vectorIndex, embedder);
  const useEmbedder = embedder.dim > 0;

  const capturePipeline = createCapturePipeline({
    documents: documentRepo,
    memories,
    embedder,
    vectorIndex,
    memoryModel,
    useEmbedder,
    onError: (error) => {
      console.error("[mnemium] capture pipeline error", error);
    },
  });

  return {
    db,
    embedder,
    vectorIndex,
    memories,
    ledger,
    retriever,
    memoryModel,
    capturePipeline,
  };
}

function resolveMemoryModel(
  config: Config,
  daemon: DaemonClient | null,
  status: DaemonStatus | null,
): MemoryModel {
  const distill = config.backends.distill;
  if (distill.kind === "daemon" && daemon !== null && status?.backends.distill.ready === true) {
    return new DaemonMemoryModel(daemon, status.backends.distill.model ?? "daemon");
  }
  // ollama / apiKey / disabled (and daemon-unavailable) handled by createMemoryModel.
  return createMemoryModel(distill);
}

function resolveEmbedder(
  config: Config,
  daemon: DaemonClient | null,
  status: DaemonStatus | null,
): Embedder {
  const embed = config.backends.embed;
  if (
    embed.kind === "daemon" &&
    daemon !== null &&
    status?.backends.embed.ready === true &&
    typeof status.backends.embed.dim === "number"
  ) {
    return new DaemonEmbedder(
      daemon,
      status.backends.embed.model ?? "daemon",
      status.backends.embed.dim,
    );
  }
  // ollama / apiKey embedders are TODO; for now fall back to disabled.
  return disabledEmbedder;
}

function resolveVectorIndex(config: Config, daemon: DaemonClient | null): VectorIndex {
  const vec = config.backends.vec;
  if (vec.kind === "daemon" && daemon !== null) {
    return new DaemonVectorIndex(daemon);
  }
  if (vec.kind === "edgevec") {
    return createEdgeVecVectorIndex(createIndexedDbMapStore());
  }
  return disabledVectorIndex;
}

const disabledEmbedder: Embedder = {
  id: "disabled",
  dim: 0,
  async embed() {
    return [];
  },
};

const disabledVectorIndex: VectorIndex = {
  async upsert() {
    /* no-op */
  },
  async search() {
    return [];
  },
  async drop() {
    /* no-op */
  },
};

void DisabledMemoryModel; // referenced symbol kept reachable for future direct use

async function handleCaptureExchange(msg: Extract<Rpc, { t: "capture.exchange" }>): Promise<{ captured: true }> {
  const runtime = await engine();
  try {
    await runtime.capturePipeline.captureExchange(msg.payload);
  } catch (error) {
    console.error("[mnemium] capture failed; persisting raw exchange", error);
    await persistExchange(runtime.db, msg.payload);
  }
  return { captured: true };
}

async function handleRetrieve(msg: Extract<Rpc, { t: "retrieve" }>): Promise<{ chunks: SurfacedChunk[] }> {
  const runtime = await engine();
  const query = msg.draft.trim();
  if (query.length === 0 || msg.k <= 0) {
    return { chunks: [] };
  }

  const chunks = await retrieveChunks(runtime, query, msg.scope, msg.k);
  return { chunks };
}

async function handleInjectFeedback(
  msg: Extract<Rpc, { t: "inject.feedback" }>,
): Promise<{ recorded: boolean }> {
  const runtime = await engine();
  if (msg.accepted) {
    await runtime.memories.bumpReuse(msg.memoryId);
  }
  // TODO(autoinject): wire bandit feedback once core/autoinject/bandit exposes a
  // controller compatible with the inject.feedback contract.
  return { recorded: msg.accepted };
}

async function handleLedgerAdd(msg: Extract<Rpc, { t: "ledger.add" }>): Promise<{ added: true }> {
  const runtime = await engine();
  await runtime.ledger.add(msg.entry);
  return { added: true };
}

async function handleUiList(msg: Extract<Rpc, { t: "ui.list" }>): Promise<{ memories: Memory[] }> {
  const runtime = await engine();
  const memories = await runtime.memories.byScope(msg.scopePrefix ?? "", { limit: msg.limit ?? 50 });
  return { memories };
}

async function handleUiSearch(msg: Extract<Rpc, { t: "ui.search" }>): Promise<{ memories: Memory[] }> {
  const runtime = await engine();
  const memories = await runtime.memories.search(msg.query, { k: 50 });
  return { memories };
}

async function handleUiDelete(msg: Extract<Rpc, { t: "ui.delete" }>): Promise<{ deleted: true }> {
  const runtime = await engine();
  await runtime.memories.delete(msg.memoryId);
  return { deleted: true };
}

async function handleUiExport(
  _msg: Extract<Rpc, { t: "ui.export" }>,
  _envelope: RpcEnvelope,
): Promise<{ filename: string; content: string }> {
  const runtime = await engine();
  const [memories, documents, chunks] = await Promise.all([
    runtime.memories.byScope("", { limit: 100000 }),
    runtime.db
      .prepare(
        `SELECT id, source_type, provider, uri, title, scope_uri, captured_at, raw_content
         FROM document ORDER BY captured_at DESC`,
      )
      .all<Record<string, unknown>>(),
    runtime.db
      .prepare(
        `SELECT id, document_id, ord, text
         FROM chunk ORDER BY document_id, ord`,
      )
      .all<Record<string, unknown>>(),
  ]);
  const payload = {
    exportedAt: new Date().toISOString(),
    schema: "mnemium.v0.1",
    counts: {
      memories: memories.length,
      documents: documents.length,
      chunks: chunks.length,
    },
    memories,
    documents,
    chunks,
  };
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    filename: `mnemium-export-${timestamp}.json`,
    content: JSON.stringify(payload, null, 2),
  };
}

async function readConfig(): Promise<Config> {
  // Offscreen documents do not have chrome.storage; ask the service worker.
  const reqId = crypto.randomUUID();
  try {
    const response = (await chrome.runtime.sendMessage({
      reqId,
      msg: { t: "settings.get" } satisfies Rpc,
    })) as RpcResponse | undefined;
    if (response !== undefined && response.ok) {
      const data = response.data as { config?: Partial<Config> } | undefined;
      if (data?.config !== undefined) {
        return { ...DEFAULT_CONFIG, ...data.config } as Config;
      }
    } else if (response !== undefined) {
      console.warn("[mnemium/off] settings.get from SW failed", response.error);
    }
  } catch (error) {
    console.warn("[mnemium/off] settings.get RPC threw, falling back to defaults", error);
  }
  return DEFAULT_CONFIG;
}

async function retrieveChunks(
  runtime: RuntimeEngine,
  query: string,
  scopePrefix: string,
  k: number,
): Promise<SurfacedChunk[]> {
  // Hybrid path when both embedder and vector index are real (daemon paired).
  // Falls through to FTS5 on any failure so the loop stays usable.
  if (runtime.embedder.dim > 0) {
    try {
      const hits = await runtime.retriever.hybridSearch(query, { scopePrefix, k });
      if (hits.length > 0) return hits;
    } catch (error) {
      console.warn("[mnemium/off] hybrid search failed; falling back to FTS", error);
    }
  }
  const memories = await runtime.memories.search(query, { scopePrefix, k });
  return memories.map((memory) => ({
    memoryId: memory.id,
    content: memory.content,
    type: memory.type,
    sourceLabel: sourceLabelFor(memory.scopeUri, memory.createdAt),
    score: memory.confidence,
  }));
}

function sourceLabelFor(scopeUri: string, createdAt: number): string {
  const provider = scopeUri.split("::")[1] ?? "local";
  const capitalized = `${provider[0]?.toUpperCase() ?? "L"}${provider.slice(1)}`;
  const days = Math.max(0, Math.round((Date.now() - createdAt) / 86400000));
  const age = days === 0 ? "today" : days === 1 ? "1d" : days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
  return `${capitalized} · ${age}`;
}

async function persistExchange(runtime: Database, exchange: Exchange): Promise<void> {
  const documentRepo = createDocumentRepo(runtime);
  const documentId = stableId("doc", exchange.provider, exchange.threadId, exchange.messageId);
  const chunkId = stableId("chunk", exchange.provider, exchange.threadId, exchange.messageId);
  const rawContent = [`User: ${exchange.userText}`, `Assistant: ${exchange.assistantText}`].join("\n\n");
  const document: Document = {
    id: documentId,
    sourceType: "chat_turn",
    provider: exchange.provider,
    scopeUri: scopeUri(exchange),
    capturedAt: exchange.ts,
    rawContent,
  };
  const chunk: Chunk = {
    id: chunkId,
    documentId,
    ord: 0,
    text: rawContent,
  };

  await documentRepo.insert(document);
  await documentRepo.insertChunks([chunk]);
}

function stableId(prefix: string, ...parts: string[]): string {
  const source = parts.join("");
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function scopeUri(exchange: Exchange): string {
  return `personal::${exchange.provider}::${exchange.threadId}`;
}
