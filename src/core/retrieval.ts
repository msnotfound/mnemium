import type { Database, SqlRow, SqlValue } from "./storage/db";
import type { Embedder, VectorIndex } from "@shared/interfaces";
import type { MemoryType, Provider, SurfacedChunk } from "@shared/types";

export interface HybridSearchOptions {
  scopePrefix?: string;
  currentScopePrefix?: string;
  type?: MemoryType[];
  k: number;
}

export interface ScoredCandidate {
  memoryId: string;
  score: number;
  denseScore?: number;
  lexicalScore?: number;
}

export interface HybridSearchResult {
  chunks: SurfacedChunk[];
  candidates: ScoredCandidate[];
}

export class HybridRetriever {
  constructor(
    private readonly db: Database,
    private readonly vectorIndex: VectorIndex,
    private readonly embedder: Embedder,
  ) {}

  async hybridSearch(query: string, opts: HybridSearchOptions): Promise<SurfacedChunk[]> {
    const result = await this.hybridSearchWithCandidates(query, opts);
    return result.chunks;
  }

  async hybridSearchWithCandidates(query: string, opts: HybridSearchOptions): Promise<HybridSearchResult> {
    if (opts.k <= 0) {
      return { chunks: [], candidates: [] };
    }
    const [queryVec] = await this.embedder.embed([query]);
    if (queryVec === undefined) {
      return { chunks: [], candidates: [] };
    }
    const dense = await this.vectorIndex.search(this.embedder.id, queryVec, opts.k * 3, {
      scopePrefix: opts.scopePrefix,
      type: opts.type,
    });
    const lexical = await this.lexicalSearch(query, opts, opts.k * 3);
    const candidates = await this.applyCurrentScopeBonus(mergeCandidates(dense, lexical), opts.currentScopePrefix);
    const topCandidates = candidates.slice(0, opts.k);
    const chunks = await this.fetchSurfaced(topCandidates, opts.currentScopePrefix);
    return { chunks, candidates: topCandidates };
  }

  private async lexicalSearch(
    query: string,
    opts: HybridSearchOptions,
    limit: number,
  ): Promise<Array<{ id: string; score: number }>> {
    const where = ["memory.is_latest = 1", "memory.is_forgotten = 0", "fts_memory MATCH ?"];
    const params: SqlValue[] = [query];
    if (opts.scopePrefix !== undefined) {
      where.push("memory.scope_uri LIKE ?");
      params.push(`${opts.scopePrefix}%`);
    }
    if (opts.type !== undefined && opts.type.length > 0) {
      where.push(`memory.type IN (${opts.type.map(() => "?").join(", ")})`);
      params.push(...opts.type);
    }
    params.push(toLimit(limit));

    const rows = await this.db.prepare(
      `SELECT memory.id AS id, bm25(fts_memory) AS rank
       FROM fts_memory
       JOIN memory ON memory.rowid = fts_memory.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY rank
       LIMIT ?`,
    ).all<LexicalRow>(params);
    return normalizeLexicalRows(rows);
  }

  private async fetchSurfaced(candidates: ScoredCandidate[], currentScopePrefix?: string): Promise<SurfacedChunk[]> {
    if (candidates.length === 0) {
      return [];
    }
    const order = new Map(candidates.map((candidate, index) => [candidate.memoryId, index]));
    const scoreById = new Map(candidates.map((candidate) => [candidate.memoryId, candidate.score]));
    const rows = await this.db.prepare(
      `SELECT
         memory.id AS memory_id,
         memory.content AS content,
         memory.type AS type,
         memory.scope_uri AS scope_uri,
         document.provider AS provider,
         document.title AS title,
         document.uri AS uri,
         document.captured_at AS captured_at,
         COALESCE(MAX(memory_source.relevance), 0) AS relevance
       FROM memory
       LEFT JOIN memory_source ON memory_source.memory_id = memory.id
       LEFT JOIN document ON document.id = memory_source.document_id
       WHERE memory.id IN (${candidates.map(() => "?").join(", ")})
       GROUP BY memory.id
       ORDER BY relevance DESC`,
    ).all<SurfaceRow>(candidates.map((candidate) => candidate.memoryId));

    return rows
      .sort((a, b) => (order.get(a.memory_id) ?? 0) - (order.get(b.memory_id) ?? 0))
      .map((row) => ({
        memoryId: row.memory_id,
        content: row.content,
        type: row.type,
        sourceLabel: sourceLabel(row),
        score: scoreById.get(row.memory_id) ?? 0,
        provenance: {
          scopeUri: row.scope_uri,
          sameThread: currentScopePrefix !== undefined && row.scope_uri.startsWith(currentScopePrefix),
        },
      }));
  }

