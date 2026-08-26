import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { captureLosslessJson } from "./lossless-json.mjs";

const HEX64 = /^[a-f0-9]{64}$/;
const FINGERPRINT_FIELDS = ["schemaVersion", "capabilityFingerprint", "extensions", "behavioralExtension"];
const ATTESTATION_FIELDS = [...FINGERPRINT_FIELDS, "fingerprint"];

export class LauncherAttestationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LauncherAttestationError";
    this.code = "launcher_attestation_failed";
  }
}

function ownKeysExactly(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedHash(value, label) {
  if (typeof value !== "string" || !HEX64.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return value;
}

function canonicalExtension(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4_096 || /[\0\r\n]/.test(path)) {
    throw new Error(`${label} must be a bounded absolute path`);
  }
  let canonical;
  try {
    // A resolver must name a concrete source file, not a symlink whose target
    // could be switched between policy check and Pi's --extension load.
    if (lstatSync(path).isSymbolicLink()) throw new Error("path is a symbolic link");
    canonical = realpathSync(path);
    const stat = statSync(canonical);
    if (!stat.isFile()) throw new Error("path is not a regular file");
    if ((stat.mode & 0o022) !== 0) throw new Error("source grants group/other write access");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not a trusted regular source file: ${detail}`);
  }
  return canonical;
}

function sourceRecord(path, expectedDigest, label) {
  const canonicalPath = canonicalExtension(path, label);
  const digest = hash(readFileSync(canonicalPath));
  if (digest !== boundedHash(expectedDigest, `${label} expected digest`)) {
    throw new LauncherAttestationError(`${label} digest does not match its pinned trusted digest`);
  }
  return Object.freeze({ path: canonicalPath, digest });
}

function normalizeFingerprint(input) {
  ownKeysExactly(input, FINGERPRINT_FIELDS, "Launcher attestation fingerprint payload");
  if (input.schemaVersion !== 1) throw new Error("Launcher attestation schemaVersion must equal 1");
  const capabilityFingerprint = boundedHash(input.capabilityFingerprint, "Launcher attestation capabilityFingerprint");
  if (!Array.isArray(input.extensions) || input.extensions.length < 1 || input.extensions.length > 32) {
    throw new Error("Launcher attestation needs 1..32 extension records");
  }
  const extensions = input.extensions.map((extension, index) => {
    ownKeysExactly(extension, ["path", "digest"], `Launcher attestation extension ${index}`);
    return Object.freeze({
      path: canonicalExtension(extension.path, `Launcher attestation extension ${index}`),
      digest: boundedHash(extension.digest, `Launcher attestation extension ${index} digest`),
    });
  });
  if (new Set(extensions.map((extension) => extension.path)).size !== extensions.length) {
    throw new Error("Launcher attestation contains duplicate extension paths");
  }
  ownKeysExactly(input.behavioralExtension, ["path", "digest"], "Launcher attestation behavioral extension");
  const behavioralExtension = Object.freeze({
    path: canonicalExtension(input.behavioralExtension.path, "Launcher attestation behavioral extension"),
    digest: boundedHash(input.behavioralExtension.digest, "Launcher attestation behavioral extension digest"),
  });
  const last = extensions.at(-1);
  if (!last || last.path !== behavioralExtension.path || last.digest !== behavioralExtension.digest) {
    throw new Error("Launcher attestation requires the behavioral extension to be final in explicit order");
  }
  return Object.freeze({ schemaVersion: 1, capabilityFingerprint, extensions: Object.freeze(extensions), behavioralExtension });
}

function fingerprint(payload) {
  const captured = captureLosslessJson(payload, { maxDepth: 8, maxNodes: 256, maxBytes: 64 * 1024 });
  return hash(captured.canonical);
}

/**
 * Create a controller-side source attestation. Expected digests are reviewed
 * launcher configuration, not values discovered from the child. This binds the
 * capability to concrete extension bytes and requires the behavioral extension
 * to load after every other explicit extension.
 */
export function createLauncherAttestation({ capabilityFingerprint, extensionPaths, trustedExtensionDigests, behavioralExtensionPath } = {}) {
  boundedHash(capabilityFingerprint, "Launcher attestation capabilityFingerprint");
  if (!Array.isArray(extensionPaths) || !Array.isArray(trustedExtensionDigests)
    || extensionPaths.length !== trustedExtensionDigests.length || extensionPaths.length < 1) {
    throw new Error("Launcher attestation requires equal non-empty extensionPaths and trustedExtensionDigests arrays");
  }
  const extensions = extensionPaths.map((path, index) => sourceRecord(path, trustedExtensionDigests[index], `Launcher attestation extension ${index}`));
  const behavioralPath = canonicalExtension(behavioralExtensionPath, "Launcher attestation behavioral extension");
  const behavioralExtension = extensions.at(-1);
  if (!behavioralExtension || behavioralExtension.path !== behavioralPath) {
    throw new Error("Launcher attestation behavioralExtensionPath must be the final explicit extension path");
  }
  const payload = normalizeFingerprint({
    schemaVersion: 1,
    capabilityFingerprint,
    extensions,
    behavioralExtension,
  });
  return Object.freeze({ ...payload, fingerprint: fingerprint(payload) });
}

/** Rehash sources immediately before spawn; never trust a stale admission-time check. */
export function verifyLauncherAttestation(attestation, { capabilityFingerprint } = {}) {
  ownKeysExactly(attestation, ATTESTATION_FIELDS, "Launcher attestation");
  const { fingerprint: suppliedFingerprint, ...payloadInput } = attestation;
  const payload = normalizeFingerprint(payloadInput);
  if (capabilityFingerprint !== undefined && payload.capabilityFingerprint !== boundedHash(capabilityFingerprint, "Expected capabilityFingerprint")) {
    throw new Error("Launcher attestation does not bind the expected capability");
  }
  if (suppliedFingerprint !== fingerprint(payload)) throw new Error("Launcher attestation fingerprint is invalid");
  for (const [index, extension] of payload.extensions.entries()) {
    const actual = hash(readFileSync(extension.path));
    if (actual !== extension.digest) throw new LauncherAttestationError(`Launcher attestation extension ${index} changed after approval`);
  }
  return Object.freeze({
    ...payload,
    fingerprint: suppliedFingerprint,
    extensionPaths: Object.freeze(payload.extensions.map((extension) => extension.path)),
  });
}
