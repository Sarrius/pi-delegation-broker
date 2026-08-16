import { captureLosslessJson } from "./lossless-json.mjs";
import { captureProviderContext } from "./provider-context.mjs";
import { ProviderProtocolError } from "./provider-protocol.mjs";

/**
 * Controller-owned raw transport for the Anthropic Messages streaming API.
 *
 * This adapter deliberately has no environment lookup, SDK, retry loop, or
 * provider fallback. A controller supplies one exact endpoint and one exact
 * credential resolver for a pre-frozen AttemptRouteSnapshot. The adapter
 * normalizes provider SSE into the broker's small controller event vocabulary;
 * it never exposes raw headers, error bodies, or credentials to a child.
 *
 * It is transport machinery only. Admission, lease/fencing, health mutation,
 * frame validation, evidence persistence, and retry policy remain controller
 * responsibilities.
 */

export const ANTHROPIC_MESSAGES_ADAPTER_ID = "anthropic-messages@1";
export const ANTHROPIC_API_VERSION = "2023-06-01";

const MAX_ERROR_BYTES = 32 * 1024;
const MAX_RETRY_AFTER_MS = 86_400_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const STOP_REASONS = new Set(["end_turn", "tool_use", "stop_sequence", "max_tokens"]);
const SSE_EVENTS = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
  "error",
]);

