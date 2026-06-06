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

interface WasmExecOptions {
  sql: string;
  bind?: WasmBindValue;
  returnValue?: "resultRows";
  rowMode?: "object";
}

interface WasmDatabase {
  exec(sqlOrOptions: string | WasmExecOptions): unknown;
  close(): void;
}

interface WasmFactoryResult {
  oo1: {
    DB: new (filename: string, mode?: string, vfs?: string) => WasmDatabase;
  };
}

const SCHEMA_VERSION = 1;
const schemaUrl = new URL("./schema.sql", import.meta.url);

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
  const sqlite3 = await importWasmSqlite();
  const db = new sqlite3.oo1.DB(filename, "ct", "opfs-sahpool");
  await tryLoadWasmSqliteVec(db);
  const wrapped = new WasmDatabaseAdapter(db);
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
    await db.exec(schemaSql);
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
  const mod = require("sqlite-vec") as Partial<SqliteVecLoader> | { default?: Partial<SqliteVecLoader> };
  const loader = "load" in mod ? mod : mod.default;
  if (loader?.load === undefined) {
    throw new Error("sqlite-vec did not expose a load(db) function");
  }
  loader.load(db);
}

async function tryLoadWasmSqliteVec(db: WasmDatabase): Promise<void> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  const mod = (await dynamicImport("sqlite-vec")) as Partial<{
    load(db: WasmDatabase): void | Promise<void>;
    default: Partial<{ load(db: WasmDatabase): void | Promise<void> }>;
  }>;
  const loader = mod.load === undefined ? mod.default : mod;
  if (loader?.load === undefined) {
    throw new Error("sqlite-vec did not expose a wasm load(db) function");
  }
  await loader.load(db);
}

async function nodeRequire(): Promise<(specifier: string) => unknown> {
  const module = await nodeImport<{ createRequire(url: string): (specifier: string) => unknown }>("node:module");
  return module.createRequire(import.meta.url);
}

async function nodeImport<T>(specifier: string): Promise<T> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  return (await dynamicImport(specifier)) as T;
}

async function importWasmSqlite(): Promise<WasmFactoryResult> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  const mod = await dynamicImport("@sqlite.org/sqlite-wasm");
  const candidate = mod as { default?: unknown; sqlite3InitModule?: unknown };
  const initializer = candidate.default ?? candidate.sqlite3InitModule;
  if (typeof initializer !== "function") {
    throw new Error("@sqlite.org/sqlite-wasm did not expose an initializer");
  }
  return (await (initializer as () => Promise<unknown>)()) as WasmFactoryResult;
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

class WasmDatabaseAdapter implements Database {
  constructor(private readonly db: WasmDatabase) {}

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (params?: SqlParams) => {
        this.db.exec({ sql, bind: normalizeWasmParams(params) });
        return { changes: 0 };
      },
      get: async <T extends SqlRow = SqlRow>(params?: SqlParams) => {
        const rows = this.db.exec({
          sql,
          bind: normalizeWasmParams(params),
          rowMode: "object",
          returnValue: "resultRows",
        }) as T[];
        return rows[0];
      },
      all: async <T extends SqlRow = SqlRow>(params?: SqlParams) =>
        this.db.exec({
          sql,
          bind: normalizeWasmParams(params),
          rowMode: "object",
          returnValue: "resultRows",
        }) as T[],
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
    this.db.close();
  }
}

function normalizeWasmParams(params: SqlParams | undefined): WasmBindValue | undefined {
  if (params === undefined) {
    return undefined;
  }
  return Array.isArray(params) ? params : Object.values(params);
}
