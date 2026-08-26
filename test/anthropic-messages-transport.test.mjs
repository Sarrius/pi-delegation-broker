import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_ADAPTER_ID,
  AnthropicMessagesTransport,
  AnthropicMessagesTransportError,
  buildAnthropicMessagesRequest,
} from "../src/anthropic-messages-transport.mjs";
import { createAttemptRouteSnapshot } from "../src/provider-protocol.mjs";

const ZERO64 = "0".repeat(64);
const ONE64 = "1".repeat(64);

function snapshot(overrides = {}) {
  return createAttemptRouteSnapshot({
    schemaVersion: 1,
    controllerEpoch: "epoch-1",
    attemptId: "attempt-1",
    streamId: "stream-1",
    taskId: "task-1",
    leaseId: "lease-1",
    fencingToken: 1,
    registryFingerprint: ZERO64,
    registryVersion: 1,
    resourceId: "anthropic-r1",
    capacityGroup: "anthropic-g1",
    accountAlias: "anthropic-a1",
    provider: "anthropic",
    model: "claude-test",
    reasoningEffort: null,
    apiDialect: "anthropic-messages",
    endpointId: "anthropic-messages-primary",
    adapterId: ANTHROPIC_MESSAGES_ADAPTER_ID,
    credentialRefFingerprint: ONE64,
    cacheRetention: "short",
    retryOwner: "broker",
    sdkMaxRetries: 0,
    deadlineAt: 1_800_000_000_000,
    maxInputBytes: 512 * 1024,
    maxOutputBytes: 128 * 1024,
    maxOutputTokens: 1024,
    ...overrides,
  });
}

function context(overrides = {}) {
  return {
    systemPrompt: "You are a careful coding agent.",
    messages: [{ role: "user", content: "Review this patch." }],
    tools: [{
      name: "read",
      description: "Read one bounded file.",
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
    }],
    ...overrides,
  };
}

function sse(events) {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req-1" } });
}

