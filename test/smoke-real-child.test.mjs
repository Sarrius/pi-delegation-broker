import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { requestBrokerIpc } from "../src/ipc.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";

const MODEL = { provider: "openai-codex", modelId: "gpt-5.6-terra" };
const CONTROLLER_TOKEN = "s".repeat(48);
const SHIM_PATH = new URL("../extensions/child-shim.ts", import.meta.url).pathname;
const PARENT_AGENT_DIR = join(homedir(), ".pi", "agent");

function signedSupervisor(root, registry = fixtureRegistry()) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const payload = { registryVersion: "smoke-v1", issuedAt: now - 1_000, expiresAt: now + 60_000, ...registry };
  const unsigned = { schemaVersion: 2, keyId: "smoke-key", registry: payload };
  return new SingleHostBrokerSupervisor({
    stateDir: root,
    signedRegistry: { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") },
    trustedRegistryKeys: { "smoke-key": publicKey.export({ type: "spki", format: "pem" }) },
    controllerToken: CONTROLLER_TOKEN,
    sweepIntervalMs: 100,
  });
}

test("smoke: spawn a real Pi child through the broker and close it cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "smoke-"));
  let supervisor;
  try {
    supervisor = signedSupervisor(root);
    await supervisor.start();

    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [SHIM_PATH],
      offline: true,
      selectContract: (input) => ({
        expectedModel: MODEL,
        contract: fixtureContract({ taskId: `smoke-${input.childId}` }),
      }),
    });

    const runner = new BrokeredChildRunner({
      resolver,
      sessionsRoot: join(root, "sessions"),
    });

    // Override the policy's agentDir to point to the parent's real agent dir
    // so the child can access auth.json. In production the controller would
    // provision a scoped agent dir with its own credentials.
    const originalResolve = resolver.resolve.bind(resolver);
    resolver.resolve = async (request) => {
      const decision = await originalResolve(request);
      if (decision.action === "allow") decision.policy.agentDir = PARENT_AGENT_DIR;
      return decision;
    };

    const handle = await runner.spawn({
      childId: "smoke-child-1",
      promptDigest: "a".repeat(64),
      model: MODEL,
      cwd: root,
      thinkingLevel: "off",
    });

    assert.ok(handle.session, "child session must exist");
    assert.ok(handle.resolved, "child resolved spec must exist");
    assert.equal(existsSync(handle.resolved.cwd), true);
    assert.ok(handle.resolved.tools.length > 0, "child must report at least one tool");

    await runner.abort("smoke-child-1").catch(() => undefined);
    await runner.dispose();

    assert.equal(supervisor.auditSnapshot().leases.length, 0, "no leases leaked");
  } finally {
    await supervisor?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});