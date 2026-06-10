export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlParams = readonly SqlValue[] | Record<string, SqlValue>;
export type SqlRow = Record<string, unknown>;

export interface SqlStatement {
  run(params?: SqlParams): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  get<T extends SqlRow = SqlRow>(params?: SqlParams): Promise<T | undefined>;
  all<T extends SqlRow = SqlRow>(params?: SqlParams): Promise<T[]>;
}

export interface Database {
  exec(sql: string): Promise<void>;
  prepare(sql: string): SqlStatement;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface BetterSqliteStatement {
  run(): { changes: number; lastInsertRowid: number | bigint };
  run(params?: SqlParams): { changes: number; lastInsertRowid: number | bigint };
  get(): SqlRow | undefined;
  get(params?: SqlParams): SqlRow | undefined;
  all(): SqlRow[];
  all(params?: SqlParams): SqlRow[];
}

interface BetterSqliteDatabase {
  exec(sql: string): void;
  pragma<T = unknown>(source: string, options?: { simple?: boolean }): T;
  prepare(sql: string): BetterSqliteStatement;
  close(): void;
}

interface BetterSqliteConstructor {
  new (path?: string): BetterSqliteDatabase;
}

interface SqliteVecLoader {
  load(db: BetterSqliteDatabase): void;
}

type WasmBindValue = SqlValue | readonly SqlValue[];

const SCHEMA_VERSION = 2;
const schemaUrl = new URL("./schema.sql", import.meta.url);

/** v1 → v2: trust fields on memory + the validator audit table.
 *  ALTER TABLE ADD COLUMN is instant in SQLite (no table rewrite); existing
 *  rows get claim_status='active' via the column default, which is the
 *  correct grandfathering — pre-trust-loop memories stay retrievable. */
const MIGRATE_V1_TO_V2 = `
ALTER TABLE memory ADD COLUMN evidence TEXT;
ALTER TABLE memory ADD COLUMN speaker TEXT;
ALTER TABLE memory ADD COLUMN support_kind TEXT;
ALTER TABLE memory ADD COLUMN claim_status TEXT NOT NULL DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_memory_claim ON memory(claim_status);
CREATE TABLE IF NOT EXISTS memory_rejection (
  id           TEXT PRIMARY KEY,
  scope_uri    TEXT NOT NULL,
  provider     TEXT,
  thread_id    TEXT,
  message_id   TEXT,
  type         TEXT,
  content      TEXT NOT NULL,
  evidence     TEXT,
  speaker      TEXT,
  support_kind TEXT,
  reason       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rejection_scope ON memory_rejection(scope_uri, created_at);
`;

export async function openNode(path = ":memory:"): Promise<Database> {
  const require = await nodeRequire();
  const mod = require("better-sqlite3") as BetterSqliteConstructor | { default: BetterSqliteConstructor };
  const BetterSqlite = typeof mod === "function" ? mod : mod.default;
  const db = new BetterSqlite(path);
  await tryLoadSqliteVec(db);
  const wrapped = new BetterSqliteDatabaseAdapter(db);
  await initialize(wrapped, await readSchemaForNode());
  return wrapped;
}

export async function openOpfs(filename = "mnemium.sqlite3"): Promise<Database> {
  // sqlite-wasm + sqlite-vec run inside a dedicated Worker because the offscreen
  // main thread lacks FileSystemSyncAccessHandle (Worker-only on this Chromium).
  const worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url), { type: "module" });
  const wrapped = new WorkerDatabaseAdapter(worker);
  await wrapped.open(filename);
  await initialize(wrapped, await readSchemaForBrowser());
  return wrapped;
}

