import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { requestBrokerIpc } from "../src/ipc.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };
const CONTROLLER_TOKEN = "r".repeat(48);
const EXTENSION_PATH = new URL("./isolated-fake-provider.ts", import.meta.url).pathname;

function signedSupervisor(root, registry = fixtureRegistry()) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const payload = { registryVersion: "resolver-v1", issuedAt: now - 1_000, expiresAt: now + 60_000, ...registry };
  const unsigned = { schemaVersion: 2, keyId: "resolver-key", registry: payload };
  return new SingleHostBrokerSupervisor({
    stateDir: root,
    signedRegistry: { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") },
    trustedRegistryKeys: { "resolver-key": publicKey.export({ type: "spki", format: "pem" }) },
    controllerToken: CONTROLLER_TOKEN,
    sweepIntervalMs: 100,
  });
}

function request(childId) {
  return {
    childId,
    promptDigest: "a".repeat(64),
    requestedCwd: tmpdir(),
    isolation: "none",
    schemaRequested: false,
    model: { ...MODEL, thinkingLevel: "off" },
  };
}

function resolverFor(supervisor, root, selectContract) {
  return new BrokeredLaunchResolver({
    socketPath: supervisor.socketPath,
    controllerToken: supervisor.controllerToken,
    agentRoot: join(root, "child-agents"),
    extensionPaths: [EXTENSION_PATH],
    offline: true,
    selectContract,
  });
}

