import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRegistry } from "../src/broker.mjs";
import { signedRegistryMessage, verifySignedRegistry } from "../src/signed-registry.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";

const NOW = 1_700_000_000_000;

function registryPayload(overrides = {}) {
  return {
    registryVersion: "delegation-v1",
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...fixtureRegistry(),
    ...overrides,
  };
}

function signedEnvelope(registry = registryPayload(), keyId = "release-2026", privateKey) {
  const { privateKey: generated } = generateKeyPairSync("ed25519");
  const signingKey = privateKey ?? generated;
  const unsigned = { schemaVersion: 2, keyId, registry };
  return {
    ...unsigned,
    signature: sign(null, signedRegistryMessage(unsigned), signingKey).toString("base64url"),
    signingKey,
  };
}

function signedEnvelopeWithKey(registry = registryPayload(), keyId = "release-2026") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const unsigned = { schemaVersion: 2, keyId, registry };
  return {
    envelope: {
      ...unsigned,
      signature: sign(null, signedRegistryMessage(unsigned), privateKey).toString("base64url"),
    },
    trustedKeys: { [keyId]: publicKey.export({ type: "spki", format: "pem" }) },
  };
}

test("valid Ed25519 registry has a deterministic fingerprint and frozen broker projection", () => {
  const { envelope, trustedKeys } = signedEnvelopeWithKey();
  const verified = verifySignedRegistry(envelope, { trustedKeys, now: NOW });
  assert.equal(verified.keyId, "release-2026");
  assert.match(verified.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(verified.brokerRegistry.resources.R1.profile, "reasoning-high/v1");
  assert.throws(() => { verified.brokerRegistry.resources.R1.profile = "audit-low/v1"; }, TypeError);
  assert.equal(verified.brokerRegistry.resources.R1.profile, "reasoning-high/v1");
});

test("an empty signed registry is a valid no-provider runtime state", async () => {
  const currentNow = Date.now();
  const { envelope, trustedKeys } = signedEnvelopeWithKey({
    registryVersion: "empty-fleet-v1",
    issuedAt: currentNow - 1_000,
    expiresAt: currentNow + 60_000,
    profiles: {}, capacityGroups: {}, resources: {},
  });
  const verified = verifySignedRegistry(envelope, { trustedKeys, now: currentNow });
  assert.deepEqual(verified.brokerRegistry, { profiles: {}, capacityGroups: {}, resources: {} });
  const stateDir = mkdtempSync(join(tmpdir(), "broker-empty-registry-"));
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir, signedRegistry: envelope, trustedRegistryKeys: trustedKeys, controllerToken: "e".repeat(48), sweepIntervalMs: 100,
  });
  try {
    await supervisor.start();
    assert.deepEqual(supervisor.inventory(), []);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("closed controller provenance metadata can be signed but is stripped from broker authority", () => {
  const registry = registryPayload();
  registry.resources.R1.provenance = {
    providerClass: "first_party_subscription",
    modelDeveloper: "openai",
    routeProvider: "openai-codex",
    baseProvider: "openai-codex",
    billingPool: "native_subscription",
    nativeToRoute: true,
    source: "subscription-native-current-only/v1",
  };
  const { envelope, trustedKeys } = signedEnvelopeWithKey(registry);
  const verified = verifySignedRegistry(envelope, { trustedKeys, now: NOW });
  assert.equal(verified.brokerRegistry.resources.R1.provenance, undefined);
  const malformed = registryPayload();
  malformed.resources.R1.provenance = { unexpected: true };
  assert.throws(() => signedRegistryMessage({ schemaVersion: 2, keyId: "release-2026", registry: malformed }), /provenance.*unsupported/);
});

test("signature, trust key and validity interval are fail-closed", () => {
  const { envelope, trustedKeys } = signedEnvelopeWithKey();
  const altered = structuredClone(envelope);
  altered.registry.resources.R1.enforcement.output = "unavailable";
  assert.throws(() => verifySignedRegistry(altered, { trustedKeys, now: NOW }), /signature verification failed/);
  assert.throws(() => verifySignedRegistry(envelope, { trustedKeys: {}, now: NOW }), /keyId is not trusted/);
  assert.throws(() => verifySignedRegistry(envelope, { trustedKeys, now: NOW + 60_000 }), /not currently valid/);
});

test("invalid registry semantics cannot be signed into an accepted envelope", () => {
  assert.throws(
    () => signedRegistryMessage({ schemaVersion: 1, keyId: "legacy", registry: registryPayload() }),
    /schemaVersion must equal 2/,
  );
  const bad = registryPayload();
  bad.resources.R1.capacityGroup = "missing-group";
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () => signedEnvelope(bad, "release-2026", privateKey),
    /references unknown capacity group/,
  );
  const noControlReserve = registryPayload();
  noControlReserve.capacityGroups["G-shared"].admission.controlReserve = 0;
  assert.throws(
    () => signedEnvelope(noControlReserve, "release-2026", privateKey),
    /invalid admission reserves/,
  );
});

test("supervisor requires a signed registry by default and reports only safe registry metadata", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "broker-signed-registry-"));
  const currentNow = Date.now();
  const { envelope, trustedKeys } = signedEnvelopeWithKey(registryPayload({
    issuedAt: currentNow - 1_000,
    expiresAt: currentNow + 60_000,
  }));
  const controllerToken = "t".repeat(48);
  assert.throws(
    () => new SingleHostBrokerSupervisor({ stateDir, registry: fixtureRegistry(), controllerToken }),
    /requires a signedRegistry/,
  );
  assert.equal(existsSync(join(stateDir, "broker.sqlite")), false);

  const supervisor = new SingleHostBrokerSupervisor({
    stateDir,
    signedRegistry: envelope,
    trustedRegistryKeys: trustedKeys,
    controllerToken,
  });
  try {
    const status = await supervisor.start();
    assert.deepEqual(status.registry.source, "signed");
    assert.equal(status.registry.keyId, "release-2026");
    assert.match(status.registry.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(status).includes(controllerToken), false);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
