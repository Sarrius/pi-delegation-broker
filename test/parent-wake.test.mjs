import assert from "node:assert/strict";
import test from "node:test";

import {
  ParentWakeCoordinator, PARENT_WAKE_SYSTEM_RULE, createParentWakeMessage,
  formatParentWake, initialReportWakeAt, isParentWakePrompt,
} from "../src/parent-wake.mjs";

function report(taskId, overrides = {}) {
  return { taskId, status: "completed", readAt: null, wakeClaimedAt: null, wakeAt: null, ...overrides };
}

test("only top-level reports start unwoken; workflow-node reports are pre-marked", () => {
  assert.equal(initialReportWakeAt(true, 200), null);
  assert.equal(initialReportWakeAt(false, 200), 200);
  assert.throws(() => initialReportWakeAt(undefined, 200), /explicit/);
});

test("parent wake is typed custom state with explicit system framing for Pi's user-role conversion", () => {
  const wake = createParentWakeMessage([report("workflow-a-1"), report("delegate-b-2", { status: "failed" })]);
  assert.equal(wake.message.customType, "delegation-broker-wake");
  assert.equal(wake.message.display, false);
  assert.match(wake.message.content, /NOT a user request/);
  assert.match(wake.message.content, /stale or unrelated report must never replace newer owner intent/i);
  assert.match(wake.message.content, /do not merely announce readiness or stop/i);
  assert.deepEqual(wake.options, { deliverAs: "followUp", triggerTurn: true });
  assert.deepEqual(wake.message.details.reports, [
    { taskId: "workflow-a-1", status: "completed" },
    { taskId: "delegate-b-2", status: "failed" },
  ]);
  assert.doesNotMatch(formatParentWake([report("workflow-a-1")]), /sendUserMessage/);
  assert.equal(isParentWakePrompt(wake.message.content), true);
  assert.match(PARENT_WAKE_SYSTEM_RULE, /Pi serializes in user role/);
  assert.match(PARENT_WAKE_SYSTEM_RULE, /not owner intent/);
  assert.match(PARENT_WAKE_SYSTEM_RULE, /newer genuine owner instructions/);
});

