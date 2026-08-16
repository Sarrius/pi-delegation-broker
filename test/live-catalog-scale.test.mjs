import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureRegistry, SqliteLeaseBroker } from "../src/broker.mjs";
import { DynamicProviderWatcher } from "../src/dynamic-provider-watcher.mjs";
import { catalogToBrokerRegistry } from "../src/provider-catalog.mjs";

// Regression lock for a bug found against the real Pi agent directory: an aggregator
// provider (openrouter) published 346 models, the catalog validator capped a provider at
// 256, and DynamicProviderWatcher.start() swallowed the throw. The dynamic registry
// therefore never loaded at all on a real machine, silently, while providers() still
// reported 15 providers as if everything worked.

function bigStore(provider, modelCount) {
  return {
    [provider]: {
      models: Array.from({ length: modelCount }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${index}`,
        api: "openai-completions",
        provider,
        baseUrl: `https://${provider}.example/v1`,
        contextWindow: 128_000,
        maxTokens: 8_000,
        reasoning: index % 2 === 0,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    },
  };
}

test("an aggregator provider with far more than 256 models still builds a registry", () => {
  const catalog = [{
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    models: Array.from({ length: 346 }, (_, index) => ({
      id: `vendor/model-${index}`,
      name: `Model ${index}`,
      contextWindow: index % 3 === 0 ? 256_000 : 64_000,
      maxTokens: 8_000,
      reasoning: index % 2 === 0,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  }];

  const registry = catalogToBrokerRegistry(catalog, { confidence: "observed" });
  assert.equal(Object.keys(registry.resources).length, 346, "every model is selectable");
  assert.equal(Object.keys(registry.capacityGroups).length, 1, "one rate-limit bucket per account");
  assert.ok(Object.keys(registry.profiles).length > 1, "models spread across capability tiers");
});

test("real aggregator model ids carrying a variant suffix are selectable", () => {
  // openrouter publishes 86 such ids on the real machine (`:batch`, `:free`, `:thinking`).
  // A colon is part of the model identity, not a separator the broker may reject.
  const registry = catalogToBrokerRegistry([{
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    models: [
      { id: "anthropic/claude-opus-5", name: "Opus 5", contextWindow: 256_000, maxTokens: 32_000, reasoning: true, input: ["text"], cost: { input: 3, output: 15 } },
      { id: "anthropic/claude-opus-5:batch", name: "Opus 5 batch", contextWindow: 256_000, maxTokens: 32_000, reasoning: true, input: ["text"], cost: { input: 1, output: 7 } },
      { id: "cohere/north-mini-code:free", name: "North mini free", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, input: ["text"], cost: { input: 0, output: 0 } },
      { id: "~openai/gpt-latest", name: "GPT rolling", contextWindow: 256_000, maxTokens: 32_000, reasoning: true, input: ["text"], cost: { input: 2, output: 8 } },
    ],
  }], { confidence: "observed" });

  assert.ok(registry.resources["openrouter/anthropic/claude-opus-5:batch"], "variant id survives");
  assert.ok(registry.resources["openrouter/cohere/north-mini-code:free"], "free-tier variant survives");
  assert.ok(registry.resources["openrouter/~openai/gpt-latest"], "rolling-alias id survives");
  assert.equal(Object.keys(registry.resources).length, 4);
});

test("a model id carrying a control character or whitespace is still refused", () => {
  for (const id of ["bad id", "bad\nid", "/leading-slash", ""]) {
    assert.throws(
      () => catalogToBrokerRegistry([{
        provider: "p", baseUrl: "https://p.example", api: "openai-completions",
        models: [{ id, name: "x", contextWindow: 1_000, maxTokens: 100, reasoning: false, input: ["text"], cost: {} }],
      }]),
      /bounded id/,
      `model id ${JSON.stringify(id)} must be refused`,
    );
  }
});

test("a provider list beyond the hard bound is refused rather than silently truncated", () => {
  const tooMany = [{
    provider: "runaway",
    baseUrl: "https://runaway.example",
    api: "openai-completions",
    models: Array.from({ length: 4_097 }, (_, index) => ({
      id: `model-${index}`, name: `M${index}`, contextWindow: 8_000, maxTokens: 1_000,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  }];
  assert.throws(() => catalogToBrokerRegistry(tooMany), /1\.\.4096 models/);
});

test("dynamic watcher reloads a large real-world catalog instead of failing silently", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-scale-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify(bigStore("openrouter", 346)), { mode: 0o600 });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openrouter: { type: "api-key", key: "x" } }), { mode: 0o600 });

  try {
    const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry: fixtureRegistry() });
    const events = [];
    const watcher = new DynamicProviderWatcher({ agentDir, broker, onReload: (info) => events.push(info) });

    const result = await watcher.refresh();
    assert.equal(result.status, "reloaded", "a real-sized catalog must load");
    assert.equal(events.at(-1)?.status, "reloaded");

    watcher.stop();
    broker.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a catalog failure is reported to the controller instead of being swallowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-fail-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  // A model with no usable id cannot become a resource; the controller must hear about it.
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    broken: { models: [{ id: "", name: "no id", contextWindow: 1_000, maxTokens: 100 }] },
  }), { mode: 0o600 });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ broken: { type: "api-key", key: "x" } }), { mode: 0o600 });

  try {
    const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry: fixtureRegistry() });
    const events = [];
    const watcher = new DynamicProviderWatcher({ agentDir, broker, onReload: (info) => events.push(info) });

    const result = await watcher.refresh();
    assert.equal(result.status, "failed", "a malformed catalog is a reported outcome, not a throw");
    assert.match(result.reason, /bounded id/);

    // start() must surface the same failure rather than discarding it.
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(events.at(-1)?.status, "failed", "controller is told the dynamic registry is not live");

    watcher.stop();
    broker.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
