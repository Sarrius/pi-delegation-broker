import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteLeaseBroker } from "../src/broker.mjs";
import {
  createResourceModelResolver,
  createSelectContract,
  deriveTaskRequirement,
  parseResourceModel,
  selectModelForTask,
} from "../src/model-selector.mjs";
import { catalogToBrokerRegistry } from "../src/provider-catalog.mjs";

const DIGEST = "b".repeat(64);

/** One account offering a weak, a mid and a strong model. */
function account(provider, { weak = true, mid = true, strong = true } = {}) {
  const models = [];
  if (weak) models.push({ id: "weak", name: "Weak", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, input: ["text"], cost: { input: 1, output: 2 } });
  if (mid) models.push({ id: "mid", name: "Mid", contextWindow: 64_000, maxTokens: 8_000, reasoning: true, input: ["text"], cost: { input: 3, output: 9 } });
  if (strong) models.push({ id: "strong", name: "Strong", contextWindow: 400_000, maxTokens: 32_000, reasoning: true, input: ["text"], cost: { input: 10, output: 40 } });
  return { provider, baseUrl: `https://${provider}.example`, api: "openai-completions", models };
}

function registryOf(accounts, options = { confidence: "measured" }) {
  return catalogToBrokerRegistry(accounts, options);
}

function baseConstraints(overrides = {}) {
  return { taskId: "task-1", promptDigest: DIGEST, ...overrides };
}

function withBroker(registry, callback) {
  const directory = mkdtempSync(join(tmpdir(), "model-selector-"));
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry });
  try { return callback(broker); } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// Stage 4: what class does a task need
// ---------------------------------------------------------------------------

test("a simple read task asks only for text generation", () => {
  const requirement = deriveTaskRequirement("read the changelog and summarize it");
  assert.deepEqual(requirement.capabilities, ["text_generation"]);
  assert.equal(requirement.operationClass, "observe");
});

test("a code task additionally asks for code reasoning", () => {
  const requirement = deriveTaskRequirement("refactor the payment module and fix the failing test");
  assert.ok(requirement.capabilities.includes("code_reasoning"));
});

test("a whole-repository task additionally asks for a large context", () => {
  const requirement = deriveTaskRequirement("audit the entire repository for unused exports");
  assert.ok(requirement.capabilities.includes("large_context"));
});

test("an effect-capable task never lands on the weakest class and is budgeted in what the controller can enforce", () => {
  const registry = registryOf([account("solo")]);
  const selected = selectModelForTask({
    taskDescription: "apply the patch to the repository",
    registry,
    constraints: baseConstraints({ operationClass: "apply" }),
  });
  assert.equal(selected.action, "allow");
  assert.ok(selected.contract.capability.required.includes("code_reasoning"), "effect work reasons about what it changes");
  // Consumption is hard because the controller can actually enforce it. There is no money
  // dimension at all: the broker never observes spend, so it does not pretend to bound it.
  assert.deepEqual(selected.contract.budget.enforcement, { input: "hard", output: "hard" });
  assert.equal(selected.contract.budget.maxCostMicros, undefined);
});

test("a monetary cap is rejected rather than becoming a fictional controller guarantee", () => {
  const registry = registryOf([account("solo")]);
  assert.throws(() => selectModelForTask({
    taskDescription: "apply the patch to the repository",
    registry,
    constraints: baseConstraints({
      operationClass: "apply",
      budget: { maxInputTokens: 1_000, maxOutputTokens: 100, maxCostMicros: 5_000, enforcement: { input: "hard", output: "hard" } },
    }),
  }), /money budgets are not supported/);
});

test("explicit controller capabilities override anything derived from the description", () => {
  const requirement = deriveTaskRequirement("just read a file", { requiredCapabilities: ["large_context"] });
  assert.deepEqual(requirement.capabilities, ["large_context", "text_generation"]);
});

// ---------------------------------------------------------------------------
// Stage 4: closest sufficient quality class, and the escalation that overrides it
// ---------------------------------------------------------------------------

