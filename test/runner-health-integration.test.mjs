/**
 * Health reporting across the real controller IPC path.
 *
 * The fake-resolver unit tests prove the runner's decision logic. They cannot prove that the
 * decision survives the resolver → IPC → broker hop, which is where a live run showed exhausted
 * accounts staying selectable. This exercises the real supervisor and a real SQLite broker.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };
const CONTROLLER_TOKEN = "h".repeat(48);

function signedSupervisor(root) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  // R1 and R1_ALIAS deliberately share capacity group G-shared. Without a sibling model the
  // "condemn the resource" and "condemn the account" behaviours are indistinguishable, and a
  // test written against a one-model account would pass even with the scope argument dropped.
  const registry = fixtureRegistry();
  delete registry.resources.R3;
  const unsigned = {
    schemaVersion: 2,
    keyId: "health-key",
    registry: { registryVersion: "health-v1", issuedAt: now - 1_000, expiresAt: now + 120_000, ...registry },
  };
  return new SingleHostBrokerSupervisor({
    stateDir: root,
    signedRegistry: { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") },
    trustedRegistryKeys: { "health-key": publicKey.export({ type: "spki", format: "pem" }) },
    controllerToken: CONTROLLER_TOKEN,
    sweepIntervalMs: 100,
  });
}

test("every throttled account is cooled in real broker state, including the last one tried", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-health-ipc-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    let issued = 0;
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [new URL("../extensions/child-shim.ts", import.meta.url).pathname],
      offline: true,
      resolveModelForResource: () => MODEL,
      selectContract: () => ({ expectedModel: MODEL, contract: fixtureContract({ taskId: `health-${++issued}` }) }),
    });
    // Two distinct accounts, both of which will report a throttle: R1 in G-shared, R2 in
    // G-independent. The second one fails on the final attempt.
    const spawnChild = async () => ({
      resolved: MODEL,
      session: {
        usage: { input: 1, output: 1 },
        latestAssistantMessage: { stopReason: "error", errorMessage: "429 rate limit" },
        async prompt() {}, async dispose() {},
      },
    });
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild, delay: async () => {} });
    const result = await runner.run({
      childId: "health-run", promptDigest: "a".repeat(64), model: MODEL, cwd: root, prompt: "x", maxAttempts: 2,
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.route.map((hop) => hop.outcome), ["rate_limited", "rate_limited"]);

    const cooling = supervisor.inventory().filter((row) => row.breakerState === "cooling_down").map((row) => row.capacityGroup);
    assert.deepEqual([...new Set(cooling)].sort(), ["G-independent", "G-shared"],
      "both accounts must be cooled in durable broker state, not just in the local attempt trail");
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a revoked credential condemns the whole account through the real IPC path", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-auth-ipc-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    let issued = 0;
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [new URL("../extensions/child-shim.ts", import.meta.url).pathname],
      offline: true,
      resolveModelForResource: () => MODEL,
      selectContract: () => ({ expectedModel: MODEL, contract: fixtureContract({ taskId: `auth-${++issued}` }) }),
    });
    const spawnChild = async () => ({
      resolved: MODEL,
      session: {
        usage: { input: 1, output: 1 },
        latestAssistantMessage: { stopReason: "error", errorMessage: "401 unauthorized: invalid api key" },
        async prompt() {}, async dispose() {},
      },
    });
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild, delay: async () => {} });
    await runner.run({ childId: "auth-run", promptDigest: "a".repeat(64), model: MODEL, cwd: root, prompt: "x", maxAttempts: 1 });

    // The scope must survive the resolver -> IPC -> broker hop. Asserting only against the
    // broker object would pass even when the transport silently drops the argument.
    const inventory = supervisor.inventory();
    const leased = inventory.find((row) => row.state === "unknown");
    assert.ok(leased, "the failing resource is condemned");
    const siblings = inventory.filter((row) => row.capacityGroup === leased.capacityGroup);
    assert.ok(siblings.length > 1, "the account under test must own more than one model");
    assert.ok(siblings.every((row) => row.state === "unknown"),
      "every model sharing the revoked credential is condemned, not just the one that reported it");
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful child is durably tracked and finalized through the real controller path", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-track-ipc-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    let issued = 0;
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [new URL("../extensions/child-shim.ts", import.meta.url).pathname],
      offline: true,
      resolveModelForResource: () => MODEL,
      selectContract: () => ({ expectedModel: MODEL, contract: fixtureContract({ taskId: `track-${++issued}` }) }),
    });
    const spawnChild = async () => ({
      resolved: MODEL,
      session: {
        usage: { input: 4, output: 2 },
        latestAssistantMessage: { stopReason: "stop", content: [{ type: "text", text: "four" }] },
        async prompt() {}, async dispose() {},
      },
    });
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild, delay: async () => {} });
    const result = await runner.run({
      childId: "track-run", promptDigest: "a".repeat(64), model: MODEL, cwd: root, prompt: "x",
      maxAttempts: 2, trackForVerification: true,
    });
    assert.equal(result.status, "completed", result.error);
    // Tracked durably, then released for verification: without a configured verifier the task
    // correctly waits for a controller receipt rather than completing itself.
    assert.deepEqual(supervisor.auditSnapshot().pendingTasks.map((task) => task.state), ["awaiting_result"]);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untrackable final result reports why, instead of an opaque failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-track-reason-"));
  const supervisor = signedSupervisor(root);
  try {
    await supervisor.start();
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [new URL("../extensions/child-shim.ts", import.meta.url).pathname],
      offline: true,
      resolveModelForResource: () => MODEL,
      selectContract: () => ({ expectedModel: MODEL, contract: fixtureContract({ taskId: "reason-task" }) }),
    });
    const spawnChild = async () => ({
      resolved: MODEL,
      session: {
        usage: { input: 1, output: 1 },
        latestAssistantMessage: { stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        async prompt() {}, async dispose() {},
      },
    });
    // Simulate the controller losing the admission before the terminal result is tracked.
    const originalResolve = resolver.resolve.bind(resolver);
    resolver.resolve = async (request) => {
      const decision = await originalResolve(request);
      if (decision.action === "allow") decision.policy.trackForVerification = async () => resolver.trackHandedChildForVerification("never-admitted");
      return decision;
    };
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild, delay: async () => {} });
    const result = await runner.run({
      childId: "reason-run", promptDigest: "a".repeat(64), model: MODEL, cwd: root, prompt: "x",
      maxAttempts: 1, trackForVerification: true,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /admission_missing/, "the operator must learn which precondition failed");
    // The lease must still be freed: a bookkeeping failure cannot strand capacity.
    assert.deepEqual(supervisor.auditSnapshot().leases, []);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
