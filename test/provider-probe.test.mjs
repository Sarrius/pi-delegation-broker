import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { catalogToBrokerRegistry } from "../src/provider-catalog.mjs";
import { createSelectContract, selectModelForTask } from "../src/model-selector.mjs";
import {
  LEGACY_GENERATION,
  assignGenerations,
  buildCurrencyMap,
  classifyProviderProbe,
  isControllerProbeUrl,
  parseModelVersion,
  probeProviderModels,
  retryAfterMs,
  readCurrencyCache,
  writeCurrencyCache,
  listingsFromCache,
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
    enforceQuality: true,
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
  assert.deepEqual(parseModelVersion("gpt-6-astra"), { family: "gpt-astra", version: [6] });
  assert.deepEqual(parseModelVersion("minimax-m3"), { family: "minimax-m", version: [3] });
  assert.deepEqual(parseModelVersion("kimi-k3"), { family: "kimi-k", version: [3] });
  assert.deepEqual(parseModelVersion("deepseek-v4-pro-0813"), { family: "deepseek", version: [4] });
  assert.deepEqual(parseModelVersion("qwen3.8-max"), { family: "qwen", version: [3, 8] });
  assert.deepEqual(parseModelVersion("claude-opus-5"), { family: "claude-opus", version: [5] });
});

