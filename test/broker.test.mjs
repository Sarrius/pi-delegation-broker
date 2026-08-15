import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../src/broker.mjs";

function withBroker(callback, registry = fixtureRegistry(), options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-"));
  const path = join(directory, "broker.sqlite");
  const broker = new SqliteLeaseBroker({ path, registry, ...options });
  try { return callback(broker, path, directory); } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
}

function leased(broker, contract = fixtureContract(), now = 1_000) {
  const result = broker.reserve(contract, now);
  assert.equal(result.status, "leased");
  return result.lease;
}

test("SQLite transaction serializes the shared capacity group across independent broker instances", () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-shared-"));
  const path = join(directory, "broker.sqlite");
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const first = new SqliteLeaseBroker({ path, registry });
  const second = new SqliteLeaseBroker({ path, registry });
  try {
    assert.equal(first.reserve(fixtureContract({ taskId: "one" }), 1_000).status, "leased");
    assert.equal(second.reserve(fixtureContract({ taskId: "two" }), 1_000).status, "denied_capacity");
    assert.equal(first.leases().length, 1);
    assert.equal(second.leases().length, 1);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("separate Node processes cannot oversubscribe the same SQLite capacity group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-processes-"));
  const path = join(directory, "broker.sqlite");
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const seed = new SqliteLeaseBroker({ path, registry });
  seed.close();
  const worker = fileURLToPath(new URL("./reserve-worker.mjs", import.meta.url));
  const runWorker = (taskId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, path, taskId], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `worker exited ${code}`)));
  });
  try {
    const results = await Promise.all([runWorker("process-a"), runWorker("process-b")]);
    assert.equal(results.filter((result) => result.status === "leased").length, 1);
    assert.equal(results.filter((result) => result.status === "denied_capacity").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("backward wall-clock steps fail closed instead of extending an old capability", () => withBroker((broker) => {
  const lease = leased(broker, fixtureContract({ taskId: "clock-regression" }), 1_000);
  const issued = broker.issueLeaseCapability(lease.leaseId, lease.fencingToken, 1_001);
  assert.equal(issued.status, "issued");
  assert.throws(() => broker.leaseForCapability(issued.capability, 900), /clock_regression_detected/);
  assert.throws(() => broker.heartbeat(lease.leaseId, lease.fencingToken, 900, 30_000), /clock_regression_detected/);
  assert.equal(broker.leases()[0].expiresAt, lease.expiresAt);
}));

test("expiry plus monotonic fencing prevents stale workers from authorizing an effect", () => withBroker((broker) => {
  const first = leased(broker, fixtureContract({ leaseTtlMs: 5 }));
  assert.deepEqual(broker.expire(1_005), [first.leaseId]);
  const second = leased(broker, fixtureContract({ taskId: "task-2" }), 1_005);
  assert.ok(second.fencingToken > first.fencingToken);
  const authorization = broker.authorizeEffect({
    taskId: first.taskId,
    leaseId: first.leaseId,
    fencingToken: first.fencingToken,
    idempotencyKey: "stale-effect",
    targetDigest: "patch-A",
    approval: { targetDigest: "patch-A", expiresAt: 2_000 },
  }, 1_006);
  assert.equal(authorization.status, "denied_lease");
}));

test("429 moves only to an approved equivalent profile and otherwise pauses capacity", () => withBroker((broker) => {
  const first = leased(broker);
  broker.markRateLimited(first.resourceId, 5_000, 1_001);
  broker.release(first.leaseId, first.fencingToken, "429", 1_001);
  const replacement = broker.reserve(fixtureContract({ taskId: "retry" }), 1_001);
  assert.equal(replacement.status, "leased");
  assert.equal(replacement.lease.resourceId, "R2");
  assert.equal(replacement.lease.profile, "reasoning-high/v1");

  broker.markUnknown("R2", 1_002);
  broker.release(replacement.lease.leaseId, replacement.lease.fencingToken, "test", 1_002);
  const stopped = broker.reserve(fixtureContract({ taskId: "no-downgrade" }), 1_002);
  assert.equal(stopped.status, "denied_capacity");
  assert.equal(stopped.earliestCompatibleAt, 6_001);
}));

test("queued capacity work wakes after lease release and becomes ready without a child process waiting", () => {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  withBroker((broker) => {
    const first = leased(broker, fixtureContract({ taskId: "occupant" }), 1_000);
    const queued = broker.submit(fixtureContract({
      taskId: "queued-control",
      recovery: { owner: "root-controller", deadlineAt: 60_000 },
    }), 1_001);
    assert.equal(queued.status, "queued");
    assert.equal(queued.eligibleAt, first.expiresAt);
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["waiting"]);

    broker.release(first.leaseId, first.fencingToken, "completed", 1_002);
    const ready = broker.dispatchPending(1_002);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].taskId, "queued-control");
    assert.equal(ready[0].lease.admissionClass, "control");
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["ready"]);
  }, registry);
});

