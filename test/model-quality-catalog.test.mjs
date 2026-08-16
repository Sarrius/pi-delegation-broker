import assert from "node:assert/strict";
import test from "node:test";
import { qualityForModel, meetsQualityFloor } from "../src/model-quality-catalog.mjs";

test("quality catalog rejects free/unknown aggregator models and admits researched current routes", () => {
  assert.equal(qualityForModel({ provider: "openrouter", modelId: "liquid/lfm-2.5-2.6b:free" }), undefined);
  assert.equal(qualityForModel({ provider: "openrouter", modelId: "mistralai/mistral-nemo" }), undefined);
  assert.equal(qualityForModel({ provider: "zai", modelId: "glm-4.7" }), undefined);
  assert.equal(qualityForModel({ provider: "zai", modelId: "glm-5.3" }), "frontier");
  assert.equal(qualityForModel({ provider: "openai-codex-account-2", modelId: "gpt-5.6-sol" }), "frontier");
  assert.equal(qualityForModel({ provider: "openrouter", modelId: "anthropic/claude-opus-5" }), "frontier");
  assert.equal(meetsQualityFloor({ provider: "zai", modelId: "glm-5.3" }, "cheap"), true);
  assert.equal(meetsQualityFloor({ provider: "openrouter", modelId: "liquid/lfm-2.5-2.6b:free" }, "cheap"), false);
});
test("the contract carries the vetted candidate set so the broker cannot lease a filtered model", async () => {
  const { selectModelForTask } = await import("../src/model-selector.mjs");
  const { readProviderRegistry } = await import("../src/dynamic-provider-watcher.mjs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  let registry;
  try { registry = readProviderRegistry(join(homedir(), ".pi", "agent")); } catch { return; }
  const selected = selectModelForTask({
    taskDescription: "read one file and summarize it",
    registry,
    enforceQuality: true,
    constraints: { taskId: "quality-allowlist", promptDigest: "a".repeat(64) },
  });
  if (selected.action !== "allow") return;
  const allowed = selected.contract.capability.allowedResources;
  assert.ok(Array.isArray(allowed) && allowed.length > 0, "contract must pin vetted resources");
  assert.ok(allowed.includes(selected.selection.resourceId));
  assert.ok(!allowed.some((id) => /o3-mini|gpt-4|glm-4|:free\b/.test(id)), `allow-list leaked a filtered model: ${allowed.join(", ")}`);
});
