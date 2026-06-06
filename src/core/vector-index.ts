import type { Database, SqlRow, SqlValue } from "./storage/db";
import type { VectorIndex as VectorIndexContract } from "@shared/interfaces";
import type { MemoryType } from "@shared/types";

const META_DIM_PREFIX = "vector.dim.";

export class SqliteVectorIndex implements VectorIndexContract {
  constructor(private readonly db: Database) {}

  async upsert(modelId: string, rows: { id: string; vec: Float32Array }[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const dim = rows[0]?.vec.length;
    if (dim === undefined || dim === 0) {
      throw new Error("Cannot upsert empty vectors");
    }
    for (const row of rows) {
      if (row.vec.length !== dim) {
        throw new Error(`Vector ${row.id} dim ${row.vec.length} does not match batch dim ${dim}`);
      }
    }
    const table = tableForModel(modelId);
    await this.ensureModelTable(modelId, table, dim);
    const insertMap = this.db.prepare(
      `INSERT INTO ${quoteIdent(mapTable(table))} (memory_id) VALUES (?)
       ON CONFLICT(memory_id) DO NOTHING`,
    );
    const selectMap = this.db.prepare(`SELECT rowid FROM ${quoteIdent(mapTable(table))} WHERE memory_id = ?`);
    const deleteVector = this.db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE rowid = ?`);
    const insertVector = this.db.prepare(
      `INSERT INTO ${quoteIdent(table)} (rowid, embedding) VALUES (?, ?)`,
    );

    await this.db.transaction(async () => {
      for (const row of rows) {
        await insertMap.run([row.id]);
        const mapped = await selectMap.get<RowIdRow>([row.id]);
        if (mapped === undefined) {
          throw new Error(`Unable to map vector row for memory ${row.id}`);
        }
        await deleteVector.run([mapped.rowid]);
        await insertVector.run([mapped.rowid, serializeVector(row.vec)]);
      }
    });
  }

  async search(
    modelId: string,
    q: Float32Array,
    k: number,
    filter?: { scopePrefix?: string; type?: MemoryType[] },
  ): Promise<Array<{ id: string; score: number }>> {
    if (k <= 0) {
      return [];
    }
    const table = tableForModel(modelId);
    await this.assertDim(modelId, q.length);

    const where = ["memory.is_latest = 1", "memory.is_forgotten = 0"];
    const params: SqlValue[] = [serializeVector(q), k];
    if (filter?.scopePrefix !== undefined) {
      where.push("memory.scope_uri LIKE ?");
      params.push(`${filter.scopePrefix}%`);
    }
    if (filter?.type !== undefined && filter.type.length > 0) {
      where.push(`memory.type IN (${filter.type.map(() => "?").join(", ")})`);
      params.push(...filter.type);
    }

    const rows = await this.db.prepare(
      `SELECT map.memory_id AS id, vec.distance AS distance
       FROM ${quoteIdent(table)} AS vec
       JOIN ${quoteIdent(mapTable(table))} AS map ON map.rowid = vec.rowid
       JOIN memory ON memory.id = map.memory_id
       WHERE vec.embedding MATCH ? AND k = ? AND ${where.join(" AND ")}
       ORDER BY vec.distance
       LIMIT ${toLimit(k)}`,
    ).all<VectorSearchRow>(params);

    return rows.map((row) => ({
      id: row.id,
      score: distanceToScore(row.distance),
    }));
  }

  async drop(modelId: string): Promise<void> {
    const table = tableForModel(modelId);
    await this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
    await this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(mapTable(table))}`);
    await this.db.prepare("DELETE FROM meta WHERE key = ?").run([dimMetaKey(modelId)]);
  }

  private async ensureModelTable(modelId: string, table: string, dim: number): Promise<void> {
    const existing = await this.readDim(modelId);
    if (existing !== undefined && existing !== dim) {
      throw new Error(`Vector table ${modelId} has dim ${existing}; cannot upsert dim ${dim}`);
    }
    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(mapTable(table))} (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL UNIQUE REFERENCES memory(id) ON DELETE CASCADE
      )`,
    );
    await this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdent(table)}
       USING vec0(embedding float[${toDim(dim)}])`,
    );
    await this.db.prepare(
      `INSERT INTO meta (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run([dimMetaKey(modelId), String(dim)]);
  }

  private async assertDim(modelId: string, dim: number): Promise<void> {
    const expected = await this.readDim(modelId);
    if (expected === undefined) {
      throw new Error(`Vector table for model ${modelId} has not been created`);
    }
    if (expected !== dim) {
      throw new Error(`Query vector dim ${dim} does not match ${modelId} dim ${expected}`);
    }
  }

  private async readDim(modelId: string): Promise<number | undefined> {
    const row = await this.db.prepare("SELECT value FROM meta WHERE key = ?").get<MetaRow>([
      dimMetaKey(modelId),
    ]);
    if (row === undefined) {
      return undefined;
    }
    const parsed = Number.parseInt(row.value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid vector dim metadata for ${modelId}: ${row.value}`);
    }
    return parsed;
  }
}

export function createVectorIndex(db: Database): VectorIndexContract {
  return new SqliteVectorIndex(db);
}

interface MetaRow extends SqlRow {
  value: string;
}

interface RowIdRow extends SqlRow {
  rowid: number;
}

interface VectorSearchRow extends SqlRow {
  id: string;
  distance: number;
}

function tableForModel(modelId: string): string {
  const sanitized = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `vec_${sanitized.length === 0 ? "model" : sanitized}`;
}

function mapTable(vectorTable: string): string {
  return `${vectorTable}_map`;
}

function dimMetaKey(modelId: string): string {
  return `${META_DIM_PREFIX}${modelId}`;
}

function serializeVector(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

function distanceToScore(distance: number): number {
  return 1 / (1 + Math.max(0, distance));
}

function toDim(dim: number): number {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 100_000) {
    throw new Error(`Invalid vector dim ${dim}`);
  }
  return dim;
}

function toLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error(`Invalid vector search limit ${limit}`);
  }
  return limit;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
