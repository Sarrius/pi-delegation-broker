import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureRegistry, SqliteLeaseBroker } from "../src/broker.mjs";
import { activeAuthorizedProviders, DynamicProviderWatcher, modelRegistryToProviderCatalog } from "../src/dynamic-provider-watcher.mjs";

function modelsStore(providers) {
  const store = {};
  for (const p of providers) {
    store[p] = {
      models: [{
        id: "test-model", name: "Test Model", api: "openai-completions",
        provider: p, baseUrl: `https://${p}.example/v1`, reasoning: true,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    };
  }
  return store;
}

function authJson(providers) {
  const auth = {};
  for (const p of providers) auth[p] = { type: "api-key", key: "test" };
  return auth;
}

test("credential preflight excludes expired OAuth before child launch and re-admits refreshed auth", () => {
  const now = 1_000_000;
  const auth = {
    api: { type: "api_key", key: "secret" },
    current: { type: "oauth", access: "access", refresh: "refresh", expires: now + 60_000 },
    expired: { type: "oauth", access: "access", refresh: "bad", expires: now - 1 },
    unknown: { type: "oauth", access: "access", refresh: "refresh" },
  };
  assert.deepEqual([...activeAuthorizedProviders(auth, now)].sort(), ["api", "current"]);
  auth.expired.expires = now + 120_000;
  assert.ok(activeAuthorizedProviders(auth, now).includes("expired"));
});

test("live model registry preserves per-account model availability", async () => {
  const models = [
    { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex", input: ["text"], reasoning: true },
    { provider: "openai-codex-account-5", id: "gpt-5.6-terra", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex", input: ["text"], reasoning: true },
  ];
  const catalog = modelRegistryToProviderCatalog(models, {
    authorizedProviders: ["openai-codex", "openai-codex-account-5"],
  });
  assert.deepEqual(catalog.find((entry) => entry.provider === "openai-codex").models.map((model) => model.id), ["gpt-5.6-sol"]);
  assert.deepEqual(catalog.find((entry) => entry.provider === "openai-codex-account-5").models.map((model) => model.id), ["gpt-5.6-terra"]);

  const root = mkdtempSync(join(tmpdir(), "dpw-runtime-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  try {
    const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry: fixtureRegistry() });
    const watcher = new DynamicProviderWatcher({ agentDir, broker, readCatalog: () => catalog });
    await watcher.refresh();
    const resources = watcher.currentRegistry().resources;
    assert.ok(resources["openai-codex/gpt-5.6-sol"]);
    assert.ok(resources["openai-codex-account-5/gpt-5.6-terra"]);
    assert.equal(resources["openai-codex-account-5/gpt-5.6-sol"], undefined);
    watcher.stop(); broker.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dynamic provider watcher reloads broker registry when catalog changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpw-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify(modelsStore(["alpha"])), { mode: 0o600 });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authJson(["alpha"])), { mode: 0o600 });

  try {
    const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry: fixtureRegistry() });
    let reloadInfo;
    const watcher = new DynamicProviderWatcher({
      agentDir,
      broker,
      onReload: (info) => { reloadInfo = info; },
    });

    const first = await watcher.refresh();
    assert.equal(first.status, "reloaded");
    assert.ok(first.providerCount >= 1);
    assert.ok(reloadInfo.providers.includes("alpha"));

    // Add a second provider
    writeFileSync(join(agentDir, "models-store.json"), JSON.stringify(modelsStore(["alpha", "beta"])), { mode: 0o600 });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authJson(["alpha", "beta"])), { mode: 0o600 });
    const second = await watcher.refresh();
    assert.equal(second.status, "reloaded");
    assert.ok(reloadInfo.providers.includes("beta"));

    // No change
    const third = await watcher.refresh();
    assert.equal(third.status, "unchanged");

    watcher.stop();
    broker.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic provider watcher excludes listed providers without an active credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpw-auth-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify(modelsStore(["authorized", "ghost"])), { mode: 0o600 });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authJson(["authorized"])), { mode: 0o600 });
  try {
    const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry: fixtureRegistry() });
    const watcher = new DynamicProviderWatcher({ agentDir, broker });
    await watcher.refresh();
    assert.ok(watcher.currentRegistry().resources["authorized/test-model"]);
    assert.equal(watcher.currentRegistry().resources["ghost/test-model"], undefined);
    watcher.stop(); broker.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dynamic provider watcher discovers pi-multi-account providers from auth.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpw-ma-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  // Base provider in models-store, account variants only in auth
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify(modelsStore(["openai-codex"])), { mode: 0o600 });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authJson([
    "openai-codex", "openai-codex-account-2", "openai-codex-account-7",
  ])), { mode: 0o600 });

  try {
    const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry: fixtureRegistry() });
    const watcher = new DynamicProviderWatcher({ agentDir, broker });
    const providers = watcher.providers();
    assert.ok(providers.includes("openai-codex"), "base provider");
    assert.ok(providers.includes("openai-codex-account-2"), "pi-multi-account provider 2");
    assert.ok(providers.includes("openai-codex-account-7"), "pi-multi-account provider 7");

    const result = await watcher.refresh();
    assert.equal(result.status, "reloaded");
    assert.ok(result.providerCount >= 3, "should have at least 3 providers");

    watcher.stop();
    broker.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth-only provider with models.json models registers THOSE models, not a placeholder", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpw-cfgmodels-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  // No models-store entry for this provider: only auth + models.json endpoint config,
  // exactly what multi-account provisions for cursor / kimi-coding-account-N slots.
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authJson(["cursor"])), { mode: 0o600 });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      cursor: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:41999/v1",
        models: ["cursor-grok-4.6", { id: "composer-2.5", contextWindow: 200000, maxTokens: 64000 }],
      },
    },
  }), { mode: 0o600 });
  try {
    const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry: fixtureRegistry() });
    const watcher = new DynamicProviderWatcher({ agentDir, broker });
    await watcher.refresh();
    const resources = watcher.currentRegistry().resources;
    assert.ok(resources["cursor/cursor-grok-4.6"], "real model from models.json must be routable");
    assert.ok(resources["cursor/composer-2.5"], "object-form model entries must register too");
    assert.equal(resources["cursor/default"], undefined, "placeholder must not appear when real models exist");
    watcher.stop();
    broker.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const SKIP_LIVE_AGENT = Boolean(process.env.CI || process.env.GITHUB_ACTIONS)
  || !existsSync(join(homedir(), ".pi", "agent"));

test("dynamic provider watcher reads the live Pi agent dir", {
  skip: SKIP_LIVE_AGENT && "live Pi agent dir is not available on CI",
}, () => {
  const agentDir = join(homedir(), ".pi", "agent");
  const root = mkdtempSync(join(tmpdir(), "dpw-live-"));
  try {
    const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry: fixtureRegistry() });
    const watcher = new DynamicProviderWatcher({ agentDir, broker });
    const providers = watcher.providers();
    assert.ok(providers.length >= 7, `should read providers from live agent dir, got: ${providers.join(", ")}`);
    assert.ok(providers.includes("openai-codex"), "should include openai-codex");
    assert.ok(providers.some((p) => p.startsWith("openai-codex-account-")), "should include pi-multi-account providers");
    watcher.stop();
    broker.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});