export async function initialize(db: Database, schemaSql: string): Promise<void> {
  await db.exec("PRAGMA foreign_keys = ON");
  const version = await userVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(`Database schema version ${version} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (version < 1) {
    // Fresh database — schema.sql is always the CURRENT shape (v2 columns
    // included), so no incremental migrations run after it.
    await db.exec(schemaSql);
  } else if (version < 2) {
    await db.exec(MIGRATE_V1_TO_V2);
  }
  await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

async function userVersion(db: Database): Promise<number> {
  const row = await db.prepare("PRAGMA user_version").get<{ user_version: number }>();
  return row?.user_version ?? 0;
}

async function readSchemaForNode(): Promise<string> {
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    nodeImport<{ readFile(path: string, encoding: "utf8"): Promise<string> }>("node:fs/promises"),
    nodeImport<{ fileURLToPath(url: URL): string }>("node:url"),
  ]);
  return readFile(fileURLToPath(schemaUrl), "utf8");
}

async function readSchemaForBrowser(): Promise<string> {
  const response = await fetch(schemaUrl.href);
  if (!response.ok) {
    throw new Error(`Unable to load schema.sql: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function tryLoadSqliteVec(db: BetterSqliteDatabase): Promise<void> {
  const require = await nodeRequire();
  const mod = require("sqlite-vec") as Partial<SqliteVecLoader> & { default?: Partial<SqliteVecLoader> };
  const loader = mod.load !== undefined ? mod : mod.default;
  if (loader?.load === undefined) {
    throw new Error("sqlite-vec did not expose a load(db) function");
  }
  loader.load(db);
}

async function nodeRequire(): Promise<(specifier: string) => unknown> {
  const module = await nodeImport<{ createRequire(url: string): (specifier: string) => unknown }>("node:module");
  return module.createRequire(import.meta.url);
}

async function nodeImport<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}

class BetterSqliteDatabaseAdapter implements Database {
  constructor(private readonly db: BetterSqliteDatabase) {}

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: async (params?: SqlParams) => (params === undefined ? stmt.run() : stmt.run(params)),
      get: async <T extends SqlRow = SqlRow>(params?: SqlParams) =>
        (params === undefined ? stmt.get() : stmt.get(params)) as T | undefined,
      all: async <T extends SqlRow = SqlRow>(params?: SqlParams) =>
        (params === undefined ? stmt.all() : stmt.all(params)) as T[],
    };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error; rollback can fail if SQLite auto-closed the transaction.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

interface WorkerResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface WorkerExecOptions {
  sql: string;
  bind?: WasmBindValue;
  rowMode?: "object";
  returnValue?: "resultRows";
}

type WorkerRequestPayload =
  | { t: "open"; filename: string }
  | { t: "exec"; payload: string | WorkerExecOptions }
  | { t: "close" };

class WorkerDatabaseAdapter implements Database {
  private nextId = 0;
  private readonly pending = new Map<
    string,
    { resolve(data: unknown): void; reject(err: Error): void }
  >();
  private terminated = false;

  constructor(private readonly worker: Worker) {
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const handler = this.pending.get(event.data.id);
      if (handler === undefined) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) {
        handler.resolve(event.data.data);
      } else {
        handler.reject(new Error(event.data.error ?? "sqlite worker error"));
      }
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      const message = event.message || "sqlite worker crashed";
      for (const handler of this.pending.values()) {
        handler.reject(new Error(message));
      }
      this.pending.clear();
    });
  }

  private send(request: WorkerRequestPayload): Promise<unknown> {
    if (this.terminated) {
      return Promise.reject(new Error("sqlite worker terminated"));
    }
    const id = `r${this.nextId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.worker.postMessage({ id, ...request });
    return promise;
  }

  async open(filename: string): Promise<void> {
    await this.send({ t: "open", filename });
  }

  async exec(sql: string): Promise<void> {
    await this.send({ t: "exec", payload: sql });
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (params?: SqlParams) => {
        await this.send({ t: "exec", payload: { sql, bind: normalizeWasmParams(params) } });
        return { changes: 0 };
      },
      get: async <T extends SqlRow = SqlRow>(params?: SqlParams) => {
        const rows = (await this.send({
          t: "exec",
          payload: {
            sql,
            bind: normalizeWasmParams(params),
            rowMode: "object",
            returnValue: "resultRows",
          },
        })) as SqlRow[];
        return rows[0] as T | undefined;
      },
      all: async <T extends SqlRow = SqlRow>(params?: SqlParams) =>
        (await this.send({
          t: "exec",
          payload: {
            sql,
            bind: normalizeWasmParams(params),
            rowMode: "object",
            returnValue: "resultRows",
          },
        })) as T[],
    };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      await this.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.exec("ROLLBACK");
      } catch {
        // Preserve the original error; rollback can fail if SQLite auto-closed the transaction.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.send({ t: "close" });
    } finally {
      this.terminated = true;
      this.worker.terminate();
    }
  }
}

function normalizeWasmParams(params: SqlParams | undefined): WasmBindValue | undefined {
  if (params === undefined) {
    return undefined;
  }
  return Array.isArray(params) ? params : Object.values(params);
}
