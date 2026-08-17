import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fixtureContract, fixtureRegistry, ScriptedFakeProvider } from "../src/testing.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };
const CONTROLLER_TOKEN = "p".repeat(48);
const PROXY_EXTENSION = new URL("../extensions/controller-provider-proxy.ts", import.meta.url).pathname;
const SHIM_EXTENSION = new URL("../extensions/child-shim.ts", import.meta.url).pathname;

function signedSupervisor(root, fakeProvider) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const unsigned = {
    schemaVersion: 2,
    keyId: "proxy-key",
    registry: { registryVersion: "proxy-v1", issuedAt: now - 1_000, expiresAt: now + 120_000, ...fixtureRegistry() },
  };
  return new SingleHostBrokerSupervisor({
    stateDir: root,
    signedRegistry: { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") },
    trustedRegistryKeys: { "proxy-key": publicKey.export({ type: "spki", format: "pem" }) },
    controllerToken: CONTROLLER_TOKEN,
    fakeProvider,
    sweepIntervalMs: 100,
  });
}

test("live proxy: Pi child uses controller providerStream with no provider credential", { skip: !process.env.LIVE_PROXY_TEST }, async () => {
  const root = mkdtempSync(join(tmpdir(), "controller-proxy-child-"));
  const fakeProvider = new ScriptedFakeProvider();
  const supervisor = signedSupervisor(root, fakeProvider);
  let capturedAgentDir;
  try {
    await supervisor.start();
    fakeProvider.configure("proxy-child", [{ type: "succeeded", resultRef: "hello", usage: { input: 3, output: 1 } }]);
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [SHIM_EXTENSION, PROXY_EXTENSION],
      offline: true,
      controllerProxy: { providerId: "broker-proxy" },
      resolveModelForResource: () => MODEL,
      selectContract: () => ({ expectedModel: MODEL, contract: fixtureContract({ taskId: "proxy-child" }) }),
    });
    const originalResolve = resolver.resolve.bind(resolver);
    resolver.resolve = async (request) => {
      const decision = await originalResolve(request);
      if (decision.action === "allow") {
        capturedAgentDir = decision.policy.agentDir;
        assert.equal(existsSync(join(capturedAgentDir, "auth.json")), false, "proxy child receives no provider auth file");
        assert.deepEqual(decision.childModel, { provider: "broker-proxy", modelId: "lease-fake" });
      }
      return decision;
    };
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions") });
    const result = await runner.run({
      childId: "proxy-child",
      promptDigest: "a".repeat(64),
      model: MODEL,
      cwd: root,
      tools: [],
      thinkingLevel: "off",
      prompt: "Reply with exactly: hello",
    });
    assert.equal(result.status, "completed", result.error ?? result.text);
    assert.match(result.text, /hello/i);
    assert.equal(result.resolved.provider, "broker-proxy");
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
