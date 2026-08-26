import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { verifyProposedPatch } from "../src/effect-verification.mjs";

const CONTROLLER_TOKEN = "l".repeat(48);
const SHIM_PATH = new URL("../extensions/child-shim.ts", import.meta.url).pathname;
const ENFORCEMENT_PATH = new URL("../extensions/pi-behavioral-enforcement.ts", import.meta.url).pathname;
const PARENT_AGENT_DIR = join(homedir(), ".pi", "agent");
const PROMPT = "Edit the file value.txt in your working directory so that its entire contents are the single word: two"
  + "\nUse your write or edit tool. Do not create any other file. When the file is saved, reply with the single word: done";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

test("live: a child proposes a change and only a controller-verified patch comes back", { skip: !process.env.LIVE_TEST }, async () => {
  const root = mkdtempSync(join(tmpdir(), "live-effect-"));
  const repo = join(root, "repo");
  let supervisor;
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
    git(repo, "config", "user.email", "controller@example.invalid");
    git(repo, "config", "user.name", "controller");
    writeFileSync(join(repo, "value.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "base");

    const registry = readProviderRegistry(PARENT_AGENT_DIR);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const now = Date.now();
    const unsigned = {
      schemaVersion: 2,
      keyId: "live-key",
      registry: { registryVersion: "live-effect-v1", issuedAt: now - 1_000, expiresAt: now + 300_000, ...registry },
    };
    supervisor = new SingleHostBrokerSupervisor({
      stateDir: root,
      signedRegistry: { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") },
      trustedRegistryKeys: { "live-key": publicKey.export({ type: "spki", format: "pem" }) },
      controllerToken: CONTROLLER_TOKEN,
      // Effect-capable contracts are inadmissible without this, and the child below is launched
      // with the enforcement extension that backs the claim.
      behavioralEnforcement: "blocking_monitor",
      sweepIntervalMs: 500,
    });
    await supervisor.start();

    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths: [SHIM_PATH, ENFORCEMENT_PATH],
      // An effect-capable launch is only admissible against pinned extension digests, so the
      // monitor a child runs is the exact file the controller attested to.
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
      provisionChildAuth: ({ agentDir, model }) =>
        writeScopedChildAuth({ agentDir, provider: model.provider, parentAgentDir: PARENT_AGENT_DIR }),
    });
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions") });

    const result = await runner.run({
      childId: "live-effect-child",
      promptDigest: createHash("sha256").update(PROMPT).digest("hex"),
      cwd: repo,
      isolation: "worktree",
      thinkingLevel: "off",
      prompt: PROMPT,
      // This test changes one line. Its controller-owned hard cap proves the shim enforces the
      // leased budget and keeps the live test within the fleet's remaining credit, rather than
      // asking every provider for its 16k default maximum.
      capabilityRequest: {
        taskDescription: "edit a file in the repository",
        operationClass: "propose_patch",
        budget: { maxInputTokens: 20_000, maxOutputTokens: 2_048 },
      },
    });

    assert.equal(result.status, "completed", `child should complete, got: ${result.error ?? result.text}`);
    assert.ok(result.patch, "an effect-class child must return a patch");
    assert.match(result.baseCommit ?? "", /^[0-9a-f]{40}$/, "the patch must carry the base commit it was produced against");

    const receipt = await verifyProposedPatch({
      repoCwd: repo,
      baseCommit: result.baseCommit,
      patch: result.patch,
      changed: result.changed,
      checks: [{ id: "file-equals", path: "value.txt", content: "two\n" }],
    });

    assert.equal(receipt.verified, true, `controller must verify the patch, got: ${receipt.reason} ${JSON.stringify(receipt.checks)}`);
    assert.deepEqual([...receipt.changed], ["value.txt"]);

    // The whole point: a verified effect that was never performed on the caller's repository.
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(git(repo, "show", "HEAD:value.txt"), "one\n");

    await runner.dispose();
    assert.equal(supervisor.auditSnapshot().leases.length, 0, "no leases leaked");
  } finally {
    await supervisor?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