test("with eight accounts alive a simple task takes the closest sufficient class, not the strongest", () => {
  const registry = registryOf(Array.from({ length: 8 }, (_, index) => account(`acct-${index}`)));
  const selected = selectModelForTask({
    taskDescription: "read this file and tell me what it says",
    registry,
    constraints: baseConstraints(),
  });

  assert.equal(selected.action, "allow");
  assert.deepEqual(selected.selection.capabilities, ["text_generation"]);
  assert.equal(selected.selection.escalated, false);
  assert.equal(selected.expectedModel.modelId, "weak", "the weak model is selectable at all");
  assert.equal(selected.selection.capacityGroupCount, 8, "the class spans every account, so one dying is survivable");
});

test("with a single strong-only account the selector escalates instead of denying", () => {
  const registry = registryOf([account("only-strong", { weak: false, mid: false })]);
  const selected = selectModelForTask({
    taskDescription: "read this file and tell me what it says",
    registry,
    constraints: baseConstraints(),
  });

  assert.equal(selected.action, "allow", "work must not stop because the cheap tier is empty");
  assert.equal(selected.selection.escalated, true);
  assert.equal(selected.expectedModel.modelId, "strong");
});

test("an exact identity request narrows selection and never bypasses a gate", () => {
  const registry = registryOf(Array.from({ length: 3 }, (_, index) => account(`acct-${index}`)));

  // Naming a live, admissible model pins selection to exactly that identity.
  const pinned = selectModelForTask({
    taskDescription: "read this file and tell me what it says",
    registry,
    constraints: baseConstraints({ requireModelIdentity: { provider: "acct-1", modelId: "strong" } }),
  });
  assert.equal(pinned.action, "allow");
  assert.equal(pinned.expectedModel.provider, "acct-1");
  assert.equal(pinned.expectedModel.modelId, "strong");

  // Naming a model that does not exist denies; it must never fall back to a different one.
  const missing = selectModelForTask({
    taskDescription: "read this file and tell me what it says",
    registry,
    constraints: baseConstraints({ requireModelIdentity: { provider: "acct-1", modelId: "not-in-catalog" } }),
  });
  assert.equal(missing.action, "deny");

  // Naming a model too weak for the work is still refused: identity is a filter, not a waiver.
  const tooWeak = selectModelForTask({
    taskDescription: "refactor the module and fix the failing test",
    registry,
    constraints: baseConstraints({ requireModelIdentity: { provider: "acct-0", modelId: "weak" } }),
  });
  assert.equal(tooWeak.action, "deny", "an exact identity cannot lower the quality floor");

  assert.throws(
    () => selectModelForTask({
      taskDescription: "read", registry,
      constraints: baseConstraints({ requireModelIdentity: { provider: "acct-0" } }),
    }),
    /requireModelIdentity must be \{provider, modelId\}/,
  );
});

test("a class weaker than required is never selected, even as the only survivor", () => {
  const registry = registryOf([account("weak-only", { mid: false, strong: false })]);
  const selected = selectModelForTask({
    taskDescription: "refactor the module and fix the failing test",
    registry,
    constraints: baseConstraints(),
  });

  assert.equal(selected.action, "deny", "downward substitution stays forbidden");
  assert.match(selected.reason, /no (approved profile|live resource)/);
});

test("when every unknown route is still inside its retry delay the denial is explicit", () => {
  const registry = registryOf([account("solo")]);
  const availability = Object.keys(registry.resources).map((resourceId) => ({
    resourceId,
    state: "unknown",
    cooldownUntil: 2_000,
  }));
  const selected = selectModelForTask({
    taskDescription: "read a file",
    registry,
    availability,
    constraints: baseConstraints(),
    now: 1_000,
  });
  assert.equal(selected.action, "deny");
});

test("an unknown authenticated route becomes eligible for one half-open recovery probe", () => {
  const registry = registryOf([account("solo")]);
  const availability = Object.keys(registry.resources).map((resourceId) => ({
    resourceId,
    state: "unknown",
    cooldownUntil: 999,
    probeLeaseId: null,
  }));
  const selected = selectModelForTask({
    taskDescription: "audit the entire repository",
    registry,
    availability,
    constraints: baseConstraints(),
    now: 1_000,
  });
  assert.equal(selected.action, "allow");
  assert.equal(selected.expectedModel.modelId, "strong");
});

