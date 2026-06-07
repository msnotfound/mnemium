import type { Database, SqlParams, SqlRow } from "./db";
import type {
  Chunk,
  Document,
  LedgerEntry,
  Memory,
  MemorySource,
  MemoryType,
} from "@shared/types";
import type { DocumentRepo, LedgerRepo, MemoryRepo } from "@shared/interfaces";

export function createDocumentRepo(db: Database): DocumentRepo {
  return new SqlDocumentRepo(db);
}

export function createMemoryRepo(db: Database): MemoryRepo {
  return new SqlMemoryRepo(db);
}

export function createLedgerRepo(db: Database): LedgerRepo {
  return new SqlLedgerRepo(db);
}

class SqlDocumentRepo implements DocumentRepo {
  constructor(private readonly db: Database) {}

  async insert(doc: Document): Promise<void> {
    await this.db.prepare(
      `INSERT INTO document (
        id, source_type, provider, uri, title, scope_uri, captured_at, raw_content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_type = excluded.source_type,
        provider = excluded.provider,
        uri = excluded.uri,
        title = excluded.title,
        scope_uri = excluded.scope_uri,
        captured_at = excluded.captured_at,
        raw_content = excluded.raw_content`,
    ).run([
      doc.id,
      doc.sourceType,
      doc.provider ?? null,
      doc.uri ?? null,
      doc.title ?? null,
      doc.scopeUri,
      doc.capturedAt,
      doc.rawContent,
    ]);
  }

  async insertChunks(chunks: Chunk[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO chunk (id, document_id, ord, text)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         document_id = excluded.document_id,
         ord = excluded.ord,
         text = excluded.text`,
    );
    await this.db.transaction(async () => {
      for (const chunk of chunks) {
        await stmt.run([chunk.id, chunk.documentId, chunk.ord, chunk.text]);
      }
    });
  }
}

class SqlMemoryRepo implements MemoryRepo {
  constructor(private readonly db: Database) {}

  async upsert(m: Memory): Promise<void> {
    await this.insertMemory(m);
  }

  async linkSource(link: MemorySource): Promise<void> {
    await this.db.prepare(
      `INSERT INTO memory_source (memory_id, chunk_id, document_id, relevance)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id, chunk_id) DO UPDATE SET
         document_id = excluded.document_id,
         relevance = excluded.relevance`,
    ).run([link.memoryId, link.chunkId, link.documentId, link.relevance]);

    await this.db.prepare(
      `UPDATE memory
       SET source_count = (
         SELECT COUNT(*) FROM memory_source WHERE memory_id = ?
       )
       WHERE id = ?`,
    ).run([link.memoryId, link.memoryId]);
  }

  async supersede(oldId: string, next: Memory): Promise<void> {
    await this.db.transaction(async () => {
      const old = await this.byId(oldId);
      if (old === undefined) {
        throw new Error(`Cannot supersede missing memory ${oldId}`);
      }
      const replacement: Memory = {
        ...next,
        version: old.version + 1,
        isLatest: true,
        parentMemoryId: old.id,
        rootMemoryId: old.rootMemoryId ?? old.id,
      };
      await this.db.prepare("UPDATE memory SET is_latest = 0 WHERE id = ?").run([oldId]);
      await this.insertMemory(replacement);
    });
  }

  async byScope(scopePrefix: string, opts?: { type?: MemoryType[]; limit?: number }): Promise<Memory[]> {
    const where = ["scope_uri LIKE ?", "is_latest = 1", "is_forgotten = 0"];
    const bind: Array<string | number> = [`${scopePrefix}%`];
    appendTypeFilter(where, bind, opts?.type);
    const limit = opts?.limit ?? 50;
    bind.push(limit);
    const rows = await this.db.prepare(
      `SELECT * FROM memory
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all<MemoryRow>(bind);
    return rows.map(rowToMemory);
  }

  async search(
    query: string,
    opts: { scopePrefix?: string; type?: MemoryType[]; k: number },
  ): Promise<Memory[]> {
    const ftsQuery = toFtsPrefixQuery(query);
    if (ftsQuery.length === 0) {
      return [];
    }
    const where = ["memory.is_latest = 1", "memory.is_forgotten = 0", "fts_memory MATCH ?"];
    const bind: Array<string | number> = [ftsQuery];
    if (opts.scopePrefix !== undefined) {
      where.push("memory.scope_uri LIKE ?");
      bind.push(`${opts.scopePrefix}%`);
    }
    appendTypeFilter(where, bind, opts.type, "memory.type");
    bind.push(opts.k);
    const rows = await this.db.prepare(
      `SELECT memory.*
       FROM fts_memory
       JOIN memory ON memory.rowid = fts_memory.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(fts_memory)
       LIMIT ?`,
    ).all<MemoryRow>(bind);
    return rows.map(rowToMemory);
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM memory WHERE id = ?").run([id]);
  }

  async sweepExpired(now: number): Promise<number> {
    const result = await this.db.prepare(
      `UPDATE memory
       SET is_forgotten = 1, is_latest = 0
       WHERE forget_after IS NOT NULL
         AND forget_after <= ?
         AND is_forgotten = 0`,
    ).run([now]);
    return result.changes;
  }

  async bumpReuse(id: string): Promise<void> {
    await this.db.prepare("UPDATE memory SET reuse_count = reuse_count + 1 WHERE id = ?").run([id]);
  }