function successEvents({ stopReason = "end_turn" } = {}) {
  return [
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function adapter({ fetchImpl, credentialResolver, endpointResolver, now } = {}) {
  return new AnthropicMessagesTransport({
    fetchImpl: fetchImpl ?? (async () => sse(successEvents())),
    credentialResolver: credentialResolver ?? (async () => ({ apiKey: "test-key" })),
    endpointResolver: endpointResolver ?? (async () => "https://gateway.example/v1/messages"),
    now: now ?? (() => 1_000_000),
  });
}

async function collect(transport, route = snapshot(), input = context(), options = {}) {
  return Array.fromAsync(transport.stream(route, input, options));
}

test("build request is lossless, closed-schema, and makes cache retention explicit", () => {
  const short = buildAnthropicMessagesRequest(snapshot({ cacheRetention: "short" }), context());
  assert.equal(short.request.system[0].cache_control.type, "ephemeral");
  assert.equal(short.request.system[0].cache_control.ttl, undefined);
  assert.equal(short.request.tools[0].input_schema.type, "object");

  const long = buildAnthropicMessagesRequest(snapshot({ cacheRetention: "long" }), context());
  assert.equal(long.request.system[0].cache_control.ttl, "1h");

  const none = buildAnthropicMessagesRequest(snapshot({ cacheRetention: "none" }), context());
  assert.equal(none.request.system, "You are a careful coding agent.");

  assert.throws(
    () => buildAnthropicMessagesRequest(snapshot(), context({ tools: [{ name: "read", description: "x", schema: {} }] })),
    /unknown field schema/,
  );
  assert.throws(
    () => buildAnthropicMessagesRequest(snapshot(), context({ messages: [{ role: "user", content: [{ type: "text", text: "not silently coerced" }] }] })),
    /bounded printable text/,
  );
});

test("transport resolves exactly one named credential and makes exactly one raw dispatch", async () => {
  let resolved = 0;
  let sent = 0;
  let observed;
  const transport = adapter({
    credentialResolver: async (route) => {
      resolved += 1;
      assert.equal(route.accountAlias, "anthropic-a1");
      return { apiKey: "exact-key" };
    },
    fetchImpl: async (url, options) => {
      sent += 1;
      observed = { url, options, body: JSON.parse(options.body) };
      return sse(successEvents());
    },
  });
  const events = await collect(transport, snapshot({ cacheRetention: "long" }));
  assert.equal(resolved, 1);
  assert.equal(sent, 1);
  assert.equal(observed.url, "https://gateway.example/v1/messages");
  assert.equal(observed.options.redirect, "error");
  assert.equal(observed.options.headers["anthropic-version"], ANTHROPIC_API_VERSION);
  assert.equal(observed.options.headers["x-api-key"], "exact-key");
  assert.equal(observed.body.system[0].cache_control.ttl, "1h");
  assert.deepEqual(events.map((event) => event.type), ["headers", "block_start", "text_delta", "block_end", "usage", "terminal"]);
  assert.equal(events.at(-1).outcome, "succeeded_terminal");
  assert.deepEqual(events.find((event) => event.type === "usage").payload, {
    input: 11, output: 3, cacheRead: 7, cacheWrite: 2,
  });
});

test("Anthropic OAuth credentials use Claude Code bearer headers and identity", async () => {
  let observed;
  const transport = adapter({
    credentialResolver: async () => ({ type: "oauth", accessToken: "sk-ant-oat-test-access" }),
    fetchImpl: async (url, options) => {
      observed = { url, options, body: JSON.parse(options.body) };
      return sse(successEvents());
    },
  });
  const events = await collect(transport, snapshot({ cacheRetention: "short" }), context({ tools: [] }));
  assert.equal(events.at(-1).outcome, "succeeded_terminal");
  assert.equal(observed.options.headers.authorization, "Bearer sk-ant-oat-test-access");
  assert.equal(observed.options.headers["x-api-key"], undefined);
  assert.equal(observed.options.headers["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14");
  assert.equal(observed.options.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(observed.options.headers["user-agent"], "claude-cli/2.1.75");
  assert.equal(observed.options.headers["x-app"], "cli");
  assert.equal(observed.body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(observed.body.system[1].text, "You are a careful coding agent.");
  assert.deepEqual(observed.body.thinking, { type: "disabled" });
});

test("unsupported controller credential shapes fail closed before dispatch", async () => {
  let sent = 0;
  const transport = adapter({
    credentialResolver: async () => ({ type: "oauth", accessToken: "not-valid\naccess" }),
    fetchImpl: async () => { sent += 1; return sse(successEvents()); },
  });
  await assert.rejects(() => collect(transport), (error) => error instanceof AnthropicMessagesTransportError && error.reasonCode === "credential_unavailable");
  assert.equal(sent, 0);
});

test("named credential miss fails closed even with an unrelated ambient API key", async () => {
  let sent = 0;
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "ambient-key-that-must-not-be-read";
  try {
    const transport = adapter({
      credentialResolver: async () => undefined,
      fetchImpl: async () => { sent += 1; return sse(successEvents()); },
    });
    await assert.rejects(() => collect(transport), (error) => error instanceof AnthropicMessagesTransportError && error.reasonCode === "credential_unavailable");
    assert.equal(sent, 0);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("abort before exact credential resolution is a before-send terminal without dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  let resolved = 0;
  let sent = 0;
  const events = await collect(adapter({
    credentialResolver: async () => { resolved += 1; return { apiKey: "never" }; },
    fetchImpl: async () => { sent += 1; return sse(successEvents()); },
  }), snapshot(), context(), { signal: controller.signal });
  assert.deepEqual(events, [{ type: "terminal", outcome: "cancelled_before_send", payload: {} }]);
  assert.equal(resolved, 0);
  assert.equal(sent, 0);
});

test("send acknowledgement happens once before a single failed fetch and classifies non-abort transport loss", async () => {
  let sends = 0;
  let fetches = 0;
  const events = await collect(adapter({
    fetchImpl: async () => { fetches += 1; throw new Error("socket reset"); },
  }), snapshot(), context(), { onSendStarted: () => { sends += 1; } });
  assert.equal(sends, 1);
  assert.equal(fetches, 1);
  assert.deepEqual(events, [{ type: "terminal", outcome: "transport_before_headers", payload: {} }]);
});

test("HTTP 429 uses bounded provider Retry-After and does not invoke a retry", async () => {
  let sent = 0;
  const transport = adapter({
    fetchImpl: async () => {
      sent += 1;
      return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "2", "request-id": "req-429" },
      });
    },
  });
  const events = await collect(transport);
  assert.equal(sent, 1);
  assert.deepEqual(events, [
    { type: "headers", payload: { httpStatus: 429, providerRequestId: "req-429" } },
    { type: "terminal", outcome: "rate_limited", payload: { httpStatus: 429, providerRequestId: "req-429", retryAfterMs: 2_000 } },
  ]);
});

test("provider errors classify auth, quota, context, and unknown 4xx without leaking raw body", async () => {
  const cases = [
    { status: 401, body: { error: { type: "authentication_error", message: "do not expose" } }, outcome: "auth_fatal" },
    { status: 400, body: { error: { type: "invalid_request_error", message: "prompt is too long" } }, outcome: "context_window_exceeded" },
    { status: 400, body: { error: { type: "invalid_request_error", message: "credit balance exhausted" } }, outcome: "quota_fatal" },
    { status: 422, body: { error: { type: "invalid_request_error", message: "bad input" } }, outcome: "rejected_before_send" },
    { status: 400, body: { error: { type: "invalid_request_error", message: "Third-party apps now draw from your extra usage, not your plan limits." } }, outcome: "rejected_before_send", providerReason: "subscription_extra_usage_required" },
  ];
  for (const item of cases) {
    const events = await collect(adapter({ fetchImpl: async () => new Response(JSON.stringify(item.body), { status: item.status }) }));
    assert.equal(events.at(-1).outcome, item.outcome);
    if (item.providerReason) assert.equal(events.at(-1).payload.providerReason, item.providerReason);
    assert.equal(JSON.stringify(events).includes("do not expose"), false);
  }
});

test("SSE success supports text and tool blocks while preserving tool identity", async () => {
  const events = await collect(adapter({ fetchImpl: async () => sse([
    { event: "message_start", data: { message: { usage: { input_tokens: 1 } } } },
    { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.mjs\"}" } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "message_delta", data: { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: {} },
  ]) }));
  assert.deepEqual(events.map((event) => event.type), ["headers", "block_start", "tool_call_delta", "block_end", "usage", "terminal"]);
  assert.deepEqual(events[1].payload, { index: 0, blockType: "tool_call", id: "tool-1", name: "read" });
  assert.equal(events[3].payload.value, "{\"path\":\"a.mjs\"}");
  assert.equal(events.at(-1).outcome, "succeeded_terminal");
});

test("max_tokens, EOF, and malformed provider frames never become success", async () => {
  const maxTokens = await collect(adapter({ fetchImpl: async () => sse(successEvents({ stopReason: "max_tokens" })) }));
  assert.equal(maxTokens.at(-1).outcome, "unknown_finish");

  const truncated = await collect(adapter({ fetchImpl: async () => sse(successEvents().slice(0, -1)) }));
  assert.equal(truncated.at(-1).outcome, "stream_truncated");

  const malformed = await collect(adapter({ fetchImpl: async () => sse([
    { event: "message_start", data: { message: { usage: {} } } },
    { event: "mystery", data: { x: 1 } },
  ]) }));
  assert.equal(malformed.at(-1).outcome, "malformed_provider_frame");
});

test("malformed context and unsupported adapter route fail before credential resolution or send", async () => {
  let resolved = 0;
  let sent = 0;
  const transport = adapter({
    credentialResolver: async () => { resolved += 1; return { apiKey: "x" }; },
    fetchImpl: async () => { sent += 1; return sse(successEvents()); },
  });
  await assert.rejects(() => collect(transport, snapshot(), context({ extra: true })), /context has unknown field/);
  await assert.rejects(() => collect(transport, snapshot({ apiDialect: "other" }), context()), /apiDialect/);
  assert.equal(resolved, 0);
  assert.equal(sent, 0);
});
