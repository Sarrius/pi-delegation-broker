import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { baseProviderFor, writeScopedChildAuth } from "../src/scoped-child-auth.mjs";

function parentDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "sca-parent-"));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(value), { mode: 0o600 });
  }
  return dir;
}

function childDir() {
  const dir = mkdtempSync(join(tmpdir(), "sca-child-"));
  return dir;
}

const MODEL = (id, provider, extra = {}) => ({
  id, name: id, api: "openai-completions", provider, baseUrl: `https://${provider}.example/v1`,
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000, maxTokens: 8_000, ...extra,
});

test("scoped auth writes exactly one credential and that provider's catalog", () => {
  const parent = parentDir({
    "auth.json": {
      alpha: { type: "api_key", key: "sk-alpha" },
      beta: { type: "api_key", key: "sk-beta" },
    },
    "models-store.json": {
      alpha: { models: [MODEL("a1", "alpha"), MODEL("a2", "alpha")] },
      beta: { models: [MODEL("b1", "beta")] },
    },
  });
  const child = childDir();
  try {
    const summary = writeScopedChildAuth({ agentDir: child, provider: "alpha", parentAgentDir: parent });
    assert.deepEqual(summary, { provider: "alpha", credentialType: "api_key", modelCount: 2, modelsSource: "direct" });

    const auth = JSON.parse(readFileSync(join(child, "auth.json"), "utf8"));
    assert.deepEqual(Object.keys(auth), ["alpha"], "child sees exactly one credential");
    assert.equal(auth.alpha.key, "sk-alpha");

    const store = JSON.parse(readFileSync(join(child, "models-store.json"), "utf8"));
    assert.deepEqual(Object.keys(store), ["alpha"]);
    assert.deepEqual(store.alpha.models.map((m) => m.id), ["a1", "a2"]);

    for (const file of readdirSync(child)) {
      assert.equal(statSync(join(child, file)).mode & 0o077, 0, `${file} must be owner-only`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});

test("multi-account lease is represented under a canonical provider with its own credential", () => {
  const parent = parentDir({
    "auth.json": {
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acc-0" },
      "openai-codex-account-2": { type: "oauth", access: "a2", refresh: "r2", expires: 1, accountId: "acc-2" },
    },
    "models-store.json": {
      "openai-codex": { models: [MODEL("gpt-x", "openai-codex", { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" })] },
    },
  });
  const child = childDir();
  try {
    const summary = writeScopedChildAuth({ agentDir: child, provider: "openai-codex-account-2", parentAgentDir: parent });
    assert.equal(summary.modelsSource, "base");
    assert.equal(summary.modelCount, 1);
    assert.equal(summary.credentialType, "oauth");
    assert.equal(summary.provider, "openai-codex-account-2", "audit retains the leased account identity");
    assert.equal(summary.runtimeProvider, "openai-codex");

    const auth = JSON.parse(readFileSync(join(child, "auth.json"), "utf8"));
    assert.deepEqual(Object.keys(auth), ["openai-codex"]);
    assert.equal(auth["openai-codex"].accountId, "acc-2", "the account's own credential, not the base one");

    const store = JSON.parse(readFileSync(join(child, "models-store.json"), "utf8"));
    const model = store["openai-codex"].models[0];
    assert.equal(model.provider, "openai-codex", "a fresh Pi process can resolve the canonical provider");
    assert.equal(model.api, "openai-codex-responses");
    assert.equal(model.baseUrl, "https://chatgpt.com/backend-api");

    const config = JSON.parse(readFileSync(join(child, "models.json"), "utf8"));
    assert.equal(config.providers["openai-codex"].api, "openai-codex-responses");
    assert.equal(config.providers["openai-codex"].baseUrl, "https://chatgpt.com/backend-api");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});

test("config-only provider gets models from the parent's endpoint config", () => {
  const parent = parentDir({
    "auth.json": { ollama: { type: "api_key", key: "k" } },
    "models.json": {
      providers: {
        ollama: { api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1", models: [MODEL("glm:cloud", "ollama")] },
      },
    },
  });
  const child = childDir();
  try {
    const summary = writeScopedChildAuth({ agentDir: child, provider: "ollama", parentAgentDir: parent });
    assert.equal(summary.modelsSource, "config");
    assert.equal(summary.modelCount, 1);
    const config = JSON.parse(readFileSync(join(child, "models.json"), "utf8"));
    assert.equal(config.providers.ollama.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(config.providers.ollama.models[0].id, "glm:cloud");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});

test("missing credential for the leased provider fails closed", () => {
  const parent = parentDir({ "auth.json": { alpha: { type: "api_key", key: "k" } } });
  const child = childDir();
  try {
    assert.throws(
      () => writeScopedChildAuth({ agentDir: child, provider: "beta", parentAgentDir: parent }),
      /no credential for leased provider: beta/,
    );
    assert.deepEqual(readdirSync(child), [], "nothing written on failure");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});

test("invalid provider ids and relative paths are rejected", () => {
  const parent = parentDir({ "auth.json": { alpha: { type: "api_key", key: "k" } } });
  const child = childDir();
  try {
    assert.throws(() => writeScopedChildAuth({ agentDir: child, provider: "../escape", parentAgentDir: parent }), /valid provider id/);
    assert.throws(() => writeScopedChildAuth({ agentDir: "relative/dir", provider: "alpha", parentAgentDir: parent }), /absolute agentDir/);
    assert.throws(() => writeScopedChildAuth({ agentDir: child, provider: "alpha", parentAgentDir: "relative" }), /absolute parentAgentDir/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});

test("baseProviderFor strips only the account suffix", () => {
  assert.equal(baseProviderFor("openai-codex-account-2"), "openai-codex");
  assert.equal(baseProviderFor("openai-codex-account-12"), "openai-codex");
  assert.equal(baseProviderFor("openai-codex"), "openai-codex");
  assert.equal(baseProviderFor("zai"), "zai");
});