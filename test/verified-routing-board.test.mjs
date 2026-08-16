import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureContract, fixtureRegistry, SqliteLeaseBroker } from "../src/broker.mjs";
import { ControllerEvidenceStore } from "../src/evidence.mjs";
import { RoutingBoard } from "../src/routing-board.mjs";
import { ControllerVerificationAuthority } from "../src/verification-authority.mjs";
import { ControllerVerifiedRoutingBoard } from "../src/verified-routing-board.mjs";

const CAPABILITIES = ["code_reasoning", "repo_navigation"];

function withAuthority(run) {
  const root = mkdtempSync(join(tmpdir(), "verified-routing-"));
  const store = new ControllerEvidenceStore({ root: join(root, "evidence") });
  const authority = new ControllerVerificationAuthority({ evidenceStore: store });
  try { return run({ root, store, authority }); } finally { rmSync(root, { recursive: true, force: true }); }
}

function receipt(authority, store, { taskId, leaseId, fencingToken, status = "accepted", runId }) {
  const evidence = store.captureObservation({
    kind: "test", claim: "fixed acceptance", observation: { suite: "fixed", outcome: status === "accepted" ? "pass" : "fail", passed: status === "accepted" ? 1 : 0, failed: status === "accepted" ? 0 : 1, skipped: 0 },
  });
  return authority.attest({
    runId, status, validation: { status }, checks: [{ status: status === "accepted" ? "passed" : "failed" }], result: { evidence: [evidence] },
  }, { taskId, leaseId, fencingToken });
}

function record(bridge, authority, store, { resourceId, index, status = "accepted" }) {
  const taskId = `task-${resourceId}-${index}`;
  const leaseId = `lease-${resourceId}-${index}`;
  const fencingToken = index + 1;
  const verification = receipt(authority, store, { taskId, leaseId, fencingToken, status, runId: `verify-${resourceId}-${index}` });
  return bridge.recordFinalized({
    taskId, leaseId, fencingToken, verification,
    outcome: { status: status === "accepted" ? "completed" : "failed" },
    resourceId, capabilities: CAPABILITIES, latencyMs: 20 + index,
  });
}

test("only controller-verifier-bound finalized outcomes influence routing preference", () => withAuthority(({ root, store, authority }) => {
  const board = new RoutingBoard({ minObservations: 1, maxConsecutiveFailures: 3 });
  const bridge = new ControllerVerifiedRoutingBoard({ routingBoard: board, verificationAuthority: authority, now: () => 1_000 });
  for (let index = 0; index < 8; index += 1) record(bridge, authority, store, { resourceId: "R2", index });
  for (let index = 0; index < 3; index += 1) record(bridge, authority, store, { resourceId: "R1", index, status: "rejected" });

  assert.deepEqual(bridge.prioritizeCandidates({ resourceIds: ["R1", "R2", "R3"], capabilities: CAPABILITIES, now: 1_000 }), ["R2", "R1", "R3"]);
  const forged = receipt(authority, store, { taskId: "task-forged", leaseId: "lease-forged", fencingToken: 1, runId: "verify-forged" });
  assert.throws(() => bridge.recordFinalized({
    taskId: "other-task", leaseId: "lease-forged", fencingToken: 1, verification: forged,
    outcome: { status: "completed" }, resourceId: "R3", capabilities: CAPABILITIES, latencyMs: 1,
  }), /authentic controller verifier receipt/);
  assert.equal(board.snapshot(1_000).totalEntries, 4);

  const registry = fixtureRegistry();
  delete registry.resources.R3;
  const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry, resourceRanker: bridge.resourceRanker() });
  try {
    const reservation = broker.reserve(fixtureContract({ taskId: "ranked-reservation" }), 1_000);
    assert.equal(reservation.status, "leased");
    assert.equal(reservation.lease.resourceId, "R2", "ranking changes preference but broker still made all policy checks");
  } finally {
    broker.close();
  }
}));

test("routing-ranker output is constrained to a complete signed-registry candidate permutation", () => {
  const root = mkdtempSync(join(tmpdir(), "routing-ranker-boundary-"));
  const registry = fixtureRegistry();
  delete registry.resources.R3;
  const broker = new SqliteLeaseBroker({ path: join(root, "broker.sqlite"), registry, resourceRanker: () => ["R1"] });
  try {
    assert.throws(() => broker.reserve(fixtureContract({ taskId: "bad-ranker" }), 1_000), /exact resource candidate permutation/);
    assert.equal(broker.leases().length, 0);
  } finally {
    broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
