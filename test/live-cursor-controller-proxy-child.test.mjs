import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControllerCredentialStore, ControllerLiveProviderApproval, ControllerRouteTable, createApprovedOpenAIProviderRoute } from "../src/controller-provider-config.mjs";
import { OPENAI_CHAT_COMPLETIONS_ADAPTER_ID } from "../src/openai-chat-completions-transport.mjs";
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
const CANARY_MODEL = process.env.LIVE_CURSOR_MODEL ?? "cursor-grok-4.6";
const PROMPT = "Reply with exactly CURSOR_PROXY_OK and nothing else.";

function registryForCanary() {
  const registry = fixtureRegistry();
  registry.profiles["cursor-canary-text/v1"] = { status: "approved", supports: ["text_generation"] };
  registry.resources = {
    R1: {
      ...registry.resources.R1,
      capacityGroup: "G-cheap",
      profile: "cursor-canary-text/v1",
      model: { provider: "cursor", modelId: CANARY_MODEL },
    },
  };
  return registry;
}

function credentialFromOwnerFile(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw new Error("owner credential file is empty");
  try {
    const parsed = JSON.parse(raw);
    const provider = process.env.LIVE_CONTROLLER_CREDENTIAL_PROVIDER ?? "cursor";
    const candidate = parsed?.type ? parsed : parsed?.[provider];
    if (candidate?.type === "oauth" && typeof candidate.access === "string") return { oauthAccess: candidate.access };
    if (candidate?.type === "api_key" && typeof candidate.key === "string") return { apiKey: candidate.key };
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
    keyId: "live-cursor-canary-key",
    registry: { registryVersion: "live-cursor-canary-v1", issuedAt: now - 1_000, expiresAt: now + 120_000, ...registry },
  };
  const signedRegistry = { ...unsigned, signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url") };
  const trustedRegistryKeys = { "live-cursor-canary-key": publicKey.export({ type: "spki", format: "pem" }) };
  const verified = verifySignedRegistry(signedRegistry, { trustedKeys: trustedRegistryKeys });
  return { signedRegistry, trustedRegistryKeys, fingerprint: verified.fingerprint };
}

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function cursorCompletionEndpoint(value) {
  const endpoint = new URL(value);
  if (!endpoint.pathname.endsWith("/chat/completions")) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
  }
  return endpoint.toString();
}

test("owner-gated Cursor subscription canary keeps OAuth in the controller proxy", {
  skip: process.env.LIVE_PROVIDER_TEST !== "1"
    || process.env.LIVE_PROXY_CANARY_APPROVED !== "1"
    || typeof process.env.LIVE_CONTROLLER_CREDENTIAL_FILE !== "string"
    || typeof process.env.LIVE_CURSOR_ENDPOINT !== "string",
}, async () => {
  const credentialFile = process.env.LIVE_CONTROLLER_CREDENTIAL_FILE;
  assert.ok(credentialFile);
  const credentialStat = lstatSync(credentialFile);
  assert.equal(credentialStat.isSymbolicLink(), false);
  assert.equal(credentialStat.isFile(), true);
  assert.equal(credentialStat.mode & 0o077, 0);
  const credential = credentialFromOwnerFile(credentialFile);
  const credentialValue = credential.oauthAccess ?? credential.apiKey;
  assert.ok(typeof credentialValue === "string" && credentialValue.length >= 16);

  // Keep owner-only broker/socket paths short enough for macOS Unix-domain sockets.
  const root = mkdtempSync(join(tmpdir(), "lcc-"));
  const registry = registryForCanary();
  const signed = signedRegistryFor(registry);
  const routeTable = new ControllerRouteTable({
    registryFingerprint: signed.fingerprint,
    registryVersion: 1,
    routes: [{
      resourceId: "R1", capacityGroup: "G-cheap", profile: "cursor-canary-text/v1",
      accountAlias: "cursor-canary", provider: "cursor", model: CANARY_MODEL,
      reasoningEffort: null, apiDialect: "openai-completions", endpointId: "cursor-canary",
      endpoint: cursorCompletionEndpoint(process.env.LIVE_CURSOR_ENDPOINT),
      adapterId: OPENAI_CHAT_COMPLETIONS_ADAPTER_ID, credentialRef: "cursor-canary-key", cacheRetention: "none",
    }],
  });
  const credentials = new ControllerCredentialStore({ entries: [{ credentialRef: "cursor-canary-key", ...credential }] });
  const approval = new ControllerLiveProviderApproval({ routeTableFingerprint: routeTable.fingerprint, expiresAt: Date.now() + 120_000, maxRequests: 1 });
  const approved = createApprovedOpenAIProviderRoute({ routeTable, credentialStore: credentials, liveApproval: approval });
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: join(root, "broker"), signedRegistry: signed.signedRegistry, trustedRegistryKeys: signed.trustedRegistryKeys,
    controllerToken: CONTROLLER_TOKEN, ...approved, sweepIntervalMs: 500,
  });
  try {
    await supervisor.start();
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath, controllerToken: supervisor.controllerToken, agentRoot: join(root, "child-agents"),
      extensionPaths: [SHIM_PATH, PROXY_PATH],
      offline: false,
      controllerProxy: { providerId: "broker-proxy" },
      resolveModelForResource: () => ({ provider: "cursor", modelId: CANARY_MODEL }),
      selectContract: createSelectContract({
        registry, availability: () => supervisor.inventory(),
        currency: () => buildCurrencyMap({ resources: [{ provider: "cursor", modelId: CANARY_MODEL }] }),
        constraints: { budget: { maxInputTokens: 32_000, maxOutputTokens: 1_024 } },
      }),
    });
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions") });
    const result = await runner.run({
      childId: "live-cursor-proxy-child", prompt: PROMPT, promptDigest: createHash("sha256").update(PROMPT).digest("hex"),
      cwd: root, tools: [], thinkingLevel: "off", capabilityRequest: {
        taskDescription: "return one fixed canary token through Cursor",
        operationClass: "observe",
        budget: { maxInputTokens: 20_000, maxOutputTokens: 128, maxAttempts: 1 },
      },
    });
    assert.equal(result.status, "completed", `Cursor controller proxy canary failed: ${result.error ?? result.text}`);
    assert.equal(result.text.trim(), "CURSOR_PROXY_OK");
    const childAuthFiles = filesUnder(join(root, "child-agents")).filter((path) => path.endsWith("auth.json"));
    assert.deepEqual(childAuthFiles, [], "the live Cursor child must never receive auth.json");
    await runner.dispose();
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
