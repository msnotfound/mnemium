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

interface OpfsSahPoolUtil {
  removeVfs(): Promise<boolean>;
}

interface Sqlite3 {
  oo1: { DB: new (filename: string, mode?: string, vfs?: string) => WasmDatabaseLike };
  installOpfsSAHPoolVfs?(options?: {
    name?: string;
    directory?: string;
    initialCapacity?: number;
    clearOnInit?: boolean;
    forceReinitIfPreviouslyFailed?: boolean;
  }): Promise<OpfsSahPoolUtil>;
}

let dbInstance: WasmDatabaseLike | null = null;
let poolUtil: OpfsSahPoolUtil | null = null;
let opening: Promise<void> | null = null;

async function openDb(filename: string): Promise<void> {
  if (dbInstance !== null) return;
  if (opening !== null) return opening;

  opening = (async () => {
    const sqlite3 = (await (sqlite3InitModule as unknown as () => Promise<unknown>)()) as Sqlite3;
    if (typeof sqlite3.installOpfsSAHPoolVfs !== "function") {
      throw new Error("sqlite-wasm did not expose installOpfsSAHPoolVfs in Worker");
    }
    // Retry SAH Pool install up to 5 times. The pool grabs file handles via
    // FileSystemSyncAccessHandle; if a previous Worker for this origin
    // terminated very recently (e.g. engine.reload after pairing), the browser
    // can take a beat to release OPFS locks and install will fail with
    // NoModificationAllowedError. Without retry, one race kills the engine
    // until the user restarts the browser.
    let installed: OpfsSahPoolUtil | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        installed = await sqlite3.installOpfsSAHPoolVfs({
          name: "opfs-sahpool",
          initialCapacity: 8,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    if (installed === null) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    poolUtil = installed;
    dbInstance = new sqlite3.oo1.DB(filename, "ct", "opfs-sahpool");
    // Vector search lives in EdgeVec (browser-native HNSW + IndexedDB) — see
    // src/core/vector-index-edgevec.ts. The Node code path still uses
    // sqlite-vec via better-sqlite3 (tests rely on this).
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
        try {
          dbInstance.close();
        } catch (error) {
          console.warn("[mnemium/sqlite] db.close threw", error);
        }
        dbInstance = null;
        if (poolUtil !== null) {
          // removeVfs() releases the SAH Pool's FileSystemSyncAccessHandles.
          // Without this, the next Worker that tries installOpfsSAHPoolVfs
          // for this origin will fail with NoModificationAllowedError
          // (handles persist beyond the DB close, owned by the VFS itself).
          try {
            await poolUtil.removeVfs();
          } catch (error) {
            console.warn("[mnemium/sqlite] removeVfs threw", error);
          }
          poolUtil = null;
        }
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
