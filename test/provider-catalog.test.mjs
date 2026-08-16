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

  // A resource is one concrete (account, model) pair — the unit a lease can route to.
  assert.ok(registry.resources["fake-anthropic/claude-fake-1"]);
  assert.ok(registry.resources["fake-codex/gpt-fake-1"]);
  // A capacity group is the account: every one of its models draws on the same quota.
  assert.ok(registry.capacityGroups["G-fake-anthropic"]);
  assert.ok(registry.capacityGroups["G-fake-codex"]);

  // A profile is a capability tier shared across accounts, so a contract pinned to it can be
  // served by whichever provider is alive rather than by one named vendor.
  const anthropicProfile = registry.profiles[registry.resources["fake-anthropic/claude-fake-1"].profile];
  assert.equal(anthropicProfile.status, "approved");
  assert.ok(anthropicProfile.supports.includes("text_generation"));
  assert.ok(anthropicProfile.supports.includes("code_reasoning"));
  assert.ok(anthropicProfile.supports.includes("vision_input"));
  assert.ok(anthropicProfile.supports.includes("large_context"));

  const group = registry.capacityGroups["G-fake-anthropic"];
  assert.equal(group.maxConcurrent, 2, "one slot is reserved for control admission, so a single slot admits no work");
  assert.equal(group.confidence, "assumed");
});

test("two accounts offering equivalent models share one capability tier", () => {
  const registry = catalogToBrokerRegistry([
    {
      provider: "acct-a", baseUrl: "https://a.example", api: "openai-completions",
      models: [{ id: "m", name: "M", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, input: ["text"], cost: {} }],
    },
    {
      provider: "acct-b", baseUrl: "https://b.example", api: "openai-completions",
      models: [{ id: "other", name: "Other", contextWindow: 16_000, maxTokens: 2_000, reasoning: false, input: ["text"], cost: {} }],
    },
  ]);

  assert.equal(registry.resources["acct-a/m"].profile, registry.resources["acct-b/other"].profile,
    "substitution across accounts is only possible when the tier is shared");
  assert.equal(Object.keys(registry.profiles).length, 1);
});

test("broker registry from catalog can reserve and lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-catalog-"));
  try {
    const registry = catalogToBrokerRegistry(fixtureCatalog(), { confidence: "measured" });
    const profile = registry.resources["fake-anthropic/claude-fake-1"].profile;
    const broker = new SqliteLeaseBroker({ path: join(dir, "b.sqlite"), registry });
    const reservation = broker.reserve(fixtureContract({
      taskId: "catalog-task",
      capability: { minimumProfile: profile, required: ["code_reasoning"], downgradePolicy: "forbid" },
      budget: { maxInputTokens: 1_000, maxOutputTokens: 100, enforcement: { input: "hard", output: "hard" } },
    }), Date.now());
    assert.equal(reservation.status, "leased");
    assert.equal(reservation.lease.resourceId, "fake-anthropic/claude-fake-1");
    assert.equal(reservation.lease.profile, profile);
    broker.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog rejects malformed provider entries", () => {
  assert.throws(() => catalogToBrokerRegistry([]), /non-empty array/);
  assert.throws(() => catalogToBrokerRegistry([{ provider: 123 }]), /bounded provider identifier/);
  assert.throws(() => catalogToBrokerRegistry([{ provider: "p1", baseUrl: "", api: "x", models: [] }]), /baseUrl/);
  assert.throws(() => catalogToBrokerRegistry([{ provider: "p1", baseUrl: "http://x", api: "x", models: [] }]), /1\.\.4096 models/);
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

  // The weak model is a resource of its own rather than being folded into the strong one —
  // without that there is nothing cheap left to select.
  const weak = registry.profiles[registry.resources["test-provider/small"].profile];
  assert.deepEqual(weak.supports, ["text_generation"]);

  const strong = registry.profiles[registry.resources["test-provider/large"].profile];
  assert.ok(strong.supports.includes("code_reasoning"));
  assert.ok(strong.supports.includes("vision_input"));
  assert.ok(strong.supports.includes("large_context"));
  assert.ok(strong.supports.includes("text_generation"));
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