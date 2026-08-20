import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { ControllerEvidenceStore } from "../src/evidence.mjs";
import { ControllerVerificationAuthority } from "../src/verification-authority.mjs";

function withBroker(callback, registry = fixtureRegistry(), options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-"));
  const path = join(directory, "broker.sqlite");
  const broker = new SqliteLeaseBroker({ path, registry, ...options });
  try { return callback(broker, path, directory); } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
}

function withVerifiedBroker(callback, registry = fixtureRegistry(), options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-verified-"));
  const store = new ControllerEvidenceStore({ root: join(directory, "evidence") });
  const authority = new ControllerVerificationAuthority({ evidenceStore: store });
  const broker = new SqliteLeaseBroker({
    path: join(directory, "broker.sqlite"), registry,
    verificationReceiptVerifier: (receipt, binding) => authority.verify(receipt, binding),
    ...options,
  });
  try { return callback(broker, authority, store); } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
}

function acceptedReceipt(authority, store, runId, binding) {
  const evidence = store.captureObservation({
    kind: "command", claim: "controller check", observation: { exitCode: 0, stdout: "ok", stderr: "" }, capturedAt: 1_005,
  });
  return authority.attest({
    status: "accepted", runId, validation: { status: "accepted" },
    checks: [{ status: "passed" }], result: { evidence: [evidence] },
  }, binding);
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

test("heartbeat keeps the IPC capability authorized past the original lease expiry", () => withBroker((broker) => {
  const lease = leased(broker, fixtureContract({ taskId: "cap-ttl", leaseTtlMs: 1_000 }), 1_000);
  const issued = broker.issueLeaseCapability(lease.leaseId, lease.fencingToken, 1_000);
  assert.equal(issued.status, "issued");
  assert.equal(broker.leaseForCapability(issued.capability, 1_500).status, "authorized");
  assert.equal(broker.heartbeat(lease.leaseId, lease.fencingToken, 1_800, 5_000).status, "leased");
  // Original capability snapshot expired at 2_000. A child that heartbeated at 1_800 must
  // still be able to declare a tool at 2_500 — otherwise the lease looks alive and IPC is dead.
  assert.equal(broker.leaseForCapability(issued.capability, 2_500).status, "authorized");
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

test("ready work is claimed against the exact contract and only a controller verifier can complete it", () => {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  withVerifiedBroker((broker, authority, store) => {
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

    // The child releases its own lease on exit; only the controller's close path may then move
    // the task toward verification — a bare release is capacity bookkeeping, not a result.
    broker.release(claimed.lease.leaseId, claimed.lease.fencingToken, "child provider shutdown", 1_004);
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["claimed"]);
    assert.equal(broker.releaseClaimedTaskForVerification("claim-task", claimed.lease.leaseId, claimed.lease.fencingToken, 1_004).status, "awaiting_verification");
    assert.equal(broker.finalizeVerifiedTask("claim-task", claimed.lease.leaseId, claimed.lease.fencingToken, {
      status: "accepted", verifierRunId: "forged-controller-shape",
      evidenceRefs: ["controller:11111111-1111-4111-8111-111111111111"],
      receiptRef: "controller:22222222-2222-4222-8222-222222222222",
    }, 1_005).status, "denied_verification", "controller IPC shape alone cannot complete a task");
    assert.equal(broker.finalizeVerifiedTask(
      "claim-task", claimed.lease.leaseId, claimed.lease.fencingToken,
      acceptedReceipt(authority, store, "verifier-claim-task", {
        taskId: "claim-task", leaseId: claimed.lease.leaseId, fencingToken: claimed.lease.fencingToken,
      }), 1_005,
    ).status, "completed");
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["completed"]);
    assert.equal(broker.leases().length, 0);
  }, registry);
});

test("an immediate lease can become a durable verifier-bound task", () => {
  withVerifiedBroker((broker, authority, store) => {
    const contract = fixtureContract({ taskId: "direct-tracked" });
    const lease = leased(broker, contract, 1_000);
    assert.equal(broker.trackLeasedTask(contract, lease.leaseId, lease.fencingToken, 1_001).status, "tracked");
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["claimed"]);
    assert.equal(broker.releaseClaimedTaskForVerification("direct-tracked", lease.leaseId, lease.fencingToken, 1_002).status, "awaiting_verification");
    assert.equal(broker.finalizeVerifiedTask("direct-tracked", lease.leaseId, lease.fencingToken,
      acceptedReceipt(authority, store, "verifier-direct-tracked", { taskId: "direct-tracked", leaseId: lease.leaseId, fencingToken: lease.fencingToken }), 1_003).status, "completed");
  });
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
    assert.deepEqual(broker.pendingTasks().map((task) => task.state), ["claimed"],
      "a child that released without a close is an orphan, not a result awaiting verification");
    broker.dispatchPending(2_000);
    assert.deepEqual(broker.pendingTasks().map((task) => ({ state: task.state, owner: task.recoveryOwner })), [
      { state: "escalated", owner: "result-owner" },
    ]);
    assert.equal(broker.events().at(-1).payload.reason, "claimed_child_deadline");
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
  const result = broker.reserve(fixtureContract({
    operationClass: "external_write",
    budget: { maxInputTokens: 100, maxOutputTokens: 10, enforcement: { input: "hard", output: "metered_best_effort" } },
  }), 1_000);
  assert.equal(result.status, "denied_policy");
  assert.match(result.reasons[0], /hard token budget enforcement/);
  assert.equal(broker.leases().length, 0);
}, fixtureRegistry(), { behavioralEnforcement: "blocking_monitor" }));

