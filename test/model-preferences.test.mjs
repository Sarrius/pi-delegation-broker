import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { catalogToBrokerRegistry } from "../src/provider-catalog.mjs";
import { selectModelForTask } from "../src/model-selector.mjs";
import {
  DEFAULT_MODEL_PREFERENCES,
  loadModelPreferences,
  normalizeModelPreferences,
  preferenceMatches,
  taskModelTier,
  writeModelPreferences,
} from "../src/model-preferences.mjs";

const digest = "a".repeat(64);
function model(id, provider, reasoning = true) {
  return { id, name: id, provider, api: "openai-completions", baseUrl: `https://${provider}.example`, reasoning, input: ["text"], contextWindow: 200_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
function registry() {
  return catalogToBrokerRegistry([
    { provider: "openai-codex-account-2", api: "openai-completions", baseUrl: "https://x", models: [model("gpt-5.6-sol", "openai-codex-account-2")] },
    { provider: "openrouter", api: "openai-completions", baseUrl: "https://x", models: [model("grok-4.6", "openrouter"), model("gpt-5.6-sol", "openrouter")] },
    { provider: "zai", api: "openai-completions", baseUrl: "https://x", models: [model("glm-5.3", "zai")] },
  ], { confidence: "observed" });
}
function select(preferences, constraints = {}) {
  return selectModelForTask({ taskDescription: "implement a small feature", registry: registry(), preferences, constraints: { taskId: "preference-test", promptDigest: digest, ...constraints } });
}

test("default policy has curated frontier and deliberately empty standard/cheap", () => {
  const preferences = normalizeModelPreferences(DEFAULT_MODEL_PREFERENCES);
  assert.equal(preferences.tiers.frontier.length, 5);
  assert.deepEqual(preferences.tiers.standard, []);
  assert.deepEqual(preferences.tiers.cheap, []);
  assert.equal(preferenceMatches(preferences.tiers.frontier, { provider: "openai-codex-account-2", modelId: "gpt-5.6-sol" }), true);
  assert.equal(preferenceMatches(preferences.tiers.frontier, { provider: "openrouter", modelId: "gpt-5.6-sol" }), false, "subscription route is allowed, pay-per-token route is not");
});

test("user frontier choice wins when a permitted route is live", () => {
  const result = select(DEFAULT_MODEL_PREFERENCES, { modelTier: "frontier" });
  assert.equal(result.action, "allow");
  assert.deepEqual(result.expectedModel, { provider: "openai-codex-account-2", modelId: "gpt-5.6-sol" });
  assert.equal(result.selection.preferenceSource, "user");
  assert.equal(result.selection.modelTier, "frontier");
});

test("unservable user tier falls back to controller auto-selection rather than blocking work", () => {
  const preferences = { schemaVersion: 1, tiers: { frontier: [{ model: "claude-opus-5", via: ["openrouter"] }], standard: [], cheap: [] } };
  const result = select(preferences, { modelTier: "frontier" });
  assert.equal(result.action, "allow");
  assert.equal(result.selection.preferenceSource, "auto_user_tier_unavailable");
});

test("task levels default from capability but caller may override", () => {
  assert.equal(taskModelTier({ effectCapable: false, capabilities: ["text_generation"] }), "cheap");
  assert.equal(taskModelTier({ effectCapable: false, capabilities: ["text_generation", "code_reasoning"] }), "standard");
  assert.equal(taskModelTier({ effectCapable: false, capabilities: ["text_generation", "large_context"] }), "frontier");
  assert.equal(taskModelTier({ effectCapable: false, capabilities: ["text_generation"] }, "frontier"), "frontier");
});

test("preferences persist owner-side and reject invalid provider routes", () => {
  const root = mkdtempSync(join(tmpdir(), "prefs-"));
  const path = join(root, "preferences.json");
  try {
    writeModelPreferences(path, DEFAULT_MODEL_PREFERENCES);
    assert.deepEqual(loadModelPreferences(path), normalizeModelPreferences(DEFAULT_MODEL_PREFERENCES));
    assert.throws(() => normalizeModelPreferences({ schemaVersion: 1, tiers: { frontier: [{ model: "gpt-5.6-sol", via: ["../all"] }], standard: [], cheap: [] } }), /valid via providers/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});