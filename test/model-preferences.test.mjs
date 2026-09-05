import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { catalogToBrokerRegistry } from "../src/provider-catalog.mjs";
import { selectModelForTask } from "../src/model-selector.mjs";
import {
  DEFAULT_MODEL_PREFERENCES,
  addModelPreference,
  loadModelPreferences,
  normalizeModelPreferences,
  preferenceMatches,
  removeModelPreference,
  taskModelTier,
  writeModelPreferences,
} from "../src/model-preferences.mjs";

const digest = "a".repeat(64);
function model(id, provider, reasoning = true) {
  return { id, name: id, provider, api: "openai-completions", baseUrl: `https://${provider}.example`, reasoning, input: ["text"], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
function registry() {
  return catalogToBrokerRegistry([
    { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", models: [{ ...model("gpt-6-astra", "openai"), api: "openai-responses", input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000 }] },
    { provider: "openai-codex-account-2", api: "openai-codex-responses", baseUrl: "https://x", models: [model("gpt-6-astra", "openai-codex-account-2"), model("gpt-5.6-sol", "openai-codex-account-2")] },
    { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://x", models: [model("claude-fable-5-1", "anthropic"), model("claude-opus-5", "anthropic")] },
    { provider: "openrouter", api: "openai-completions", baseUrl: "https://x", models: [model("grok-4.6", "openrouter"), model("gpt-5.6-sol", "openrouter")] },
    { provider: "zai", api: "openai-completions", baseUrl: "https://x", models: [model("glm-5.3", "zai")] },
  ], { confidence: "observed" });
}
function currentCurrency(reg = registry()) {
  return Object.fromEntries(Object.keys(reg.resources).map((id) => [id, { generation: 0, listed: true, legacy: false }]));
}
function select(preferences, constraints = {}, currency = currentCurrency()) {
  return selectModelForTask({
    taskDescription: "implement a small feature",
    registry: registry(),
    preferences,
    currency,
    enforceQuality: true,
    enforceProvenance: true,
    constraints: { taskId: "preference-test", promptDigest: digest, ...constraints },
  });
}

test("default policy uses automatic subscription-native pools for every tier", () => {
  const preferences = normalizeModelPreferences(DEFAULT_MODEL_PREFERENCES);
  assert.deepEqual(preferences.tiers.apex, []);
  assert.deepEqual(preferences.tiers.frontier, []);
  assert.deepEqual(preferences.tiers.standard, []);
  assert.deepEqual(preferences.tiers.cheap, []);
});

test("automatic frontier selection chooses a current first-party subscription route", () => {
  const result = select(DEFAULT_MODEL_PREFERENCES, { modelTier: "frontier" });
  assert.equal(result.action, "allow");
  assert.ok(["gpt-5.6-sol", "claude-opus-5", "glm-5.3"].includes(result.expectedModel.modelId));
  assert.ok(!result.contract.capability.allowedResources.some((id) => /astra|fable/i.test(id)), "ordinary routing must exclude every apex candidate");
  assert.equal(result.selection.preferenceSource, "auto");
  assert.equal(result.selection.billingPool, "native_subscription");
  assert.equal(result.selection.freshness, "current");
  assert.match(result.selection.policyGeneration, /^[a-f0-9]{64}$/);
});

test("a frontier preference cannot smuggle paid Astra into ordinary routing", () => {
  const preferences = { schemaVersion: 1, tiers: { apex: [], frontier: [{ model: "gpt-6-astra", via: ["openai"] }], standard: [], cheap: [] } };
  const result = select(preferences, { modelTier: "frontier" });
  assert.equal(result.action, "deny");
});

test("an unavailable explicit pool denies instead of silently broadening to auto", () => {
  const preferences = { schemaVersion: 1, tiers: { apex: [], frontier: [{ model: "claude-opus-5", via: ["openrouter"] }], standard: [], cheap: [] } };
  const result = select(preferences, { modelTier: "frontier" });
  assert.equal(result.action, "deny");
  assert.match(result.reason, /explicit model pool/);
});

test("an explicit current aggregator allowlist is honored but previous generations stay denied", () => {
  const preferences = { schemaVersion: 1, tiers: { apex: [], frontier: [{ model: "grok-4.6", via: ["openrouter"] }], standard: [], cheap: [] } };
  const current = select(preferences, { modelTier: "frontier" });
  assert.equal(current.action, "allow");
  assert.deepEqual(current.expectedModel, { provider: "openrouter", modelId: "grok-4.6" });
  const currency = currentCurrency();
  currency["openrouter/grok-4.6"] = { generation: 1, listed: true, legacy: false };
  const previous = select(preferences, { modelTier: "frontier" }, currency);
  assert.equal(previous.action, "deny");
});

test("task levels default from capability but caller may override", () => {
  assert.equal(taskModelTier({ effectCapable: false, capabilities: ["text_generation"] }), "cheap");
  assert.equal(taskModelTier({ effectCapable: false, capabilities: ["text_generation", "code_reasoning"] }), "standard");
  assert.equal(taskModelTier({ effectCapable: false, capabilities: ["text_generation", "large_context"] }), "frontier");
  assert.equal(taskModelTier({ effectCapable: false, capabilities: ["text_generation"] }, "frontier"), "frontier");
});

test("policy mutations merge provider routes and remove only what the user names", () => {
  const seeded = normalizeModelPreferences({ schemaVersion: 1, tiers: { apex: [], frontier: [], standard: [], cheap: [] } });
  const withRoutes = addModelPreference(seeded, { tier: "standard", model: "glm-5.3", via: ["zai"] });
  const merged = addModelPreference(withRoutes, { tier: "standard", model: "glm-5.3", via: ["opencode-go-api", "zai"] });
  assert.deepEqual(merged.tiers.standard, [{ model: "glm-5.3", via: ["zai", "opencode-go-api"] }]);
  const partial = removeModelPreference(merged, { tier: "standard", model: "glm-5.3", via: ["zai"] });
  assert.deepEqual(partial.tiers.standard, [{ model: "glm-5.3", via: ["opencode-go-api"] }]);
  const removed = removeModelPreference(partial, { tier: "standard", model: "glm-5.3" });
  assert.deepEqual(removed.tiers.standard, []);
  assert.throws(() => addModelPreference(seeded, { tier: "not-a-tier", model: "glm-5.3", via: ["zai"] }), /tier/);
});

test("the exact legacy shipped seed migrates to strict automatic mode", () => {
  const root = mkdtempSync(join(tmpdir(), "prefs-legacy-"));
  const path = join(root, "preferences.json");
  try {
    const legacy = {
      schemaVersion: 1,
      tiers: {
        apex: [],
        frontier: [
          { model: "gpt-5.6-sol", via: ["openai-codex*"] },
          { model: "kimi-k3", via: ["kimi-coding", "ollama"] },
          { model: "glm-5.3", via: ["zai", "opencode-go-api"] },
          { model: "grok-4.6", via: ["openrouter"] },
          { model: "claude-opus-5", via: ["openrouter"] },
        ],
        standard: [], cheap: [],
      },
    };
    writeFileSync(path, `${JSON.stringify(legacy)}\n`);
    assert.deepEqual(loadModelPreferences(path), normalizeModelPreferences(DEFAULT_MODEL_PREFERENCES));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preferences persist owner-side and reject invalid provider routes", () => {
  const root = mkdtempSync(join(tmpdir(), "prefs-"));
  const path = join(root, "preferences.json");
  try {
    writeModelPreferences(path, DEFAULT_MODEL_PREFERENCES);
    assert.deepEqual(loadModelPreferences(path), normalizeModelPreferences(DEFAULT_MODEL_PREFERENCES));
    assert.throws(() => normalizeModelPreferences({ schemaVersion: 1, tiers: { apex: [], frontier: [{ model: "gpt-5.6-sol", via: ["../all"] }], standard: [], cheap: [] } }), /valid via providers/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
