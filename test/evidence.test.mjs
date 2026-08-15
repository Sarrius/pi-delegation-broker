import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerEvidenceStore, validateResultEvidence } from "../src/evidence.mjs";

function withStore(callback, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "controller-evidence-"));
  try { return callback(new ControllerEvidenceStore({ root, ...options }), root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("self-reported evidence is context only and cannot satisfy acceptance", () => withStore((store) => {
  const result = {
    evidence: [{
      kind: "test",
      ref: "self:test-output",
      claim: "npm test",
      source: "self_reported",
    }],
    validationPerformed: [{ check: "npm test", outcome: "pass", evidenceRef: "self:test-output" }],
  };
  const validation = validateResultEvidence(result, { acceptance: ["npm test"], evidenceStore: store });
  assert.equal(validation.status, "rejected");
  assert.deepEqual(validation.satisfied, []);
  assert.match(validation.reasons[0], /lacks controller evidence/);
}));

test("controller-captured output satisfies only the acceptance claim it was captured for", () => withStore((store) => {
  const evidence = store.capture({ kind: "test", claim: "npm test", artifact: "31 tests passed", capturedAt: 1_000 });
  const result = {
    evidence: [evidence],
    validationPerformed: [{ check: "npm test", outcome: "pass", evidenceRef: evidence.ref }],
  };
  assert.deepEqual(
    validateResultEvidence(result, { acceptance: ["npm test"], evidenceStore: store }),
    { status: "accepted", reasons: [], satisfied: ["npm test"] },
  );
  assert.equal(
    validateResultEvidence(result, { acceptance: ["npm run check"], evidenceStore: store }).status,
    "rejected",
  );
}));

test("a child cannot forge controller provenance or mutate a captured digest", () => withStore((store) => {
  const evidence = store.capture({ kind: "command", claim: "git diff --check", artifact: "", capturedAt: 1_000 });
  const forged = { ...evidence, contentHash: "0".repeat(64) };
  const result = {
    evidence: [forged],
    validationPerformed: [{ check: "git diff --check", outcome: "pass", evidenceRef: forged.ref }],
  };
  const validation = validateResultEvidence(result, { acceptance: ["git diff --check"], evidenceStore: store });
  assert.equal(validation.status, "rejected");
  assert.match(validation.reasons.join(" "), /not authentic/);
}));

test("redacted content-addressed evidence survives restart and can be re-read", () => withStore((store, root) => {
  const evidence = store.capture({
    kind: "command",
    claim: "typed command CANARY_SECRET_CLAIM",
    artifact: "exit=0 token=CANARY_SECRET_SHOULD_NOT_PERSIST\nnormalized output",
    capturedAt: 1_000,
  });
  const retained = store.artifact(evidence).toString("utf8");
  assert.equal(evidence.claim, "typed command [REDACTED]");
  assert.match(retained, /\[REDACTED\]/);
  assert.doesNotMatch(retained, /CANARY_SECRET/);
  const restarted = new ControllerEvidenceStore({ root });
  assert.equal(restarted.verify(evidence), true);
  assert.equal(restarted.artifact(evidence).toString("utf8"), retained);
  assert.deepEqual(restarted.entries(), [evidence]);
}));

test("corrupt or expired retained evidence cannot satisfy acceptance", () => withStore((store, root) => {
  const evidence = store.capture({ kind: "file", claim: "file range", artifact: "line one\n", capturedAt: 1_000 });
  writeFileSync(join(root, "objects", evidence.contentHash), "tampered", { mode: 0o600 });
  assert.equal(store.verify(evidence), false);
  assert.throws(() => new ControllerEvidenceStore({ root }), /missing or corrupt/);
}, { retentionMs: 10 }));

test("retention pruning removes metadata and unreferenced content through an explicit transition", () => withStore((store, root) => {
  const evidence = store.capture({ kind: "test", claim: "test outcome", artifact: "pass", capturedAt: 1_000 });
  assert.deepEqual(store.prune(1_009), []);
  assert.deepEqual(store.prune(1_010), [evidence.ref]);
  assert.equal(store.verify(evidence), false);
  assert.deepEqual(new ControllerEvidenceStore({ root, retentionMs: 10 }).entries(), []);
}, { retentionMs: 10 }));

test("unredacted binary evidence is rejected at ingress", () => withStore((store) => {
  assert.throws(
    () => store.capture({ kind: "receipt", claim: "binary receipt", artifact: Buffer.from([0, 1, 2]) }),
    /artifactIsRedacted/,
  );
}));
