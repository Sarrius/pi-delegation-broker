import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControllerLiveProviderApproval, ControllerRouteTable, ControllerCredentialStore, createApprovedAnthropicProviderRoute } from "../src/controller-provider-config.mjs";
import { ANTHROPIC_MESSAGES_ADAPTER_ID } from "../src/anthropic-messages-transport.mjs";
import { fixtureRegistry } from "../src/broker.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";
import { buildCurrencyMap } from "../src/provider-probe.mjs";
import { createSelectContract } from "../src/model-selector.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { signedRegistryMessage, verifySignedRegistry } from "../src/signed-registry.mjs";

const CONTROLLER_TOKEN = "c".repeat(48);
const SHIM_PATH = new URL("../extensions/child-shim.ts", import.meta.url).pathname;
const PROXY_PATH = new URL("../extensions/controller-provider-proxy.ts", import.meta.url).pathname;
const ENFORCEMENT_PATH = new URL("../extensions/pi-behavioral-enforcement.ts", import.meta.url).pathname;
const PROMPT = "Reply with exactly LIVE_PROXY_OK and nothing else.";

function registryForCanary() {
  const registry = fixtureRegistry();
  registry.resources = {
    R1: {
      ...registry.resources.R1,
      model: { provider: "anthropic", modelId: "claude-live-canary" },
    },
  };
  return registry;
}

function signedRegistryFor(registry) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const unsigned = {
    schemaVersion: 2,
    keyId: "live-canary-key",
    registry: { registryVersion: "live-canary-v1", issuedAt: now - 1_000, expiresAt: now + 120_000, ...registry },
  };
  const signedRegistry = {
    ...unsigned,
    signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url"),
  };
  const verified = verifySignedRegistry(signedRegistry, { trustedKeys: { "live-canary-key": publicKey.export({ type: "spki", format: "pem" }) } });
  return {
    signedRegistry,
    trustedRegistryKeys: { "live-canary-key": publicKey.export({ type: "spki", format: "pem" }) },
    fingerprint: verified.fingerprint,
  };
}

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("owner-gated live canary keeps provider credentials in the controller proxy", {
  skip: process.env.LIVE_PROVIDER_TEST !== "1"
    || process.env.LIVE_PROXY_CANARY_APPROVED !== "1"
    || typeof process.env.LIVE_CONTROLLER_CREDENTIAL_FILE !== "string",
}, async () => {
  const credentialFile = process.env.LIVE_CONTROLLER_CREDENTIAL_FILE;
  assert.ok(credentialFile, "owner must supply a credential file path");
  const credentialStat = lstatSync(credentialFile);
  assert.equal(credentialStat.isSymbolicLink(), false, "credential file must not be a symlink");
  assert.equal(credentialStat.isFile(), true, "credential file must be a regular file");
  assert.equal(credentialStat.mode & 0o077, 0, "credential file must be owner-only");
  const apiKey = readFileSync(credentialFile, "utf8").trim();
  assert.ok(apiKey.length >= 16, "credential file must contain one bounded key");
  const root = mkdtempSync(join(tmpdir(), "live-controller-proxy-"));
  const registry = registryForCanary();
  const signed = signedRegistryFor(registry);
  const routeTable = new ControllerRouteTable({
    registryFingerprint: signed.fingerprint,
    registryVersion: 1,
    routes: [{
      resourceId: "R1", capacityGroup: "G-shared", profile: "reasoning-high/v1",
      accountAlias: "anthropic-canary", provider: "anthropic", model: "claude-live-canary",
      reasoningEffort: null, apiDialect: "anthropic-messages", endpointId: "anthropic-canary",
      endpoint: process.env.LIVE_ANTHROPIC_ENDPOINT ?? "https://api.anthropic.com/v1/messages",
      adapterId: ANTHROPIC_MESSAGES_ADAPTER_ID, credentialRef: "anthropic-canary-key", cacheRetention: "short",
    }],
  });
  const credentials = new ControllerCredentialStore({ entries: [{ credentialRef: "anthropic-canary-key", apiKey }] });
  const approval = new ControllerLiveProviderApproval({ routeTableFingerprint: routeTable.fingerprint, expiresAt: Date.now() + 120_000, maxRequests: 1 });
  const approved = createApprovedAnthropicProviderRoute({ routeTable, credentialStore: credentials, liveApproval: approval });
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: join(root, "broker"), signedRegistry: signed.signedRegistry, trustedRegistryKeys: signed.trustedRegistryKeys,
    controllerToken: CONTROLLER_TOKEN, ...approved, sweepIntervalMs: 500,
  });
  try {
    await supervisor.start();
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath, controllerToken: supervisor.controllerToken, agentRoot: join(root, "child-agents"),
      extensionPaths: [SHIM_PATH, PROXY_PATH, ENFORCEMENT_PATH],
      launcherAttestationConfig: {
        behavioralExtensionPath: ENFORCEMENT_PATH,
        trustedExtensionDigests: [SHIM_PATH, PROXY_PATH, ENFORCEMENT_PATH]
          .map((path) => createHash("sha256").update(readFileSync(path)).digest("hex")),
      },
      offline: false,
      controllerProxy: { providerId: "broker-proxy" },
      resolveModelForResource: () => ({ provider: "anthropic", modelId: "claude-live-canary" }),
      selectContract: createSelectContract({
        registry, availability: () => supervisor.inventory(),
        currency: () => buildCurrencyMap({ resources: [{ provider: "anthropic", modelId: "claude-live-canary" }] }),
      }),
    });
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions") });
    const result = await runner.run({
      childId: "live-proxy-child", prompt: PROMPT, promptDigest: createHash("sha256").update(PROMPT).digest("hex"),
      cwd: root, tools: [], thinkingLevel: "off", capabilityRequest: {
        taskDescription: "return one fixed canary token",
        operationClass: "observe",
        budget: { maxInputTokens: 20_000, maxOutputTokens: 128, maxAttempts: 1 },
      },
    });
    assert.equal(result.status, "completed", `controller proxy canary failed: ${result.error ?? result.text}`);
    assert.equal(result.text.trim(), "LIVE_PROXY_OK");
    const childAuthFiles = filesUnder(join(root, "child-agents")).filter((path) => path.endsWith("auth.json"));
    assert.deepEqual(childAuthFiles, [], "the live child must never receive auth.json");
    await runner.dispose();
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
