import assert from "node:assert/strict";
import test from "node:test";
import { proxyCanonicalContext } from "../src/proxy-context.mjs";
import { captureProviderContext } from "../src/provider-context.mjs";

const read = { name: "read", description: "Read one owned path.", parameters: { type: "object", properties: { path: { type: "string" } } } };
const find = { name: "find", description: "Find owned paths.", parameters: { type: "object" } };
const system = { role: "system", content: "Exact owner instructions.", timestamp: 0, sections: { tools: "read is available", transient: "old" }, toolsAdded: [read] };

test("native transcript preserves ordered system sections/tool changes and tool round trip", () => {
  const source = { messages: [system, { role: "user", content: "Read README.md", timestamp: 1 },
    { role: "assistant", durationMs: 12, content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } }] },
    { role: "toolResult", durationMs: 1, toolName: "read", toolCallId: "call_read", isError: false, content: [{ type: "text", text: "owned content" }] },
    { role: "system", timestamp: 2, content: "New tool phase.", sections: { tools: "find only", transient: null }, toolsRemoved: [{ name: "read" }], toolsAdded: [find] },
    { role: "user", content: "Find paths", timestamp: 3 },
  ] };
  const result = proxyCanonicalContext(source);
  assert.equal(result.systemPrompt, "");
  assert.equal(result.messages.length, source.messages.length);
  assert.deepEqual(result.tools.map(tool => tool.name), ["find"]);
  assert.deepEqual(result.messages[4].sections, { tools: "find only", transient: null });
  assert.deepEqual(result.messages[4].toolsRemoved, [{ name: "read" }]);
  assert.equal(result.messages[0].toolsAdded[0].inputSchema.type, "object");
  assert.equal(Object.hasOwn(result.messages[0].toolsAdded[0], "parameters"), false);
  assert.equal(result.messages[3].content, "owned content");
  assert.notEqual(result.messages[0].sections, system.sections);
  assert.throws(() => { result.messages[0].sections.tools = "changed"; }, TypeError);
});

test("native transcript cannot smuggle legacy/system ambiguity or widen tool approval", () => {
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "another prompt", messages: [system] }), /mixes legacy/);
  assert.throws(() => proxyCanonicalContext({ tools: [], messages: [system] }), /mixes legacy/);
  assert.throws(() => proxyCanonicalContext({ messages: [{ ...system, privileged: true }] }), /unknown field privileged/);
  assert.throws(() => proxyCanonicalContext({ messages: [{ ...system, sections: { tools: { execute: "bad" } } }] }), /bounded printable text/);
  assert.throws(() => proxyCanonicalContext({ messages: [system, { role: "system", content: "", toolsRemoved: [{ name: "write" }] }] }), /removes an unknown/);
  assert.throws(() => proxyCanonicalContext({ messages: [system, { role: "assistant", content: [{ type: "toolCall", id: "call_write", name: "write", arguments: {} }] }] }), /not an approved tool/);
  const canonical = proxyCanonicalContext({ messages: [system] });
  assert.throws(() => captureProviderContext({ ...canonical, tools: [] }), /final tools do not match/);
  assert.throws(() => captureProviderContext({ ...canonical, systemPrompt: "extra" }), /mixes legacy/);
});

test("native system updates cannot break tool-call/result ordering or redeclare a removed tool implicitly", () => {
  const call = { role: "assistant", content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }] };
  assert.throws(() => proxyCanonicalContext({ messages: [system, call, { role: "system", content: "do not interrupt tool result" }] }), /interrupts unresolved/);
  assert.throws(() => proxyCanonicalContext({ messages: [system, { role: "system", content: "", toolsRemoved: [{ name: "read" }] }, call] }), /not an approved tool/);
});
