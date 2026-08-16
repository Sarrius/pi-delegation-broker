import { createHash, createPublicKey, verify } from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
// A resource id is `${provider}/${modelId}`. Provider model ids legitimately carry vendor
// paths, rolling aliases and variants such as `:batch` and `~openai/gpt-latest`.
const RESOURCE_IDENTIFIER = /^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,191}$/;
const ENFORCEMENT = new Set(["hard", "metered_best_effort", "unavailable"]);
const PROFILE_STATUS = new Set(["approved", "disabled"]);
const INVENTORY_CONFIDENCE = new Set(["measured", "observed", "assumed"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new Error("Signed registry contains a non-finite or unsafe number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (!isPlainObject(value)) throw new Error("Signed registry must contain JSON objects only");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function ownKeysExactly(value, keys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} is not a bounded identifier`);
  return value;
}

function requireResourceIdentifier(value, label) {
  if (typeof value !== "string" || !RESOURCE_IDENTIFIER.test(value)) throw new Error(`${label} is not a bounded resource identifier`);
  return value;
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe-integer timestamp`);
  return value;
}

function freeze(value) {
  if (Array.isArray(value)) value.forEach(freeze);
  else if (isPlainObject(value)) Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function normalizedBrokerRegistry(registry) {
  ownKeysExactly(registry, ["registryVersion", "issuedAt", "expiresAt", "profiles", "capacityGroups", "resources"], "Signed registry");
  requireIdentifier(registry.registryVersion, "registryVersion");
  const issuedAt = requireTimestamp(registry.issuedAt, "issuedAt");
  const expiresAt = requireTimestamp(registry.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) throw new Error("Signed registry expiresAt must be after issuedAt");
  if (!isPlainObject(registry.profiles) || !isPlainObject(registry.capacityGroups) || !isPlainObject(registry.resources)) {
    throw new Error("Signed registry profiles, capacityGroups and resources must be objects");
  }

  const profiles = {};
  for (const [id, profile] of Object.entries(registry.profiles)) {
    requireIdentifier(id, `profile ${id}`);
    ownKeysExactly(profile, ["status", "supports"], `profile ${id}`);
    if (typeof profile.status !== "string" || !PROFILE_STATUS.has(profile.status)) throw new Error(`profile ${id} has invalid status`);
    if (!Array.isArray(profile.supports) || profile.supports.length === 0) throw new Error(`profile ${id} supports must be a non-empty array`);
    const supports = profile.supports.map((capability) => requireIdentifier(capability, `profile ${id} support`));
    if (new Set(supports).size !== supports.length) throw new Error(`profile ${id} has duplicate supports`);
    profiles[id] = { status: profile.status, supports };
  }
  if (Object.keys(profiles).length === 0) throw new Error("Signed registry must contain a profile");

  const capacityGroups = {};
  for (const [id, group] of Object.entries(registry.capacityGroups)) {
    requireIdentifier(id, `capacity group ${id}`);
    ownKeysExactly(group, ["maxConcurrent", "admission", "cooldown", "confidence"], `capacity group ${id}`);
    if (!Number.isSafeInteger(group.maxConcurrent) || group.maxConcurrent < 1 || group.maxConcurrent > 10_000) {
      throw new Error(`capacity group ${id} has invalid maxConcurrent`);
    }
    if (!INVENTORY_CONFIDENCE.has(group.confidence)) throw new Error(`capacity group ${id} has invalid confidence`);
    ownKeysExactly(group.admission, ["controlReserve", "verifyReserve"], `capacity group ${id} admission`);
    const { controlReserve, verifyReserve } = group.admission;
    if (!Number.isSafeInteger(controlReserve) || controlReserve < 1
      || !Number.isSafeInteger(verifyReserve) || verifyReserve < 0
      || controlReserve + verifyReserve > group.maxConcurrent) {
      throw new Error(`capacity group ${id} has invalid admission reserves`);
    }
    ownKeysExactly(group.cooldown, ["defaultMs", "probeIntervalMs"], `capacity group ${id} cooldown`);
    if (!Number.isSafeInteger(group.cooldown.defaultMs) || group.cooldown.defaultMs < 1 || group.cooldown.defaultMs > 2_592_000_000
      || !Number.isSafeInteger(group.cooldown.probeIntervalMs) || group.cooldown.probeIntervalMs < 1 || group.cooldown.probeIntervalMs > 86_400_000) {
      throw new Error(`capacity group ${id} has invalid cooldown policy`);
    }
    capacityGroups[id] = {
      maxConcurrent: group.maxConcurrent,
      admission: { controlReserve, verifyReserve },
      cooldown: { defaultMs: group.cooldown.defaultMs, probeIntervalMs: group.cooldown.probeIntervalMs },
      confidence: group.confidence,
    };
  }
  if (Object.keys(capacityGroups).length === 0) throw new Error("Signed registry must contain a capacity group");

  const resources = {};
  for (const [id, resource] of Object.entries(registry.resources)) {
    requireResourceIdentifier(id, `resource ${id}`);
    // catalogToBrokerRegistry carries controller-side identity/metadata (`model`, `catalog`)
    // so the selector can map a lease back to a concrete model. The broker persists neither;
    // permit and deliberately strip both while normalizing the signed registry. Unknown fields
    // still fail closed.
    const keys = [
      "capacityGroup", "profile", "confidence", "enforcement",
      ...(resource.model !== undefined ? ["model"] : []),
      ...(resource.catalog !== undefined ? ["catalog"] : []),
    ];
    ownKeysExactly(resource, keys, `resource ${id}`);
    requireIdentifier(resource.capacityGroup, `resource ${id} capacityGroup`);
    requireIdentifier(resource.profile, `resource ${id} profile`);
    if (!capacityGroups[resource.capacityGroup]) throw new Error(`resource ${id} references unknown capacity group`);
    if (!profiles[resource.profile]) throw new Error(`resource ${id} references unknown profile`);
    if (!INVENTORY_CONFIDENCE.has(resource.confidence)) throw new Error(`resource ${id} has invalid confidence`);
    let model;
    if (resource.model !== undefined) {
      ownKeysExactly(resource.model, ["provider", "modelId"], `resource ${id} model`);
      requireIdentifier(resource.model.provider, `resource ${id} model provider`);
      if (typeof resource.model.modelId !== "string" || resource.model.modelId.length < 1 || resource.model.modelId.length > 200 || /[\0\r\n]/.test(resource.model.modelId)) {
        throw new Error(`resource ${id} model modelId is not a bounded string`);
      }
      model = { provider: resource.model.provider, modelId: resource.model.modelId };
    }
    ownKeysExactly(resource.enforcement, ["input", "output", "cost"], `resource ${id} enforcement`);
    const enforcement = {};
    for (const dimension of ["input", "output", "cost"]) {
      const value = resource.enforcement[dimension];
      if (typeof value !== "string" || !ENFORCEMENT.has(value)) throw new Error(`resource ${id} has invalid ${dimension} enforcement`);
      enforcement[dimension] = value;
    }
    resources[id] = { capacityGroup: resource.capacityGroup, profile: resource.profile, confidence: resource.confidence, enforcement };
  }
  if (Object.keys(resources).length === 0) throw new Error("Signed registry must contain a resource");

  return {
    registryVersion: registry.registryVersion,
    issuedAt,
    expiresAt,
    brokerRegistry: { profiles, capacityGroups, resources },
  };
}

function decodeSignature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value)) throw new Error("Signed registry signature must be an Ed25519 base64url signature");
  const signature = Buffer.from(value, "base64url");
  if (signature.length !== 64) throw new Error("Signed registry signature has an invalid length");
  return signature;
}

/** Canonical bytes that an offline release signer must sign with Ed25519. */
export function signedRegistryMessage({ schemaVersion, keyId, registry }) {
  if (schemaVersion !== 2) throw new Error("Signed registry schemaVersion must equal 2");
  requireIdentifier(keyId, "keyId");
  // Sign the normalized broker shape, not controller-only catalog metadata. The latter may
  // carry descriptive floating-point costs and is deliberately neither persisted nor routed by
  // the broker; signing the raw object made any real catalog impossible to sign.
  const normalized = normalizedBrokerRegistry(registry);
  const signedRegistry = {
    registryVersion: normalized.registryVersion,
    issuedAt: normalized.issuedAt,
    expiresAt: normalized.expiresAt,
    ...normalized.brokerRegistry,
  };
  return Buffer.from(canonicalize({ schemaVersion, keyId, registry: signedRegistry }), "utf8");
}

/**
 * Verify a controller-owned signed registry before it reaches SQLite admission.
 * `trustedKeys` is a controller/release-pipeline keyring (keyId -> public key),
 * never child configuration and never an account/provider credential.
 */
export function verifySignedRegistry(envelope, { trustedKeys, now = Date.now() } = {}) {
  ownKeysExactly(envelope, ["schemaVersion", "keyId", "registry", "signature"], "Signed registry envelope");
  if (!isPlainObject(trustedKeys)) throw new Error("Signed registry requires a trusted keyring");
  const message = signedRegistryMessage(envelope);
  const key = trustedKeys[envelope.keyId];
  if (!key) throw new Error(`Signed registry keyId is not trusted: ${envelope.keyId}`);
  let publicKey;
  try { publicKey = createPublicKey(key); } catch { throw new Error("Signed registry trusted public key is invalid"); }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Signed registry trusted key must be Ed25519");
  if (!verify(null, message, publicKey, decodeSignature(envelope.signature))) throw new Error("Signed registry signature verification failed");
  const normalized = normalizedBrokerRegistry(envelope.registry);
  if (!Number.isSafeInteger(now) || now < normalized.issuedAt || now >= normalized.expiresAt) {
    throw new Error("Signed registry is not currently valid");
  }
  const fingerprint = createHash("sha256").update(message).digest("hex");
  return freeze({
    keyId: envelope.keyId,
    registryVersion: normalized.registryVersion,
    issuedAt: normalized.issuedAt,
    expiresAt: normalized.expiresAt,
    fingerprint,
    brokerRegistry: normalized.brokerRegistry,
  });
}
