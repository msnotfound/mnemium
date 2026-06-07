/// <reference lib="webworker" />

// sqlite-wasm + SAH Pool VFS + sqlite-vec all live in this dedicated Worker.
// The offscreen page can't use FileSystemSyncAccessHandle on its main thread,
// but a Worker can. The Worker exposes a simple request/response protocol so
// the offscreen Database proxy looks identical to the in-page wasm adapter.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

interface ExecOptions {
  sql: string;
  bind?: unknown;
  rowMode?: "object";
  returnValue?: "resultRows";
}

interface OpenRequest {
  id: string;
  t: "open";
  filename: string;
}

interface ExecRequest {
  id: string;
  t: "exec";
  payload: string | ExecOptions;
}

interface CloseRequest {
  id: string;
  t: "close";
}

type Request = OpenRequest | ExecRequest | CloseRequest;

interface OkResponse {
  id: string;
  ok: true;
  data?: unknown;
}

interface ErrResponse {
  id: string;
  ok: false;
  error: string;
}

type Response = OkResponse | ErrResponse;

interface WasmDatabaseLike {
  exec(sqlOrOptions: string | ExecOptions): unknown;
  close(): void;
}

interface Sqlite3 {
  oo1: { DB: new (filename: string, mode?: string, vfs?: string) => WasmDatabaseLike };
  installOpfsSAHPoolVfs?(options?: {
    name?: string;
    directory?: string;
    initialCapacity?: number;
    clearOnInit?: boolean;
    forceReinitIfPreviouslyFailed?: boolean;
  }): Promise<unknown>;
}

interface SqliteVecLoader {
  load(db: WasmDatabaseLike): void | Promise<void>;
}

let dbInstance: WasmDatabaseLike | null = null;
let opening: Promise<void> | null = null;

async function openDb(filename: string): Promise<void> {
  if (dbInstance !== null) return;
  if (opening !== null) return opening;

  opening = (async () => {
    const sqlite3 = (await (sqlite3InitModule as unknown as () => Promise<unknown>)()) as Sqlite3;
    if (typeof sqlite3.installOpfsSAHPoolVfs !== "function") {
      throw new Error("sqlite-wasm did not expose installOpfsSAHPoolVfs in Worker");
    }
    await sqlite3.installOpfsSAHPoolVfs({ name: "opfs-sahpool", initialCapacity: 8 });
    dbInstance = new sqlite3.oo1.DB(filename, "ct", "opfs-sahpool");
    // sqlite-vec ships a native-only loader (node + better-sqlite3). The browser
    // worker has no way to register the extension yet, so we tolerate the failure
    // and run in FTS5-only mode. Vector index callers must already handle a
    // missing vec0 (the retriever falls back to memories.search).
    try {
      const vecMod = (await import("sqlite-vec")) as unknown as Partial<SqliteVecLoader> & {
        default?: Partial<SqliteVecLoader>;
      };
      const loader: Partial<SqliteVecLoader> | undefined =
        vecMod.load !== undefined ? vecMod : vecMod.default;
      if (loader?.load === undefined) {
        throw new Error("sqlite-vec did not expose a load(db) function");
      }
      await loader.load(dbInstance);
      console.info("[mnemium/sqlite-worker] sqlite-vec loaded");
    } catch (error) {
      console.warn(
        "[mnemium/sqlite-worker] sqlite-vec unavailable, vector search disabled",
        error,
      );
    }
  })().finally(() => {
    opening = null;
  });

  return opening;
}

function post(message: Response): void {
  (self as unknown as { postMessage(msg: Response): void }).postMessage(message);
}

self.addEventListener("message", (event: MessageEvent<Request>) => {
  const req = event.data;
  void (async () => {
    try {
      if (req.t === "open") {
        await openDb(req.filename);
        post({ id: req.id, ok: true });
        return;
      }
      if (dbInstance === null) {
        throw new Error("worker received request before open()");
      }
      if (req.t === "exec") {
        const result = dbInstance.exec(req.payload);
        post({ id: req.id, ok: true, data: result });
        return;
      }
      if (req.t === "close") {
        dbInstance.close();
        dbInstance = null;
        post({ id: req.id, ok: true });
        return;
      }
    } catch (error) {
      post({
        id: req.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
