import assert from "node:assert/strict";
import test from "node:test";
import { ControllerEvidenceStore, validateResultEvidence } from "../src/evidence.mjs";

test("self-reported evidence is context only and cannot satisfy acceptance", () => {
  const store = new ControllerEvidenceStore();
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
});

test("controller-captured output satisfies only the acceptance claim it was captured for", () => {
  const store = new ControllerEvidenceStore();
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
});

test("a child cannot forge controller provenance or mutate a captured digest", () => {
  const store = new ControllerEvidenceStore();
  const evidence = store.capture({ kind: "command", claim: "git diff --check", artifact: "", capturedAt: 1_000 });
  const forged = { ...evidence, contentHash: "0".repeat(64) };
  const result = {
    evidence: [forged],
    validationPerformed: [{ check: "git diff --check", outcome: "pass", evidenceRef: forged.ref }],
  };
  const validation = validateResultEvidence(result, { acceptance: ["git diff --check"], evidenceStore: store });
  assert.equal(validation.status, "rejected");
  assert.match(validation.reasons.join(" "), /not authentic/);
});
