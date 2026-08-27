import assert from "node:assert/strict";
import test from "node:test";
import { captureProviderContext } from "../src/provider-context.mjs";

function context(overrides = {}) {
  return {
    systemPrompt: "Inspect only the supplied repository state.",
    messages: [{ role: "user", content: "Find the failing test." }],
    tools: [{
      name: "read",
      description: "Read a bounded path.",
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
    }],
    ...overrides,
  };
}

test("provider context captures one frozen closed-schema snapshot", () => {
  const input = context();
  const captured = captureProviderContext(input);
  input.messages[0].content = "mutated after ingress";
  assert.equal(captured.value.messages[0].content, "Find the failing test.");
  assert.throws(() => { captured.value.tools.push({}); }, TypeError);
  assert.match(captured.canonical, /systemPrompt/);
});

test("provider context rejects ambiguous replay/options/modalities instead of dropping them", () => {
  assert.throws(() => captureProviderContext(context({ options: {} })), /unknown field options/);
  assert.throws(() => captureProviderContext(context({ providerResponseId: "opaque-state" })), /unknown field providerResponseId/);
  assert.throws(() => captureProviderContext(context({ messages: [{ role: "user", content: [{ type: "text", text: "not silently transformed" }] }] })), /bounded printable text/);
  assert.throws(() => captureProviderContext(context({ tools: [{ name: "read", description: "x", schema: {} }] })), /unknown field schema/);
});

test("provider context rejects duplicate tools, unsupported roles, and non-schema tool definitions", () => {
  assert.throws(() => captureProviderContext(context({
    tools: [
      { name: "read", description: "x", inputSchema: {} },
      { name: "read", description: "y", inputSchema: {} },
    ],
  })), /duplicated/);
  assert.throws(() => captureProviderContext(context({ messages: [{ role: "tool", content: "x" }] })), /role is unsupported/);
  assert.throws(() => captureProviderContext(context({ tools: [{ name: "read", description: "x", inputSchema: [] }] })), /JSON Schema object/);
});

test("provider context validates tool-call and tool-result replay as a closed conversation", () => {
  const captured = captureProviderContext(context({
    messages: [
      { role: "user", content: "read greeting.txt" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "greeting.txt" } }] },
      { role: "toolResult", toolCallId: "call_1", toolName: "read", content: "hello", isError: false },
    ],
  }));
  assert.equal(captured.value.messages[1].content[0].arguments.path, "greeting.txt");
  assert.equal(captured.value.messages[2].isError, false);
  assert.throws(() => captureProviderContext(context({
    messages: [{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }] }],
  })), /not an approved tool/);
  assert.throws(() => captureProviderContext(context({
    messages: [{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "missing", isError: true }],
  })), /no matching assistant tool call/);
  assert.throws(() => captureProviderContext(context({
    messages: [{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }] }],
  })), /unresolved tool calls/);
});
