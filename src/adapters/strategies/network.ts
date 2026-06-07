import type { Unsubscribe } from "@/shared/interfaces";
import type { Exchange, Provider } from "@/shared/types";

export interface NetworkCaptureConfig {
  provider: Provider;
  urlPatterns: RegExp[];
  parse: NetworkPayloadParser;
}

export interface NetworkPayload {
  url: string;
  method: string;
  requestText: string;
  responseText: string;
  transport: "fetch" | "xhr" | "ws";
  ts: number;
}

export type NetworkPayloadParser = (payload: NetworkPayload) => Exchange[];

interface PayloadValues {
  texts: string[];
  userPrompts: string[];
  roleTexts: Map<string, string>;
  ids: Map<string, string>;
}

interface MainBridgeMessage {
  source: "mnemium-main";
  type: "exchange" | "route";
  payload?: Exchange;
}

type FetchLike = typeof window.fetch;
type XhrOpen = XMLHttpRequest["open"];
type XhrSend = XMLHttpRequest["send"];
type WebSocketCtor = typeof WebSocket;

const installed = Symbol.for("mnemium.networkCapture.installed");
const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string; requestText: string }>();
const wsMeta = new WeakMap<WebSocket, { url: string }>();

export function installNetworkCapture(configs: NetworkCaptureConfig[]): Unsubscribe {
  const globalObject = window as typeof window & { [installed]?: boolean };
  if (globalObject[installed]) {
    return () => undefined;
  }
  globalObject[installed] = true;

  const originalFetch = window.fetch.bind(window);
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const OriginalWebSocket = window.WebSocket;

  window.fetch = patchFetch(originalFetch, configs);
  XMLHttpRequest.prototype.open = patchXhrOpen(originalOpen);
  XMLHttpRequest.prototype.send = patchXhrSend(originalSend, configs);
  window.WebSocket = patchWebSocket(OriginalWebSocket, configs);

  return () => {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
    window.WebSocket = OriginalWebSocket;
    globalObject[installed] = false;
  };
}

export function installHistoryRouteCapture(): Unsubscribe {
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    const result = originalPushState(...args);
    postRouteChanged();
    return result;
  };

  history.replaceState = (...args) => {
    const result = originalReplaceState(...args);
    postRouteChanged();
    return result;
  };

  window.addEventListener("popstate", postRouteChanged);

  return () => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener("popstate", postRouteChanged);
  };
}

export function createGenericProviderParser(provider: Provider): NetworkPayloadParser {
  return (payload) => {
    const assistantText = extractAssistantText(payload.responseText);
    if (assistantText.length === 0) {
      return [];
    }

    return [
      {
        provider,
        threadId: extractThreadId(payload.responseText, payload.url),
        messageId: extractMessageId(payload.responseText, assistantText),
        userText: extractUserText(payload.requestText),
        assistantText,
        ts: payload.ts,
      },
    ];
  };
}

function patchFetch(originalFetch: FetchLike, configs: NetworkCaptureConfig[]): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const requestText = await requestBodyText(input, init);
    const response = await originalFetch(input, init);

    if (matchesAny(configs, url)) {
      void response
        .clone()
        .text()
        .then((responseText) => {
          emitParsed(configs, {
            url,
            method,
            requestText,
            responseText,
            transport: "fetch",
            ts: Date.now(),
          });
        })
        .catch(() => undefined);
    }

    return response;
  };
}

function patchXhrOpen(originalOpen: XhrOpen): XhrOpen {
  return function open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
    xhrMeta.set(this, { method, url: String(url), requestText: "" });
    (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
  };
}

function patchXhrSend(originalSend: XhrSend, configs: NetworkCaptureConfig[]): XhrSend {
  return function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const meta = xhrMeta.get(this);
    if (meta !== undefined) {
      meta.requestText = bodyToText(body);
      this.addEventListener("loadend", () => {
        if (!matchesAny(configs, meta.url) || typeof this.responseText !== "string") {
          return;
        }

        emitParsed(configs, {
          url: meta.url,
          method: meta.method,
          requestText: meta.requestText,
          responseText: this.responseText,
          transport: "xhr",
          ts: Date.now(),
        });
      });
    }

    originalSend.call(this, body as XMLHttpRequestBodyInit | null | undefined);
  };
}

function patchWebSocket(OriginalWebSocket: WebSocketCtor, configs: NetworkCaptureConfig[]): WebSocketCtor {
  const PatchedWebSocket = function WebSocketPatched(this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const socket =
      protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
    wsMeta.set(socket, { url: String(url) });

    socket.addEventListener("message", (event) => {
      const meta = wsMeta.get(socket);
      if (meta === undefined || !matchesAny(configs, meta.url) || typeof event.data !== "string") {
        return;
      }

      emitParsed(configs, {
        url: meta.url,
        method: "WS",
        requestText: "",
        responseText: event.data,
        transport: "ws",
        ts: Date.now(),
      });
    });

    return socket;
  } as unknown as WebSocketCtor;

  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
  return PatchedWebSocket;
}

function emitParsed(configs: NetworkCaptureConfig[], payload: NetworkPayload): void {
  for (const config of configs) {
    if (!config.urlPatterns.some((pattern) => pattern.test(payload.url))) {
      continue;
    }

    try {
      for (const exchange of config.parse(payload)) {
        postExchange(exchange);
      }
    } catch {
      // Parser failures are isolated per-provider so one changed endpoint does not break capture.
    }
  }
}

function postExchange(exchange: Exchange): void {
  const message: MainBridgeMessage = { source: "mnemium-main", type: "exchange", payload: exchange };
  window.postMessage(message, location.origin);
}

function postRouteChanged(): void {
  const message: MainBridgeMessage = { source: "mnemium-main", type: "route" };
  window.postMessage(message, location.origin);
}