test("high-risk work cannot omit a hard token budget dimension", () => withBroker((broker) => {
  const result = broker.reserve(fixtureContract({
    operationClass: "external_write",
    budget: { maxInputTokens: 100, enforcement: { input: "hard", output: "hard" } },
  }), 1_000);
  assert.equal(result.status, "denied_policy");
  assert.match(result.reasons[0], /hard output enforcement/);
  assert.equal(broker.leases().length, 0);
}, fixtureRegistry(), { behavioralEnforcement: "blocking_monitor" }));

test("typed effect receipts are approval-bound and idempotent", () => {
  const registry = fixtureRegistry();
  withBroker((broker) => {
    const lease = leased(broker, fixtureContract({
      operationClass: "apply",
      budget: { maxInputTokens: 100, maxOutputTokens: 10, enforcement: { input: "hard", output: "hard" } },
    }));
    assert.equal(lease.maxInputTokens, 100);
    assert.equal(lease.maxOutputTokens, 10);
    assert.equal(lease.maxCostMicros, undefined);
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

test("a dynamic broker reconciles a changed catalog at startup through the drain-safe update path", () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-dynamic-startup-"));
  const path = join(directory, "broker.sqlite");
  const first = new SqliteLeaseBroker({ path, registry: fixtureRegistry() });
  first.close();
  const changed = fixtureRegistry();
  delete changed.resources.R2;
  delete changed.capacityGroups["G-independent"];
  try {
    const restarted = new SqliteLeaseBroker({ path, registry: changed, reconcileRegistryOnStart: true });
    assert.deepEqual(restarted.inventory(Date.now()).map((row) => row.resourceId).sort(), ["R1", "R1_ALIAS", "R3"]);
    assert.ok(restarted.events().some((event) => event.type === "RegistryUpdated"));
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
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


test("transactional registry reload replaces registry when no active leases or tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-reload-"));
  try {
    const broker = new SqliteLeaseBroker({ path: join(dir, "b.sqlite"), registry: fixtureRegistry() });
    const newRegistry = fixtureRegistry();
    newRegistry.resources = {
      ...fixtureRegistry().resources,
      R4: { capacityGroup: "G-cheap", profile: "audit-low/v1", confidence: "measured", enforcement: { input: "hard", output: "hard" } },
    };
    const result = broker.reloadRegistry(newRegistry, Date.now());
    assert.equal(result.status, "reloaded");
    // The old resources (R1, R2) are gone; only the new set remains
    const reservation = broker.reserve(fixtureContract({ taskId: "reload-test" }), Date.now());
    assert.equal(reservation.status, "leased");
    // R4 exists in the new registry and is available for the audit-low profile
    const auditReservation = broker.reserve(fixtureContract({
      taskId: "reload-audit",
      capability: { minimumProfile: "audit-low/v1", required: ["read_only_audit"], downgradePolicy: "forbid" },
    }), Date.now());
    assert.equal(auditReservation.status, "leased");
    assert.equal(auditReservation.lease.resourceId, "R4");
    broker.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registry reload is denied while active leases exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-reload-busy-"));
  try {
    const broker = new SqliteLeaseBroker({ path: join(dir, "b.sqlite"), registry: fixtureRegistry() });
    const reservation = broker.reserve(fixtureContract({ taskId: "busy-task" }), Date.now());
    assert.equal(reservation.status, "leased");
    const result = broker.reloadRegistry(fixtureRegistry(), Date.now());
    assert.equal(result.status, "denied");
    assert.equal(result.reason, "active_leases_exist");
    broker.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registry reload is denied while active pending tasks exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-reload-queue-"));
  try {
    const broker = new SqliteLeaseBroker({ path: join(dir, "b.sqlite"), registry: fixtureRegistry() });
    // Consume both reasoning-high resources so submit queues
    const r1 = broker.reserve(fixtureContract({ taskId: "holder-1" }), Date.now());
    const r2 = broker.reserve(fixtureContract({ taskId: "holder-2" }), Date.now());
    const submitted = broker.submit(fixtureContract({ taskId: "queued-task", recovery: { owner: "controller", deadlineAt: Date.now() + 60_000 } }), Date.now());
    assert.equal(submitted.status, "queued");
    // Release both holders so no active leases remain, but the waiting task persists
    broker.release(r1.lease.leaseId, r1.lease.fencingToken, "test", Date.now());
    broker.release(r2.lease.leaseId, r2.lease.fencingToken, "test", Date.now());
    const result = broker.reloadRegistry(fixtureRegistry(), Date.now());
    assert.equal(result.status, "denied");
    assert.equal(result.reason, "active_tasks_exist");
    broker.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registry reload with invalid candidate rolls back to previous registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-reload-invalid-"));
  try {
    const broker = new SqliteLeaseBroker({ path: join(dir, "b.sqlite"), registry: fixtureRegistry() });
    const badRegistry = fixtureRegistry();
    badRegistry.resources = {
      R4: { capacityGroup: "G-nonexistent", profile: "audit-low/v1", confidence: "measured", enforcement: { input: "hard", output: "hard" } },
    };
    assert.throws(() => broker.reloadRegistry(badRegistry, Date.now()), /Invalid resource policy/);
    // The old registry should still work
    const reservation = broker.reserve(fixtureContract({ taskId: "after-rollback" }), Date.now());
    assert.equal(reservation.status, "leased");
    broker.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a revoked credential condemns its whole account, not just the model that reported it", () => withBroker((broker) => {
  // R1 and R1_ALIAS are two models of one account: they share a credential, so proving that
  // credential dead on one of them is proof for both.
  const auth = broker.markUnknown("R1", 1_000, "provider auth fatal", "capacity_group");
  assert.equal(auth.capacityGroup, "G-shared");
  assert.equal(auth.alsoAffected, 1, "the sibling model on the same account is condemned too");
  const states = broker.inventory(1_000);
  assert.equal(states.find((row) => row.resourceId === "R1_ALIAS").state, "unknown");
  // A different account is untouched: this is credential evidence, not a global outage.
  assert.equal(states.find((row) => row.resourceId === "R2").state, "healthy");
}));

test("a model-specific refusal condemns only that route", () => withBroker((broker) => {
  const single = broker.markUnknown("R1", 1_000, "model refused request", "resource");
  assert.equal(single.status, "unknown");
  assert.equal(single.capacityGroup, undefined);
  assert.equal(broker.inventory(1_000).find((row) => row.resourceId === "R1_ALIAS").state, "healthy");
}));

test("a registry reload does not resurrect accounts already proven dead", () => withBroker((broker) => {
  broker.markRateLimited("R1", 60_000, 1_000);            // throttled account
  broker.markUnknown("R2", 1_000, "revoked", "resource"); // dead credential
  const reloaded = broker.reloadRegistry(fixtureRegistry(), 1_001);
  assert.equal(reloaded.status, "reloaded");
  const inventory = broker.inventory(1_001);
  const shared = inventory.find((row) => row.resourceId === "R1");
  assert.equal(shared.breakerState, "cooling_down", "a throttle survives a configuration reload");
  assert.ok(shared.groupCooldownUntil > 1_001, "the remaining cooldown is preserved, not reset");
  assert.equal(inventory.find((row) => row.resourceId === "R2").state, "unknown");
  // A healthy account is untouched, so a reload cannot silently quarantine a working route.
  assert.equal(inventory.find((row) => row.resourceId === "R3").state, "healthy");
}));

test("a controller with no receipt authority says so instead of denying opaquely", () => withBroker((broker) => {
  // withBroker wires no verificationReceiptVerifier, which is exactly the misconfiguration that
  // silently made every verified completion fail: the acceptance path ran and was then discarded.
  const denied = broker.finalizeVerifiedTask("t", "l", 1, {
    status: "accepted", verifierRunId: "run-1", evidenceRefs: ["controller:11111111-1111-4111-8111-111111111111"],
    receiptRef: "controller:22222222-2222-4222-8222-222222222222",
  }, 1_000);
  assert.equal(denied.status, "denied_verification");
  assert.equal(denied.reason, "no_receipt_authority");
}));

test("a failed child that releases its own lease leaves the task requeueable for the next route", () => withBroker((broker) => {
  // The exact live sequence: attempt 1's child fails and self-releases, then attempt 2 must be
  // able to rebind the same logical task instead of finding it stranded in awaiting_result.
  const contract = fixtureContract({ taskId: "relay" });
  const first = broker.reserve(contract, 1_000);
  assert.equal(broker.trackLeasedTask(contract, first.lease.leaseId, first.lease.fencingToken, 1_001).status, "tracked");
  broker.release(first.lease.leaseId, first.lease.fencingToken, "child release", 1_002);
  assert.equal(broker.pendingTasks().find((t) => t.taskId === "relay").state, "claimed",
    "a failed child's lease release must not pretend its result is ready for verification");
  assert.equal(broker.abandonClaimedTask("relay", first.lease.leaseId, first.lease.fencingToken, 1_003).status, "waiting");

  const second = broker.reserve(contract, 1_004);
  assert.equal(second.status, "leased");
  assert.equal(broker.trackLeasedTask(contract, second.lease.leaseId, second.lease.fencingToken, 1_005).status, "tracked",
    "the same logical task rebinds to the next attempt's lease");
  // The second child completes and also self-releases before the controller closes it.
  broker.release(second.lease.leaseId, second.lease.fencingToken, "child release", 1_006);
  assert.equal(broker.releaseClaimedTaskForVerification("relay", second.lease.leaseId, second.lease.fencingToken, 1_007).status,
    "awaiting_verification", "completion is verified even though the child released first");
}));
