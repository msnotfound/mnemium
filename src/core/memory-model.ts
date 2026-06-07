import type { Config } from "@shared/config";
import type { MemoryModel as MemoryModelContract } from "@shared/interfaces";
import type { DraftMemory, Edge, Entity, Exchange, Memory, MemoryType } from "@shared/types";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface DistillJson {
  memories?: DraftMemory[];
  entities?: Entity[];
}

export type MemoryModelConfig = Config["backends"]["distill"];

export function createMemoryModel(config: MemoryModelConfig): MemoryModelContract {
  if (config.kind === "ollama" && config.ollama !== undefined) {
    return new LocalServerMemoryModel(config.ollama.endpoint, config.ollama.model);
  }
  if (config.kind === "apiKey" && config.apiKey !== undefined) {
    return new ApiKeyMemoryModel(
      config.apiKey.provider,
      config.apiKey.apiKey,
      config.apiKey.model,
    );
  }
  // "daemon" lives in core/daemon-memory-model.ts (built in task #25) and is
  // resolved by the offscreen bootEngine, not here. "disabled" and any kind
  // with missing required sub-config falls through to a no-op model so the
  // capture pipeline cleanly writes zero memories instead of throwing.
  return new DisabledMemoryModel();
}

export class DisabledMemoryModel implements MemoryModelContract {
  readonly id = "disabled";
  async distill(): Promise<{ memories: DraftMemory[]; entities: Entity[] }> {
    return { memories: [], entities: [] };
  }
  async classifyRelations(): Promise<Edge[]> {
    return [];
  }
}

export class LocalServerMemoryModel implements MemoryModelContract {
  readonly id: string;

  constructor(private readonly endpoint: string, private readonly model = "mnemium-distill") {
    this.id = `localServer:${model}`;
  }

  async distill(ex: Exchange): Promise<{ memories: DraftMemory[]; entities: Entity[] }> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: distillMessages(ex),
        stream: false,
        format: "json",
      }),
    });
    if (!response.ok) {
      throw new Error(`Local memory model failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as { response?: string; message?: { content?: string } };
    return parseDistillation(body.response ?? body.message?.content ?? "", ex);
  }

  async classifyRelations(_m: Memory, _candidates: Memory[]): Promise<Edge[]> {
    return [];
  }
}

export class ApiKeyMemoryModel implements MemoryModelContract {
  readonly id: string;

  constructor(
    private readonly provider: "openai" | "anthropic" | "openrouter",
    private readonly apiKey: string,
    private readonly model = provider === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini",
  ) {
    this.id = `apiKey:${provider}:${this.model}`;
  }

  async distill(ex: Exchange): Promise<{ memories: DraftMemory[]; entities: Entity[] }> {
    const text = await callApiProvider(this.provider, this.apiKey, this.model, distillMessages(ex));
    return parseDistillation(text, ex);
  }

  async classifyRelations(_m: Memory, _candidates: Memory[]): Promise<Edge[]> {
    return [];
  }
}

export function heuristicDistill(ex: Exchange): { memories: DraftMemory[]; entities: Entity[] } {
  const scopeUri = scopeForExchange(ex);
  const text = stripMarkdown(`${ex.userText}\n${ex.assistantText}`);
  const entities = extractEntities(text, scopeUri);
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24 && sentence.length <= 500)
    .filter((sentence) => /[a-z]/i.test(sentence))
    .slice(0, 6);
  const memories = sentences
    .map((sentence): DraftMemory => ({
      type: inferType(sentence),
      content: sentence.replace(/\s+/g, " "),
      isStatic: inferType(sentence) !== "task" && !/\b(now|currently|today|this week|latest)\b/i.test(sentence),
      isInference: false,
      confidence: 0.45,
      entities: entities
        .filter((entity) => sentence.toLowerCase().includes(entity.name.toLowerCase()))
        .map((entity) => entity.normalizedName),
    }))
    .filter((memory) => memory.content.length > 0);
  return { memories, entities };
}

/** Lightweight markdown stripper so sentence-splitting doesn't get confused by
 *  `**bold**`, `## headings`, fenced code blocks, list markers, or links. The
 *  goal isn't perfect rendering — just clean enough that the next regex-based
 *  sentence split produces readable memory content. */
function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/!?\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
}

function distillMessages(ex: Exchange): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Extract atomic durable memories from this chat turn. Resolve coreferences. Return only JSON with memories and entities. memories items require type, content, isStatic, confidence, entities. types: fact, preference, episode, task, identity.",
    },
    {
      role: "user",
      content: `User: ${ex.userText}\nAssistant: ${ex.assistantText}`,
    },
  ];
}

