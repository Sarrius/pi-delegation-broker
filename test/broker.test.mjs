import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../src/broker.mjs";

function withBroker(callback, registry = fixtureRegistry()) {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-mvp-"));
  const path = join(directory, "broker.sqlite");
  const broker = new SqliteLeaseBroker({ path, registry });
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

test("high-risk work is denied before lease when a requested budget dimension is not hard", () => withBroker((broker) => {
  const result = broker.reserve(fixtureContract({ operationClass: "external_write" }), 1_000);
  assert.equal(result.status, "denied_policy");
  assert.match(result.reasons[0], /hard budget enforcement/);
  assert.equal(broker.leases().length, 0);
}));

test("typed effect receipts are approval-bound and idempotent", () => {
  const registry = fixtureRegistry();
  for (const resource of Object.values(registry.resources)) resource.enforcement.cost = "hard";
  withBroker((broker) => {
    const lease = leased(broker, fixtureContract({
      operationClass: "apply",
      budget: { maxOutputTokens: 10, enforcement: { input: "hard", output: "hard", cost: "hard" } },
    }));
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
  }, registry);
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
