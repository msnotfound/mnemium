import type { Config } from "@shared/config";
import { DEFAULT_CONFIG } from "@shared/config";
import type { DocumentRepo, Embedder, LedgerRepo, MemoryModel, MemoryRepo } from "@shared/interfaces";
import type { Chunk, Document, Exchange, Memory, SurfacedChunk } from "@shared/types";
import type { Rpc, RpcEnvelope } from "@shared/rpc";
import { openOpfs } from "@core/storage/db";
import type { Database } from "@core/storage/db";
import { createDocumentRepo, createLedgerRepo, createMemoryRepo } from "@core/storage/repos";
import { createEmbedder } from "@core/embedder";
import { createVectorIndex } from "@core/vector-index";
import { createHybridRetriever } from "@core/retrieval";
import type { HybridRetriever } from "@core/retrieval";
import { serve } from "@/runtime/rpc";

interface RuntimeEngine {
  db: Database;
  embedder: Embedder;
  memories: MemoryRepo;
  ledger: LedgerRepo;
  retriever: HybridRetriever;
  capturePipeline?: CapturePipeline;
  bandit?: BanditController;
}

interface CapturePipeline {
  captureExchange(exchange: Exchange): Promise<void>;
}

interface BanditController {
  recordFeedback(memoryId: string, accepted: boolean, ctx: unknown): Promise<void>;
}

interface SettingsValue {
  config?: Partial<Config>;
}

let enginePromise: Promise<RuntimeEngine> | null = null;

serve(
  {
    "capture.exchange": async (msg) => handleCaptureExchange(msg),
    retrieve: async (msg) => handleRetrieve(msg),
    "inject.feedback": async (msg) => handleInjectFeedback(msg),
    "ledger.add": async (msg) => handleLedgerAdd(msg),
    "ui.list": async (msg) => handleUiList(msg),
    "ui.search": async (msg) => handleUiSearch(msg),
    "ui.delete": async (msg) => handleUiDelete(msg),
    "ui.export": async (msg, envelope) => handleUiExport(msg, envelope),
    "settings.get": async () => ({ config: await readConfig() }),
    "settings.update": async (msg) => handleSettingsUpdate(msg),
  },
  { target: "mnemium-offscreen" },
);

async function engine(): Promise<RuntimeEngine> {
  enginePromise ??= bootEngine();
  return enginePromise;
}

async function bootEngine(): Promise<RuntimeEngine> {
  const db = await openOpfs();
  const embedder = createEmbedder();
  const vectorIndex = createVectorIndex(db);
  const documentRepo = createDocumentRepo(db);
  const memories = createMemoryRepo(db);
  const ledger = createLedgerRepo(db);
  const retriever = createHybridRetriever(db, vectorIndex, embedder);
  const memoryModel = await loadMemoryModel();
  const capturePipeline = await loadCapturePipeline({
    documentRepo,
    memories,
    embedder,
    memoryModel,
  });
  const bandit = await loadBanditController(db);

  return {
    db,
    embedder,
    memories,
    ledger,
    retriever,
    capturePipeline,
    bandit,
  };
}

async function handleCaptureExchange(msg: Extract<Rpc, { t: "capture.exchange" }>): Promise<{ captured: true }> {
  const runtime = await engine();
  if (runtime.capturePipeline !== undefined) {
    await runtime.capturePipeline.captureExchange(msg.payload);
    return { captured: true };
  }

  await persistExchange(runtime.db, msg.payload);
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

  if (runtime.bandit === undefined) {
    return { recorded: false };
  }

  await runtime.bandit.recordFeedback(msg.memoryId, msg.accepted, msg.ctx);
  return { recorded: true };
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

async function handleSettingsUpdate(msg: Extract<Rpc, { t: "settings.update" }>): Promise<{ config: Config }> {
  const current = await readConfig();
  const next = mergeConfig(current, msg.patch);
  await chrome.storage.local.set({ config: next });
  return { config: next };
}

async function readConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get("config") as SettingsValue;
  return mergeConfig(DEFAULT_CONFIG, stored.config ?? {});
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

function mergeConfig(base: Config, patch: Partial<Config>): Config {
  return {
    ...base,
    ...patch,
    memoryModel: patch.memoryModel ?? base.memoryModel,
    embedder: { ...base.embedder, ...patch.embedder },
    autoInject: { ...base.autoInject, ...patch.autoInject },
    sites: { ...base.sites, ...patch.sites },
  };
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

async function loadMemoryModel(): Promise<MemoryModel | undefined> {
  // TODO(integration): wire "@/core/memory-model" once the distill module lands.
  const module = await optionalImport("@/core/memory-model");
  if (isRecord(module) && typeof module.createMemoryModel === "function") {
    const config = await readConfig();
    const createMemoryModel = module.createMemoryModel as (
      memoryModel: Config["memoryModel"],
    ) => Promise<unknown> | unknown;
    const model = await createMemoryModel(config.memoryModel);
    return isMemoryModel(model) ? model : undefined;
  }
  return undefined;
}

async function loadCapturePipeline(deps: {
  documentRepo: DocumentRepo;
  memories: MemoryRepo;
  embedder: Embedder;
  memoryModel?: MemoryModel;
}): Promise<CapturePipeline | undefined> {
  // TODO(integration): wire "@/core/capture" once the distill module lands.
  const module = await optionalImport("@/core/capture");
  if (isRecord(module) && typeof module.createCapturePipeline === "function") {
    const createCapturePipeline = module.createCapturePipeline as (
      dependencies: typeof deps,
    ) => Promise<unknown> | unknown;
    const pipeline = await createCapturePipeline(deps);
    return isCapturePipeline(pipeline) ? pipeline : undefined;
  }
  return undefined;
}

async function loadBanditController(db: Database): Promise<BanditController | undefined> {
  // TODO(integration): wire "@/core/autoinject/bandit" once the distill module lands.
  const module = await optionalImport("@/core/autoinject/bandit");
  if (isRecord(module) && typeof module.createBanditController === "function") {
    const createBanditController = module.createBanditController as (
      database: Database,
    ) => Promise<unknown> | unknown;
    const controller = await createBanditController(db);
    return isBanditController(controller) ? controller : undefined;
  }
  return undefined;
}

async function optionalImport(specifier: string): Promise<unknown> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<unknown>;
    return await dynamicImport(specifier);
  } catch {
    return undefined;
  }
}

function isMemoryModel(value: unknown): value is MemoryModel {
  return isRecord(value) && typeof value.id === "string" && typeof value.distill === "function";
}

function isCapturePipeline(value: unknown): value is CapturePipeline {
  return isRecord(value) && typeof value.captureExchange === "function";
}

function isBanditController(value: unknown): value is BanditController {
  return isRecord(value) && typeof value.recordFeedback === "function";
}

function stableId(prefix: string, ...parts: string[]): string {
  const source = parts.join("\u001f");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