  private async applyCurrentScopeBonus(
    candidates: ScoredCandidate[],
    currentScopePrefix?: string,
  ): Promise<ScoredCandidate[]> {
    if (currentScopePrefix === undefined || candidates.length === 0) {
      return candidates.sort((a, b) => b.score - a.score);
    }

    const rows = await this.db.prepare(
      `SELECT id, scope_uri FROM memory
       WHERE id IN (${candidates.map(() => "?").join(", ")})`,
    ).all<MemoryScopeRow>(candidates.map((candidate) => candidate.memoryId));
    const scopeById = new Map(rows.map((row) => [row.id, row.scope_uri]));

    return candidates
      .map((candidate) => {
        const scopeUri = scopeById.get(candidate.memoryId);
        if (scopeUri === undefined || !scopeUri.startsWith(currentScopePrefix)) {
          return candidate;
        }
        return { ...candidate, score: candidate.score + 0.08 };
      })
      .sort((a, b) => b.score - a.score);
  }
}

export function createHybridRetriever(
  db: Database,
  vectorIndex: VectorIndex,
  embedder: Embedder,
): HybridRetriever {
  return new HybridRetriever(db, vectorIndex, embedder);
}

export async function hybridSearch(
  db: Database,
  vectorIndex: VectorIndex,
  embedder: Embedder,
  query: string,
  opts: HybridSearchOptions,
): Promise<SurfacedChunk[]> {
  return new HybridRetriever(db, vectorIndex, embedder).hybridSearch(query, opts);
}

export async function hybridSearchWithCandidates(
  db: Database,
  vectorIndex: VectorIndex,
  embedder: Embedder,
  query: string,
  opts: HybridSearchOptions,
): Promise<HybridSearchResult> {
  return new HybridRetriever(db, vectorIndex, embedder).hybridSearchWithCandidates(query, opts);
}

interface LexicalRow extends SqlRow {
  id: string;
  rank: number;
}

interface SurfaceRow extends SqlRow {
  memory_id: string;
  content: string;
  type: MemoryType;
  scope_uri: string;
  provider: Provider | null;
  title: string | null;
  uri: string | null;
  captured_at: number | null;
}

interface MemoryScopeRow extends SqlRow {
  id: string;
  scope_uri: string;
}

function mergeCandidates(
  dense: Array<{ id: string; score: number }>,
  lexical: Array<{ id: string; score: number }>,
): ScoredCandidate[] {
  const merged = new Map<string, ScoredCandidate>();
  for (const item of dense) {
    merged.set(item.id, {
      memoryId: item.id,
      denseScore: item.score,
      score: item.score * 0.65,
    });
  }
  for (const item of lexical) {
    const candidate = merged.get(item.id);
    if (candidate === undefined) {
      merged.set(item.id, {
        memoryId: item.id,
        lexicalScore: item.score,
        score: item.score * 0.35,
      });
    } else {
      candidate.lexicalScore = item.score;
      candidate.score += item.score * 0.35;
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

function normalizeLexicalRows(rows: LexicalRow[]): Array<{ id: string; score: number }> {
  if (rows.length === 0) {
    return [];
  }
  const ranks = rows.map((row) => row.rank);
  const best = Math.min(...ranks);
  const worst = Math.max(...ranks);
  if (best === worst) {
    return rows.map((row) => ({ id: row.id, score: 1 }));
  }
  return rows.map((row) => ({
    id: row.id,
    score: 1 - (row.rank - best) / (worst - best),
  }));
}

function sourceLabel(row: SurfaceRow): string {
  const source = providerLabel(row.provider) ?? row.title ?? row.uri ?? "Memory";
  if (row.captured_at === null) {
    return source;
  }
  return `${source} · ${relativeAge(row.captured_at)}`;
}

function providerLabel(provider: Provider | null): string | undefined {
  if (provider === null) {
    return undefined;
  }
  return provider[0]?.toUpperCase() + provider.slice(1);
}

function relativeAge(epochMs: number): string {
  const deltaMs = Math.max(0, Date.now() - epochMs);
  const days = Math.floor(deltaMs / 86_400_000);
  if (days <= 0) {
    return "today";
  }
  if (days < 30) {
    return `${days}d`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }
  return `${Math.floor(months / 12)}y`;
}

function toLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error(`Invalid retrieval limit ${limit}`);
  }
  return limit;
}
