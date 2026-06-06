import type { Embedder } from "@shared/interfaces";

export const BGE_SMALL_ID = "bge-small-en-v1.5";
export const BGE_SMALL_DIM = 384;

type Device = "webgpu" | "wasm";

interface FeatureExtractionTensor {
  data: Float32Array | number[];
  dims?: readonly number[];
}

type FeatureExtractor = (
  texts: string | string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<FeatureExtractionTensor>;

interface TransformersModule {
  pipeline(
    task: "feature-extraction",
    model: string,
    options: { device: Device; dtype: "q8" },
  ): Promise<FeatureExtractor>;
}

export class BgeSmallEmbedder implements Embedder {
  readonly id = BGE_SMALL_ID;
  readonly dim = BGE_SMALL_DIM;

  private extractor?: Promise<FeatureExtractor>;

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    const extractor = await this.load();
    const tensor = await extractor(texts, { pooling: "mean", normalize: true });
    return tensorToVectors(tensor, texts.length, this.dim);
  }

  private async load(): Promise<FeatureExtractor> {
    this.extractor ??= loadExtractor();
    return this.extractor;
  }
}

export function createEmbedder(): Embedder {
  return new BgeSmallEmbedder();
}

async function loadExtractor(): Promise<FeatureExtractor> {
  const transformers = await importTransformers();
  try {
    return await transformers.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
      device: "webgpu",
      dtype: "q8",
    });
  } catch (error) {
    if (!isDeviceFailure(error)) {
      throw error;
    }
    return transformers.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
      device: "wasm",
      dtype: "q8",
    });
  }
}

async function importTransformers(): Promise<TransformersModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  return (await dynamicImport("@huggingface/transformers")) as TransformersModule;
}

function tensorToVectors(tensor: FeatureExtractionTensor, count: number, dim: number): Float32Array[] {
  const data = tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data);
  if (data.length !== count * dim) {
    throw new Error(`Unexpected embedding shape: got ${data.length} values for ${count}x${dim}`);
  }
  const vectors: Float32Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * dim;
    const vec = data.slice(start, start + dim);
    vectors.push(normalize(vec));
  }
  return vectors;
}

function normalize(vec: Float32Array): Float32Array {
  let normSq = 0;
  for (const value of vec) {
    normSq += value * value;
  }
  if (normSq === 0) {
    return vec;
  }
  const norm = Math.sqrt(normSq);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = (vec[i] ?? 0) / norm;
  }
  return out;
}

function isDeviceFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("webgpu") || message.includes("gpu") || message.includes("device");
}
