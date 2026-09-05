import { captureLosslessJson } from "./lossless-json.mjs";
import { captureProviderContext } from "./provider-context.mjs";
/**
 * Controller-owned text transport for OpenAI-compatible chat-completions
 * adapters such as the local Cursor subscription bridge. It intentionally
 * supports only the lossless text-only context accepted by the controller
 * proxy; tools, images and tool-result replay fail closed before dispatch.
 */
export const OPENAI_CHAT_COMPLETIONS_ADAPTER_ID = "openai-chat-completions@1";
export const OPENAI_CHAT_COMPLETIONS_DIALECT = "openai-completions";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ERROR_BYTES = 32 * 1024;
const MAX_SSE_LINE_BYTES = 256 * 1024;

export class OpenAIChatCompletionsTransportError extends Error {
  constructor(reasonCode, detail) {
    super(detail ? `${reasonCode}: ${detail}` : reasonCode);
    this.name = "OpenAIChatCompletionsTransportError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, detail) {
  throw new OpenAIChatCompletionsTransportError(reasonCode, detail);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") fail("route_invalid", "route snapshot is unavailable");
  if (snapshot.apiDialect !== OPENAI_CHAT_COMPLETIONS_DIALECT || snapshot.adapterId !== OPENAI_CHAT_COMPLETIONS_ADAPTER_ID) {
    fail("route_unsupported", "snapshot is not an approved OpenAI chat-completions route");
  }
  if (typeof snapshot.model !== "string" || !ID.test(snapshot.model)) fail("route_invalid", "model is invalid");
  for (const key of ["maxInputBytes", "maxOutputBytes", "maxOutputTokens"]) {
    if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 1) fail("route_invalid", `${key} is invalid`);
  }
  if (!["none", "short", "long"].includes(snapshot.cacheRetention)) fail("route_invalid", "cacheRetention is invalid");
}

function captureRequestContext(snapshot, context) {
  try {
    return captureProviderContext(context, { maxBytes: snapshot.maxInputBytes });
  } catch (error) {
    fail("context_invalid", error instanceof Error ? error.message : "context validation failed");
  }
}

function requestFromCapturedContext(snapshot, captured) {
  if (captured.value.tools.length > 0) fail("context_invalid", "tools are outside the text-only OpenAI proxy contract");
  const messages = [];
  if (captured.value.systemPrompt) messages.push({ role: "system", content: captured.value.systemPrompt });
  for (const [index, message] of captured.value.messages.entries()) {
    if (typeof message.content !== "string") fail("context_invalid", `messages[${index}].content cannot be replayed by this adapter`);
    messages.push({ role: message.role, content: message.content });
  }
  if (messages.length === 0) fail("context_invalid", "context has no replayable messages");
  const request = {
    model: snapshot.model,
    messages,
    max_tokens: snapshot.maxOutputTokens,
    stream: true,
  };
  return Object.freeze({ request: captureLosslessJson(request).value, contextDigest: captured.digest });
}

function parseEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { fail("endpoint_invalid", "endpoint is not a URL"); }
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" || endpoint.hostname === "::1";
  if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail("endpoint_invalid", "endpoint must be credential-free HTTPS or loopback HTTP");
  }
  return endpoint.toString();
}

function authHeadersForCredential(credential) {
  if (!isPlainObject(credential)) fail("credential_unavailable", "exact credential resolver returned an invalid credential");
  const keys = Object.keys(credential).sort().join(",");
  let token;
  if (keys === "apiKey") token = credential.apiKey;
  else if (keys === "accessToken,type" && credential.type === "oauth") token = credential.accessToken;
  else fail("credential_unavailable", "exact credential resolver returned an unsupported credential");
  if (typeof token !== "string" || token.length < 1 || token.length > 4_096 || /[\0\r\n]/.test(token)) {
    fail("credential_unavailable", "exact credential resolver returned an invalid bearer token");
  }
  return Object.freeze({ authorization: `Bearer ${token}` });
}