test("hard-budget work refuses assumed inventory the way the broker does", () => {
  const registry = registryOf([account("guessy")], { confidence: "assumed" });
  const selected = selectModelForTask({
    taskDescription: "read a file",
    registry,
    constraints: baseConstraints(),
  });
  assert.equal(selected.action, "deny");
  assert.match(selected.reason, /measured or observed/);
});

// ---------------------------------------------------------------------------
// Stage 4: choosing among equals
// ---------------------------------------------------------------------------

test("a measured account outranks an otherwise equivalent observed one", () => {
  const registry = {
    profiles: { "caps/text_generation/v1": { status: "approved", supports: ["text_generation"] } },
    capacityGroups: {
      "G-cheap": { maxConcurrent: 2, admission: { controlReserve: 1, verifyReserve: 0 }, cooldown: { defaultMs: 1_000, probeIntervalMs: 100 }, confidence: "observed" },
      "G-known": { maxConcurrent: 2, admission: { controlReserve: 1, verifyReserve: 0 }, cooldown: { defaultMs: 1_000, probeIntervalMs: 100 }, confidence: "measured" },
    },
    resources: {
      "cheap/m": { capacityGroup: "G-cheap", profile: "caps/text_generation/v1", confidence: "observed", enforcement: { input: "hard", output: "hard" }, model: { provider: "cheap", modelId: "m" } },
      "known/m": { capacityGroup: "G-known", profile: "caps/text_generation/v1", confidence: "measured", enforcement: { input: "hard", output: "hard" }, model: { provider: "known", modelId: "m" } },
    },
  };
  const selected = selectModelForTask({ taskDescription: "read a file", registry, constraints: baseConstraints() });
  assert.equal(selected.selection.resourceId, "known/m", "measured availability is stronger evidence than an unobserved peer");
});

test("among equally known accounts cold start is deterministic without a price table", () => {
  const registry = registryOf([account("a", { mid: false, strong: false }), account("b", { mid: false, strong: false })]);
  const selected = selectModelForTask({ taskDescription: "read a file", registry, constraints: baseConstraints() });
  assert.equal(selected.selection.resourceId, "a/weak");
});

test("a resource the caller excluded is not selected", () => {
  const registry = registryOf([account("a", { mid: false, strong: false }), account("b", { mid: false, strong: false })]);
  const selected = selectModelForTask({
    taskDescription: "read a file",
    registry,
    constraints: baseConstraints({ excludeResources: ["a/weak"] }),
  });
  assert.equal(selected.selection.resourceId, "b/weak");
});

test("selection can be confined to the accounts delegation is allowed to spend", () => {
  const registry = registryOf([account("human-only", { mid: false, strong: false }), account("children", { mid: false, strong: false })]);
  const selected = selectModelForTask({
    taskDescription: "read a file",
    registry,
    constraints: baseConstraints({ allowedProviders: ["children"] }),
  });
  assert.equal(selected.selection.resourceId, "children/weak");
});

// ---------------------------------------------------------------------------
// The strongest check: the contract the selector builds is one the broker accepts
// ---------------------------------------------------------------------------

test("the selected contract actually leases against a real broker", () => {
  const registry = registryOf([account("acct-a"), account("acct-b")]);
  withBroker(registry, (broker) => {
    const now = 1_000;
    const selected = selectModelForTask({
      taskDescription: "read the file and summarize",
      registry,
      availability: broker.inventory(now),
      constraints: baseConstraints({ admissionClass: "work" }),
      now,
    });
    assert.equal(selected.action, "allow");

    const reservation = broker.reserve(selected.contract, now);
    assert.equal(reservation.status, "leased", JSON.stringify(reservation));
    assert.equal(reservation.lease.profile, selected.contract.capability.minimumProfile);

    const resolveModel = createResourceModelResolver(registry);
    const leasedModel = resolveModel(reservation.lease.resourceId);
    assert.ok(leasedModel?.provider && leasedModel?.modelId, "the leased resource maps back to a concrete model");
  });
});

