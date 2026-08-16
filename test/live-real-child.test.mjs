import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { writeScopedChildAuth } from "../src/scoped-child-auth.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";

const MODEL = { provider: "ollama", modelId: "glm-5.2:cloud" };
const CONTROLLER_TOKEN = "l".repeat(48);
const SHIM_PATH = new URL("../extensions/child-shim.ts", import.meta.url).pathname;
const PARENT_AGENT_DIR = join(homedir(), ".pi", "agent");
const PROMPT = "Reply with exactly one word: hello";

function signedSupervisor(root) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const payload = { registryVersion: "live-v1", issuedAt: now - 1_000, expiresAt: now + 120_000, ...fixtureRegistry() };
  const unsigned = { schemaVersion: 2, keyId: "live-key", registry: payload };
  return new SingleHostBrokerSupervisor({
    stateDir: root,
    signedRegistry: { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") },
    trustedRegistryKeys: { "live-key": publicKey.export({ type: "spki", format: "pem" }) },
    controllerToken: CONTROLLER_TOKEN,
    sweepIntervalMs: 500,
  });
}

test("live: spawn Pi child, send prompt, get real response, verify, close", { skip: !process.env.LIVE_TEST }, async () => {
  const root = mkdtempSync(join(tmpdir(), "live-"));
  let supervisor;
  try {
    supervisor = signedSupervisor(root);
    await supervisor.start();

    const promptDigest = createHash("sha256").update(PROMPT).digest("hex");
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [SHIM_PATH],
      offline: false,
      selectContract: (input) => ({
        expectedModel: MODEL,
        contract: fixtureContract({ taskId: `live-${input.childId}`, promptDigest }),
      }),
      resolveModelForResource: () => MODEL,
      // Production auth path: the child gets exactly the leased account's credential in its
      // own isolated agent dir — never the parent's full agent directory with every account.
      provisionChildAuth: ({ agentDir, model }) =>
        writeScopedChildAuth({ agentDir, provider: model.provider, parentAgentDir: PARENT_AGENT_DIR }),
    });

    const runner = new BrokeredChildRunner({
      resolver,
      sessionsRoot: join(root, "sessions"),
    });

    const handle = await runner.spawn({
      childId: "live-child-1",
      promptDigest,
      model: MODEL,
      cwd: root,
      thinkingLevel: "off",
      prompt: PROMPT,
    });

    const result = await handle.result;
    assert.equal(result.status, "completed", `child should complete, got: ${result.error ?? result.text}`);
    assert.ok(result.text.length > 0, "child must return non-empty text");
    assert.match(result.text.toLowerCase(), /hello/, `response should contain "hello", got: ${result.text}`);

    await runner.dispose();
    assert.equal(supervisor.auditSnapshot().leases.length, 0, "no leases leaked");
  } finally {
    await supervisor?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});