import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { requestBrokerIpc } from "../src/ipc.mjs";
import { ScriptedFakeProvider } from "../src/fake-provider.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";

const CONTROLLER_TOKEN = "c".repeat(48);

function stateDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function oneCapacityRegistry() {
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  return registry;
}

async function reserve(supervisor, taskId, overrides = {}) {
  return requestBrokerIpc({
    socketPath: supervisor.socketPath,
    authorization: supervisor.controllerToken,
    method: "reserve",
    params: { contract: fixtureContract({ taskId, ...overrides }) },
  });
}

test("single-host supervisor owns an owner-only state dir, socket, lock and periodic TTL expiry", async () => {
  const stateDir = stateDirectory("broker-supervisor-");
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir,
    registry: oneCapacityRegistry(),
    allowUnsignedFixture: true,
    controllerToken: CONTROLLER_TOKEN,
    sweepIntervalMs: 100,
  });
  try {
    assert.equal(JSON.stringify(supervisor.status()).includes(CONTROLLER_TOKEN), false);
    const started = await supervisor.start();
    assert.equal(started.state, "running");
    assert.equal(statSync(stateDir).mode & 0o077, 0);
    assert.equal(statSync(supervisor.socketPath).mode & 0o077, 0);
    assert.equal(statSync(supervisor.databasePath).mode & 0o077, 0);
    assert.equal(statSync(join(stateDir, "broker.lock")).mode & 0o077, 0);

    const first = await reserve(supervisor, "sweep-old", { leaseTtlMs: 20 });
    assert.equal(first.status, "leased");
    const capability = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "issueLeaseCapability",
      params: { leaseId: first.lease.leaseId, fencingToken: first.lease.fencingToken },
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    await assert.rejects(
      () => requestBrokerIpc({ socketPath: supervisor.socketPath, authorization: capability.capability, method: "heartbeat" }),
      /unauthorized/,
    );
    const replacement = await reserve(supervisor, "sweep-new");
    assert.equal(replacement.status, "leased");

    const stopped = await supervisor.stop();
    assert.equal(stopped.state, "stopped");
    assert.equal(existsSync(supervisor.socketPath), false);
    assert.equal(existsSync(join(stateDir, "broker.lock")), false);
    assert.equal(existsSync(supervisor.databasePath), true, "durable ledger survives a clean lifecycle restart");
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("supervisor scheduler wakes queued controller work after capacity is released", async () => {
  const stateDir = stateDirectory("broker-supervisor-queue-");
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir,
    registry: oneCapacityRegistry(),
    allowUnsignedFixture: true,
    controllerToken: CONTROLLER_TOKEN,
    sweepIntervalMs: 100,
  });
  try {
    await supervisor.start();
    const occupant = await reserve(supervisor, "queue-occupant", { leaseTtlMs: 60_000 });
    const queued = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "submit",
      params: { contract: fixtureContract({
        taskId: "queue-waiter",
        recovery: { owner: "root-controller", deadlineAt: Date.now() + 60_000 },
      }) },
    });
    assert.equal(queued.status, "queued");
    await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "release",
      params: { leaseId: occupant.lease.leaseId, fencingToken: occupant.lease.fencingToken },
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const snapshot = supervisor.auditSnapshot();
    assert.deepEqual(snapshot.pendingTasks.map((task) => task.state), ["ready"]);
    assert.equal(snapshot.leases.some((lease) => lease.taskId === "queue-waiter"), true);
    const ready = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "readyTasks",
    });
    assert.equal(ready.length, 1);
    assert.equal(ready[0].taskId, "queue-waiter");
    assert.equal(ready[0].lease.taskId, "queue-waiter");
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("supervisor fails closed on a stale/foreign lock without deleting it", async () => {
  const stateDir = stateDirectory("broker-supervisor-lock-");
  const lockPath = join(stateDir, "broker.lock");
  const foreignLock = '{"instanceId":"foreign","pid":99999}\n';
  writeFileSync(lockPath, foreignLock, { mode: 0o600 });
  const supervisor = new SingleHostBrokerSupervisor({ stateDir, registry: fixtureRegistry(), allowUnsignedFixture: true, controllerToken: CONTROLLER_TOKEN });
  try {
    await assert.rejects(() => supervisor.start(), /already locked or has a stale lock/);
    assert.equal(readFileSync(lockPath, "utf8"), foreignLock);
    assert.equal(existsSync(join(stateDir, "broker.sock")), false);
    assert.equal(existsSync(join(stateDir, "broker.sqlite")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("supervisor rejects an insecure state directory before any broker artifact is created", () => {
  const stateDir = stateDirectory("broker-supervisor-mode-");
  try {
    chmodSync(stateDir, 0o755);
    assert.throws(
      () => new SingleHostBrokerSupervisor({ stateDir, registry: fixtureRegistry(), allowUnsignedFixture: true, controllerToken: CONTROLLER_TOKEN }),
      /owner-only directory/,
    );
    assert.equal(existsSync(join(stateDir, "broker.sqlite")), false);
    assert.equal(existsSync(join(stateDir, "broker.lock")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("supervisor rejects an owner-only state dir whose Unix socket path is too long", () => {
  const parent = stateDirectory("broker-supervisor-socket-limit-");
  const stateDir = join(parent, "x".repeat(48));
  mkdirSync(stateDir, { mode: 0o700 });
  try {
    assert.throws(
      () => new SingleHostBrokerSupervisor({ stateDir, registry: fixtureRegistry(), allowUnsignedFixture: true, controllerToken: CONTROLLER_TOKEN }),
      /Unix socket path exceed/,
    );
    assert.equal(existsSync(join(stateDir, "broker.lock")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bounded supervisor shutdown aborts a delayed fake attempt instead of waiting for it", async () => {
  const stateDir = stateDirectory("broker-supervisor-stop-");
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir,
    registry: fixtureRegistry(),
    allowUnsignedFixture: true,
    controllerToken: CONTROLLER_TOKEN,
    fakeProvider: new ScriptedFakeProvider(),
    shutdownDrainMs: 0,
  });
  try {
    await supervisor.start();
    await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "configureFakeProvider",
      params: {
        taskId: "stop-delayed",
        events: [{ type: "succeeded", resultRef: "must-not-return", delayMs: 5_000, usage: { input: 1, output: 1 } }],
      },
    });
    const reservation = await reserve(supervisor, "stop-delayed");
    const issued = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "issueLeaseCapability",
      params: { leaseId: reservation.lease.leaseId, fencingToken: reservation.lease.fencingToken },
    });
    const pending = requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: issued.capability,
      method: "providerAttempt",
      params: { inputDigest: "e".repeat(64) },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAt = Date.now();
    await supervisor.stop();
    assert.ok(Date.now() - startedAt < 1_000, "shutdown must not wait for the five-second fake attempt");
    await assert.rejects(() => pending);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
