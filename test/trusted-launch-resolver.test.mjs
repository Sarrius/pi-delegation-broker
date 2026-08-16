import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { ControllerEvidenceStore } from "../src/evidence.mjs";
import { ControllerQueuedTaskVerifier, ControllerVerificationAuthority } from "../src/verification-authority.mjs";
import { requestBrokerIpc } from "../src/ipc.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };
const CONTROLLER_TOKEN = "r".repeat(48);
const EXTENSION_PATH = new URL("./isolated-fake-provider.ts", import.meta.url).pathname;
const BEHAVIORAL_EXTENSION_PATH = new URL("../extensions/pi-behavioral-enforcement.ts", import.meta.url).pathname;

function signedSupervisor(root, registry = fixtureRegistry(), verificationReceiptVerifier) {
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
    ...(verificationReceiptVerifier === undefined ? {} : { verificationReceiptVerifier }),
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

function resolverFor(supervisor, root, selectContract, launcherAttestationConfig, extensionPaths = [EXTENSION_PATH], queuedTaskVerifier) {
  return new BrokeredLaunchResolver({
    socketPath: supervisor.socketPath,
    controllerToken: supervisor.controllerToken,
    agentRoot: join(root, "child-agents"),
    extensionPaths,
    offline: true,
    selectContract,
    ...(launcherAttestationConfig === undefined ? {} : { launcherAttestationConfig }),
    ...(queuedTaskVerifier === undefined ? {} : { queuedTaskVerifier }),
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
      return {
        expectedModel: MODEL,
        contract: fixtureContract({ taskId: `task-${input.childId}` }),
        selection: { modelTier: "standard", preferenceSource: "auto", legacyExcluded: true, candidateCount: 2 },
      };
    });
    const decision = await resolver.resolve(request("child_A"));
    assert.equal(decision.action, "allow");
    assert.deepEqual(decision.selection, { modelTier: "standard", preferenceSource: "auto", legacyExcluded: true, candidateCount: 2 });
    assert.equal(decision.policy.environment.PI_BROKER_SOCKET, supervisor.socketPath);
    assert.match(decision.policy.environment.PI_BROKER_CAPABILITY, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(JSON.stringify(decision.policy).includes(CONTROLLER_TOKEN), false);
    assert.equal(resolver.admissions().length, 1);
    assert.equal(supervisor.auditSnapshot().leases.length, 1);
    assert.equal(existsSync(decision.policy.agentDir), true);
    const bound = await requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: decision.policy.environment.PI_BROKER_CAPABILITY,
      method: "getEffectiveChildCapability",
    });
    assert.equal(bound.status, "bound");
    assert.equal(bound.capability.capabilityFingerprint, decision.policy.authorizationPolicy.capabilityFingerprint);

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

test("controller resolver claims an exact ready task, requeues pre-handoff failure, and runs controller verification before completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-q-"));
  const registry = fixtureRegistry();
  delete registry.resources.R2;
  delete registry.resources.R3;
  const evidenceStore = new ControllerEvidenceStore({ root: join(root, "evidence") });
  const authority = new ControllerVerificationAuthority({ evidenceStore });
  let supervisor;
  let routingFinalization;
  const queuedTaskVerifier = new ControllerQueuedTaskVerifier({
    authority,
    createVerifier: async ({ taskId }) => ({
      verify: async () => {
        const evidence = evidenceStore.captureObservation({
          kind: "command", claim: "controller completion check",
          observation: { exitCode: 0, stdout: `verified ${taskId}`, stderr: "" },
        });
        return {
          runId: "resolver-queue-verifier", status: "accepted", validation: { status: "accepted" },
          checks: [{ status: "passed" }], result: { evidence: [evidence] },
        };
      },
    }),
    finalize: ({ taskId, leaseId, fencingToken, verification }) => requestBrokerIpc({
      socketPath: supervisor.socketPath,
      authorization: supervisor.controllerToken,
      method: "finalizeVerifiedTask",
      params: { taskId, leaseId, fencingToken, verification },
    }),
    onFinalized: (input) => {
      routingFinalization = input;
      return { status: "recorded" };
    },
  });
  supervisor = signedSupervisor(root, registry, (receipt, binding) => authority.verify(receipt, binding));
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
    }), undefined, undefined, queuedTaskVerifier);

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
    const completion = await completed.policy.onChildSessionClosed({ status: "completed" });
    assert.deepEqual(completion.verification.outcome, { status: "completed" });
    assert.deepEqual(completion.verification.routing, { status: "recorded" });
    assert.equal(routingFinalization.routingObservation.resourceId, "R1");
    assert.deepEqual(routingFinalization.routingObservation.capabilities, queuedContract.capability.required);
    assert.equal(authority.verify(completion.verification.verification, {
      taskId: queuedContract.taskId,
      leaseId: completed.policy.environment.PI_BROKER_LEASE_ID,
      fencingToken: Number(completed.policy.environment.PI_BROKER_FENCING_TOKEN),
    }), true);
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["completed"]);
    assert.equal(resolver.admissions().length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver tracks only a terminal successful handoff before verifier finalization", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-terminal-track-"));
  const evidenceStore = new ControllerEvidenceStore({ root: join(root, "evidence") });
  const authority = new ControllerVerificationAuthority({ evidenceStore });
  let supervisor;
  let observed;
  const queuedTaskVerifier = new ControllerQueuedTaskVerifier({
    authority,
    createVerifier: async () => ({
      verify: async () => {
        const evidence = evidenceStore.captureObservation({ kind: "command", claim: "terminal check", observation: { exitCode: 0, stdout: "ok", stderr: "" } });
        return { runId: "terminal-track", status: "accepted", validation: { status: "accepted" }, checks: [{ status: "passed" }], result: { evidence: [evidence] } };
      },
    }),
    finalize: ({ taskId, leaseId, fencingToken, verification }) => requestBrokerIpc({
      socketPath: supervisor.socketPath, authorization: supervisor.controllerToken,
      method: "finalizeVerifiedTask", params: { taskId, leaseId, fencingToken, verification },
    }),
    onFinalized: (input) => { observed = input.routingObservation; return { status: "recorded" }; },
  });
  supervisor = signedSupervisor(root, fixtureRegistry(), (receipt, binding) => authority.verify(receipt, binding));
  try {
    await supervisor.start();
    const contract = fixtureContract({ taskId: "terminal-logical-task" });
    const resolver = resolverFor(supervisor, root, () => ({ expectedModel: MODEL, contract }), undefined, undefined, queuedTaskVerifier);
    const decision = await resolver.resolve(request("terminal-child"));
    assert.equal(decision.action, "allow");
    await decision.policy.onChildSessionOpened();
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks, [], "failed/unfinished attempts never pre-track themselves");
    assert.deepEqual(await decision.policy.trackForVerification(), { status: "tracked" });
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["claimed"]);
    const closed = await decision.policy.onChildSessionClosed({ status: "completed", usage: { input: 8, output: 5 }, attempts: 2 });
    assert.deepEqual(closed.verification.outcome, { status: "completed" });
    assert.equal(observed.tokens, 13);
    assert.equal(observed.attempts, 2);
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["completed"]);
  } finally {
    await supervisor?.stop().catch(() => undefined);
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

test("resolver adds a pinned final-extension attestation when controller configuration supplies every reviewed digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-attest-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const digest = createHash("sha256").update(readFileSync(BEHAVIORAL_EXTENSION_PATH)).digest("hex");
    const resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: "task-attested" }),
    }), {
      behavioralExtensionPath: BEHAVIORAL_EXTENSION_PATH,
      trustedExtensionDigests: [digest],
    }, [BEHAVIORAL_EXTENSION_PATH]);
    const decision = await resolver.resolve(request("child_attested"));
    assert.equal(decision.action, "allow");
    assert.equal(decision.policy.launcherAttestation.capabilityFingerprint, decision.policy.authorizationPolicy.capabilityFingerprint);
    assert.deepEqual(decision.policy.requiredActiveTools, ["broker_declare_action"]);
    assert.equal(decision.policy.launcherAttestation.extensions.at(-1).path, decision.policy.launcherAttestation.behavioralExtension.path);
    await decision.policy.onBeforeChildAbandoned("test_cleanup");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver refuses effect-capable launch before reservation when its extension bytes are not pinned", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-attest-required-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, () => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: "task-effect-without-attestation", operationClass: "apply" }),
    }));
    assert.deepEqual(await resolver.resolve(request("child_effect_without_attestation")), {
      action: "deny", reason: "effect capable brokered launch requires pinned extension attestation",
    });
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop();
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

