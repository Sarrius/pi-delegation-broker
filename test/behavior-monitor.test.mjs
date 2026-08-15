import assert from "node:assert/strict";
import test from "node:test";
import { BehavioralRunMonitor } from "../src/behavior-monitor.mjs";

const stateA = "a".repeat(64);
const stateB = "b".repeat(64);

function run(monitor, stepId, args = { command: "npm test" }) {
  assert.equal(monitor.declareAction({ stepId, toolName: "bash", args }).status, "declared");
  assert.equal(monitor.authorizeAction({ stepId, toolName: "bash", args }).status, "allowed");
}

test("three semantically identical completed actions with no state change terminate as no_progress", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["tests pass"] });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    run(monitor, `test-${attempt}`);
    const observed = monitor.observeActionResult({
      toolName: "bash",
      args: { command: "npm test" },
      result: { exitCode: 1, failure: "same" },
      isError: true,
      stateDigest: stateA,
    });
    assert.equal(observed.status, attempt < 3 ? "progress_observed" : "no_progress");
  }
  assert.deepEqual(monitor.metrics(), {
    actionCount: 3,
    progressTransitions: 1,
    repeatedNoProgress: 2,
    planMismatches: 0,
    completionClaims: 0,
    completionRejected: 0,
    terminalStatus: "no_progress",
  });
});

test("a state transition resets repetition and a running tool is not misclassified", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["tests pass"], repeatedNoProgressLimit: 2 });
  run(monitor, "first");
  assert.equal(monitor.observeActionResult({ toolName: "bash", args: { command: "npm test" }, result: "fail", isError: true, stateDigest: stateA }).status, "progress_observed");
  run(monitor, "second");
  assert.equal(monitor.observeActionResult({ toolName: "bash", args: { command: "npm test" }, result: "fail", isError: true, stateDigest: stateB }).status, "progress_observed");
  assert.equal(monitor.metrics().terminalStatus, null);
});

test("a tool call that differs from its typed declaration is blocked before execution", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["inspect only"] });
  monitor.declareAction({ stepId: "read", toolName: "read", args: { path: "/repo/a" } });
  const verdict = monitor.authorizeAction({ stepId: "read", toolName: "bash", args: { command: "rm -rf /repo" } });
  assert.equal(verdict.status, "reasoning_action_mismatch");
  assert.equal(verdict.block, true);
  assert.equal(verdict.terminate, true);
  assert.match(verdict.nextAction, /escalated/);
});

test("declared changes are reconciled against the controller mutation log", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["patch proposed"] });
  assert.equal(monitor.reconcileChanges({
    declaredChanges: ["src/a.mjs"],
    controllerActionLog: [{ effect: "mutation", target: "src/a.mjs" }],
  }).status, "matched");
  assert.deepEqual(monitor.reconcileChanges({
    declaredChanges: ["src/a.mjs"],
    controllerActionLog: [{ effect: "mutation", target: "src/b.mjs" }],
  }), {
    status: "reasoning_action_mismatch",
    missingFromResult: ["src/b.mjs"],
    notObservedByController: ["src/a.mjs"],
  });
});

test("worker completion is only an evidence-bound claim", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["tests pass", "diff is clean"] });
  assert.equal(monitor.claimCompletion({ evidenceRefs: [] }).status, "completion_claim_rejected");
  assert.deepEqual(monitor.claimCompletion({ evidenceRefs: ["controller:test"] }), {
    status: "completion_claimed",
    doneWhen: ["tests pass", "diff is clean"],
    evidenceRefs: ["controller:test"],
  });
  assert.equal(monitor.metrics().completionClaims, 2);
});