test("controller resolver admits a matching child with only scoped policy data and releases pre-handoff failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-"));
  const supervisor = signedSupervisor(root);
  let resolver;
  try {
    await supervisor.start();
    resolver = resolverFor(supervisor, root, (input) => {
      assert.equal(Object.hasOwn(input, "prompt"), false);
      assert.equal(input.promptDigest, "a".repeat(64));
      return { expectedModel: MODEL, contract: fixtureContract({ taskId: `task-${input.childId}` }) };
    });
    const decision = await resolver.resolve(request("child_A"));
    assert.equal(decision.action, "allow");
    assert.equal(decision.policy.environment.PI_BROKER_SOCKET, supervisor.socketPath);
    assert.match(decision.policy.environment.PI_BROKER_CAPABILITY, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(JSON.stringify(decision.policy).includes(CONTROLLER_TOKEN), false);
    assert.equal(resolver.admissions().length, 1);
    assert.equal(supervisor.auditSnapshot().leases.length, 1);
    assert.equal(existsSync(decision.policy.agentDir), true);

    await decision.policy.onBeforeChildAbandoned("child_construction_failed");
    await decision.policy.onBeforeChildAbandoned("child_construction_failed");
    assert.equal(resolver.admissions().length, 0);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.equal(existsSync(decision.policy.agentDir), false);
    const ledger = JSON.stringify(supervisor.auditSnapshot().events);
    assert.equal(ledger.includes(CONTROLLER_TOKEN), false);
    assert.equal(ledger.includes(decision.policy.environment.PI_BROKER_CAPABILITY), false);

    const handed = await resolver.resolve(request("child_B"));
    assert.equal(handed.action, "allow");
    await handed.policy.onChildSessionClosed();
    await handed.policy.onChildSessionClosed();
    assert.equal(resolver.admissions().length, 0);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.equal(existsSync(handed.policy.agentDir), false);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resolver preserves and safely reconciles a release after controller IPC failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-rf-"));
  const supervisor = signedSupervisor(root);
  let restarted;
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    }));
    const decision = await resolver.resolve(request("child_release_failure"));
    assert.equal(decision.action, "allow");
    await decision.policy.onChildSessionOpened();
    assert.deepEqual(await resolver.reconcilePendingReleases(), [], "active handed child must never be reconciled");
    assert.equal(supervisor.auditSnapshot().leases.length, 1);

    await supervisor.stop();
    await assert.rejects(() => decision.policy.onChildSessionClosed());
    assert.deepEqual(resolver.admissions().map((admission) => admission.phase), ["closed_release_pending"]);
    assert.equal(existsSync(decision.policy.agentDir), true);

    restarted = signedSupervisor(root);
    await restarted.start();
    assert.deepEqual(await resolver.reconcilePendingReleases(), [{ childId: "child_release_failure", status: "released" }]);
    assert.equal(resolver.admissions().length, 0);
    assert.equal(restarted.auditSnapshot().leases.length, 0);
    assert.equal(existsSync(decision.policy.agentDir), false);
  } finally {
    await restarted?.stop().catch(() => undefined);
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resolver claims an exact ready task, requeues pre-handoff failure, and records terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-q-"));
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const supervisor = signedSupervisor(root, registry);
  try {
    await supervisor.start();
    const occupantContract = fixtureContract({ taskId: "resolver-queue-occupant" });
    const occupant = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "reserve",
      params: { contract: occupantContract },
    });
    const queuedContract = fixtureContract({ taskId: "resolver-queued", recovery: { owner: "resolver-controller", deadlineAt: Date.now() + 60_000 } });
    assert.equal((await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "submit",
      params: { contract: queuedContract },
    })).status, "queued");
    await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "release",
      params: { leaseId: occupant.lease.leaseId, fencingToken: occupant.lease.fencingToken },
    });
    let [ready] = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "dispatchPending",
    });
    const resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: queuedContract,
      readyTask: { taskId: queuedContract.taskId, leaseId: ready.lease.leaseId },
    }));

    const abandoned = await resolver.resolve(request("queued_abandoned"));
    assert.equal(abandoned.action, "allow");
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["claimed"]);
    await abandoned.policy.onBeforeChildAbandoned("child_construction_failed");
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["waiting"]);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);

    [ready] = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "dispatchPending",
    });
    const completed = await resolver.resolve(request("queued_completed"));
    assert.equal(completed.action, "allow");
    await completed.policy.onChildSessionOpened();
    await completed.policy.onChildSessionClosed({ status: "completed" });
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["completed"]);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.equal(resolver.admissions().length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resolver denies a child prompt not bound to the selected contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-prompt-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: "wrong-frame", promptDigest: "b".repeat(64) }),
    }));
    const decision = await resolver.resolve(request("wrong_frame"));
    assert.deepEqual(decision, { action: "deny", reason: "child prompt is not bound to the selected broker contract" });
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resolver denies a model mismatch before reservation and capacity exhaustion without a fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-c-"));
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const supervisor = signedSupervisor(root, registry);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    }));
    const mismatch = await resolver.resolve({ ...request("child_mismatch"), model: { provider: "other", modelId: "wrong", thinkingLevel: "off" } });
    assert.deepEqual(mismatch, { action: "deny", reason: "resolved model is not approved for this broker contract" });
    assert.equal(supervisor.auditSnapshot().leases.length, 0);

    const first = await resolver.resolve(request("child_first"));
    assert.equal(first.action, "allow");
    const second = await resolver.resolve(request("child_second"));
    assert.deepEqual(second, { action: "deny", reason: "no compatible broker capacity" });
    assert.equal(supervisor.auditSnapshot().leases.length, 1);
    await first.policy.onBeforeChildAbandoned("cancelled_before_child");
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver policy includes compiled capability prompt rules and authorization policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-cap-"));
  const supervisor = signedSupervisor(root);
  let resolver;
  try {
    await supervisor.start();
    resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: "task-capability" }),
    }));
    const decision = await resolver.resolve(request("child_cap"));
    assert.equal(decision.action, "allow");
    assert.equal(typeof decision.policy.promptRules, "string");
    assert.ok(decision.policy.promptRules.includes("operation_class: observe"));
    assert.ok(decision.policy.promptRules.includes("allowed_tools:"));
    assert.ok(decision.policy.authorizationPolicy);
    assert.ok(decision.policy.authorizationPolicy.allowedTools instanceof Set);
    assert.ok(decision.policy.authorizationPolicy.allowedTools.has("read"));
    assert.equal(decision.policy.authorizationPolicy.effectCapable, false);
    assert.equal(decision.policy.authorizationPolicy.operationClass, "observe");
    await decision.policy.onBeforeChildAbandoned("test_cleanup");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
