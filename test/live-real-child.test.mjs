import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readProviderRegistry } from "../src/dynamic-provider-watcher.mjs";
import { buildCurrencyMap } from "../src/provider-probe.mjs";
import { createSelectContract, parseResourceModel } from "../src/model-selector.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { writeScopedChildAuth } from "../src/scoped-child-auth.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";

const CONTROLLER_TOKEN = "l".repeat(48);
const SHIM_PATH = new URL("../extensions/child-shim.ts", import.meta.url).pathname;
const ENFORCEMENT_PATH = new URL("../extensions/pi-behavioral-enforcement.ts", import.meta.url).pathname;
const PARENT_AGENT_DIR = join(homedir(), ".pi", "agent");
const PROMPT = "Use the read tool to read observation.txt, then reply with exactly its contents and nothing else";

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function signedSupervisor(root, registry) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const payload = { registryVersion: "live-v1", issuedAt: now - 1_000, expiresAt: now + 120_000, ...registry };
  const unsigned = { schemaVersion: 2, keyId: "live-key", registry: payload };
  return new SingleHostBrokerSupervisor({
    stateDir: root,
    signedRegistry: { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") },
    trustedRegistryKeys: { "live-key": publicKey.export({ type: "spki", format: "pem" }) },
    controllerToken: CONTROLLER_TOKEN,
    sweepIntervalMs: 500,
  });
}

// Legacy direct-child-auth coverage is deliberately never enabled by LIVE_TEST; live validation
// must use test/live-controller-proxy-child.test.mjs and its owner-injected controller route.
test("legacy live: spawn Pi child with scoped auth", { skip: process.env.LIVE_LEGACY_SCOPED_AUTH_TEST !== "1" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "live-"));
  let supervisor;
  try {
    writeFileSync(join(root, "observation.txt"), "automatic-observe-ok\n");
    const registry = readProviderRegistry(PARENT_AGENT_DIR);
    supervisor = signedSupervisor(root, registry);
    await supervisor.start();

    const promptDigest = createHash("sha256").update(PROMPT).digest("hex");
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [SHIM_PATH, ENFORCEMENT_PATH],
      launcherAttestationConfig: {
        behavioralExtensionPath: ENFORCEMENT_PATH,
        trustedExtensionDigests: [SHIM_PATH, ENFORCEMENT_PATH]
          .map((path) => createHash("sha256").update(readFileSync(path)).digest("hex")),
      },
      offline: false,
      selectContract: createSelectContract({
        registry,
        availability: () => supervisor.inventory(),
        currency: buildCurrencyMap({ resources: Object.entries(registry.resources).map(([id, resource]) => resource.model ?? parseResourceModel(id)) }),
        enforceQuality: true,
      }),
      resolveModelForResource: parseResourceModel,
      // Production auth path: the child gets exactly the leased account's credential in its
      // own isolated agent dir — never the parent's full agent directory with every account.
      provisionChildAuth: ({ agentDir, model }) =>
        writeScopedChildAuth({ agentDir, provider: model.provider, parentAgentDir: PARENT_AGENT_DIR }),
    });

    const runner = new BrokeredChildRunner({
      resolver,
      sessionsRoot: join(root, "sessions"),
    });

    const result = await runner.run({
      childId: "live-child-1",
      promptDigest,
      cwd: root,
      thinkingLevel: "off",
      prompt: PROMPT,
      capabilityRequest: {
        taskDescription: "read one exact local file and return its contents",
        operationClass: "observe",
        budget: { maxInputTokens: 20_000, maxOutputTokens: 1_024 },
      },
    });

    assert.equal(result.status, "completed", `child should complete, got: ${result.error ?? result.text}`);
    assert.ok(result.route.length >= 1, "dynamic runner must record its selected/failover route");
    assert.equal(result.text.trim(), "automatic-observe-ok");
    const sessionFiles = filesUnder(join(root, "sessions"))
      .filter((path) => path.endsWith(".jsonl") && statSync(path).isFile());
    assert.ok(sessionFiles.length > 0, "live child must persist a session for protocol inspection");
    const toolNames = sessionFiles.flatMap((sessionFile) =>
      readFileSync(sessionFile, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line))
        .flatMap((entry) => entry.type === "message" && entry.message?.role === "assistant"
          ? entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
          : []));
    assert.ok(toolNames.includes("read"), `child should invoke read directly, got ${toolNames.join(",")}`);
    assert.ok(!toolNames.includes("broker_declare_action"), "observe tools must not spend a model turn on declaration");

    await runner.dispose();
    assert.equal(supervisor.auditSnapshot().leases.length, 0, "no leases leaked");
  } finally {
    await supervisor?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});