import assert from "node:assert/strict";
import test from "node:test";

import { proxyCanonicalContext, proxyTerminalError } from "../src/proxy-context.mjs";

test("proxy bridge preserves text and controller-approved Codex compound tool replay", () => {
  const context = proxyCanonicalContext({
    systemPrompt: "Be concise.",
    messages: [
      { role: "user", content: [{ type: "text", text: "read greeting.txt" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "greeting.txt" } }] },
      { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: [{ type: "text", text: "hello" }], isError: false },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
    tools: [{
      name: "read",
      description: "Read one bounded path.",
      parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
      label: "Read",
      execute: () => { throw new Error("must never cross the proxy"); },
    }],
  });
  assert.deepEqual(context, {
    systemPrompt: "Be concise.",
    messages: [
      { role: "user", content: "read greeting.txt" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "greeting.txt" } }] },
      { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: "hello", isError: false },
      { role: "assistant", content: "done" },
    ],
    tools: [{
      name: "read",
      description: "Read one bounded path.",
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
    }],
  });
  assert.equal(Object.hasOwn(context.tools[0], "execute"), false);
});

test("proxy preserves Cursor Grok's LF-joined tool-call identity across replay", () => {
  const toolCallId = "call_2\nfc_2";
  const context = proxyCanonicalContext({
    systemPrompt: "Be concise.",
    messages: [
      { role: "user", content: "read README.md" },
      { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "README.md" } }] },
      { role: "toolResult", toolCallId, toolName: "read", content: "ok", isError: false },
    ],
    tools: [{ name: "read", description: "Read one bounded path.", parameters: { type: "object" } }],
  });
  assert.equal(context.messages[1].content[0].id, toolCallId);
  assert.equal(context.messages[2].toolCallId, toolCallId);
});

test("proxy preserves bounded image blocks from read tool results for a vision route", () => {
  const image = { type: "image", data: "iVBORw==", mimeType: "image/png" };
  const context = proxyCanonicalContext({
    systemPrompt: "Review the supplied logo.",
    messages: [
      { role: "user", content: [{ type: "text", text: "inspect logo.png" }, image] },
      { role: "assistant", content: [{ type: "toolCall", id: "call_image", name: "read", arguments: { path: "logo.png" } }] },
      { role: "toolResult", toolCallId: "call_image", toolName: "read", content: [{ type: "text", text: "Image Size: 64x64." }, image], isError: false },
    ],
    tools: [{ name: "read", description: "Read one bounded path.", parameters: { type: "object" } }],
  });
  assert.deepEqual(context.messages[0].content, [{ type: "text", text: "inspect logo.png" }, image]);
  assert.deepEqual(context.messages[2].content, [{ type: "text", text: "Image Size: 64x64." }, image]);
  assert.notEqual(context.messages[0].content[1], image, "provider context must be detached");
});

test("proxy accepts an image-bearing context larger than the old 512 KiB text-only ceiling", () => {
  const data = "a".repeat(700_000);
  const context = proxyCanonicalContext({
    systemPrompt: "Inspect.",
    messages: [{ role: "user", content: [{ type: "image", data, mimeType: "image/jpeg" }] }],
    tools: [],
  });
  assert.equal(context.messages[0].content[0].data.length, data.length);
});

test("proxy makes non-printable tool output safe for the next provider turn", () => {
  const context = proxyCanonicalContext({
    systemPrompt: "Be concise.",
    messages: [
      { role: "user", content: "inspect the file" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_binary", name: "read", arguments: { path: ".git/index" } }] },
      { role: "toolResult", toolCallId: "call_binary", toolName: "read", content: [{ type: "text", text: "DIRC\0\u001b\u007fdata" }], isError: false },
    ],
    tools: [{ name: "read", description: "Read one bounded path.", parameters: { type: "object" } }],
  });
  assert.equal(
    context.messages[2].content,
    "[Broker escaped 3 non-printable control characters in this tool result.]\nDIRC\\u0000\\u001b\\u007fdata",
  );
});

test("proxy fails closed on unsupported modalities, replay state, and unapproved tools", () => {
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "", messages: [], tools: [{ name: "read", description: "x" }] }), /parameters is required/);
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "", messages: [{ role: "user", content: [{ type: "image", data: "x" }] }], tools: [] }), /unsupported image metadata|unknown field|mimeType/);
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "", messages: [{ role: "user", content: [{ type: "image", data: "not-base64!", mimeType: "image/png" }] }], tools: [] }), /canonical base64/);
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "", messages: [{ role: "user", content: [{ type: "image", data: "eA==", mimeType: "image/svg+xml" }] }], tools: [] }), /unsupported image metadata/);
  assert.throws(() => proxyCanonicalContext({
    systemPrompt: "",
    messages: [{ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }] }],
    tools: [{ name: "read", description: "x", parameters: {} }],
  }), /not an approved tool/);
  assert.throws(() => proxyCanonicalContext({
    systemPrompt: "",
    messages: [{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [], isError: true }],
    tools: [{ name: "read", description: "x", parameters: {} }],
  }), /no matching assistant tool call/);
  assert.throws(() => proxyCanonicalContext({
    systemPrompt: "",
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private" }] }],
    tools: [],
  }), /unknown field thinking/);
  assert.throws(() => proxyCanonicalContext({
    systemPrompt: "",
    messages: [{ role: "user", content: "hello", hidden: "must reject" }],
    tools: [],
  }), /unknown field hidden/);
  const decorated = ["x"];
  decorated.extra = "must reject";
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "", messages: [], tools: [{ name: "read", description: "x", parameters: { enum: decorated } }] }), /dense and undecorated/);
});

test("proxy terminal mapping never converts an unknown/failed provider terminal into success", () => {
  assert.equal(proxyTerminalError({ payload: { outcome: "succeeded_terminal" } }), undefined);
  assert.equal(proxyTerminalError({ payload: { outcome: "rate_limited" } }), "controller provider terminal: rate_limited");
  assert.equal(proxyTerminalError({ payload: { outcome: "rejected_before_send", httpStatus: 400 } }), "controller provider terminal: rejected_before_send (400)");
  assert.equal(proxyTerminalError({ payload: { outcome: "rejected_before_send", httpStatus: 400, providerReason: "invalid_model" } }), "controller provider terminal: rejected_before_send (400, invalid_model)");
  assert.equal(proxyTerminalError({ payload: { outcome: "controller_failure", finishReason: "phase_invalid" } }), "controller provider terminal: controller_failure (phase_invalid)");
  assert.equal(proxyTerminalError({ payload: { outcome: "bad value" } }), "controller provider returned an invalid terminal");
});
