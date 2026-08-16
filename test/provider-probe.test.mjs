import assert from "node:assert/strict";
import test from "node:test";
import { catalogToBrokerRegistry } from "../src/provider-catalog.mjs";
import { createSelectContract, selectModelForTask } from "../src/model-selector.mjs";
import {
  LEGACY_GENERATION,
  assignGenerations,
  buildCurrencyMap,
  parseModelVersion,
  probeProviderModels,
} from "../src/provider-probe.mjs";

function model(id, provider, { reasoning = false } = {}) {
  return {
    id, name: id, provider, api: "openai-completions", baseUrl: `https://${provider}.example/v1`,
    reasoning, input: ["text"], contextWindow: 200_000, maxTokens: 8_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function registryFor(entries) {
  return catalogToBrokerRegistry(entries.map(({ provider, models }) => ({
    provider, baseUrl: `https://${provider}.example/v1`, api: "openai-completions", models,
  })), { confidence: "observed" });
}

function resourcesFor(registry) {
  return Object.values(registry.resources).map((resource) => resource.model);
}

function choose(registry, currency, allowedProviders) {
  return selectModelForTask({
    taskDescription: "read a file and summarize it",
    registry,
    currency,
    constraints: {
      taskId: "currency-test",
      promptDigest: "a".repeat(64),
      ...(allowedProviders ? { allowedProviders } : {}),
    },
  });
}

test("version parser recognizes current provider families without hardcoded model lists", () => {
  assert.deepEqual(parseModelVersion("glm-5.3"), { family: "glm", version: [5, 3] });
  assert.deepEqual(parseModelVersion("gpt-5.6-luna"), { family: "gpt", version: [5, 6] });
  assert.deepEqual(parseModelVersion("minimax-m3"), { family: "minimax-m", version: [3] });
  assert.deepEqual(parseModelVersion("kimi-k3"), { family: "kimi-k", version: [3] });
  assert.deepEqual(parseModelVersion("deepseek-v4-pro-0813"), { family: "deepseek", version: [4] });
  assert.deepEqual(parseModelVersion("qwen3.8-max"), { family: "qwen", version: [3, 8] });
  assert.deepEqual(parseModelVersion("claude-opus-5"), { family: "claude-opus", version: [5] });
});

test("all stale generations are excluded: glm-4, gpt-3.5/4, and MiniMax-M2 never win", () => {
  const registry = registryFor([
    { provider: "zai", models: [model("glm-4.7", "zai"), model("glm-5.2", "zai"), model("glm-5.3", "zai")] },
    { provider: "openai", models: [model("gpt-3.5-turbo", "openai"), model("gpt-4", "openai"), model("gpt-5.4-mini", "openai"), model("gpt-5.6-luna", "openai")] },
    { provider: "minimax", models: [model("minimax-m2", "minimax"), model("minimax-m2.7", "minimax"), model("minimax-m3", "minimax")] },
  ]);
  const currency = buildCurrencyMap({
    resources: resourcesFor(registry),
    liveListings: new Map([
      ["zai", new Map([["glm-4.7", 1_650_000_000_000], ["glm-5.2", 1_750_000_000_000], ["glm-5.3", 1_780_000_000_000]])],
      ["openai", new Map([["gpt-3.5-turbo", 1_670_000_000_000], ["gpt-4", 1_690_000_000_000], ["gpt-5.4-mini", 1_750_000_000_000], ["gpt-5.6-luna", 1_780_000_000_000]])],
      ["minimax", new Map([["minimax-m2", 1_650_000_000_000], ["minimax-m2.7", 1_750_000_000_000], ["minimax-m3", 1_780_000_000_000]])],
    ]),
  });

  assert.equal(currency["zai/glm-4.7"].legacy, true);
  assert.equal(currency["openai/gpt-3.5-turbo"].legacy, true);
  assert.equal(currency["openai/gpt-4"].legacy, true);
  assert.equal(currency["minimax/minimax-m2"].legacy, true);

  for (const provider of ["zai", "openai", "minimax"]) {
    const chosen = choose(registry, currency, [provider]);
    assert.equal(chosen.action, "allow");
    assert.equal(currency[chosen.expectedModel.provider + "/" + chosen.expectedModel.modelId].legacy, false,
      `${provider} must never choose a legacy model while a current one lives`);
  }
  assert.equal(choose(registry, currency, ["zai"]).expectedModel.modelId, "glm-5.3");
  assert.equal(choose(registry, currency, ["openai"]).expectedModel.modelId, "gpt-5.6-luna");
  assert.equal(choose(registry, currency, ["minimax"]).expectedModel.modelId, "minimax-m3");
});

test("a model missing from the live API is legacy even if Pi's local cache still lists it", () => {
  const registry = registryFor([{ provider: "zai", models: [model("glm-5.2", "zai"), model("glm-5.3", "zai")] }]);
  const currency = buildCurrencyMap({
    resources: resourcesFor(registry),
    liveListings: new Map([["zai", new Map([["glm-5.3", 1_780_000_000_000]])]]),
  });
  assert.equal(currency["zai/glm-5.2"].listed, false);
  assert.equal(currency["zai/glm-5.2"].legacy, true);
  const selected = choose(registry, currency, ["zai"]);
  assert.equal(selected.expectedModel.modelId, "glm-5.3");
});

test("date catches an old alias even when its parsed generation is the same", () => {
  const registry = registryFor([{ provider: "openai", models: [model("gpt-5.6-early", "openai"), model("gpt-5.6-luna", "openai")] }]);
  const currency = buildCurrencyMap({
    resources: resourcesFor(registry),
    liveListings: new Map([["openai", new Map([
      ["gpt-5.6-early", 1_650_000_000_000],
      ["gpt-5.6-luna", 1_700_000_000_001], // > 90 days newer
    ])]]),
  });
  assert.equal(currency["openai/gpt-5.6-early"].generation, LEGACY_GENERATION);
  assert.equal(currency["openai/gpt-5.6-early"].staleByDate, true);
  assert.equal(choose(registry, currency, ["openai"]).expectedModel.modelId, "gpt-5.6-luna");
});

test("legacy is only an explicit emergency fallback when no current resource exists", () => {
  const registry = registryFor([{ provider: "zai", models: [model("glm-4.7", "zai")] }]);
  const currency = buildCurrencyMap({
    resources: resourcesFor(registry),
    // The provider's live listing knows about the current release even though this user's
    // local cache/resource set is stale and contains only glm-4.7.
    liveListings: new Map([["zai", new Map([
      ["glm-4.7", 1_650_000_000_000],
      ["glm-5.3", 1_780_000_000_000],
    ])]]),
  });
  const selected = choose(registry, currency, ["zai"]);
  assert.equal(selected.action, "allow");
  assert.equal(selected.expectedModel.modelId, "glm-4.7");
  assert.equal(selected.selection.legacyFallback, true, "use of legacy cannot be silent");
});

test("live probes preserve upstream creation dates without exposing credentials", async () => {
  const seen = [];
  const result = await probeProviderModels({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret-never-returned",
    fetchImpl: async (url, options) => {
      seen.push({ url, authorization: options.headers.authorization });
      return { ok: true, json: async () => ({ data: [{ id: "glm-5.3", created: 1_780_000_000 }] }) };
    },
  });
  assert.deepEqual(result, { status: "ok", models: ["glm-5.3"], created: { "glm-5.3": 1_780_000_000_000 } });
  assert.equal(seen[0].url, "https://provider.example/v1/models");
  assert.equal(seen[0].authorization, "Bearer secret-never-returned");
  assert.equal(JSON.stringify(result).includes("secret-never-returned"), false);
});

test("createSelectContract passes the live currency feed into automatic selection", () => {
  const registry = registryFor([{ provider: "zai", models: [model("glm-4.7", "zai"), model("glm-5.3", "zai")] }]);
  const currency = buildCurrencyMap({ resources: resourcesFor(registry) });
  const select = createSelectContract({ registry: () => registry, currency: () => currency });
  const result = select({ childId: "currency-contract", promptDigest: "a".repeat(64), capabilityRequest: { taskDescription: "read file" } });
  assert.equal(result.expectedModel.modelId, "glm-5.3");
});