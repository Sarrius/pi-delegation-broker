import assert from "node:assert/strict";
import test from "node:test";
import { catalogToBrokerRegistry, fixtureCatalog } from "../src/provider-catalog.mjs";
import { SqliteLeaseBroker, fixtureContract } from "../src/broker.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("catalog converts provider entries into a broker registry with derived profiles", () => {
  const catalog = fixtureCatalog();
  const registry = catalogToBrokerRegistry(catalog);

  assert.ok(registry.profiles["fake-anthropic/claude-fake-1"]);
  assert.ok(registry.profiles["fake-codex/gpt-fake-1"]);
  assert.ok(registry.capacityGroups["G-fake-anthropic"]);
  assert.ok(registry.capacityGroups["G-fake-codex"]);
  assert.ok(registry.resources["fake-anthropic"]);
  assert.ok(registry.resources["fake-codex"]);

  const anthropicProfile = registry.profiles["fake-anthropic/claude-fake-1"];
  assert.equal(anthropicProfile.status, "approved");
  assert.ok(anthropicProfile.supports.includes("code_reasoning"));
  assert.ok(anthropicProfile.supports.includes("vision_input"));
  assert.ok(anthropicProfile.supports.includes("large_context"));

  const group = registry.capacityGroups["G-fake-anthropic"];
  assert.equal(group.maxConcurrent, 1);
  assert.equal(group.confidence, "assumed");
});

test("broker registry from catalog can reserve and lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-catalog-"));
  try {
    const registry = catalogToBrokerRegistry(fixtureCatalog(), { confidence: "measured" });
    const broker = new SqliteLeaseBroker({ path: join(dir, "b.sqlite"), registry });
    const reservation = broker.reserve(fixtureContract({
      taskId: "catalog-task",
      capability: { minimumProfile: "fake-anthropic/claude-fake-1", required: ["code_reasoning"], downgradePolicy: "forbid" },
      budget: { maxInputTokens: 1_000, maxOutputTokens: 100, enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
    }), Date.now());
    assert.equal(reservation.status, "leased");
    assert.equal(reservation.lease.resourceId, "fake-anthropic");
    assert.equal(reservation.lease.profile, "fake-anthropic/claude-fake-1");
    broker.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog rejects malformed provider entries", () => {
  assert.throws(() => catalogToBrokerRegistry([]), /non-empty array/);
  assert.throws(() => catalogToBrokerRegistry([{ provider: 123 }]), /bounded provider identifier/);
  assert.throws(() => catalogToBrokerRegistry([{ provider: "p1", baseUrl: "", api: "x", models: [] }]), /baseUrl/);
  assert.throws(() => catalogToBrokerRegistry([{ provider: "p1", baseUrl: "http://x", api: "x", models: [] }]), /1\.\.256 models/);
  assert.throws(() => catalogToBrokerRegistry([{ provider: "p1", baseUrl: "http://x", api: "x", models: [{ id: "m1" }] }]), /positive contextWindow/);
});

test("catalog model supports are derived from model capabilities", () => {
  const catalog = fixtureCatalog([{
    provider: "test-provider",
    baseUrl: "http://localhost",
    api: "openai-completions",
    models: [
      { id: "small", name: "Small", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, input: ["text"] },
      { id: "large", name: "Large", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"] },
    ],
  }]);
  const registry = catalogToBrokerRegistry(catalog);
  const profile = registry.profiles["test-provider/large"];
  assert.ok(profile.supports.includes("code_reasoning"));
  assert.ok(profile.supports.includes("vision_input"));
  assert.ok(profile.supports.includes("large_context"));
  assert.ok(profile.supports.includes("text_generation"));
});

test("catalog respects controller overrides for capacity and confidence", () => {
  const registry = catalogToBrokerRegistry(fixtureCatalog(), {
    maxConcurrentPerProvider: 4,
    confidence: "measured",
    cooldownDefaultMs: 60_000,
    cooldownProbeIntervalMs: 10_000,
  });
  const group = registry.capacityGroups["G-fake-anthropic"];
  assert.equal(group.maxConcurrent, 4);
  assert.equal(group.confidence, "measured");
  assert.equal(group.cooldown.defaultMs, 60_000);
  assert.equal(group.cooldown.probeIntervalMs, 10_000);
});