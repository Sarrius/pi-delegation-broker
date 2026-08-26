import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENAI_CHAT_COMPLETIONS_ADAPTER_ID,
  OpenAIChatCompletionsTransport,
  OpenAIChatCompletionsTransportError,
  buildOpenAIChatCompletionsRequest,
} from "../src/openai-chat-completions-transport.mjs";

function snapshot(overrides = {}) {
  return {
    apiDialect: "openai-completions",
    adapterId: OPENAI_CHAT_COMPLETIONS_ADAPTER_ID,
    model: "cursor-grok-4.6",
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 64 * 1024,
    maxOutputTokens: 1_024,
    cacheRetention: "none",
    reasoningEffort: null,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    systemPrompt: "Be concise.",
    messages: [{ role: "user", content: "Reply with CURSOR_CANARY_OK." }],
    tools: [],
    ...overrides,
  };
}

function sse(chunks, { status = 200, headers = {} } = {}) {
  const body = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

async function collect(transport, route = snapshot(), value = context()) {
  return Array.fromAsync(transport.stream(route, value));
}

function successSse() {
  return sse([
    { id: "chat-1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id: "chat-1", choices: [{ index: 0, delta: { content: "CURSOR_" }, finish_reason: null }] },
    { id: "chat-1", choices: [{ index: 0, delta: { content: "CANARY_OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    "[DONE]",
  ], { headers: { "request-id": "cursor-request-1" } });
}

function adapter({ credentialResolver = async () => ({ type: "oauth", accessToken: "cursor-access-token" }), endpointResolver = async () => "http://127.0.0.1:52164/v1/chat/completions", fetchImpl } = {}) {
  return new OpenAIChatCompletionsTransport({ credentialResolver, endpointResolver, fetchImpl });
}

test("builds a bounded text-only OpenAI request from the frozen context", () => {
  const built = buildOpenAIChatCompletionsRequest(snapshot(), context());
  assert.deepEqual(built.request, {
    model: "cursor-grok-4.6",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Reply with CURSOR_CANARY_OK." },
    ],
    max_tokens: 1_024,
    stream: true,
  });
});

test("streams one exact Cursor bearer route and normalizes OpenAI SSE", async () => {
  let observed;
  const events = await collect(adapter({
    fetchImpl: async (url, options) => {
      observed = { url, options, body: JSON.parse(options.body) };
      return successSse();
    },
  }));
  assert.deepEqual(events.map((event) => event.type), ["headers", "block_start", "text_delta", "text_delta", "block_end", "usage", "terminal"]);
  assert.equal(events.at(-1).outcome, "succeeded_terminal");
  assert.deepEqual(events.at(-2).payload, { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(observed.url, "http://127.0.0.1:52164/v1/chat/completions");
  assert.equal(observed.options.headers.authorization, "Bearer cursor-access-token");
  assert.equal(observed.options.headers["x-api-key"], undefined);
  assert.equal(observed.body.model, "cursor-grok-4.6");
  assert.equal(observed.body.stream, true);
});

test("Cursor subscription policy rejection is classified without retaining the provider message", async () => {
  const events = await collect(adapter({
    fetchImpl: async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "third-party subscription requires extra usage" } }), { status: 400 }),
  }));
  assert.deepEqual(events.at(-1), {
    type: "terminal",
    outcome: "rejected_before_send",
    payload: { httpStatus: 400, providerReason: "subscription_extra_usage_required" },
  });
  assert.equal(JSON.stringify(events).includes("third-party subscription"), false);
});

test("tool-bearing context and malformed provider frames fail closed", async () => {
  let sends = 0;
  const transport = adapter({ fetchImpl: async () => { sends += 1; return successSse(); } });
  await assert.rejects(() => collect(transport, snapshot(), context({ tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }] })), OpenAIChatCompletionsTransportError);
  assert.equal(sends, 0);

  const malformed = await collect(adapter({ fetchImpl: async () => sse([{ id: "chat-1", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }, "not-json"]) }));
  assert.equal(malformed.at(-1).outcome, "malformed_provider_frame");
});

test("OpenAI stream without DONE is never treated as success", async () => {
  const events = await collect(adapter({ fetchImpl: async () => sse([{ id: "chat-1", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }]) }));
  assert.equal(events.at(-1).outcome, "stream_truncated");
});
