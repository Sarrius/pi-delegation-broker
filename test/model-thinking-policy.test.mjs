import assert from "node:assert/strict";
import test from "node:test";
import { effectiveThinkingLevel, requiresReasoning } from "../src/model-thinking-policy.mjs";
import { classifyChildFailure } from "../src/brokered-runner.mjs";

test("an always-reasoning model is raised off the illegal disabled mode, never reduced", () => {
  assert.equal(requiresReasoning({ provider: "zai", modelId: "glm-5.3" }), true);
  assert.equal(effectiveThinkingLevel({ provider: "zai", modelId: "glm-5.3" }, "off"), "low");
  assert.equal(effectiveThinkingLevel({ provider: "openrouter", modelId: "z-ai/glm-5.2" }, "minimal"), "low");
  assert.equal(effectiveThinkingLevel({ provider: "zai", modelId: "glm-5.3" }, "high"), "high");
});

test("models without the constraint keep the controller's requested mode", () => {
  assert.equal(effectiveThinkingLevel({ provider: "anthropic", modelId: "claude-opus-5" }, "off"), "off");
  assert.equal(effectiveThinkingLevel({ provider: "openai", modelId: "gpt-5.6-luna" }, "off"), "off");
});

test("a child that never settles is a failover-eligible route failure", () => {
  assert.equal(classifyChildFailure("controller prompt deadline exceeded after 180000ms"), "unavailable");
});

test("an exhausted account is a route failure, not a dead task", () => {
  assert.equal(classifyChildFailure('402: {"message":"This request requires more credits, or fewer max_tokens"}'), "account_exhausted");
  assert.equal(classifyChildFailure("400: Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage"), "account_exhausted");
  assert.equal(classifyChildFailure("400: Reasoning is mandatory for this endpoint and cannot be disabled."), "unavailable");
});
