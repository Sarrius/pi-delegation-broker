import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureRegistry, SqliteLeaseBroker } from "../src/broker.mjs";
import { DynamicProviderWatcher } from "../src/dynamic-provider-watcher.mjs";

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

test("dynamic provider watcher reads the live Pi agent dir", () => {
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