async function boundedErrorBody(response) {
  if (!response?.body || typeof response.body.getReader !== "function") return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_BYTES) return null;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      const parsed = JSON.parse(text);
      return isPlainObject(parsed) ? parsed : null;
    } catch { return null; }
  } catch { return null; }
}

function providerReason(body) {
  const error = isPlainObject(body?.error) ? body.error : null;
  const type = typeof error?.type === "string" ? error.type : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const joined = `${type} ${message}`.toLowerCase();
  if (joined.includes("extra usage") || joined.includes("plan limits")) return "subscription_extra_usage_required";
  if (joined.includes("model") && (joined.includes("not found") || joined.includes("does not exist") || joined.includes("invalid") || joined.includes("unknown"))) return "invalid_model";
  if (joined.includes("max_tokens") || joined.includes("max tokens") || joined.includes("maximum tokens")) return "invalid_max_tokens";
  if (joined.includes("message") || joined.includes("content")) return "invalid_messages";
  if (joined.includes("tool")) return "invalid_tools";
  if (joined.includes("oauth") || joined.includes("subscription")) return "oauth_request_rejected";
  if (type === "invalid_request_error") return "invalid_request";
  return undefined;
}

function normalizedHttpTerminal(response, body) {
  const status = response.status;
  const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
  const base = {
    httpStatus: status,
    ...(typeof requestId === "string" && ID.test(requestId) ? { providerRequestId: requestId } : {}),
  };
  if (status === 429) return { type: "terminal", outcome: "rate_limited", payload: base };
  if (status === 401 || status === 403) return { type: "terminal", outcome: "auth_fatal", payload: base };
  const reason = providerReason(body);
  return {
    type: "terminal",
    outcome: status >= 400 && status < 500 ? "rejected_before_send" : "transport_before_headers",
    payload: { ...base, ...(reason === undefined ? {} : { providerReason: reason }) },
  };
}

async function* sseEvents(body, maxBytes, signal) {
  if (!body || typeof body.getReader !== "function") fail("provider_frame_invalid", "streaming response body is unavailable");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let received = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) fail("provider_frame_invalid", "provider SSE exceeds output byte cap");
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer) > MAX_SSE_LINE_BYTES) fail("provider_frame_invalid", "provider SSE line exceeds cap");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data:")) {
          if (line === "" || line.startsWith(":")) continue;
          fail("provider_frame_invalid", "unsupported OpenAI SSE field");
        }
        const data = line.slice(5).trimStart();
        if (data === "[DONE]") {
          yield { done: true };
          return;
        }
        if (!data) fail("provider_frame_invalid", "OpenAI SSE data is empty");
        let parsed;
        try { parsed = JSON.parse(data); } catch { fail("provider_frame_invalid", "OpenAI SSE data is invalid JSON"); }
        if (!isPlainObject(parsed)) fail("provider_frame_invalid", "OpenAI SSE data must be an object");
        yield { data: parsed };
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) fail("stream_truncated", "OpenAI SSE ended with an unterminated line");
  } finally {
    try { await reader.cancel(); } catch { /* best effort */ }
  }
}

function usageFrom(value) {
  if (!isPlainObject(value)) return undefined;
  const input = value.prompt_tokens;
  const output = value.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return undefined;
  return { input, output, cacheRead: 0, cacheWrite: 0 };
}

export function buildOpenAIChatCompletionsRequest(snapshot, context) {
  validateSnapshot(snapshot);
  return requestFromCapturedContext(snapshot, captureRequestContext(snapshot, context));
}

export class OpenAIChatCompletionsTransport {
  #credentialResolver;
  #endpointResolver;
  #fetch;
  #now;