test("a code contract leases onto a reasoning-capable class", () => {
  const registry = registryOf([account("acct-a")]);
  withBroker(registry, (broker) => {
    const now = 2_000;
    const selected = selectModelForTask({
      taskDescription: "fix the failing test in the parser module",
      registry,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "task-code", admissionClass: "work" }),
      now,
    });
    assert.ok(selected.contract.capability.required.includes("code_reasoning"));
    const reservation = broker.reserve(selected.contract, now);
    assert.equal(reservation.status, "leased");
    const resolveModel = createResourceModelResolver(registry);
    assert.notEqual(resolveModel(reservation.lease.resourceId).modelId, "weak", "a weak model cannot serve a code class");
  });
});

// ---------------------------------------------------------------------------
// Stage 1 + 4: a rate limit mid-flight reroutes and the work still completes
// ---------------------------------------------------------------------------

test("a rate limit on one account reroutes the same contract onto another", () => {
  const registry = registryOf([account("acct-a", { mid: false, strong: false }), account("acct-b", { mid: false, strong: false })]);
  withBroker(registry, (broker) => {
    let now = 3_000;
    const first = selectModelForTask({
      taskDescription: "read a file",
      registry,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "task-rl", admissionClass: "work" }),
      now,
    });
    const lease = broker.reserve(first.contract, now).lease;
    assert.equal(lease.status, undefined);
    const burned = lease.resourceId;

    // The child hits a provider rate limit. That is a routing signal, not a child failure:
    // the whole account cools down and the lease goes back.
    broker.markRateLimited(burned, 60_000, now);
    broker.release(lease.leaseId, lease.fencingToken, "rate limited", now);

    now += 1;
    const second = selectModelForTask({
      taskDescription: "read a file",
      registry,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "task-rl-2", admissionClass: "work" }),
      now,
    });
    assert.equal(second.action, "allow", "the job must still finish");
    assert.notEqual(second.selection.resourceId, burned, "the cooled account is not offered again");

    const retry = broker.reserve(second.contract, now);
    assert.equal(retry.status, "leased");
    assert.notEqual(retry.lease.resourceId, burned);
  });
});

// ---------------------------------------------------------------------------
// Stage 3: the picture changes while work is in flight
// ---------------------------------------------------------------------------

test("a newly authenticated account becomes usable immediately, without waiting for idle", () => {
  const before = registryOf([account("acct-a", { mid: false, strong: false })]);
  withBroker(before, (broker) => {
    const now = 4_000;
    const held = broker.reserve(selectModelForTask({
      taskDescription: "read a file",
      registry: before,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "holder", admissionClass: "work" }),
      now,
    }).contract, now);
    assert.equal(held.status, "leased", "something is deliberately in flight");

    // The whole-registry swap is the operation that cannot run under load.
    assert.equal(broker.reloadRegistry(registryOf([account("acct-a", { mid: false, strong: false }), account("acct-b", { mid: false, strong: false })]), now).status, "denied");

    const after = registryOf([account("acct-a", { mid: false, strong: false }), account("acct-b", { mid: false, strong: false })]);
    const update = broker.updateRegistry(after, now);
    assert.equal(update.status, "updated");
    assert.ok(update.added.includes("resource:acct-b/weak"), "the new account applied while work was running");

    const selected = selectModelForTask({
      taskDescription: "read a file",
      registry: after,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "task-new", admissionClass: "work" }),
      now,
    });
    assert.equal(broker.reserve(selected.contract, now).status, "leased", "the brand-new account takes work at once");
  });
});

