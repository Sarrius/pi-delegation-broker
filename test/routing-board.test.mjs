import assert from "node:assert/strict";
import test from "node:test";
import { RoutingBoard } from "../src/routing-board.mjs";

test("routing board records and scores machine-verifiable outcomes", () => {
  const board = new RoutingBoard();
  for (let i = 0; i < 20; i++) {
    board.record({
      resourceId: "r1",
      capability: "code_reasoning",
      taskClass: "control",
      outcome: i < 18 ? "accepted" : "rejected",
      evidenceKind: "test_pass",
      latencyMs: 100 + i,
      timestamp: 1_000 + i,
    });
  }
  const s = board.score("r1", "code_reasoning", 2_000);
  assert.ok(s);
  assert.equal(s.n, 20);
  assert.equal(s.accepted, 18);
  assert.ok(s.lowerBound > 0.5);
  assert.ok(s.lowerBound < s.acceptedRate);
  assert.equal(s.exploration, false);
});

test("routing board gives exploration bonus to under-observed resources", () => {
  const board = new RoutingBoard({ minObservations: 10, explorationBonus: 0.3 });
  board.record({
    resourceId: "new-r",
    capability: "code_reasoning",
    taskClass: "control",
    outcome: "accepted",
    evidenceKind: "test_pass",
    latencyMs: 100,
    timestamp: 1_000,
  });
  const s = board.score("new-r", "code_reasoning", 2_000);
  assert.equal(s.exploration, true);
  assert.ok(s.score > s.lowerBound); // bonus applied

  const established = new RoutingBoard({ minObservations: 10 });
  for (let i = 0; i < 20; i++) {
    established.record({
      resourceId: "old-r",
      capability: "code_reasoning",
      taskClass: "control",
      outcome: "accepted",
      evidenceKind: "test_pass",
      latencyMs: 100,
      timestamp: 1_000 + i,
    });
  }
  const establishedScore = established.score("old-r", "code_reasoning", 2_000);
  assert.equal(establishedScore.exploration, false);
});

test("routing board ranks resources by Wilson lower bound, not raw rate", () => {
  const board = new RoutingBoard({ minObservations: 5 });
  // Resource A: 3/3 accepted (100% raw rate, but small sample)
  for (let i = 0; i < 3; i++) {
    board.record({ resourceId: "rA", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_000 + i });
  }
  // Resource B: 290/300 accepted (96.7% raw rate, large sample, no consecutive failures)
  for (let i = 0; i < 300; i++) {
    const accepted = (i % 10 !== 9) ? "accepted" : "rejected"; // 10% rejected, spread out
    board.record({ resourceId: "rB", capability: "code", taskClass: "control", outcome: accepted, evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_000 + i });
  }
  const ranked = board.rank("code", 2_000, { resourceIds: ["rA", "rB"] });
  assert.equal(ranked.length, 2);
  // B should outrank A despite lower raw rate (larger sample = tighter interval)
  assert.equal(ranked[0].resourceId, "rB");
  assert.ok(ranked[0].lowerBound > ranked[1].lowerBound);
});

test("routing board detects drift via rolling window divergence", () => {
  const board = new RoutingBoard({ rollingWindowSize: 20, driftThresholdSigma: 2 });
  // First 50: all accepted
  for (let i = 0; i < 50; i++) {
    board.record({ resourceId: "drift-r", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_000 + i });
  }
  // Last 20: all rejected (drift!)
  for (let i = 0; i < 20; i++) {
    board.record({ resourceId: "drift-r", capability: "code", taskClass: "control", outcome: "rejected", evidenceKind: "test_pass", latencyMs: 50, timestamp: 2_000 + i });
  }
  const s = board.score("drift-r", "code", 3_000);
  assert.equal(s.drifting, true);
  assert.ok(s.score < s.lowerBound); // drift penalty applied
});

test("routing board excludes resources with consecutive failures", () => {
  const board = new RoutingBoard({ maxConsecutiveFailures: 3 });
  for (let i = 0; i < 5; i++) {
    board.record({ resourceId: "failing-r", capability: "code", taskClass: "control", outcome: "error", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_000 + i });
  }
  const ranked = board.rank("code", 2_000, { resourceIds: ["failing-r"] });
  assert.equal(ranked.length, 0);
});

test("routing board recency decay reduces stale scores", () => {
  const board = new RoutingBoard({ recencyDecayHalfLifeMs: 60_000 });
  board.record({ resourceId: "stale-r", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_000 });
  const fresh = board.score("stale-r", "code", 1_500);
  const stale = board.score("stale-r", "code", 1_000 + 120_000);
  assert.ok(stale.recencyFactor < 1);
  assert.ok(stale.score < fresh.score);
});

test("routing board rejects non-machine-verifiable evidence", () => {
  const board = new RoutingBoard();
  assert.throws(
    () => board.record({ resourceId: "r1", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "model_graded", latencyMs: 50, timestamp: 1_000 }),
    /machine-verifiable/,
  );
});

test("routing board export/import round-trips", () => {
  const board = new RoutingBoard();
  for (let i = 0; i < 10; i++) {
    board.record({ resourceId: "r1", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_000 + i });
  }
  const exported = board.export();
  assert.equal(exported.version, 1);

  const imported = new RoutingBoard();
  const result = imported.import(exported);
  assert.equal(result.status, "imported");
  assert.equal(imported.size, 1);
  const s = imported.score("r1", "code", 2_000);
  assert.equal(s.n, 10);
  assert.equal(s.accepted, 10);
});

test("routing board snapshot is read-only and complete", () => {
  const board = new RoutingBoard();
  board.record({ resourceId: "r1", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_000 });
  board.record({ resourceId: "r2", capability: "code", taskClass: "control", outcome: "rejected", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_001 });
  const snap = board.snapshot(2_000);
  assert.equal(snap.totalEntries, 2);
  assert.ok(snap.entries["r1::code"]);
  assert.ok(snap.entries["r2::code"]);
  assert.throws(() => { snap.entries["r1::code"] = null; }, TypeError);
});

test("routing board enforces entry limit", () => {
  const board = new RoutingBoard({ maxBoardEntries: 2 });
  board.record({ resourceId: "r1", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_000 });
  board.record({ resourceId: "r2", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_001 });
  assert.throws(
    () => board.record({ resourceId: "r3", capability: "code", taskClass: "control", outcome: "accepted", evidenceKind: "test_pass", latencyMs: 50, timestamp: 1_002 }),
    /entry limit/,
  );
});

test("routing board validates constructor config", () => {
  assert.throws(() => new RoutingBoard({ minObservations: 0 }), /minObservations/);
  assert.throws(() => new RoutingBoard({ explorationBonus: 2 }), /explorationBonus/);
  assert.throws(() => new RoutingBoard({ maxConsecutiveFailures: 0 }), /maxConsecutiveFailures/);
});

test("one-provider degenerate case: board serves as monitoring dashboard", () => {
  const board = new RoutingBoard();
  for (let i = 0; i < 50; i++) {
    board.record({
      resourceId: "sole-provider",
      capability: "code_reasoning",
      taskClass: "work",
      outcome: i < 45 ? "accepted" : "rejected",
      evidenceKind: "test_pass",
      latencyMs: 200,
      timestamp: 1_000 + i,
    });
  }
  const s = board.score("sole-provider", "code_reasoning", 2_000);
  assert.equal(s.n, 50);
  assert.ok(s.acceptedRate > 0.85);
  assert.ok(s.p50LatencyMs > 0);
  // The same verified outcome and latency facts that drive routing also drive monitoring
  assert.ok(s.lowerBound > 0.5); // within quality band
});