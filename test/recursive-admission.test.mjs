import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RecursiveAdmissionStore } from "../src/recursive-admission.mjs";

function request(rootId, parentTaskId, depth, task = "inspect", purpose = "specialist") {
  return { rootId, parentTaskId, depth, maxDepth: 2, task, objective: task, purpose };
}

test("recursive admission atomically enforces depth, direct-child, descendant and concurrency budgets", () => {
  const dir = mkdtempSync(join(tmpdir(), "recursive-admission-"));
  const store = new RecursiveAdmissionStore({ path: join(dir, "recursive.sqlite"), canaryEnabled: true });
  try {
    store.registerRoot({ rootId: "root", policy: { mode: "depth2_readonly_canary", maxDirectChildren: 1, maxDescendants: 1, maxParallel: 1, maxRedundant: 0 } });
    const first = store.admit({ rootId: "root", parentTaskId: "parent", parentDepth: 1, request: request("root", "parent", 2), idempotencyKey: "one" });
    assert.equal(first.status, "admitted");
    assert.equal(store.admit({ rootId: "root", parentTaskId: "other-parent", parentDepth: 1, request: request("root", "other-parent", 2, "inspect", "reviewer"), idempotencyKey: "two" }).status, "denied_duplicate");
    assert.equal(store.admit({ rootId: "root", parentTaskId: "parent", parentDepth: 1, request: request("root", "parent", 2), idempotencyKey: "one" }).status, "reused");
    store.settle(first.jobId, "completed");
    assert.equal(store.admit({ rootId: "root", parentTaskId: "parent", parentDepth: 1, request: request("root", "parent", 2, "inspect", "reviewer"), idempotencyKey: "two" }).status, "denied_duplicate");
    assert.equal(store.admit({ rootId: "root", parentTaskId: "parent", parentDepth: 2, request: request("root", "parent", 2, "too-deep"), idempotencyKey: "three" }).status, "denied_budget");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("production recursion yields when its descendant parallel budget is occupied", () => {
  const dir = mkdtempSync(join(tmpdir(), "recursive-capacity-"));
  const store = new RecursiveAdmissionStore({ path: join(dir, "recursive.sqlite") });
  try {
    store.registerRoot({ rootId: "root", policy: { mode: "production", maxDescendants: 2, maxParallel: 1, maxDirectChildren: 2 } });
    const first = store.admit({ rootId: "root", parentTaskId: "parent", parentDepth: 0, request: { rootId: "root", parentTaskId: "parent", depth: 1, maxDepth: 1, task: "one" }, idempotencyKey: "one" });
    assert.equal(first.status, "admitted");
    assert.equal(store.admit({ rootId: "root", parentTaskId: "other", parentDepth: 0, request: { rootId: "root", parentTaskId: "other", depth: 1, maxDepth: 1, task: "two", purpose: "reviewer" }, idempotencyKey: "two" }).status, "capacity_yield");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("recursive admission cancellation propagates only down the requested parent chain and restart requeues running jobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "recursive-cancel-"));
  let store = new RecursiveAdmissionStore({ path: join(dir, "recursive.sqlite"), canaryEnabled: true });
  try {
    store.registerRoot({ rootId: "root", policy: { mode: "depth2_readonly_canary", maxDescendants: 1, maxParallel: 1, maxRedundant: 0 } });
    const first = store.admit({ rootId: "root", parentTaskId: "parent", parentDepth: 1, request: request("root", "parent", 2, "one"), idempotencyKey: "one" });
    assert.equal(store.start(first.jobId).status, "started");
    store.close();
    store = new RecursiveAdmissionStore({ path: join(dir, "recursive.sqlite"), canaryEnabled: true });
    assert.equal(store.reconcile().count, 1);
    assert.equal(store.job(first.jobId).status, "admitted");
    assert.equal(store.cancelDescendants("root", "parent").count, 1);
    assert.equal(store.job(first.jobId).status, "cancelled");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
