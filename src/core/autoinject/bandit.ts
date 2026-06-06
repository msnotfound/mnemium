import type { BanditFeatures, MemoryType } from "@shared/types";

export interface MetaStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface BanditOptions {
  explorationScale?: number;
  learningRate?: number;
  benefit?: number;
  rejectCost?: number;
  weights?: Partial<Record<FeatureName, number>>;
}

type FeatureName =
  | "bias"
  | "sim"
  | "distinctiveness"
  | "noveltyVsContext"
  | "recency"
  | "reuseCount"
  | "confidence"
  | "scopeMatch"
  | `type:${MemoryType}`;

const META_KEY = "autoinject.bandit.v1";

const PRIOR_WEIGHTS: Record<FeatureName, number> = {
  bias: -1.6,
  sim: 2.4,
  distinctiveness: 0.9,
  noveltyVsContext: 1.8,
  recency: 0.5,
  reuseCount: 0.25,
  confidence: 1.2,
  scopeMatch: 0.7,
  "type:fact": 0.1,
  "type:preference": 0.45,
  "type:episode": -0.05,
  "type:task": 0.25,
  "type:identity": 0.35,
};

export class LogisticBandit {
  private weights: Record<FeatureName, number>;
  private count = 0;
  private readonly options: Required<BanditOptions>;

  constructor(options: Required<BanditOptions>) {
    this.options = options;
    this.weights = { ...PRIOR_WEIGHTS, ...options.weights };
  }

  score(features: BanditFeatures): number {
    return sigmoid(dot(this.weights, vectorize(features)));
  }

  shouldInject(features: BanditFeatures): boolean {
    const sampled = sampleWeights(this.weights, this.options.explorationScale / Math.sqrt(this.count + 1));
    const p = sigmoid(dot(sampled, vectorize(features)));
    return p * this.options.benefit - (1 - p) * this.options.rejectCost > 0;
  }

  update(features: BanditFeatures, accepted: boolean): void {
    const vec = vectorize(features);
    const prediction = sigmoid(dot(this.weights, vec));
    const error = (accepted ? 1 : 0) - prediction;
    for (const [name, value] of Object.entries(vec) as Array<[FeatureName, number]>) {
      this.weights[name] += this.options.learningRate * error * value;
    }
    this.count += 1;
  }

  serialize(): string {
    return JSON.stringify({ weights: this.weights, count: this.count });
  }

  load(serialized: string): void {
    const parsed = JSON.parse(serialized) as { weights?: Partial<Record<FeatureName, number>>; count?: number };
    this.weights = { ...PRIOR_WEIGHTS, ...(parsed.weights ?? {}) };
    this.count = parsed.count ?? 0;
  }
}

export function createBandit(options: BanditOptions = {}): LogisticBandit {
  return new LogisticBandit({
    explorationScale: options.explorationScale ?? 0.08,
    learningRate: options.learningRate ?? 0.3,
    benefit: options.benefit ?? 1,
    rejectCost: options.rejectCost ?? 0.42,
    weights: options.weights ?? {},
  });
}

export async function loadBandit(meta: MetaStore, options: BanditOptions = {}): Promise<LogisticBandit> {
  const bandit = createBandit(options);
  const saved = await meta.get(META_KEY);
  if (saved !== undefined) {
    bandit.load(saved);
  }
  return bandit;
}

export async function saveBandit(meta: MetaStore, bandit: LogisticBandit): Promise<void> {
  await meta.set(META_KEY, bandit.serialize());
}

function vectorize(features: BanditFeatures): Record<FeatureName, number> {
  return {
    bias: 1,
    sim: features.sim,
    distinctiveness: features.distinctiveness,
    noveltyVsContext: features.noveltyVsContext,
    recency: features.recency,
    reuseCount: features.reuseCount,
    confidence: features.confidence,
    scopeMatch: features.scopeMatch,
    "type:fact": features.type === "fact" ? 1 : 0,
    "type:preference": features.type === "preference" ? 1 : 0,
    "type:episode": features.type === "episode" ? 1 : 0,
    "type:task": features.type === "task" ? 1 : 0,
    "type:identity": features.type === "identity" ? 1 : 0,
  };
}

function dot(weights: Record<FeatureName, number>, vec: Record<FeatureName, number>): number {
  let total = 0;
  for (const [name, value] of Object.entries(vec) as Array<[FeatureName, number]>) {
    total += (weights[name] ?? 0) * value;
  }
  return total;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function sampleWeights(weights: Record<FeatureName, number>, scale: number): Record<FeatureName, number> {
  if (scale <= 0) {
    return weights;
  }
  const sampled = { ...weights };
  for (const name of Object.keys(sampled) as FeatureName[]) {
    sampled[name] += gaussian() * scale;
  }
  return sampled;
}

function gaussian(): number {
  const u = Math.max(Number.EPSILON, Math.random());
  const v = Math.max(Number.EPSILON, Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
