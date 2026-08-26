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
const PROMPT = "Reply with exactly LIVE_PROXY_OK and nothing else.";
const CANARY_MODEL = process.env.LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5";

function registryForCanary() {
  const registry = fixtureRegistry();
  registry.profiles["canary-text/v1"] = { status: "approved", supports: ["text_generation"] };
  registry.resources = {
    R1: {
      ...registry.resources.R1,
      capacityGroup: "G-cheap",
      profile: "canary-text/v1",
      model: { provider: "anthropic", modelId: CANARY_MODEL },
    },
  };
  return registry;
}

function credentialFromOwnerFile(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw new Error("owner credential file is empty");
  try {
    const parsed = JSON.parse(raw);
    const provider = process.env.LIVE_CONTROLLER_CREDENTIAL_PROVIDER ?? "anthropic";
    const candidate = parsed?.type ? parsed : parsed?.[provider];
    if (candidate?.type === "oauth" && typeof candidate.access === "string") {
      return { oauthAccess: candidate.access };
    }
    if (candidate?.type === "api_key" && typeof candidate.key === "string") {
      return { apiKey: candidate.key };
    }
    throw new Error("owner credential JSON must contain an api_key key or oauth access token");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { apiKey: raw };
  }
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
  const credential = credentialFromOwnerFile(credentialFile);
  const credentialValue = credential.oauthAccess ?? credential.apiKey;
  assert.ok(typeof credentialValue === "string" && credentialValue.length >= 16, "owner credential must contain one bounded token");
  // Keep the owner-only socket path below macOS's 104-byte Unix-domain limit even when tmpdir is deeply nested.
  const root = mkdtempSync(join(tmpdir(), "lcp-"));
  const registry = registryForCanary();
  const signed = signedRegistryFor(registry);
  const routeTable = new ControllerRouteTable({
    registryFingerprint: signed.fingerprint,
    registryVersion: 1,
    routes: [{
      resourceId: "R1", capacityGroup: "G-cheap", profile: "canary-text/v1",
      accountAlias: "anthropic-canary", provider: "anthropic", model: CANARY_MODEL,
      reasoningEffort: null, apiDialect: "anthropic-messages", endpointId: "anthropic-canary",
      endpoint: process.env.LIVE_ANTHROPIC_ENDPOINT ?? "https://api.anthropic.com/v1/messages",
      adapterId: ANTHROPIC_MESSAGES_ADAPTER_ID, credentialRef: "anthropic-canary-key", cacheRetention: "none",
    }],
  });
  const credentials = new ControllerCredentialStore({ entries: [{ credentialRef: "anthropic-canary-key", ...credential }] });
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
      // This is a strictly tool-free observe canary. Effect-capable launches
      // still require the separately attested behavioral extension path.
      extensionPaths: [SHIM_PATH, PROXY_PATH],
      offline: false,
      controllerProxy: { providerId: "broker-proxy" },
      resolveModelForResource: () => ({ provider: "anthropic", modelId: CANARY_MODEL }),
      selectContract: createSelectContract({
        registry, availability: () => supervisor.inventory(),
        currency: () => buildCurrencyMap({ resources: [{ provider: "anthropic", modelId: CANARY_MODEL }] }),
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
