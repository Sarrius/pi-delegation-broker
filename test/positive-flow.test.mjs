import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureContract, fixtureRegistry, SqliteLeaseBroker } from "../src/broker.mjs";
import { ControllerEvidenceStore, validateResultEvidence } from "../src/evidence.mjs";

test("non-live discover, audit, verify and merge flow reaches controller-accepted completion", () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-positive-flow-"));
  const registry = fixtureRegistry();
  registry.capacityGroups["G-shared"] = {
    ...registry.capacityGroups["G-shared"],
    maxConcurrent: 3,
    admission: { controlReserve: 1, verifyReserve: 1 },
  };
  delete registry.resources.R2;
  delete registry.resources.R3;
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry });
  try {
    const root = broker.reserve(fixtureContract({ taskId: "reference-root", admissionClass: "control" }), 1_000);
    const audit = broker.reserve(fixtureContract({ taskId: "reference-audit", admissionClass: "work" }), 1_000);
    const verifier = broker.reserve(fixtureContract({ taskId: "reference-verifier", admissionClass: "verify" }), 1_000);
    assert.deepEqual([root.status, audit.status, verifier.status], ["leased", "leased", "leased"]);

    const evidenceStore = new ControllerEvidenceStore({ root: join(directory, "evidence") });
    const discovered = evidenceStore.capture({
      kind: "file",
      claim: "repository inventory captured",
      artifact: "src/index.mjs\ntest/broker.test.mjs\n",
      capturedAt: 1_001,
    });
    const checked = evidenceStore.capture({
      kind: "test",
      claim: "reference acceptance check",
      artifact: "pass: deterministic reference audit",
      capturedAt: 1_002,
    });
    const merged = {
      status: "completed",
      result: { summary: "reference audit accepted" },
      evidence: [
        discovered,
        checked,
        { kind: "command", ref: "self:claimed-command", claim: "untrusted context", source: "self_reported" },
      ],
      validationPerformed: [
        { check: "repository inventory captured", outcome: "pass", evidenceRef: discovered.ref },
        { check: "reference acceptance check", outcome: "pass", evidenceRef: checked.ref },
      ],
    };
    const validation = validateResultEvidence(merged, {
      acceptance: ["repository inventory captured", "reference acceptance check"],
      evidenceStore,
    });
    assert.equal(validation.status, "accepted");

    for (const reservation of [audit, verifier, root]) {
      assert.equal(broker.release(reservation.lease.leaseId, reservation.lease.fencingToken, "reference flow complete", 1_003).status, "released");
    }
    assert.equal(broker.leases().length, 0);
    assert.equal(broker.events().some((event) => event.type === "LeaseIssued"), true);
  } finally {
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
