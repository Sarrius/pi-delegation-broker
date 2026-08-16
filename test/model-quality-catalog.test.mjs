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