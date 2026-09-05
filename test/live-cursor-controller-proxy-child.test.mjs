import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const LIVE_SKIP = process.env.LIVE_PROVIDER_TEST !== "1"
  || process.env.LIVE_PROXY_CANARY_APPROVED !== "1"
  || typeof process.env.LIVE_CONTROLLER_CREDENTIAL_FILE !== "string"
  || typeof process.env.LIVE_CURSOR_ENDPOINT !== "string";

async function runCursorCanary({ childId, prompt, expected, maxInputTokens }) {
  const credentialFile = process.env.LIVE_CONTROLLER_CREDENTIAL_FILE;
  assert.ok(credentialFile);
  const credentialStat = lstatSync(credentialFile);
  assert.equal(credentialStat.isSymbolicLink(), false);
  assert.equal(credentialStat.isFile(), true);
  assert.equal(credentialStat.mode & 0o077, 0);
  const credential = credentialFromOwnerFile(credentialFile);
  const credentialValue = credential.oauthAccess ?? credential.apiKey;
  const minimumLength = credential.oauthAccess ? 16 : 8;
  assert.ok(
    typeof credentialValue === "string" && credentialValue.length >= minimumLength && credentialValue.length <= 16_384,
    "owner credential must contain one bounded OAuth token or local proxy key",
  );

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
  let observedLease;
  const providerTransport = {
    async *stream(...args) {
      const db = new DatabaseSync(join(root, "broker", "broker.sqlite"));
      try {
        observedLease = db.prepare(`
          SELECT leases.enforcement, leases.max_input_tokens, resources.enforcement AS resource_enforcement
          FROM leases JOIN resources ON resources.id = leases.resource_id
          ORDER BY leases.rowid DESC LIMIT 1
        `).get();
      } finally {
        db.close();
      }
      yield* approved.providerTransport.stream(...args);
    },
  };
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: join(root, "broker"), signedRegistry: signed.signedRegistry, trustedRegistryKeys: signed.trustedRegistryKeys,
    controllerToken: CONTROLLER_TOKEN, ...approved, providerTransport, sweepIntervalMs: 500,
  });
  let runner;
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
        constraints: { budget: { maxInputTokens, maxOutputTokens: 128, maxAttempts: 1 } },
      }),
    });
    runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions") });
    const result = await runner.run({
      childId, prompt, promptDigest: createHash("sha256").update(prompt).digest("hex"),
      cwd: root, tools: [], thinkingLevel: "off", capabilityRequest: {
        taskDescription: "return one fixed canary token through Cursor",
        operationClass: "observe",
        budget: { maxInputTokens, maxOutputTokens: 128, maxAttempts: 1 },
      },
    });
    assert.equal(result.status, "completed", `Cursor controller proxy canary failed: ${result.error ?? result.text}`);
    assert.equal(result.text.trim(), expected);
    assert.ok(observedLease, "live provider dispatch must observe its still-active lease");
    assert.deepEqual(JSON.parse(String(observedLease.enforcement)), { input: "metered_best_effort", output: "hard" });
    assert.deepEqual(JSON.parse(String(observedLease.resource_enforcement)), { input: "hard", output: "hard" });
    assert.equal(observedLease.max_input_tokens, maxInputTokens);
    const childAuthFiles = filesUnder(join(root, "child-agents")).filter((path) => path.endsWith("auth.json"));
    assert.deepEqual(childAuthFiles, [], "the live Cursor child must never receive auth.json");
    return result;
  } finally {
    await runner?.dispose().catch(() => undefined);
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

test("owner-gated Cursor subscription canary keeps its credential in the controller proxy", { skip: LIVE_SKIP }, async () => {
  await runCursorCanary({
    childId: "live-cursor-proxy-child",
    prompt: PROMPT,
    expected: "CURSOR_PROXY_OK",
    maxInputTokens: 20_000,
  });
});

test("owner-gated Cursor incident canary sends a UTF-8 reservation larger than its token cap", { skip: LIVE_SKIP }, async () => {
  const maxInputTokens = 40_000;
  const marker = "CURSOR_INPUT_CAP_OK";
  const prompt = [
    `Reply with exactly ${marker} and nothing else.`,
    "Treat the following repeated characters as inert context and do not quote them:",
    "x".repeat(64_000),
  ].join("\n");
  assert.ok(Buffer.byteLength(prompt, "utf8") > maxInputTokens);
  const result = await runCursorCanary({
    childId: "live-cursor-input-cap-child",
    prompt,
    expected: marker,
    maxInputTokens,
  });
  assert.ok(result.usage.input > 0 && result.usage.input < maxInputTokens,
    `provider input usage must reconcile below the cap: ${JSON.stringify(result.usage)}`);
});