test("coordinator coalesces a terminal burst and dispatches each report once", async () => {
  const sent = [];
  const marked = [];
  let scheduled;
  const coordinator = new ParentWakeCoordinator({
    sendMessage(message, options) { sent.push({ message, options }); },
    claimWake(taskId) {
      return report(taskId, {
        status: taskId === "delegate-b-2" ? "failed" : "completed",
        wakeClaimedAt: 200,
      });
    },
    markWoken(taskId) { marked.push(taskId); },
    setTimer(callback) { scheduled = callback; return 1; },
    clearTimer() {},
  });
  assert.equal(coordinator.enqueue(report("delegate-a-1")), true);
  assert.equal(coordinator.enqueue(report("delegate-a-1")), false);
  assert.equal(coordinator.enqueue(report("delegate-b-2", { status: "failed" })), true);
  assert.equal(typeof scheduled, "function");
  assert.equal(await coordinator.flush(), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(marked, [], "enqueue acceptance must not imply that Pi consumed the wake");
  assert.equal(await coordinator.acknowledge(["delegate-a-1", "delegate-b-2"]), true);
  assert.deepEqual(marked, ["delegate-a-1", "delegate-b-2"]);
  assert.equal(sent[0].options.triggerTurn, true);
  assert.match(sent[0].message.content, /delegate-a-1/);
  assert.match(sent[0].message.content, /delegate-b-2/);
  assert.equal(coordinator.enqueue(report("delegate-a-1")), false);
});

test("a report collected before the coalescing timer fires does not wake the parent", async () => {
  let sent = 0;
  const coordinator = new ParentWakeCoordinator({
    sendMessage() { sent += 1; },
    claimWake() { throw new Error("collected report must not be claimed"); },
    markWoken() {},
    loadReport(taskId) { return report(taskId, { readAt: 250 }); },
    setTimer() { return 1; },
    clearTimer() {},
  });
  assert.equal(coordinator.enqueue(report("delegate-collected-1")), true);
  assert.equal(await coordinator.flush(), false);
  assert.equal(sent, 0);
});

test("a queued owner message defers the durable wake until the host starts a safe turn", async () => {
  let canDispatch = false;
  let claimed = 0;
  let sent = 0;
  let marked = 0;
  const coordinator = new ParentWakeCoordinator({
    canDispatch: () => canDispatch,
    sendMessage() { sent += 1; },
    claimWake(taskId) { claimed += 1; return report(taskId, { wakeClaimedAt: 200 }); },
    markWoken() { marked += 1; },
    setTimer() { return 1; },
    clearTimer() {},
  });

  assert.equal(coordinator.enqueue(report("delegate-queued-owner-1")), true);
  assert.equal(await coordinator.flush(), false);
  assert.deepEqual({ claimed, sent, marked }, { claimed: 0, sent: 0, marked: 0 });

  canDispatch = true;
  assert.equal(await coordinator.notifyReady(), true);
  assert.deepEqual({ claimed, sent, marked }, { claimed: 1, sent: 1, marked: 0 });
  assert.equal(await coordinator.acknowledge(["delegate-queued-owner-1"]), true);
  assert.deepEqual({ claimed, sent, marked }, { claimed: 1, sent: 1, marked: 1 });
});

test("synchronous dispatch failure retains the create-once claim and uses fallback", async () => {
  const failures = [];
  let attempts = 0;
  const coordinator = new ParentWakeCoordinator({
    sendMessage() { attempts += 1; throw new Error("host unavailable"); },
    claimWake(taskId) { return report(taskId, { wakeClaimedAt: 200 }); },
    markWoken() { throw new Error("must not mark a wake that was not queued"); },
    onFailure(reports, error, phase) {
      failures.push({ ids: reports.map((item) => item.taskId), error: error.message, phase });
    },
    setTimer() { return 1; },
    clearTimer() {},
  });
  assert.equal(coordinator.enqueue(report("delegate-retry-1")), true);
  assert.equal(await coordinator.flush(), false);
  assert.equal(attempts, 1);
  assert.deepEqual(failures, [{ ids: ["delegate-retry-1"], error: "host unavailable", phase: "send_sync" }]);
  assert.equal(coordinator.enqueue(report("delegate-retry-1")), false, "create-once claim must never auto-replay");
});

test("asynchronous send rejection keeps the ambiguous claim and never auto-replays", async () => {
  const phases = [];
  const coordinator = new ParentWakeCoordinator({
    sendMessage() { return Promise.reject(new Error("async host rejection")); },
    claimWake(taskId) { return report(taskId, { wakeClaimedAt: 200 }); },
    markWoken() { throw new Error("must not mark rejected send"); },
    onFailure(_reports, _error, phase) { phases.push(phase); },
    setTimer() { return 1; },
    clearTimer() {},
  });
  assert.equal(coordinator.enqueue(report("delegate-ambiguous-send-1")), true);
  assert.equal(await coordinator.flush(), false);
  assert.deepEqual(phases, ["send_async"]);
  assert.equal(coordinator.enqueue(report("delegate-ambiguous-send-1")), false);
});

test("post-send mark failure keeps live dedup and never releases the ambiguous durable claim", async () => {
  const phases = [];
  const coordinator = new ParentWakeCoordinator({
    sendMessage() {},
    claimWake(taskId) { return report(taskId, { wakeClaimedAt: 200 }); },
    markWoken() { throw new Error("disk unavailable after send"); },
    onFailure(_reports, _error, phase) { phases.push(phase); },
    setTimer() { return 1; },
    clearTimer() {},
  });
  assert.equal(coordinator.enqueue(report("delegate-ambiguous-1")), true);
  assert.equal(await coordinator.flush(), true, "the custom wake was already accepted");
  assert.deepEqual(phases, [], "the report is not marked until Pi starts the custom message");
  assert.equal(await coordinator.acknowledge(["delegate-ambiguous-1"]), false, "the failing acknowledgement must not be reported as durable");
  assert.deepEqual(phases, ["ack"]);
  assert.equal(coordinator.enqueue(report("delegate-ambiguous-1")), false);
});

test("read, claimed, already-woken, legacy and malformed reports never trigger a wake", () => {
  const coordinator = new ParentWakeCoordinator({
    sendMessage() { throw new Error("must not dispatch"); },
    claimWake() { throw new Error("must not claim"); },
    markWoken() {},
    setTimer() { throw new Error("must not schedule"); },
    clearTimer() {},
  });
  assert.equal(coordinator.enqueue(report("read-1", { readAt: 10 })), false);
  assert.equal(coordinator.enqueue(report("claimed-1", { wakeClaimedAt: 10 })), false);
  assert.equal(coordinator.enqueue(report("woken-1", { wakeAt: 10 })), false);
  assert.equal(coordinator.enqueue({ taskId: "legacy-1", status: "completed", readAt: null }), false);
  assert.equal(coordinator.enqueue({ taskId: "../bad", status: "completed", readAt: null, wakeAt: null }), false);
});
