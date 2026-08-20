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

test("behavior hashes one detached snapshot rather than caller-owned mutable arguments", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["inspect"] });
  const args = { options: { path: "/repo/a", force: false } };
  monitor.declareAction({ stepId: "mutable", toolName: "read", args });
  args.options.path = "/repo/b";

  const changed = monitor.authorizeAction({ stepId: "mutable", toolName: "read", args });
  assert.equal(changed.status, "reasoning_action_mismatch");
  assert.equal(changed.block, true);
});

test("lossless behavior ingress rejects values JSON would erase or normalize", () => {
  const rejected = [
    -0,
    Number.NaN,
    new Date(0),
    new Map([["command", "npm test"]]),
    Object.assign(["npm test"], { extra: true }),
    new Array(1),
  ];
  for (const [index, args] of rejected.entries()) {
    const monitor = new BehavioralRunMonitor({ doneWhen: ["inspect"] });
    assert.throws(
      () => monitor.declareAction({ stepId: `invalid-${index}`, toolName: "bash", args }),
      /lossless JSON/,
    );
  }

  const cyclic = {};
  cyclic.self = cyclic;
  const monitor = new BehavioralRunMonitor({ doneWhen: ["inspect"] });
  assert.throws(() => monitor.declareAction({ stepId: "cycle", toolName: "bash", args: cyclic }), /cycles/);
});

test("lossless behavior ingress never invokes accessors", () => {
  let reads = 0;
  const args = Object.defineProperty({}, "command", {
    enumerable: true,
    get() {
      reads += 1;
      return "npm test";
    },
  });
  const monitor = new BehavioralRunMonitor({ doneWhen: ["inspect"] });
  assert.throws(() => monitor.declareAction({ stepId: "getter", toolName: "bash", args }), /accessors/);
  assert.equal(reads, 0);
});

test("canonical behavior hashing is independent of object key insertion order", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["inspect"] });
  monitor.declareAction({
    stepId: "ordered",
    toolName: "bash",
    args: { command: "npm test", options: { quiet: true, color: false } },
  });
  const verdict = monitor.authorizeAction({
    stepId: "ordered",
    toolName: "bash",
    args: { options: { color: false, quiet: true }, command: "npm test" },
  });
  assert.equal(verdict.status, "allowed");
});

test("args declared as a JSON string match the object form at invocation", () => {
  const monitor = new BehavioralRunMonitor({ doneWhen: ["inspect"] });
  monitor.declareAction({
    stepId: "stringified",
    toolName: "read",
    args: '{"path":"/tmp/x","limit":5}',
  });
  const verdict = monitor.authorizeAction({
    stepId: "stringified",
    toolName: "read",
    args: { path: "/tmp/x", limit: 5 },
  });
  assert.equal(verdict.status, "allowed");
});
