import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isTerminalJobStatus, listJobs, readJob, recoverJobs, requestJobCancellation, submitJob, updateJob,
} from "../src/delegation-job-store.mjs";

function store() {
  const root = mkdtempSync(join(tmpdir(), "delegation-jobs-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function task(jobId = "delegate-a", overrides = {}) {
  return {
    schemaVersion: 1,
    jobId,
    kind: "task",
    status: "submitted",
    task: "read a file",
    cwd: "/tmp/project",
    submittedAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function workflow(jobId = "workflow-a", overrides = {}) {
  return {
    schemaVersion: 1,
    jobId,
    kind: "workflow",
    status: "queued",
    cwd: "/tmp/project",
    concurrency: 2,
    nodes: [{ id: "a", task: "inspect", dependsOn: [], inputs: [], state: "pending" }],
    submittedAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

test("submission is durable and an idempotency key returns the original job", () => {
  const s = store();
  try {
    const first = submitJob(s.root, task("delegate-a", { idempotencyKey: "tool-call-1" }));
    const replay = submitJob(s.root, task("delegate-b", { idempotencyKey: "tool-call-1" }));
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.job.jobId, "delegate-a");
    assert.equal(readJob(s.root, "delegate-a")?.status, "submitted");
    assert.deepEqual(listJobs(s.root).map((job) => job.jobId), ["delegate-a"]);
  } finally { s.done(); }
});

test("updates preserve immutable identity and terminal timestamps", () => {
  const s = store();
  try {
    submitJob(s.root, task());
    const completed = updateJob(s.root, "delegate-a", (job) => ({ ...job, status: "completed", completedAt: 300 }), 300);
    assert.equal(completed.status, "completed");
    assert.equal(isTerminalJobStatus(completed.status), true);
    assert.throws(() => updateJob(s.root, "delegate-a", (job) => ({ ...job, jobId: "other" }), 400), /immutable identity/);
  } finally { s.done(); }
});

test("cancellation is requested durably and recovery settles it", () => {
  const s = store();
  try {
    submitJob(s.root, workflow());
    const requested = requestJobCancellation(s.root, "workflow-a", 200);
    assert.equal(requested.status, "cancellation_requested");
    const recovered = recoverJobs(s.root, 300);
    assert.equal(recovered[0].status, "cancelled");
    assert.equal(recovered[0].completedAt, 300);
  } finally { s.done(); }
});

test("restart recovery requeues read-only work and resets running nodes", () => {
  const s = store();
  try {
    submitJob(s.root, workflow("workflow-a", {
      status: "running",
      startedAt: 120,
      nodes: [
        { id: "a", task: "inspect", dependsOn: [], inputs: [], state: "running" },
        { id: "b", task: "summarize", dependsOn: ["a"], inputs: ["a"], state: "pending" },
      ],
    }));
    const [recovered] = recoverJobs(s.root, 250);
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.recoveryCount, 1);
    assert.equal(recovered.nodes[0].state, "pending");
    assert.equal(recovered.nodes[1].state, "pending");
  } finally { s.done(); }
});

test("invalid terminal and deadline shapes fail closed", () => {
  const s = store();
  try {
    assert.throws(() => submitJob(s.root, task("bad", { status: "completed" })), /completedAt/);
    assert.throws(() => submitJob(s.root, task("bad", { deadlineAt: 100 })), /deadlineAt/);
    assert.equal(readJob(s.root, "../escape"), undefined);
  } finally { s.done(); }
});
