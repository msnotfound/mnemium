import type { Config } from "@shared/config";
import { DEFAULT_CONFIG } from "@shared/config";
import type { Embedder, LedgerRepo, MemoryModel, MemoryRepo, VectorIndex } from "@shared/interfaces";
import type { Chunk, Document, Exchange, Memory, SurfacedChunk } from "@shared/types";
import type { Rpc, RpcEnvelope, RpcResponse } from "@shared/rpc";
import { openOpfs } from "@core/storage/db";
import type { Database } from "@core/storage/db";
import { createDocumentRepo, createLedgerRepo, createMemoryRepo } from "@core/storage/repos";
import { createEmbedder } from "@core/embedder";
import { createVectorIndex } from "@core/vector-index";
import { createHybridRetriever } from "@core/retrieval";
import type { HybridRetriever } from "@core/retrieval";
import { createMemoryModel } from "@core/memory-model";
import { createCapturePipeline, type CapturePipeline } from "@core/capture";
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
  },
  { target: "mnemium-offscreen" },
);

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
  const embedder = createEmbedder();
  const vectorIndex = createVectorIndex(db);
  const documentRepo = createDocumentRepo(db);
  const memories = createMemoryRepo(db);
  const ledger = createLedgerRepo(db);
  const retriever = createHybridRetriever(db, vectorIndex, embedder);
  const memoryModel = createMemoryModel(config.memoryModel);
  const capturePipeline = createCapturePipeline({
    documents: documentRepo,
    memories,
    embedder,
    vectorIndex,
    memoryModel,
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
  envelope: RpcEnvelope,
): Promise<{ exported: false; reason: string; reqId: string }> {
  return {
    exported: false,
    reason: "sqlite export requires UI download wiring",
    reqId: envelope.reqId,
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
  try {
    return await runtime.retriever.hybridSearch(query, {
      scopePrefix,
      k,
    });
  } catch {
    const memories = await runtime.memories.search(query, { scopePrefix, k });
    return memories.map((memory) => ({
      memoryId: memory.id,
      content: memory.content,
      type: memory.type,
      sourceLabel: "Memory",
      score: memory.confidence,
    }));
  }
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