test("resolver admits a launch with no explicit model — the controller selector decides", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-auto-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    }));
    const { model: _omit, ...withoutModel } = request("child_auto");
    const decision = await resolver.resolve(withoutModel);
    assert.equal(decision.action, "allow", `auto-selected launch must be admitted, got: ${decision.reason}`);
    assert.equal(supervisor.auditSnapshot().leases.length, 1);
    await resolver.releaseUnhanded("child_auto");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver still denies an explicit model that does not match the selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-mismatch-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = resolverFor(supervisor, root, (input) => ({
      expectedModel: MODEL,
      contract: fixtureContract({ taskId: `task-${input.childId}` }),
    }));
    const mismatched = { ...request("child_mm"), model: { provider: "smuggled", modelId: "unapproved", thinkingLevel: "off" } };
    const decision = await resolver.resolve(mismatched);
    assert.equal(decision.action, "deny");
    assert.match(decision.reason, /not approved/);
    assert.equal(supervisor.auditSnapshot().leases.length, 0, "a denied mismatch reserves nothing");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provisionChildAuth runs with the leased resource's model before handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-auth-"));
  const supervisor = signedSupervisor(root);
  const calls = [];
  try {
    await supervisor.start();
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [EXTENSION_PATH],
      offline: true,
      selectContract: (input) => ({
        expectedModel: MODEL,
        contract: fixtureContract({ taskId: `task-${input.childId}` }),
      }),
      resolveModelForResource: (resourceId) => ({ provider: "broker-fake", modelId: `resolved-${resourceId}` }),
      provisionChildAuth: (input) => { calls.push({ ...input }); },
    });
    const decision = await resolver.resolve(request("child_hook"));
    assert.equal(decision.action, "allow");
    assert.equal(calls.length, 1, "auth provisioning ran exactly once");
    assert.equal(calls[0].childId, "child_hook");
    assert.equal(calls[0].model.provider, "broker-fake");
    assert.match(calls[0].model.modelId, /^resolved-/, "the hook sees the leased resource's model, not the prediction");
    assert.equal(calls[0].agentDir, decision.policy.agentDir);
    assert.equal(existsSync(calls[0].agentDir), true);
    await resolver.releaseUnhanded("child_hook");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing provisionChildAuth denies the launch, frees the lease, and removes the agent dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-authfail-"));
  const supervisor = signedSupervisor(root);
  let capturedDir;
  try {
    await supervisor.start();
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [EXTENSION_PATH],
      offline: true,
      selectContract: (input) => ({
        expectedModel: MODEL,
        contract: fixtureContract({ taskId: `task-${input.childId}` }),
      }),
      provisionChildAuth: ({ agentDir }) => {
        capturedDir = agentDir;
        throw new Error("no credential for leased provider: broker-fake");
      },
    });
    await assert.rejects(() => resolver.resolve(request("child_fail")), /no credential for leased provider/);
    assert.equal(supervisor.auditSnapshot().leases.length, 0, "lease released after provisioning failure");
    assert.equal(existsSync(capturedDir), false, "agent dir removed after provisioning failure");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
