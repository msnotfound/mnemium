import type { Edge, Entity, Memory } from "@shared/types";

export interface EagerEdgeInput {
  memories: Memory[];
  entities: Entity[];
  candidates?: Memory[];
  vectors?: Map<string, Float32Array>;
  now?: number;
}

export interface EagerEdgeResult {
  edges: Edge[];
  supersedes: Array<{ oldMemoryId: string; next: Memory; confidence: number }>;
}

const CO_OCCURS_THRESHOLD = 0.78;
const TEMPORAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function computeEagerEdges(input: EagerEdgeInput): EagerEdgeResult {
  const edges: Edge[] = [];
  const supersedes: Array<{ oldMemoryId: string; next: Memory; confidence: number }> = [];
  const candidates = input.candidates ?? [];

  for (const memory of input.memories) {
    for (const entity of input.entities) {
      if (mentionsEntity(memory, entity)) {
        edges.push(edge(memory.id, entity.id, "about", 1, 0.75));
      }
    }
  }

  for (const memory of input.memories) {
    for (const candidate of candidates) {
      const collision = predicateCollision(memory, candidate, input.entities);
      if (collision > 0) {
        edges.push(edge(memory.id, candidate.id, "supersedes", collision, collision));
        supersedes.push({ oldMemoryId: candidate.id, next: memory, confidence: collision });
      }

      const coOccurs = coOccurrence(memory, candidate, input.vectors);
      if (coOccurs > 0) {
        edges.push(edge(memory.id, candidate.id, "co_occurs", coOccurs, coOccurs));
      }
    }
  }

  return { edges, supersedes };
}

export function pendingLazyRelationHook(): Edge[] {
  return [];
}

function mentionsEntity(memory: Memory, entity: Entity): boolean {
  return memory.content.toLowerCase().includes(entity.name.toLowerCase())
    || memory.content.toLowerCase().includes(entity.normalizedName);
}

function predicateCollision(memory: Memory, candidate: Memory, entities: Entity[]): number {
  if (memory.id === candidate.id || memory.type !== candidate.type || memory.scopeUri !== candidate.scopeUri) {
    return 0;
  }
  const sharedEntity = entities.some((entity) => mentionsEntity(memory, entity) && mentionsEntity(candidate, entity));
  if (!sharedEntity) {
    return 0;
  }
  const memoryPredicate = predicateKey(memory.content);
  const candidatePredicate = predicateKey(candidate.content);
  if (memoryPredicate.length === 0 || memoryPredicate !== candidatePredicate) {
    return 0;
  }
  return 0.68;
}

function coOccurrence(memory: Memory, candidate: Memory, vectors?: Map<string, Float32Array>): number {
  const temporal = temporalScore(memory.createdAt, candidate.createdAt);
  const similarity = vectors === undefined ? lexicalSimilarity(memory.content, candidate.content) : vectorScore(memory, candidate, vectors);
  if (similarity < CO_OCCURS_THRESHOLD || temporal <= 0) {
    return 0;
  }
  return similarity * temporal;
}

function vectorScore(memory: Memory, candidate: Memory, vectors: Map<string, Float32Array>): number {
  const a = vectors.get(memory.id);
  const b = vectors.get(candidate.id);
  if (a === undefined || b === undefined) {
    return lexicalSimilarity(memory.content, candidate.content);
  }
  return cosine(a, b);
}

function temporalScore(a: number, b: number): number {
  const delta = Math.abs(a - b);
  if (delta > TEMPORAL_WINDOW_MS) {
    return 0;
  }
  return 1 - delta / TEMPORAL_WINDOW_MS;
}

function predicateKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/\b(i|we|my|our|the user|user)\b/g, "")
    .split(/\s+/)
    .filter((token) => token.length > 3)
    .slice(0, 3)
    .join(" ");
}

function lexicalSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(left.size * right.size);
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  return aNorm === 0 || bNorm === 0 ? 0 : dot / Math.sqrt(aNorm * bNorm);
}

function edge(srcMemoryId: string, dstMemoryId: string, type: Edge["type"], weight: number, confidence: number): Edge {
  return {
    id: `edge:${type}:${srcMemoryId}:${dstMemoryId}`,
    srcMemoryId,
    dstMemoryId,
    type,
    weight,
    computedBy: "eager",
    confidence,
  };
}