export class AnthropicMessagesTransportError extends Error {
  constructor(reasonCode, detail) {
    super(detail ? `${reasonCode}: ${detail}` : reasonCode);
    this.name = "AnthropicMessagesTransportError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, detail) {
  throw new AnthropicMessagesTransportError(reasonCode, detail);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function boundedText(value, name, max) {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    fail("context_invalid", `${name} must be bounded printable text`);
  }
  return value;
}

function boundedId(value, name, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail("context_invalid", `${name} must be a bounded identifier`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail("provider_frame_invalid", `${name} must be a non-negative safe integer`);
  return value;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") fail("snapshot_invalid", "snapshot is required");
  if (snapshot.adapterId !== ANTHROPIC_MESSAGES_ADAPTER_ID) fail("snapshot_invalid", "adapterId is not anthropic-messages@1");
  if (snapshot.apiDialect !== "anthropic-messages") fail("snapshot_invalid", "apiDialect is not anthropic-messages");
  if (snapshot.retryOwner !== "broker" || snapshot.sdkMaxRetries !== 0) {
    fail("snapshot_invalid", "snapshot does not pin broker-owned retry to zero");
  }
  if (!["none", "short", "long"].includes(snapshot.cacheRetention)) {
    fail("snapshot_invalid", "snapshot cacheRetention is invalid");
  }
  if (!Number.isSafeInteger(snapshot.maxInputBytes) || snapshot.maxInputBytes < 1) fail("snapshot_invalid", "snapshot maxInputBytes is invalid");
  if (!Number.isSafeInteger(snapshot.maxOutputBytes) || snapshot.maxOutputBytes < 1) fail("snapshot_invalid", "snapshot maxOutputBytes is invalid");
  if (!Number.isSafeInteger(snapshot.maxOutputTokens) || snapshot.maxOutputTokens < 1) fail("snapshot_invalid", "snapshot maxOutputTokens is invalid");
  return snapshot;
}

function normalizeMessages(context) {
  if (!Array.isArray(context.messages)) fail("context_invalid", "messages must be an array");
  if (context.messages.length > 1_000) fail("context_invalid", "messages exceeds the configured limit");
  return context.messages.map((message, index) => {
    if (!isPlainObject(message)) fail("context_invalid", `messages[${index}] must be a plain object`);
    for (const key of Object.keys(message)) {
      if (!["role", "content"].includes(key)) fail("context_invalid", `messages[${index}] has unknown field ${key}`);
    }
    if (message.role !== "user" && message.role !== "assistant") fail("context_invalid", `messages[${index}].role is unsupported`);
    // An Anthropic content-block vocabulary is deliberately not guessed here.
    // The first real adapter supports text only; unsupported modality/tool
    // result/replay content fails at ingress rather than being silently dropped.
    return { role: message.role, content: boundedText(message.content, `messages[${index}].content`, 256 * 1024) };
  });
}

function normalizeTools(context) {
  if (!Array.isArray(context.tools)) fail("context_invalid", "tools must be an array");
  if (context.tools.length > 128) fail("context_invalid", "tools exceeds the configured limit");
  const names = new Set();
  return context.tools.map((tool, index) => {
    if (!isPlainObject(tool)) fail("context_invalid", `tools[${index}] must be a plain object`);
    for (const key of Object.keys(tool)) {
      if (!["name", "description", "inputSchema"].includes(key)) fail("context_invalid", `tools[${index}] has unknown field ${key}`);
    }
    const name = boundedId(tool.name, `tools[${index}].name`, TOOL_NAME);
    if (names.has(name)) fail("context_invalid", `tools[${index}].name is duplicated`);
    names.add(name);
    const description = boundedText(tool.description, `tools[${index}].description`, 16 * 1024);
    if (!isPlainObject(tool.inputSchema)) fail("context_invalid", `tools[${index}].inputSchema must be a JSON Schema object`);
    return { name, description, input_schema: tool.inputSchema };
  });
}

/**
 * Build one deterministic Anthropic Messages request from an already-frozen
 * route snapshot and a lossless context snapshot. No optional provider state,
 * environment setting, or caller-owned mutable object is consulted later.
 */
export function buildAnthropicMessagesRequest(snapshot, context) {
  validateSnapshot(snapshot);
  let captured;
  try {
    captured = captureProviderContext(context, { maxBytes: snapshot.maxInputBytes });
  } catch (error) {
    fail("context_invalid", error instanceof Error ? error.message : "context validation failed");
  }
  const value = captured.value;
  const systemPrompt = boundedText(value.systemPrompt, "systemPrompt", 256 * 1024);
  const request = {
    model: snapshot.model,
    max_tokens: snapshot.maxOutputTokens,
    stream: true,
    system: snapshot.cacheRetention === "none"
      ? systemPrompt
      : [{ type: "text", text: systemPrompt, cache_control: {
        type: "ephemeral",
        ...(snapshot.cacheRetention === "long" ? { ttl: "1h" } : {}),
      } }],
    messages: normalizeMessages(value),
  };
  const tools = normalizeTools(value);
  if (tools.length > 0) request.tools = tools;
  return Object.freeze({ request: captureLosslessJson(request).value, contextDigest: captured.digest });
}

function parseUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) fail("endpoint_invalid", "endpoint resolver returned invalid URL");
  let url;
  try { url = new URL(value); } catch { fail("endpoint_invalid", "endpoint resolver returned invalid URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail("endpoint_invalid", "endpoint must be credential-free HTTPS URL");
  }
  return url.toString();
}

function parseRetryAfter(value, now) {
  if (typeof value !== "string" || value.length > 128) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    const milliseconds = Math.ceil(seconds * 1_000);
    return milliseconds <= MAX_RETRY_AFTER_MS ? milliseconds : undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const milliseconds = timestamp - now;
  return milliseconds > 0 && milliseconds <= MAX_RETRY_AFTER_MS ? milliseconds : undefined;
}

async function boundedErrorBody(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_ERROR_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return null;
    return parsed;
  } catch { return null; }
}

function errorKind(body) {
  const error = isPlainObject(body?.error) ? body.error : null;
  const type = typeof error?.type === "string" ? error.type : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const joined = `${type} ${message}`.toLowerCase();
  if (joined.includes("context") || joined.includes("prompt is too long") || joined.includes("maximum context")) return "context_window_exceeded";
  if (joined.includes("quota") || joined.includes("credit balance")) return "quota_fatal";
  return null;
}

