import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  admitTeamNodes,
  evaluateTeamJoin,
  normalizeTaskAdmission,
  normalizeTeamJoin,
} from "../src/team.mjs";
import { appendWorkflowNodes, closeWorkflow, TaskOrchestrator } from "../src/workflow-scheduler.mjs";
import { readJob, requestJobCancellation, recoverJobs } from "../src/delegation-job-store.mjs";

test("flat-team admission reuses exact duplicates and requires material difference for near duplicates", () => {
  const existing = [{ id: "one", task: "collect evidence", admission: normalizeTaskAdmission({ task: "collect evidence", purpose: "ensemble" }) }];
  const exact = admitTeamNodes(existing, [{ id: "replay", task: "collect evidence", purpose: "ensemble" }], {
    budgets: { maxNodes: 4, maxAppends: 4, maxParallel: 2, maxRedundant: 2 }, concurrency: 2,
  });
  assert.equal(exact.added.length, 0);
  assert.equal(exact.reused[0].existingId, "one");

  assert.throws(() => admitTeamNodes(existing, [{ id: "near", task: "collect evidence", purpose: "sectioning" }], {
    budgets: { maxNodes: 4, maxAppends: 4, maxParallel: 2, maxRedundant: 2 }, concurrency: 2,
  }), /materialDifference/);

  const diverse = admitTeamNodes(existing, [{
    id: "adversarial", task: "collect evidence", purpose: "ensemble",
    materialDifference: "adversarial_method",
  }], { budgets: { maxNodes: 4, maxAppends: 4, maxParallel: 2, maxRedundant: 2 }, concurrency: 2 });
  assert.equal(diverse.added.length, 1);
  assert.equal(diverse.redundancyUsed, 1);
});

test("sectioning, ensemble and reviewer joins require semantically accepted artifacts", () => {
  const nodes = [
    { id: "a", state: "completed", result: { status: "completed", semanticStatus: "accepted" } },
    { id: "b", state: "completed", result: { status: "completed", verificationStatus: "completed" } },
    { id: "c", state: "completed", result: { status: "completed" } },
    { id: "review", state: "completed", result: { status: "completed", acceptanceStatus: "accepted" } },
  ];
  assert.equal(evaluateTeamJoin({ id: "sections", kind: "sectioning", members: ["a", "b"] }, nodes).status, "accepted");
  assert.equal(evaluateTeamJoin({ id: "ensemble", kind: "ensemble", members: ["a", "b", "c"], policy: "majority" }, nodes).status, "accepted");
  assert.equal(evaluateTeamJoin({ id: "reviewed", kind: "reviewer", members: ["a"], reviewerId: "review" }, nodes).status, "accepted");
  assert.equal(evaluateTeamJoin({ id: "not-accepted", kind: "sectioning", members: ["a", "c"] }, nodes).status, "pending");
  assert.throws(() => normalizeTeamJoin({ id: "bad", kind: "ensemble", members: ["a"] }), /at least two/);
});

test("dynamic workflow appends are budgeted, persisted and settle after the append window closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dynamic-team-"));
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  try {
    const orchestrator = new TaskOrchestrator({
      root, jobId: "team", concurrency: 1,
      run: async (node) => {
        if (node.id === "first") { started(); await gate; }
        return { status: "completed", semanticStatus: "accepted" };
      },
    });
    orchestrator.initialize([{ id: "first", task: "first" }], {
      dynamic: true,
      budgets: { maxNodes: 3, maxAppends: 2, maxParallel: 1, maxRedundant: 0 },
    });
    const execution = orchestrator.execute();
    await began;
    const append = appendWorkflowNodes(root, "team", [{ id: "second", task: "second", dependsOn: ["first"] }]);
    assert.deepEqual(append.added.map((node) => node.id), ["second"]);
    assert.equal(readJob(root, "team").nodes.length, 2);
    release();
    closeWorkflow(root, "team");
    const state = await execution;
    assert.equal(state.status, "completed");
    assert.deepEqual(state.nodes.map((node) => node.state), ["completed", "completed"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dynamic proposal replay is idempotent and revision conflicts reject new work", () => {
  const root = mkdtempSync(join(tmpdir(), "dynamic-team-revision-"));
  try {
    const orchestrator = new TaskOrchestrator({ root, jobId: "team-revision", run: async () => ({ status: "completed" }) });
    orchestrator.initialize([{ id: "one", task: "one" }], { dynamic: true, budgets: { maxNodes: 3, maxAppends: 2, maxParallel: 1, maxRedundant: 0 } });
    const first = appendWorkflowNodes(root, "team-revision", [{ id: "two", task: "two" }], { proposalId: "proposal-1", expectedRevision: 0 });
    assert.equal(first.revision, 1);
    const replay = appendWorkflowNodes(root, "team-revision", [{ id: "two", task: "two" }], { proposalId: "proposal-1", expectedRevision: 0 });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(readJob(root, "team-revision").nodes.length, 2);
    assert.throws(() => appendWorkflowNodes(root, "team-revision", [{ id: "three", task: "three" }], { proposalId: "proposal-2", expectedRevision: 0 }), /revision conflict/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dynamic append rejects cancellation and restart preserves the open root team", () => {
  const root = mkdtempSync(join(tmpdir(), "dynamic-team-recovery-"));
  try {
    const orchestrator = new TaskOrchestrator({ root, jobId: "team-recovery", run: async () => ({ status: "completed" }) });
    orchestrator.initialize([{ id: "one", task: "one" }], { dynamic: true, budgets: { maxNodes: 3, maxAppends: 2, maxParallel: 1, maxRedundant: 0 } });
    // A restart requeues active nodes but does not discard team admission state.
    const running = requestJobCancellation(root, "team-recovery");
    assert.equal(running.status, "cancellation_requested");
    recoverJobs(root);
    assert.equal(readJob(root, "team-recovery").status, "cancelled");
    assert.throws(() => appendWorkflowNodes(root, "team-recovery", [{ id: "late", task: "late" }]), /terminal|running/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dynamic append rejects a root budget overflow before changing the durable graph", () => {
  const root = mkdtempSync(join(tmpdir(), "dynamic-team-budget-"));
  try {
    const orchestrator = new TaskOrchestrator({ root, jobId: "team-budget", run: async () => ({ status: "completed" }) });
    orchestrator.initialize([{ id: "one", task: "one" }], {
      dynamic: true,
      budgets: { maxNodes: 1, maxAppends: 1, maxParallel: 1, maxRedundant: 0 },
    });
    assert.throws(() => appendWorkflowNodes(root, "team-budget", [{ id: "two", task: "two" }]), /maxNodes/);
    assert.equal(readJob(root, "team-budget").nodes.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