test("ready work is claimed against the exact contract and reconciled to terminal completion", () => {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  withBroker((broker) => {
    const occupant = leased(broker, fixtureContract({ taskId: "claim-occupant" }), 1_000);
    const contract = fixtureContract({ taskId: "claim-task", recovery: { owner: "root-controller", deadlineAt: 60_000 } });
    assert.equal(broker.submit(contract, 1_001).status, "queued");
    broker.release(occupant.leaseId, occupant.fencingToken, "capacity released", 1_002);
    const [ready] = broker.dispatchPending(1_002);
    assert.equal(ready.taskId, "claim-task");
    assert.equal(broker.claimReadyTask("claim-task", ready.lease.leaseId, { ...contract, operationClass: "validate" }, 1_003).status, "denied_policy");
    const claimed = broker.claimReadyTask("claim-task", ready.lease.leaseId, contract, 1_003);
    assert.equal(claimed.status, "leased");
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["claimed"]);
    assert.equal(broker.claimReadyTask("claim-task", ready.lease.leaseId, contract, 1_003).status, "denied_policy");

    broker.release(claimed.lease.leaseId, claimed.lease.fencingToken, "child provider shutdown", 1_004);
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["awaiting_result"]);
    assert.equal(broker.finalizeClaimedTask("claim-task", claimed.lease.leaseId, claimed.lease.fencingToken, "completed", 1_005).status, "completed");
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["completed"]);
    assert.equal(broker.leases().length, 0);
  }, registry);
});

test("a claimed child release without a parent result escalates at the task deadline", () => {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  withBroker((broker) => {
    const occupant = leased(broker, fixtureContract({ taskId: "lost-result-occupant" }), 1_000);
    const contract = fixtureContract({ taskId: "lost-result-task", recovery: { owner: "result-owner", deadlineAt: 2_000 } });
    broker.submit(contract, 1_001);
    broker.release(occupant.leaseId, occupant.fencingToken, "capacity released", 1_002);
    const [ready] = broker.dispatchPending(1_002);
    const claimed = broker.claimReadyTask(contract.taskId, ready.lease.leaseId, contract, 1_003);
    broker.release(claimed.lease.leaseId, claimed.lease.fencingToken, "child provider shutdown", 1_004);
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["awaiting_result"]);
    broker.dispatchPending(2_000);
    assert.deepEqual(broker.pendingTasks().map((task) => ({ state: task.state, owner: task.recoveryOwner })), [
      { state: "escalated", owner: "result-owner" },
    ]);
    assert.equal(broker.events().at(-1).payload.reason, "result_reconciliation_deadline");
  }, registry);
});

