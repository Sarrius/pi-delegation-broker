import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLauncherAttestation, verifyLauncherAttestation } from "../src/launcher-attestation.mjs";

const CAPABILITY = "a".repeat(64);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sources() {
  const directory = mkdtempSync(join(tmpdir(), "launcher-attestation-"));
  const shim = join(directory, "shim.ts");
  const behavioral = join(directory, "behavioral.ts");
  const shimSource = "export default () => undefined;\n";
  const behavioralSource = "export default () => undefined; // behavioral\n";
  writeFileSync(shim, shimSource, { mode: 0o600 });
  writeFileSync(behavioral, behavioralSource, { mode: 0o600 });
  return { directory, shim, behavioral, shimSource, behavioralSource };
}

test("launcher attestation pins every explicit extension and requires behavioral enforcement last", () => {
  const fixture = sources();
  try {
    const attestation = createLauncherAttestation({
      capabilityFingerprint: CAPABILITY,
      extensionPaths: [fixture.shim, fixture.behavioral],
      trustedExtensionDigests: [digest(fixture.shimSource), digest(fixture.behavioralSource)],
      behavioralExtensionPath: fixture.behavioral,
    });
    assert.equal(attestation.capabilityFingerprint, CAPABILITY);
    assert.equal(attestation.extensions.length, 2);
    assert.equal(attestation.extensions.at(-1).path, attestation.behavioralExtension.path);
    assert.match(attestation.fingerprint, /^[a-f0-9]{64}$/);

    const verified = verifyLauncherAttestation(attestation, { capabilityFingerprint: CAPABILITY });
    assert.deepEqual(verified.extensionPaths, attestation.extensions.map((extension) => extension.path));
    assert.throws(() => verifyLauncherAttestation(attestation, { capabilityFingerprint: "b".repeat(64) }), /does not bind/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("attestation fails closed on wrong pins, ordering, or source changes before spawn", () => {
  const fixture = sources();
  try {
    assert.throws(() => createLauncherAttestation({
      capabilityFingerprint: CAPABILITY,
      extensionPaths: [fixture.shim, fixture.behavioral],
      trustedExtensionDigests: ["0".repeat(64), digest(fixture.behavioralSource)],
      behavioralExtensionPath: fixture.behavioral,
    }), /does not match/);
    assert.throws(() => createLauncherAttestation({
      capabilityFingerprint: CAPABILITY,
      extensionPaths: [fixture.behavioral, fixture.shim],
      trustedExtensionDigests: [digest(fixture.behavioralSource), digest(fixture.shimSource)],
      behavioralExtensionPath: fixture.behavioral,
    }), /final explicit extension/);

    const attestation = createLauncherAttestation({
      capabilityFingerprint: CAPABILITY,
      extensionPaths: [fixture.shim, fixture.behavioral],
      trustedExtensionDigests: [digest(fixture.shimSource), digest(fixture.behavioralSource)],
      behavioralExtensionPath: fixture.behavioral,
    });
    writeFileSync(fixture.behavioral, "export default () => { throw new Error('changed'); };\n", { mode: 0o600 });
    assert.throws(() => verifyLauncherAttestation(attestation), /changed after approval/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