async function callApiProvider(
  provider: "openai" | "anthropic" | "openrouter",
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const endpoint = providerEndpoint(provider);
  const authorizationHeader = provider === "anthropic" ? {} : { authorization: `Bearer ${apiKey}` };
  const anthropicHeader = provider === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {};
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authorizationHeader,
      ...anthropicHeader,
      ...(provider === "openrouter" ? { "HTTP-Referer": "chrome-extension://mnemium" } : {}),
    } as Record<string, string>,
    body: JSON.stringify(
      provider === "anthropic"
        ? { model, max_tokens: 900, system: messages[0]?.content, messages: messages.slice(1) }
        : { model, messages, response_format: { type: "json_object" } },
    ),
  });
  if (!response.ok) {
    throw new Error(`${provider} memory model failed: ${response.status} ${response.statusText}`);
  }
  const json = await response.json();
  if (provider === "anthropic") {
    return ((json as { content?: Array<{ text?: string }> }).content ?? []).map((item) => item.text ?? "").join("\n");
  }
  return (json as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
}

function providerEndpoint(provider: "openai" | "anthropic" | "openrouter"): string {
  if (provider === "anthropic") {
    return "https://api.anthropic.com/v1/messages";
  }
  if (provider === "openrouter") {
    return "https://openrouter.ai/api/v1/chat/completions";
  }
  return "https://api.openai.com/v1/chat/completions";
}

function parseDistillation(text: string, ex: Exchange): { memories: DraftMemory[]; entities: Entity[] } {
  const parsed = safeJson(text);
  if (parsed === undefined) {
    return heuristicDistill(ex);
  }
  const scopeUri = scopeForExchange(ex);
  return {
    memories: sanitizeMemories(parsed.memories ?? []),
    entities: (parsed.entities ?? []).map((entity) => ({
      ...entity,
      scopeUri: entity.scopeUri || scopeUri,
      normalizedName: normalizeEntity(entity.normalizedName || entity.name),
    })),
  };
}

function safeJson(text: string): DistillJson | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as DistillJson;
  } catch {
    return undefined;
  }
}

function sanitizeMemories(memories: DraftMemory[]): DraftMemory[] {
  return memories
    .filter((memory) => typeof memory.content === "string" && memory.content.trim().length > 0)
    .map((memory) => ({
      type: validType(memory.type) ? memory.type : "fact",
      content: memory.content.trim(),
      isStatic: Boolean(memory.isStatic),
      isInference: Boolean(memory.isInference),
      confidence: clamp01(memory.confidence ?? 0.7),
      entities: (memory.entities ?? []).map(normalizeEntity),
      eventDate: memory.eventDate,
    }));
}

function extractEntities(text: string, scopeUri: string): Entity[] {
  const names = new Set([...text.matchAll(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,3}\b/g)].map((match) => match[0]));
  return [...names].slice(0, 12).map((name) => ({
    id: `entity:${scopeUri}:${normalizeEntity(name)}`,
    type: "concept",
    name,
    normalizedName: normalizeEntity(name),
    scopeUri,
  }));
}

function inferType(sentence: string): MemoryType {
  if (/\b(prefer|like|favorite|rather|avoid)\b/i.test(sentence)) return "preference";
  if (/\b(todo|task|need to|follow up|deadline|due)\b/i.test(sentence)) return "task";
  if (/\b(i am|my name|we are|lives? in|works? at)\b/i.test(sentence)) return "identity";
  if (/\b(yesterday|today|last week|met|went|did)\b/i.test(sentence)) return "episode";
  return "fact";
}

function validType(type: string): type is MemoryType {
  return ["fact", "preference", "episode", "task", "identity"].includes(type);
}

function scopeForExchange(ex: Exchange): string {
  return `personal::${ex.provider}::${ex.threadId}`;
}

function normalizeEntity(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