function normalizedHttpTerminal(response, body, now) {
  const status = response.status;
  const providerRequestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
  const base = {
    httpStatus: status,
    ...(typeof providerRequestId === "string" && ID.test(providerRequestId) ? { providerRequestId } : {}),
  };
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
    return { type: "terminal", outcome: "rate_limited", payload: { ...base, ...(retryAfterMs ? { retryAfterMs } : {}) } };
  }
  if (status === 401 || status === 403) return { type: "terminal", outcome: "auth_fatal", payload: base };
  const classified = errorKind(body);
  if (classified) return { type: "terminal", outcome: classified, payload: base };
  // A provider HTTP rejection means no model stream was accepted. The name
  // retained by the closed vocabulary is historical; this is not a claim that
  // no TCP request was sent.
  if (status >= 400 && status < 500) return { type: "terminal", outcome: "rejected_before_send", payload: base };
  return { type: "terminal", outcome: "transport_before_headers", payload: base };
}

function parseSseData(data) {
  if (typeof data !== "string" || data.length === 0 || Buffer.byteLength(data) > MAX_ERROR_BYTES) {
    fail("provider_frame_invalid", "SSE data is empty or exceeds the frame cap");
  }
  try {
    const parsed = JSON.parse(data);
    if (!isPlainObject(parsed)) fail("provider_frame_invalid", "SSE data must decode to object");
    return parsed;
  } catch (error) {
    if (error instanceof AnthropicMessagesTransportError) throw error;
    fail("provider_frame_invalid", "SSE data is invalid JSON");
  }
}

function makeSseIterator(body, maxBytes, signal) {
  if (!body || typeof body.getReader !== "function") fail("provider_frame_invalid", "streaming response body is unavailable");
  return (async function* () {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let buffer = "";
    let eventName = "";
    let dataLines = [];
    const flush = () => {
      if (!eventName && dataLines.length === 0) return null;
      const event = { event: eventName, data: dataLines.join("\n") };
      eventName = "";
      dataLines = [];
      return event;
    };
    const processLine = (line) => {
      if (line === "") return flush();
      if (line.startsWith(":")) return null;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      else if (field === "data") dataLines.push(value);
      // Unknown SSE field names are protocol-invalid: accepting them may
      // change interpretation across adapter versions.
      else fail("provider_frame_invalid", `unsupported SSE field ${field}`);
      return null;
    };
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) fail("provider_frame_invalid", "provider SSE exceeds output byte cap");
        buffer += decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          const line = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const event = processLine(line);
          if (event) yield event;
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) {
        // Unterminated final line is not silently accepted as a frame: a
        // terminal provider event must be explicitly delimited.
        fail("provider_frame_invalid", "unterminated SSE line at EOF");
      }
      const trailing = flush();
      if (trailing) yield trailing;
    } finally {
      reader.releaseLock();
    }
  })();
}

function usageFrom(value) {
  if (!isPlainObject(value)) fail("provider_frame_invalid", "usage must be object");
  const input = nonNegativeInteger(value.input_tokens ?? 0, "usage.input_tokens");
  const output = nonNegativeInteger(value.output_tokens ?? 0, "usage.output_tokens");
  // Preserve cache accounting as named transport facts. The protocol's current
  // generic usage frame cannot yet carry them, so they remain out of the
  // child-facing frame until that schema is widened deliberately.
  const cacheRead = nonNegativeInteger(value.cache_read_input_tokens ?? 0, "usage.cache_read_input_tokens");
  const cacheWrite = nonNegativeInteger(value.cache_creation_input_tokens ?? 0, "usage.cache_creation_input_tokens");
  return { input, output, cacheRead, cacheWrite };
}

function mergeUsage(previous, next) {
  if (!previous) return next;
  return {
    input: Math.max(previous.input, next.input),
    output: Math.max(previous.output, next.output),
    cacheRead: Math.max(previous.cacheRead, next.cacheRead),
    cacheWrite: Math.max(previous.cacheWrite, next.cacheWrite),
  };
}

function normalizedBlockStart(payload) {
  if (!Number.isSafeInteger(payload.index) || payload.index < 0 || !isPlainObject(payload.content_block)) {
    fail("provider_frame_invalid", "content_block_start shape is invalid");
  }
  const block = payload.content_block;
  if (block.type === "text") return { index: payload.index, blockType: "text", initial: typeof block.text === "string" ? block.text : "" };
  if (block.type === "thinking") return { index: payload.index, blockType: "reasoning", initial: typeof block.thinking === "string" ? block.thinking : "" };
  if (block.type === "tool_use") {
    return {
      index: payload.index,
      blockType: "tool_call",
      id: boundedId(block.id, "tool_use.id"),
      name: boundedId(block.name, "tool_use.name", TOOL_NAME),
      initial: "",
    };
  }
  fail("provider_frame_invalid", "unsupported Anthropic content block type");
}