test("a withdrawn account with a live lease drains instead of vanishing under it", () => {
  const before = registryOf([account("acct-a", { mid: false, strong: false }), account("acct-b", { mid: false, strong: false })]);
  withBroker(before, (broker) => {
    const now = 5_000;
    const selected = selectModelForTask({
      taskDescription: "read a file",
      registry: before,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "drain", admissionClass: "work" }),
      now,
    });
    const lease = broker.reserve(selected.contract, now).lease;
    const leaving = lease.resourceId;

    const remaining = leaving === "acct-a/weak" ? "acct-b" : "acct-a";
    const after = registryOf([account(remaining, { mid: false, strong: false })]);
    const update = broker.updateRegistry(after, now);

    assert.ok(update.retired.includes(leaving), "the logged-out account is retiring, not deleted");
    assert.ok(broker.inventory(now).some((row) => row.resourceId === leaving && row.retiring), "still present for its live lease");

    // It takes no new work from this moment on.
    const next = selectModelForTask({
      taskDescription: "read a file",
      registry: after,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "drain-2", admissionClass: "work" }),
      now,
    });
    assert.notEqual(next.selection.resourceId, leaving);

    // When its last lease ends it disappears for real.
    broker.release(lease.leaseId, lease.fencingToken, "done", now);
    assert.ok(!broker.inventory(now).some((row) => row.resourceId === leaving), "gone once drained");
  });
});

test("an account withdrawn and re-authenticated before it drains is simply restored", () => {
  const full = registryOf([account("acct-a", { mid: false, strong: false }), account("acct-b", { mid: false, strong: false })]);
  withBroker(full, (broker) => {
    const now = 6_000;
    const lease = broker.reserve(selectModelForTask({
      taskDescription: "read a file",
      registry: full,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "flap", admissionClass: "work" }),
      now,
    }).contract, now).lease;
    const leaving = lease.resourceId;
    const remaining = leaving === "acct-a/weak" ? "acct-b" : "acct-a";

    broker.updateRegistry(registryOf([account(remaining, { mid: false, strong: false })]), now);
    assert.ok(broker.inventory(now).some((row) => row.resourceId === leaving && row.retiring));

    const restored = broker.updateRegistry(full, now);
    assert.ok(restored.restored.includes(leaving), "logging back in un-retires it");
    assert.ok(broker.inventory(now).some((row) => row.resourceId === leaving && !row.retiring));
  });
});

test("an incremental update leaves a live lease and its fencing accounting untouched", () => {
  const before = registryOf([account("acct-a", { mid: false, strong: false })]);
  withBroker(before, (broker) => {
    const now = 7_000;
    const lease = broker.reserve(selectModelForTask({
      taskDescription: "read a file",
      registry: before,
      availability: broker.inventory(now),
      constraints: baseConstraints({ taskId: "stable", admissionClass: "work" }),
      now,
    }).contract, now).lease;

    broker.updateRegistry(registryOf([account("acct-a", { mid: false, strong: false }), account("acct-c", { mid: false, strong: false })]), now);

    assert.equal(broker.heartbeat(lease.leaseId, lease.fencingToken, now, 30_000).status, "leased");
    assert.equal(broker.release(lease.leaseId, lease.fencingToken, "done", now).status, "released");
  });
});

// ---------------------------------------------------------------------------
// Resolver wiring
// ---------------------------------------------------------------------------

test("the resolver callback selects per launch from a registry read at call time", () => {
  let current = registryOf([account("acct-a", { mid: false, strong: false })]);
  const selectContract = createSelectContract({ registry: () => current });

  const first = selectContract({ childId: "child-1", promptDigest: DIGEST, capabilityRequest: { taskDescription: "read a file" } });
  assert.equal(first.action, "allow");
  assert.equal(first.expectedModel.provider, "acct-a");
  assert.equal(first.contract.taskId, "child-1", "the contract binds to the child it was selected for");
  assert.equal(first.contract.promptDigest, DIGEST, "the resolver rejects a contract not bound to the prompt");

  // The provider set changes underneath a long-lived resolver.
  current = registryOf([account("acct-z", { mid: false, strong: false })]);
  const second = selectContract({ childId: "child-2", promptDigest: DIGEST, capabilityRequest: { taskDescription: "read a file" } });
  assert.equal(second.expectedModel.provider, "acct-z", "a snapshot taken at construction would have routed to a dead account");
});

test("a model id containing slashes still maps back to provider and model", () => {
  assert.deepEqual(parseResourceModel("openrouter/anthropic/claude-opus-5:batch"), {
    provider: "openrouter",
    modelId: "anthropic/claude-opus-5:batch",
  });
  assert.equal(parseResourceModel("no-separator"), undefined);
});
