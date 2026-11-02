import assert from "node:assert/strict";
import test from "node:test";
import { ParentWakeCoordinator } from "../src/parent-wake.mjs";

function terminal(taskId, patch = {}) {
  return { taskId, status: "completed", readAt: null, wakeClaimedAt: null, wakeAt: null, ...patch };
}

function fixture() {
  const timers = new Map();
  const reports = new Map();
  const claims = [], sent = [], marked = [];
  let idle = false, queuedOwner = false;
  const coordinator = new ParentWakeCoordinator({
    canDispatch: () => idle && !queuedOwner,
    claimWake(taskId) {
      claims.push(taskId);
      const report = terminal(taskId, { wakeClaimedAt: 200 });
      reports.set(taskId, report);
      return report;
    },
    loadReport: (taskId) => reports.get(taskId),
    sendMessage(message) { sent.push(message); },
    markWoken(taskId) { marked.push(taskId); },
    setTimer(callback, delay) {
      const handle = { callback, delay, unreferenced: false, unref() { this.unreferenced = true; } };
      timers.set(handle, handle);
      return handle;
    },
    clearTimer(handle) { timers.delete(handle); },
  });
  return {
    coordinator, timers, reports, claims, sent, marked,
    idle(value) { idle = value; },
    queuedOwner(value) { queuedOwner = value; },
    enqueue(taskId) { reports.set(taskId, terminal(taskId)); coordinator.enqueue(reports.get(taskId)); },
    async tick() {
      assert.equal(timers.size, 1, "exactly one local readiness/coalescing timer may be armed");
      const [handle] = timers.values();
      timers.delete(handle);
      handle.callback();
      await new Promise(setImmediate);
    },
  };
}

test("a report deferred during standalone compaction wakes after real idle without another lifecycle event", async () => {
  const f = fixture();
  f.enqueue("manual-compact-result");
  await f.tick();
  assert.deepEqual(f.claims, []);
  assert.deepEqual(f.sent, []);
  assert.equal(f.timers.size, 1, "the lost manual-compaction wake needs an independent idle retry");
  assert.equal([...f.timers.values()][0].unreferenced, true, "readiness waiting must not keep a dead host alive");
  f.idle(true);
  await f.tick();
  assert.deepEqual(f.claims, ["manual-compact-result"]);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.marked, [], "enqueue is not acknowledgement");
  await f.coordinator.acknowledge(["manual-compact-result"]);
  assert.deepEqual(f.marked, ["manual-compact-result"]);
  assert.equal(f.timers.size, 0);
});

test("slow successful, failed and aborted compaction all preserve unclaimed reports while the host remains busy", async () => {
  for (const outcome of ["success", "failure", "abort"]) {
    const f = fixture();
    f.enqueue(`compact-${outcome}`);
    for (let i = 0; i < 20; i++) {
      await f.tick();
      assert.equal(f.claims.length, 0);
      assert.equal(f.sent.length, 0);
      assert.equal(f.timers.size, 1);
    }
    f.idle(true);
    await f.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.timers.size, 0);
    f.coordinator.close();
  }
});

test("newer queued owner intent wins even when the host briefly reports idle", async () => {
  const f = fixture();
  f.enqueue("owner-queue-result");
  f.idle(true);
  f.queuedOwner(true);
  await f.tick();
  assert.equal(f.claims.length, 0);
  f.idle(false); // owner preflight/active run
  f.queuedOwner(false);
  await f.tick();
  assert.equal(f.claims.length, 0);
  f.idle(true);
  assert.equal(await f.coordinator.notifyReady(), true, "agent_settled remains the fast path");
  assert.equal(f.sent.length, 1);
  assert.equal(f.timers.size, 0);
});

test("collecting the report during compaction retires its pending wake without dispatch", async () => {
  const f = fixture();
  f.enqueue("already-collected");
  await f.tick();
  f.reports.set("already-collected", terminal("already-collected", { readAt: 250 }));
  f.idle(true);
  await f.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.claims.length, 0);
  assert.equal(f.timers.size, 0);
});

test("shutdown/session replacement cancels the idle retry and a late timer cannot dispatch", async () => {
  const f = fixture();
  f.enqueue("old-session-result");
  await f.tick();
  const [lateTimer] = f.timers.values();
  f.coordinator.close();
  f.idle(true);
  lateTimer.callback();
  await new Promise(setImmediate);
  assert.equal(f.sent.length, 0);
  assert.equal(f.claims.length, 0);
  assert.equal(f.timers.size, 0);
});

test("reports arriving during an asynchronous flush are scheduled after it settles, not lost to an already-fired timer", async () => {
  const timers = new Map(), sent = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const c = new ParentWakeCoordinator({
    claimWake: (id) => terminal(id, { wakeClaimedAt: 200 }),
    sendMessage(message) { sent.push(message); return sent.length === 1 ? gate : undefined; },
    markWoken() {},
    setTimer(callback) { const handle = { callback }; timers.set(handle, handle); return handle; },
    clearTimer(handle) { timers.delete(handle); },
  });
  c.enqueue(terminal("first-result"));
  const flushing = c.flush();
  c.enqueue(terminal("second-result"));
  // Exercise the stale scheduled callback if an implementation arms one while flushing.
  for (const handle of timers.values()) { timers.delete(handle); handle.callback(); }
  release();
  await flushing;
  assert.equal(timers.size, 1, "the second report must remain scheduled after the first send resolves");
  const [handle] = timers.values();
  timers.delete(handle); handle.callback();
  await new Promise(setImmediate);
  assert.equal(sent.length, 2);
  assert.equal(timers.size, 0);
  c.close();
});

test("closing an old incarnation during an asynchronous claim cannot send a new parent turn", async () => {
  let release, sent = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const c = new ParentWakeCoordinator({
    claimWake: async (id) => { await gate; return terminal(id, { wakeClaimedAt: 200 }); },
    sendMessage() { sent++; }, markWoken() {},
    setTimer() { return 1; }, clearTimer() {},
  });
  c.enqueue(terminal("old-incarnation"));
  const flushing = c.flush();
  c.close(); release();
  await flushing;
  assert.equal(sent, 0);
});