test("stale generations are excluded while premium Astra does not obsolete the ordinary current lineup", () => {
  const registry = registryFor([
    { provider: "zai", models: [model("glm-4.7", "zai"), model("glm-5.2", "zai"), model("glm-5.3", "zai")] },
    { provider: "openai", models: [model("gpt-3.5-turbo", "openai"), model("gpt-4", "openai"), model("gpt-5.4-mini", "openai"), model("gpt-5.6-luna", "openai"), model("gpt-6-astra", "openai")] },
    { provider: "minimax", models: [model("minimax-m2", "minimax"), model("minimax-m2.7", "minimax"), model("minimax-m3", "minimax")] },
  ]);
  const currency = buildCurrencyMap({
    resources: resourcesFor(registry),
    liveListings: new Map([
      ["zai", new Map([["glm-4.7", 1_650_000_000_000], ["glm-5.2", 1_750_000_000_000], ["glm-5.3", 1_780_000_000_000]])],
      ["openai", new Map([["gpt-3.5-turbo", 1_670_000_000_000], ["gpt-4", 1_690_000_000_000], ["gpt-5.4-mini", 1_750_000_000_000], ["gpt-5.6-luna", 1_780_000_000_000], ["gpt-6-astra", 1_790_000_000_000]])],
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
  assert.equal(currency["openai/gpt-5.6-luna"].legacy, false);
  assert.equal(currency["openai/gpt-5.6-luna"].generation, 0);
  assert.equal(currency["openai/gpt-6-astra"].generation, 0);
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

test("legacy-only fleet is denied rather than silently routing work to an obsolete model", () => {
  const registry = registryFor([{ provider: "zai", models: [model("glm-4.7", "zai")] }]);
  const currency = buildCurrencyMap({
    resources: resourcesFor(registry),
    liveListings: new Map([["zai", new Map([
      ["glm-4.7", 1_650_000_000_000],
      ["glm-5.3", 1_780_000_000_000],
    ])]]),
  });
  const selected = choose(registry, currency, ["zai"]);
  assert.equal(selected.action, "deny");
});

test("controller probes allow HTTPS and loopback adapters but reject arbitrary HTTP", () => {
  assert.equal(isControllerProbeUrl("https://provider.example/v1"), true);
  assert.equal(isControllerProbeUrl("http://127.0.0.1:54103/account-2"), true);
  assert.equal(isControllerProbeUrl("http://localhost:11434/v1"), true);
  assert.equal(isControllerProbeUrl("http://10.0.0.5:8080/v1"), false);
  assert.equal(isControllerProbeUrl("https://user:secret@provider.example/v1"), false);
});

test("availability probes classify transient outages and preserve bounded Retry-After", async () => {
  assert.deepEqual(classifyProviderProbe({ status: "ok" }), { status: "available" });
  assert.deepEqual(classifyProviderProbe({ status: "http_error", code: 401 }), {
    status: "unknown", scope: "capacity_group", reason: "provider probe auth denied",
  });
  assert.deepEqual(classifyProviderProbe({ status: "http_error", code: 503 }), {
    status: "unknown", scope: "capacity_group", reason: "provider probe unavailable",
  });
  assert.deepEqual(classifyProviderProbe({ status: "http_error", code: 429, retryAfterMs: 12_000 }), {
    status: "unknown", scope: "capacity_group", reason: "provider availability probe throttled", retryAfterMs: 12_000,
  });
  assert.equal(retryAfterMs("12"), 12_000);
  assert.equal(retryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:00 GMT")), 60_000);
  assert.equal(retryAfterMs("86401"), undefined);
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

test("live probes retain a bounded Retry-After delay without retaining response headers", async () => {
  const result = await probeProviderModels({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    now: 1_000_000,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "7" },
    }),
  });
  assert.deepEqual(result, { status: "http_error", code: 429, models: [], retryAfterMs: 7_000 });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("currency cache is atomically persisted as credential-free listing facts", () => {
  const root = mkdtempSync(join(tmpdir(), "currency-cache-"));
  const path = join(root, "currency.json");
  try {
    writeCurrencyCache(path, new Map([["zai", new Map([["glm-5.3", 1_780]])]]));
    const cache = readCurrencyCache(path);
    assert.equal(typeof cache.probedAt, "number");
    assert.deepEqual([...listingsFromCache(cache).get("zai")], ["glm-5.3"]);
    assert.equal(JSON.stringify(cache).includes("1780"), false, "cache persists availability, not provider pricing/metadata");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fresh catalog-only Cursor listing makes the native route current for exact preflight", () => {
  const registry = registryFor([{ provider: "cursor", models: [model("composer-2.5", "cursor")] }]);
  const staleCachedListing = buildCurrencyMap({
    resources: resourcesFor(registry),
    liveListings: new Map([["cursor", new Set()]]),
  });
  assert.equal(staleCachedListing["cursor/composer-2.5"].listed, false);
  assert.equal(staleCachedListing["cursor/composer-2.5"].legacy, true);
  const staleSelection = selectModelForTask({
    taskDescription: "read a file and summarize it",
    registry,
    currency: staleCachedListing,
    enforceQuality: true,
    enforceProvenance: true,
    constraints: { taskId: "cursor-currency-test", promptDigest: "a".repeat(64), allowedProviders: ["cursor"] },
  });
  assert.equal(staleSelection.action, "deny", "an empty cached Cursor listing must not masquerade as a current route");

  // Cursor publishes its current model catalog through the parent bridge rather than a generic
  // /models endpoint. The bridge supplies the listing fact; the controller's exact route
  // preflight still has to verify runtime/auth/API readiness before leasing this model.
  const currency = buildCurrencyMap({
    resources: resourcesFor(registry),
    liveListings: new Map([["cursor", new Map([["composer-2.5", undefined]])]]),
    evaluatedAt: 1_780_000_000_000,
  });
  assert.equal(currency["cursor/composer-2.5"].listed, true);
  assert.equal(currency["cursor/composer-2.5"].source, "provider_listing");
  const selected = selectModelForTask({
    taskDescription: "read a file and summarize it",
    registry,
    currency,
    enforceQuality: true,
    enforceProvenance: true,
    constraints: { taskId: "cursor-currency-test", promptDigest: "a".repeat(64), allowedProviders: ["cursor"] },
  });
  assert.equal(selected.action, "allow");
  assert.deepEqual(selected.expectedModel, { provider: "cursor", modelId: "composer-2.5" });
});

test("createSelectContract passes the live currency feed into automatic selection", () => {
  const registry = registryFor([{ provider: "zai", models: [model("glm-4.7", "zai"), model("glm-5.3", "zai")] }]);
  const currency = buildCurrencyMap({ resources: resourcesFor(registry) });
  const select = createSelectContract({ registry: () => registry, currency: () => currency });
  const result = select({ childId: "currency-contract", promptDigest: "a".repeat(64), capabilityRequest: { taskDescription: "read file" } });
  assert.equal(result.expectedModel.modelId, "glm-5.3");
});
