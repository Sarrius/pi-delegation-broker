import assert from "node:assert/strict";
import test from "node:test";

import { proxyCanonicalContext, proxyTerminalError } from "../src/proxy-context.mjs";

test("proxy bridge preserves a text-only context without silently dropping content", () => {
  const context = proxyCanonicalContext({
    systemPrompt: "Be concise.",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
    tools: [],
  });
  assert.deepEqual(context, {
    systemPrompt: "Be concise.",
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    tools: [],
  });
});

test("proxy fails closed on tool, image, or tool-result context it cannot faithfully replay", () => {
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "", messages: [], tools: [{ name: "read" }] }), /tool-free/);
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "", messages: [{ role: "user", content: [{ type: "image", data: "x" }] }], tools: [] }), /non-text/);
  assert.throws(() => proxyCanonicalContext({ systemPrompt: "", messages: [{ role: "toolResult", content: [] }], tools: [] }), /unsupported role/);
});

test("proxy terminal mapping never converts an unknown/failed provider terminal into success", () => {
  assert.equal(proxyTerminalError({ payload: { outcome: "succeeded_terminal" } }), undefined);
  assert.equal(proxyTerminalError({ payload: { outcome: "rate_limited" } }), "controller provider terminal: rate_limited");
  assert.equal(proxyTerminalError({ payload: { outcome: "rejected_before_send", httpStatus: 400 } }), "controller provider terminal: rejected_before_send (400)");
  assert.equal(proxyTerminalError({ payload: { outcome: "rejected_before_send", httpStatus: 400, providerReason: "invalid_model" } }), "controller provider terminal: rejected_before_send (400, invalid_model)");
  assert.equal(proxyTerminalError({ payload: { outcome: "bad value" } }), "controller provider returned an invalid terminal");
});