test("an unhanded claimed task is atomically requeued with no lease leak", () => {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  withBroker((broker) => {
    const occupant = leased(broker, fixtureContract({ taskId: "abandon-occupant" }), 1_000);
    const contract = fixtureContract({ taskId: "abandon-task", recovery: { owner: "root-controller", deadlineAt: 60_000 } });
    broker.submit(contract, 1_001);
    broker.release(occupant.leaseId, occupant.fencingToken, "capacity released", 1_002);
    const [ready] = broker.dispatchPending(1_002);
    const claimed = broker.claimReadyTask("abandon-task", ready.lease.leaseId, contract, 1_003);
    assert.equal(claimed.status, "leased");
    assert.equal(broker.abandonClaimedTask("abandon-task", claimed.lease.leaseId, claimed.lease.fencingToken, 1_004).status, "waiting");
    assert.equal(broker.leases().length, 0);
    assert.deepEqual(broker.pendingTasks().map((task) => ({ state: task.state, eligibleAt: task.eligibleAt })), [{ state: "waiting", eligibleAt: 1_004 }]);
  }, registry);
});

test("queued work without a named recovery owner and deadline is rejected instead of waiting forever", () => {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  withBroker((broker) => {
    leased(broker, fixtureContract({ taskId: "occupant" }), 1_000);
    const result = broker.submit(fixtureContract({ taskId: "ownerless", recovery: undefined }), 1_001);
    assert.equal(result.status, "denied_policy");
    assert.match(result.reasons[0], /recovery owner/);
    assert.deepEqual(broker.pendingTasks(), []);
  }, registry);
});

test("durable queue has a hard entry bound and over-capacity work is explicitly escalated", () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-queue-bound-"));
  const path = join(directory, "broker.sqlite");
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const broker = new SqliteLeaseBroker({ path, registry, maxPendingTasks: 1 });
  try {
    leased(broker, fixtureContract({ taskId: "occupant" }), 1_000);
    assert.equal(broker.submit(fixtureContract({ taskId: "queued-one" }), 1_001).status, "queued");
    const overflow = broker.submit(fixtureContract({ taskId: "queued-two", recovery: { owner: "root-owner", deadlineAt: 60_000 } }), 1_002);
    assert.equal(overflow.status, "denied_capacity");
    assert.equal(overflow.reasonCode, "queue_full");
    assert.equal(overflow.recoveryOwner, "root-owner");
    assert.equal(broker.pendingTasks().length, 1);
  } finally {
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capacity wait reaches explicit owner escalation at its deadline", () => {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  withBroker((broker) => {
    leased(broker, fixtureContract({ taskId: "occupant" }), 1_000);
    assert.equal(broker.submit(fixtureContract({
      taskId: "deadline-waiter",
      recovery: { owner: "human-owner", deadlineAt: 2_000 },
    }), 1_001).status, "queued");
    assert.deepEqual(broker.dispatchPending(2_000), []);
    assert.deepEqual(broker.pendingTasks().map((task) => ({ state: task.state, owner: task.recoveryOwner })), [
      { state: "escalated", owner: "human-owner" },
    ]);
    assert.equal(broker.events().some((event) => event.type === "TaskEscalated" && event.payload.taskId === "deadline-waiter"), true);
  }, registry);
});