function matchesAny(configs: NetworkCaptureConfig[], url: string): boolean {
  return configs.some((config) => config.urlPatterns.some((pattern) => pattern.test(url)));
}

async function requestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (init?.body !== undefined && init.body !== null) {
    return bodyToText(init.body);
  }

  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return "";
    }
  }

  return "";
}

function bodyToText(body: BodyInit | Document | XMLHttpRequestBodyInit | null | undefined): string {
  if (body === null || body === undefined) {
    return "";
  }

  if (typeof body === "string") {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof FormData) {
    return Array.from(body.entries())
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : value.name}`)
      .join("&");
  }

  if (body instanceof Blob) {
    return "";
  }

  if (body instanceof ArrayBuffer) {
    return "";
  }

  return "";
}

function extractAssistantText(payload: string): string {
  const values = parsePayloadValues(payload);
  const roleText = values.roleTexts.get("assistant") ?? values.roleTexts.get("model");
  if (roleText !== undefined && roleText.length > 0) {
    return roleText;
  }

  return longest(values.texts);
}

function extractUserText(payload: string): string {
  const values = parsePayloadValues(payload);
  const roleText = values.roleTexts.get("user") ?? values.roleTexts.get("human");
  if (roleText !== undefined && roleText.length > 0) {
    return roleText;
  }

  return longest(values.userPrompts);
}

function extractThreadId(responseText: string, url: string): string {
  const values = parsePayloadValues(responseText);
  const explicit = values.ids.get("conversation_id") ?? values.ids.get("conversationId") ?? values.ids.get("thread_id");
  if (explicit !== undefined) {
    return explicit;
  }

  const fromPath = /(?:conversation|chat|c)\/([A-Za-z0-9_-]{8,})/.exec(url)?.[1];
  return fromPath ?? `url:${hashText(location.origin + location.pathname)}`;
}

function extractMessageId(responseText: string, assistantText: string): string {
  const values = parsePayloadValues(responseText);
  return (
    values.ids.get("message_id") ??
    values.ids.get("messageId") ??
    values.ids.get("id") ??
    `net:${hashText(assistantText)}`
  );
}

function parsePayloadValues(payload: string): PayloadValues {
  const decoded = decodePossiblyEncoded(payload);
  const values: PayloadValues = {
    texts: [],
    userPrompts: [],
    roleTexts: new Map<string, string>(),
    ids: new Map<string, string>(),
  };

  for (const json of jsonCandidates(decoded)) {
    collectJsonValues(json, values, null);
  }

  if (values.texts.length === 0) {
    for (const line of decoded.split(/\r?\n/)) {
      const clean = line.replace(/^data:\s*/, "").trim();
      if (clean.length > 30 && clean !== "[DONE]" && !clean.startsWith("{") && !clean.startsWith("[")) {
        values.texts.push(clean);
      }
    }
  }

  return values;
}

function decodePossiblyEncoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function jsonCandidates(payload: string): unknown[] {
  const candidates: unknown[] = [];
  for (const line of payload.split(/\r?\n/)) {
    const trimmed = line.replace(/^data:\s*/, "").trim();
    if (trimmed.length === 0 || trimmed === "[DONE]") {
      continue;
    }

    const parsed = parseJson(trimmed);
    if (parsed !== null) {
      candidates.push(parsed);
    }
  }

  const whole = parseJson(payload);
  if (whole !== null) {
    candidates.push(whole);
  }

  return candidates;
}

function collectJsonValues(
  value: unknown,
  values: PayloadValues,
  role: string | null,
): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    // Google's batchexecute (Gemini) and a few other providers embed entire
    // JSON structures as escaped strings inside the outer payload. If a string
    // is itself parseable as a non-primitive JSON value, recurse into it
    // instead of pushing the wrapper as text — otherwise the longest string
    // we collect ends up being the inner JSON envelope, not the prose inside.
    if ((trimmed.startsWith("[") || trimmed.startsWith("{")) && trimmed.length > 8) {
      const inner = parseJson(trimmed);
      if (inner !== null && typeof inner === "object") {
        collectJsonValues(inner, values, role);
        return;
      }
    }
    values.texts.push(trimmed);
    if (role !== null) {
      values.roleTexts.set(role, appendText(values.roleTexts.get(role), trimmed));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonValues(item, values, role);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const nextRole = roleFromRecord(value) ?? role;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" && idKeys.has(key)) {
      values.ids.set(key, nested);
      continue;
    }

    if (typeof nested === "string" && userTextKeys.has(key)) {
      values.userPrompts.push(nested);
    }

    if (textKeys.has(key)) {
      collectJsonValues(nested, values, nextRole);
    } else if (typeof nested === "object" && nested !== null) {
      collectJsonValues(nested, values, nextRole);
    }
  }
}

const idKeys = new Set(["id", "message_id", "messageId", "conversation_id", "conversationId", "thread_id", "chat_id"]);
const textKeys = new Set(["text", "content", "parts", "delta", "message", "answer", "completion", "candidate", "candidates"]);
const userTextKeys = new Set(["prompt", "query", "input", "userText"]);

function roleFromRecord(record: Record<string, unknown>): string | null {
  const role = record.role ?? record.author ?? record.sender;
  if (typeof role === "string") {
    return role.toLowerCase();
  }

  if (isRecord(role) && typeof role.role === "string") {
    return role.role.toLowerCase();
  }

  return null;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function appendText(current: string | undefined, next: string): string {
  if (current === undefined || current.length === 0) {
    return next;
  }
  if (current.endsWith(next)) {
    return current;
  }
  return `${current}${current.endsWith(" ") ? "" : " "}${next}`;
}

function longest(values: string[]): string {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)[0] ?? "";
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
