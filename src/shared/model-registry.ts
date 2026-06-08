// Registry of known local models. The daemon is a generic downloader —
// it just needs a name + URL + (optional) sha256. The extension owns the
// list of curated choices the user picks from in onboarding and Settings.
//
// To add a model: drop a new entry below. Names must match exactly what
// the user types into config.toml under [backends.distill].model / .embed.
//
// sha256 fields are intentionally empty in v0.1. The daemon's downloader
// skips verification when sha is empty. Populate these once we cut a
// release and pin verified hashes.

export type ModelKind = "distill" | "embed";

export interface KnownModel {
  /** Filename on disk (also the value used in config.toml's model field). */
  name: string;
  /** HTTPS URL the daemon fetches. */
  url: string;
  /** Optional sha256 hex; daemon skips verification when empty. */
  sha256: string;
  /** Approximate size for UI display. */
  sizeBytes: number;
  kind: ModelKind;
  /** Embedding dimension — embed models only. */
  dim?: number;
  /** Default context size — distill models only. */
  contextSize?: number;
  /** Human label for the model picker. */
  label: string;
  /** One-line description. */
  summary: string;
}

const HF = "https://huggingface.co";

export const KNOWN_MODELS: KnownModel[] = [
  {
    name: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    label: "Qwen2.5 1.5B Instruct (Q4_K_M)",
    summary: "Fast, balanced default. Runs comfortably on most laptops.",
    url: `${HF}/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf`,
    sha256: "",
    sizeBytes: 1_080_000_000,
    kind: "distill",
    contextSize: 4096,
  },
  {
    name: "Phi-3-mini-4k-instruct-q4.gguf",
    label: "Phi-3 Mini 4K Instruct (Q4)",
    summary: "Higher quality distillation. Heavier on RAM.",
    url: `${HF}/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf`,
    sha256: "",
    sizeBytes: 2_393_232_128,
    kind: "distill",
    contextSize: 4096,
  },
  {
    name: "nomic-embed-text-v1.5.Q4_K_M.gguf",
    label: "nomic-embed-text v1.5 (Q4_K_M)",
    summary: "Embedding model used for semantic retrieval.",
    url: `${HF}/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf`,
    sha256: "",
    sizeBytes: 87_000_000,
    kind: "embed",
    dim: 768,
  },
];

export function findModel(name: string): KnownModel | undefined {
  return KNOWN_MODELS.find((model) => model.name === name);
}

export function modelsByKind(kind: ModelKind): KnownModel[] {
  return KNOWN_MODELS.filter((model) => model.kind === kind);
}