  constructor({ credentialResolver, endpointResolver, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    if (typeof credentialResolver !== "function") throw new Error("OpenAIChatCompletionsTransport requires credentialResolver");
    if (typeof endpointResolver !== "function") throw new Error("OpenAIChatCompletionsTransport requires endpointResolver");
    if (typeof fetchImpl !== "function") throw new Error("OpenAIChatCompletionsTransport requires fetchImpl");
    if (typeof now !== "function") throw new Error("OpenAIChatCompletionsTransport requires now");
    this.#credentialResolver = credentialResolver;
    this.#endpointResolver = endpointResolver;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async *stream(snapshot, context, { signal, onSendStarted } = {}) {
    validateSnapshot(snapshot);
    const captured = captureRequestContext(snapshot, context);
    // Compatibility is decidable without credentials. Preserve the adapter's strict
    // text-only boundary and reject image/tool replay before exact secret resolution.
    const { request } = requestFromCapturedContext(snapshot, captured);
    if (signal?.aborted) {
      yield { type: "terminal", outcome: "cancelled_before_send", payload: {} };
      return;
    }
    const credential = await this.#credentialResolver(snapshot);
    const auth = authHeadersForCredential(credential);
    const endpoint = parseEndpoint(await this.#endpointResolver(snapshot));
    if (signal?.aborted) {
      yield { type: "terminal", outcome: "cancelled_before_send", payload: {} };
      return;
    }
    let response;
    try {
      onSendStarted?.();
      response = await this.#fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { accept: "text/event-stream", "content-type": "application/json", ...auth },
        body: JSON.stringify(request),
      });
    } catch {
      yield { type: "terminal", outcome: signal?.aborted ? "cancelled_after_send" : "transport_before_headers", payload: {} };
      return;
    }
    const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined;
    const headerPayload = {
      httpStatus: response.status,
      ...(typeof requestId === "string" && ID.test(requestId) ? { providerRequestId: requestId } : {}),
    };
    yield { type: "headers", payload: headerPayload };
    if (!response.ok) {
      const body = await boundedErrorBody(response);
      yield normalizedHttpTerminal(response, body);
      return;
    }

    let blockOpen = false;
    let text = "";
    let usage;
    let stopped = false;
    try {
      for await (const event of sseEvents(response.body, snapshot.maxOutputBytes, signal)) {
        if (event.done) {
          stopped = true;
          break;
        }
        const choice = Array.isArray(event.data.choices) ? event.data.choices[0] : undefined;
        if (event.data.usage) usage = usageFrom(event.data.usage) ?? usage;
        const delta = choice?.delta;
        if (delta?.tool_calls || delta?.function_call) fail("provider_frame_invalid", "Cursor tool calls are outside the text-only proxy contract");
        const value = delta?.content;
        if (value !== undefined) {
          if (typeof value !== "string") fail("provider_frame_invalid", "OpenAI content delta is not text");
          if (!blockOpen) {
            blockOpen = true;
            yield { type: "block_start", payload: { index: 0, blockType: "text" } };
          }
          text += value;
          if (Buffer.byteLength(text) > snapshot.maxOutputBytes) fail("provider_frame_invalid", "text block exceeds output byte cap");
          if (value) yield { type: "text_delta", payload: { index: 0, delta: value } };
        }
        const finish = choice?.finish_reason;
        if (finish !== undefined && finish !== null) {
          if (finish !== "stop") fail("unknown_finish", `unsupported OpenAI finish reason ${String(finish).slice(0, 32)}`);
          if (blockOpen) {
            yield { type: "block_end", payload: { index: 0, value: text } };
            blockOpen = false;
          }
        }
      }
      if (!stopped) {
        yield { type: "terminal", outcome: "stream_truncated", payload: headerPayload };
        return;
      }
      if (blockOpen) yield { type: "block_end", payload: { index: 0, value: text } };
      if (!text) {
        yield { type: "terminal", outcome: "empty_response", payload: headerPayload };
        return;
      }
      if (usage) yield { type: "usage", payload: usage };
      yield { type: "terminal", outcome: "succeeded_terminal", payload: headerPayload };
    } catch (error) {
      if (error instanceof OpenAIChatCompletionsTransportError) {
        yield { type: "terminal", outcome: error.reasonCode === "unknown_finish" ? "unknown_finish" : "malformed_provider_frame", payload: headerPayload };
      } else {
        yield { type: "terminal", outcome: signal?.aborted ? "cancelled_after_send" : "malformed_provider_frame", payload: headerPayload };
      }
    }
  }
}