  private async insertMemory(m: Memory): Promise<void> {
    await this.db.prepare(
      `INSERT INTO memory (
        id, type, content, scope_uri, version, is_latest, parent_memory_id, root_memory_id,
        is_static, is_inference, confidence, event_date, document_date, valid_from,
        valid_to, forget_after, forget_reason, is_forgotten, reuse_count, source_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        content = excluded.content,
        scope_uri = excluded.scope_uri,
        version = excluded.version,
        is_latest = excluded.is_latest,
        parent_memory_id = excluded.parent_memory_id,
        root_memory_id = excluded.root_memory_id,
        is_static = excluded.is_static,
        is_inference = excluded.is_inference,
        confidence = excluded.confidence,
        event_date = excluded.event_date,
        document_date = excluded.document_date,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        forget_after = excluded.forget_after,
        forget_reason = excluded.forget_reason,
        is_forgotten = excluded.is_forgotten,
        reuse_count = excluded.reuse_count,
        source_count = excluded.source_count,
        created_at = excluded.created_at`,
    ).run(memoryParams(m));
  }

  private async byId(id: string): Promise<Memory | undefined> {
    const row = await this.db.prepare("SELECT * FROM memory WHERE id = ?").get<MemoryRow>([id]);
    return row === undefined ? undefined : rowToMemory(row);
  }
}

class SqlLedgerRepo implements LedgerRepo {
  constructor(private readonly db: Database) {}

  async add(entry: LedgerEntry): Promise<void> {
    await this.db.prepare(
      `INSERT INTO ledger (id, memory_id, scope_uri, thread_id, message_id, injected_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         memory_id = excluded.memory_id,
         scope_uri = excluded.scope_uri,
         thread_id = excluded.thread_id,
         message_id = excluded.message_id,
         injected_at = excluded.injected_at`,
    ).run([
      entry.id,
      entry.memoryId,
      entry.scopeUri,
      entry.threadId,
      entry.messageId,
      entry.injectedAt,
    ]);
  }

  async byThread(threadId: string): Promise<LedgerEntry[]> {
    const rows = await this.db.prepare(
      `SELECT * FROM ledger
       WHERE thread_id = ?
       ORDER BY injected_at ASC`,
    ).all<LedgerRow>([threadId]);
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      scopeUri: row.scope_uri,
      threadId: row.thread_id,
      messageId: row.message_id,
      injectedAt: row.injected_at,
    }));
  }
}

type SqlValue = string | number | null;

interface MemoryRow extends SqlRow {
  id: string;
  type: MemoryType;
  content: string;
  scope_uri: string;
  version: number;
  is_latest: number;
  parent_memory_id: string | null;
  root_memory_id: string | null;
  is_static: number;
  is_inference: number;
  confidence: number;
  event_date: number | null;
  document_date: number | null;
  valid_from: number | null;
  valid_to: number | null;
  forget_after: number | null;
  forget_reason: string | null;
  is_forgotten: number;
  reuse_count: number;
  source_count: number;
  created_at: number;
}

interface LedgerRow extends SqlRow {
  id: string;
  memory_id: string;
  scope_uri: string;
  thread_id: string;
  message_id: string;
  injected_at: number;
}

function memoryParams(m: Memory): SqlParams {
  return [
    m.id,
    m.type,
    m.content,
    m.scopeUri,
    m.version,
    boolToInt(m.isLatest),
    m.parentMemoryId ?? null,
    m.rootMemoryId ?? null,
    boolToInt(m.isStatic),
    boolToInt(m.isInference),
    m.confidence,
    m.eventDate ?? null,
    m.documentDate ?? null,
    m.validFrom ?? null,
    m.validTo ?? null,
    m.forgetAfter ?? null,
    m.forgetReason ?? null,
    boolToInt(m.isForgotten),
    m.reuseCount,
    m.sourceCount,
    m.createdAt,
  ];
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    scopeUri: row.scope_uri,
    version: row.version,
    isLatest: intToBool(row.is_latest),
    parentMemoryId: row.parent_memory_id ?? undefined,
    rootMemoryId: row.root_memory_id ?? undefined,
    isStatic: intToBool(row.is_static),
    isInference: intToBool(row.is_inference),
    confidence: row.confidence,
    eventDate: row.event_date ?? undefined,
    documentDate: row.document_date ?? undefined,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    forgetAfter: row.forget_after ?? undefined,
    forgetReason: row.forget_reason ?? undefined,
    isForgotten: intToBool(row.is_forgotten),
    reuseCount: row.reuse_count,
    sourceCount: row.source_count,
    createdAt: row.created_at,
  };
}

function appendTypeFilter(
  where: string[],
  bind: Array<string | number>,
  type: MemoryType[] | undefined,
  column = "type",
): void {
  if (type === undefined || type.length === 0) {
    return;
  }
  where.push(`${column} IN (${type.map(() => "?").join(", ")})`);
  bind.push(...type);
}

/** Build an FTS5 MATCH expression that prefix-matches each typed token so
 *  "py" finds "python" and "scr j" finds "script javascript". FTS5
 *  operators (parens, quotes, dashes, colons, AND/OR/NEAR) in raw user
 *  input would throw — strip everything but word chars, then append `*`. */
function toFtsPrefixQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return "";
  // Implicit AND between tokens is FTS5's default. Each gets a prefix glob.
  return tokens.map((token) => `${token}*`).join(" ");
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function intToBool(value: number): boolean {
  return value !== 0;
}