test("aging admits old work under a sustained stream of newer control tasks", () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-aging-"));
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  registry.capacityGroups["G-shared"].maxConcurrent = 2;
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry, agingStepMs: 10 });
  try {
    leased(broker, fixtureContract({ taskId: "aging-control-floor" }), 1_000);
    let occupant = leased(broker, fixtureContract({ taskId: "aging-occupant" }), 1_000);
    const work = fixtureContract({
      taskId: "aging-work",
      admissionClass: "work",
      recovery: { owner: "scheduler", deadlineAt: 10_000 },
    });
    assert.equal(broker.submit(work, 1_001).status, "queued");
    let workReadyAt;
    for (let round = 0; round < 5 && workReadyAt === undefined; round += 1) {
      const now = 1_002 + round * 10;
      const control = fixtureContract({
        taskId: `aging-control-${round}`,
        recovery: { owner: "scheduler", deadlineAt: 10_000 },
      });
      assert.equal(broker.submit(control, now).status, "queued");
      broker.release(occupant.leaseId, occupant.fencingToken, "round complete", now);
      const [ready] = broker.dispatchPending(now);
      assert.ok(ready);
      if (ready.taskId === work.taskId) workReadyAt = now;
      occupant = ready.lease;
    }
    assert.ok(workReadyAt !== undefined, "old work must outrank a continuing stream of newer control tasks");
    assert.ok(workReadyAt <= 1_032, `work wait was not bounded by aging: ${workReadyAt}`);
  } finally {
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dispatch window keeps fresh control visible behind more than one hundred aged work tasks", () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-dispatch-window-"));
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  registry.capacityGroups["G-shared"].maxConcurrent = 2;
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry, agingStepMs: 30_000 });
  try {
    const floor = leased(broker, fixtureContract({ taskId: "window-floor", leaseTtlMs: 1_000_000 }), 1_000);
    const releasable = leased(broker, fixtureContract({ taskId: "window-release", leaseTtlMs: 1_000_000 }), 1_000);
    for (let index = 0; index < 200; index += 1) {
      assert.equal(broker.submit(fixtureContract({
        taskId: `window-work-${index}`,
        admissionClass: "work",
        recovery: { owner: "window-controller", deadlineAt: 2_000_000 },
      }), 1_001).status, "queued");
    }
    assert.equal(broker.submit(fixtureContract({
      taskId: "window-fresh-control",
      recovery: { owner: "window-controller", deadlineAt: 2_000_000 },
    }), 99_999).status, "queued");
    broker.release(releasable.leaseId, releasable.fencingToken, "capacity returns", 100_000);
    broker.release(floor.leaseId, floor.fencingToken, "control floor returns", 100_000);
    const ready = broker.dispatchPending(100_000, 100);
    assert.equal(ready.some((item) => item.taskId === "window-fresh-control"), true);
    assert.equal(ready.filter((item) => item.lease.admissionClass === "control").length, 1);
  } finally {
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("work fan-out cannot consume control and verifier admission reserves", () => {
  const registry = fixtureRegistry();
  registry.capacityGroups["G-shared"] = {
    ...registry.capacityGroups["G-shared"],
    maxConcurrent: 3,
    admission: { controlReserve: 1, verifyReserve: 1 },
  };
  delete registry.resources.R2;
  delete registry.resources.R3;
  withBroker((broker) => {
    assert.equal(broker.reserve(fixtureContract({ taskId: "work-1", admissionClass: "work" }), 1_000).status, "leased");
    assert.equal(broker.reserve(fixtureContract({ taskId: "work-2", admissionClass: "work" }), 1_000).status, "denied_capacity");
    assert.equal(broker.reserve(fixtureContract({ taskId: "verifier", admissionClass: "verify" }), 1_000).status, "leased");
    assert.equal(broker.reserve(fixtureContract({ taskId: "merger", admissionClass: "control" }), 1_000).status, "leased");
    assert.deepEqual(broker.leases().map((lease) => lease.admissionClass).sort(), ["control", "verify", "work"]);
  }, registry);
});

test("assumed inventory cannot back a route that claims hard budget enforcement", () => {
  const registry = fixtureRegistry();
  for (const group of Object.values(registry.capacityGroups)) group.confidence = "assumed";
  withBroker((broker) => {
    const result = broker.reserve(fixtureContract(), 1_000);
    assert.equal(result.status, "denied_policy");
    assert.match(result.reasons[0], /assumed inventory/);
    assert.equal(broker.leases().length, 0);
  }, registry);
});

test("cooldown default comes from registry and only one half-open probe is admitted", () => {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  registry.capacityGroups["G-shared"].cooldown = { defaultMs: 10_000, probeIntervalMs: 2_000 };
  withBroker((broker) => {
    const initial = leased(broker, fixtureContract({ taskId: "initial" }), 1_000);
    const cooldown = broker.markRateLimited(initial.resourceId, undefined, 1_001);
    assert.equal(cooldown.until, 11_001);
    broker.release(initial.leaseId, initial.fencingToken, "429", 1_001);
    assert.equal(broker.reserve(fixtureContract({ taskId: "too-early" }), 11_000).earliestCompatibleAt, 11_001);

    const probe = broker.reserve(fixtureContract({ taskId: "probe" }), 11_001);
    assert.equal(probe.status, "leased");
    assert.equal(probe.lease.probe, true);
    const follower = broker.reserve(fixtureContract({ taskId: "follower" }), 11_001);
    assert.equal(follower.status, "denied_capacity");
    assert.equal(follower.earliestCompatibleAt, probe.lease.expiresAt);

    assert.equal(broker.markProviderSucceeded(probe.lease.leaseId, probe.lease.fencingToken, 11_002).breakerClosed, true);
    broker.release(probe.lease.leaseId, probe.lease.fencingToken, "probe success", 11_002);
    const normal = broker.reserve(fixtureContract({ taskId: "normal" }), 11_002);
    assert.equal(normal.status, "leased");
    assert.equal(normal.lease.probe, false);
  }, registry);
});

test("a pre-cooldown in-flight success cannot close a breaker opened by another lease", () => {
  const registry = fixtureRegistry();
  registry.capacityGroups["G-shared"] = {
    ...registry.capacityGroups["G-shared"],
    maxConcurrent: 2,
    admission: { controlReserve: 1, verifyReserve: 0 },
    cooldown: { defaultMs: 10_000, probeIntervalMs: 2_000 },
  };
  delete registry.resources.R2;
  delete registry.resources.R3;
  withBroker((broker) => {
    const limited = leased(broker, fixtureContract({ taskId: "limited" }), 1_000);
    const olderSuccess = leased(broker, fixtureContract({ taskId: "older-success" }), 1_000);
    const cooldown = broker.markRateLimited(limited.resourceId, undefined, 1_001);
    broker.release(limited.leaseId, limited.fencingToken, "429", 1_001);
    const observed = broker.markProviderSucceeded(olderSuccess.leaseId, olderSuccess.fencingToken, 1_002);
    assert.equal(observed.breakerClosed, false);
    broker.release(olderSuccess.leaseId, olderSuccess.fencingToken, "completed", 1_002);
    const blocked = broker.reserve(fixtureContract({ taskId: "must-stay-cooling" }), 1_003);
    assert.equal(blocked.status, "denied_capacity");
    assert.equal(blocked.earliestCompatibleAt, cooldown.until);
  }, registry);
});

test("contract admission requires child-facing done criteria, prompt binding, and latency budget", () => withBroker((broker) => {
  assert.equal(broker.reserve(fixtureContract({ taskId: "missing-done", doneWhen: [] }), 1_000).status, "denied_policy");
  assert.equal(broker.reserve(fixtureContract({ taskId: "missing-prompt", promptDigest: "not-a-digest" }), 1_000).status, "denied_policy");
  assert.equal(broker.reserve(fixtureContract({ taskId: "missing-latency", latencyBudgetMs: 0 }), 1_000).status, "denied_policy");
  assert.equal(broker.leases().length, 0);
}));

test("effect-capable contracts fail closed until the launch path asserts a blocking behavioral monitor", () => {
  withBroker((broker) => {
    const denied = broker.reserve(fixtureContract({ taskId: "unwired-proposal", operationClass: "propose_patch" }), 1_000);
    assert.equal(denied.status, "denied_policy");
    assert.equal(denied.reasonCode, "behavioral_enforcement_unavailable");
    assert.equal(broker.leases().length, 0);
  });
  withBroker((broker) => {
    const admitted = broker.reserve(fixtureContract({ taskId: "wired-proposal", operationClass: "propose_patch" }), 1_000);
    assert.equal(admitted.status, "leased");
    assert.equal(admitted.lease.behavioralEnforcement, "blocking_monitor");
  }, fixtureRegistry(), { behavioralEnforcement: "blocking_monitor" });
});

test("high-risk work is denied before lease when a requested budget dimension is not hard", () => withBroker((broker) => {
  const result = broker.reserve(fixtureContract({ operationClass: "external_write" }), 1_000);
  assert.equal(result.status, "denied_policy");
  assert.match(result.reasons[0], /hard budget enforcement/);
  assert.equal(broker.leases().length, 0);
}, fixtureRegistry(), { behavioralEnforcement: "blocking_monitor" }));

test("high-risk work cannot omit a hard budget dimension", () => withBroker((broker) => {
  const result = broker.reserve(fixtureContract({
    operationClass: "external_write",
    budget: { maxInputTokens: 100, maxOutputTokens: 10, enforcement: { input: "hard", output: "hard" } },
  }), 1_000);
  assert.equal(result.status, "denied_policy");
  assert.match(result.reasons[0], /input, output, and cost/);
  assert.equal(broker.leases().length, 0);
}, fixtureRegistry(), { behavioralEnforcement: "blocking_monitor" }));

test("typed effect receipts are approval-bound and idempotent", () => {
  const registry = fixtureRegistry();
  for (const resource of Object.values(registry.resources)) resource.enforcement.cost = "hard";
  withBroker((broker) => {
    const lease = leased(broker, fixtureContract({
      operationClass: "apply",
      budget: { maxInputTokens: 100, maxOutputTokens: 10, maxCostMicros: 1_000, enforcement: { input: "hard", output: "hard", cost: "hard" } },
    }));
    assert.equal(lease.maxInputTokens, 100);
    assert.equal(lease.maxOutputTokens, 10);
    assert.equal(lease.maxCostMicros, 1_000);
    const intent = {
      taskId: lease.taskId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      idempotencyKey: "apply-task-1",
      targetDigest: "patch-A",
      approval: { targetDigest: "patch-A", expiresAt: 2_000 },
    };
    assert.equal(broker.recordEffect({ ...intent, targetDigest: "patch-B" }, 1_001).status, "denied_policy");
    const first = broker.recordEffect(intent, 1_001);
    const replay = broker.recordEffect(intent, 1_002);
    assert.equal(first.status, "recorded");
    assert.equal(replay.status, "replayed");
    assert.deepEqual(replay.receipt, first.receipt);
  }, registry, { behavioralEnforcement: "blocking_monitor" });
});

test("durable queued contracts redact secret-shaped text before SQLite persistence", () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-queue-redaction-"));
  const path = join(directory, "broker.sqlite");
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const broker = new SqliteLeaseBroker({ path, registry });
  try {
    leased(broker, fixtureContract({ taskId: "occupant" }), 1_000);
    assert.equal(broker.submit(fixtureContract({
      taskId: "secret-queue",
      intent: "CANARY_SECRET_queue_must_not_persist",
      recovery: { owner: "root-controller", deadlineAt: 60_000 },
    }), 1_001).status, "queued");
  } finally {
    broker.close();
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const serialized = database.prepare("SELECT contract FROM pending_tasks WHERE task_id = 'secret-queue'").get().contract;
    assert.equal(serialized.includes("CANARY_SECRET_queue_must_not_persist"), false);
    assert.match(serialized, /\[REDACTED\]/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a changed registry cannot silently leave stale persisted admission policy active", () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-registry-transition-"));
  const path = join(directory, "broker.sqlite");
  const first = new SqliteLeaseBroker({ path, registry: fixtureRegistry() });
  first.close();
  const changed = fixtureRegistry();
  changed.capacityGroups["G-cheap"].admission.verifyReserve = 2;
  try {
    assert.throws(
      () => new SqliteLeaseBroker({ path, registry: changed }),
      /audited migration is required/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite ledger is durable and redacts canary secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-ledger-"));
  const path = join(directory, "broker.sqlite");
  let lease;
  {
    const broker = new SqliteLeaseBroker({ path, registry: fixtureRegistry() });
    lease = leased(broker);
    broker.release(lease.leaseId, lease.fencingToken, "CANARY_SECRET_alpha token=sk-example-secret", 1_001);
    broker.close();
  }
  {
    const reopened = new SqliteLeaseBroker({ path, registry: fixtureRegistry() });
    const serialized = JSON.stringify(reopened.events());
    assert.equal(serialized.includes("CANARY_SECRET_alpha"), false);
    assert.equal(serialized.includes("sk-example-secret"), false);
    assert.match(serialized, /\[REDACTED\]/);
    reopened.close();
  }
  assert.equal(existsSync(path), true);
  rmSync(directory, { recursive: true, force: true });
});