function normalizedDelta(payload, block) {
  if (!Number.isSafeInteger(payload.index) || payload.index !== block.index || !isPlainObject(payload.delta)) {
    fail("provider_frame_invalid", "content_block_delta shape is invalid");
  }
  const delta = payload.delta;
  if (block.blockType === "text" && delta.type === "text_delta") return delta.text;
  if (block.blockType === "reasoning" && delta.type === "thinking_delta") return delta.thinking;
  if (block.blockType === "tool_call" && delta.type === "input_json_delta") return delta.partial_json;
  // Signature is provider-private replay state. It is intentionally not sent
  // to a replacement route or child; it does not alter canonical visible text.
  if (block.blockType === "reasoning" && delta.type === "signature_delta") return null;
  fail("provider_frame_invalid", "delta does not match open content block");
}

/**
 * Exact-account, one-dispatch streaming transport. The yielded events are
 * controller-normalized facts, not child-facing frames. A caller must feed
 * each into ProviderStreamAssembler and persist its terminal settlement.
 */
export class AnthropicMessagesTransport {
  #credentialResolver;
  #endpointResolver;
  #fetch;
  #now;

  constructor({ credentialResolver, endpointResolver, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    if (typeof credentialResolver !== "function") throw new Error("AnthropicMessagesTransport requires credentialResolver");
    if (typeof endpointResolver !== "function") throw new Error("AnthropicMessagesTransport requires endpointResolver");
    if (typeof fetchImpl !== "function") throw new Error("AnthropicMessagesTransport requires fetchImpl");
    if (typeof now !== "function") throw new Error("AnthropicMessagesTransport requires now");
    this.#credentialResolver = credentialResolver;
    this.#endpointResolver = endpointResolver;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async *stream(snapshot, context, { signal, onSendStarted } = {}) {
    validateSnapshot(snapshot);
    const { request } = buildAnthropicMessagesRequest(snapshot, context);
    if (signal?.aborted) {
      yield { type: "terminal", outcome: "cancelled_before_send", payload: {} };
      return;
    }

    // Named resolver receives the immutable route only. It must not read
    // process environment, keychain, or a fallback account; this adapter
    // performs no alternative lookup if it declines.
    const credential = await this.#credentialResolver(snapshot);
    if (!credential || typeof credential.apiKey !== "string" || credential.apiKey.length < 1 || credential.apiKey.length > 4_096) {
      fail("credential_unavailable", "exact credential resolver did not return an API key");
    }
    const endpoint = parseUrl(await this.#endpointResolver(snapshot));
    if (signal?.aborted) {
      yield { type: "terminal", outcome: "cancelled_before_send", payload: {} };
      return;
    }

    let response;
    try {
      // This callback is the controller's durable send-start acknowledgement.
      // It runs exactly once immediately before the single raw fetch dispatch.
      onSendStarted?.();
      response = await this.#fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "accept": "text/event-stream",
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "x-api-key": credential.apiKey,
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      yield {
        type: "terminal",
        outcome: signal?.aborted ? "cancelled_after_send" : "transport_before_headers",
        payload: {},
      };
      return;
    }

    const now = this.#now();
    const providerRequestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
    const headerPayload = {
      httpStatus: response.status,
      ...(typeof providerRequestId === "string" && ID.test(providerRequestId) ? { providerRequestId } : {}),
    };
    yield { type: "headers", payload: headerPayload };

    if (!response.ok) {
      const body = await boundedErrorBody(response);
      yield normalizedHttpTerminal(response, body, now);
      return;
    }

    const blocks = new Map();
    let usage = null;
    let stopReason = null;
    let sawMessageStop = false;
    try {
      for await (const event of makeSseIterator(response.body, snapshot.maxOutputBytes, signal)) {
        if (!SSE_EVENTS.has(event.event)) fail("provider_frame_invalid", "unknown Anthropic SSE event");
        if (event.event === "ping") continue;
        const payload = parseSseData(event.data);
        if (event.event === "error") {
          const outcome = errorKind(payload) ?? "transport_before_headers";
          yield { type: "terminal", outcome, payload: headerPayload };
          return;
        }
        if (event.event === "message_start") {
          if (usage) fail("provider_frame_invalid", "duplicate message_start");
          if (!isPlainObject(payload.message)) fail("provider_frame_invalid", "message_start lacks message");
          usage = usageFrom(payload.message.usage ?? {});
          continue;
        }
        if (event.event === "content_block_start") {
          const start = normalizedBlockStart(payload);
          if (blocks.has(start.index)) fail("provider_frame_invalid", "duplicate content block index");
          blocks.set(start.index, { ...start, value: start.initial, closed: false });
          yield { type: "block_start", payload: start.blockType === "tool_call"
            ? { index: start.index, blockType: start.blockType, id: start.id, name: start.name }
            : { index: start.index, blockType: start.blockType } };
          if (start.initial) yield { type: start.blockType === "text" ? "text_delta" : "reasoning_delta", payload: { index: start.index, delta: start.initial } };
          continue;
        }
        if (event.event === "content_block_delta") {
          const block = blocks.get(payload.index);
          if (!block || block.closed) fail("provider_frame_invalid", "delta without open block");
          const delta = normalizedDelta(payload, block);
          if (delta === null) continue;
          boundedText(delta, "content block delta", snapshot.maxOutputBytes);
          block.value += delta;
          if (Buffer.byteLength(block.value) > snapshot.maxOutputBytes) fail("provider_frame_invalid", "content block exceeds output byte cap");
          yield { type: block.blockType === "text" ? "text_delta" : block.blockType === "reasoning" ? "reasoning_delta" : "tool_call_delta", payload: { index: block.index, delta } };
          continue;
        }
        if (event.event === "content_block_stop") {
          if (!Number.isSafeInteger(payload.index)) fail("provider_frame_invalid", "content_block_stop index is invalid");
          const block = blocks.get(payload.index);
          if (!block || block.closed) fail("provider_frame_invalid", "block stop without open block");
          block.closed = true;
          yield { type: "block_end", payload: { index: block.index, value: block.value } };
          continue;
        }
        if (event.event === "message_delta") {
          if (!isPlainObject(payload.delta) || !STOP_REASONS.has(payload.delta.stop_reason)) fail("provider_frame_invalid", "message_delta stop_reason is invalid");
          stopReason = payload.delta.stop_reason;
          usage = mergeUsage(usage, usageFrom(payload.usage ?? {}));
          continue;
        }
        if (event.event === "message_stop") {
          if (sawMessageStop) fail("provider_frame_invalid", "duplicate message_stop");
          sawMessageStop = true;
          continue;
        }
      }
    } catch (error) {
      if (error instanceof AnthropicMessagesTransportError || error instanceof ProviderProtocolError) {
        yield { type: "terminal", outcome: "malformed_provider_frame", payload: headerPayload };
        return;
      }
      yield { type: "terminal", outcome: signal?.aborted ? "cancelled_after_send" : "stream_truncated", payload: headerPayload };
      return;
    }

    if (!sawMessageStop || !stopReason || [...blocks.values()].some((block) => !block.closed)) {
      yield { type: "terminal", outcome: "stream_truncated", payload: headerPayload };
      return;
    }
    const finalUsage = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    yield { type: "usage", payload: finalUsage };
    if (stopReason === "max_tokens") {
      yield { type: "terminal", outcome: "unknown_finish", payload: { ...headerPayload, finishReason: stopReason, usage: finalUsage } };
      return;
    }
    const hasSemanticOutput = [...blocks.values()].some((block) => block.value.length > 0);
    yield {
      type: "terminal",
      outcome: hasSemanticOutput ? "succeeded_terminal" : "empty_response",
      payload: { ...headerPayload, finishReason: stopReason, usage: finalUsage },
    };
  }
}
