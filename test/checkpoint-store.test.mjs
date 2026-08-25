import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CheckpointStore } from "../src/checkpoint-store.mjs";

function store() {
  const root = mkdtempSync(join(tmpdir(), "checkpoints-"));
  return { store: new CheckpointStore({ root }), done: () => rmSync(root, { recursive: true, force: true }) };
}

function publish(store, overrides = {}) {
  return store.publish({
    taskId: "task-1", rootId: "root-1", attemptId: "attempt-1", artifactKey: "findings",
    artifact: { cursor: 3, findings: ["first"] },
    provenance: { source: "lease_child", leaseId: "lease-1" }, publishedAt: 100,
    ...overrides,
  });
}

test("partial checkpoint publication is immutable and controller acceptance is explicit", () => {
  const s = store();
  try {
    const published = publish(s.store);
    assert.equal(published.status, "published");
    assert.equal(s.store.acceptedFor({ taskId: "task-1" }).length, 0);
    const accepted = s.store.accept(published.checkpointId, { authority: "controller:test", at: 110 });
    assert.equal(accepted.status, "accepted");
    assert.equal(s.store.acceptedFor({ taskId: "task-1", rootId: "root-1" })[0].artifact.findings[0], "first");
    assert.match(s.store.renderAccepted({ taskId: "task-1" }), /controller-accepted partial checkpoints/);
    assert.equal(s.store.read(published.checkpointId).artifact.findings[0], "first");
  } finally { s.done(); }
});

test("replacement prompt contains only accepted checkpoints", () => {
  const s = store();
  try {
    const rejected = publish(s.store, { artifactKey: "secret", artifact: { value: "do not reuse" }, attemptId: "attempt-1" });
    const accepted = publish(s.store, { artifactKey: "cursor", artifact: { line: 42 }, attemptId: "attempt-2", sequence: 2 });
    s.store.accept(accepted.checkpointId, { at: 120 });
    assert.equal(s.store.acceptedFor({ taskId: "task-1" }).map((item) => item.artifactKey).join(","), "cursor");
    const prompt = s.store.renderAccepted({ taskId: "task-1" });
    assert.match(prompt, /cursor/);
    assert.doesNotMatch(prompt, /do not reuse/);
    assert.equal(s.store.reject(rejected.checkpointId, { at: 130 }).status, "rejected");
  } finally { s.done(); }
});

test("conflicting partials are withheld from replacement until adjudicated", () => {
  const s = store();
  try {
    const first = publish(s.store, { artifact: { cursor: 1 }, attemptId: "attempt-1" });
    s.store.accept(first.checkpointId, { at: 110 });
    const second = publish(s.store, { artifact: { cursor: 2 }, attemptId: "attempt-2", publishedAt: 120, autoAccept: true });
    assert.equal(second.status, "conflicted");
    assert.equal(s.store.acceptedFor({ taskId: "task-1" }).length, 0);
    assert.equal(s.store.renderAccepted({ taskId: "task-1" }), "");
    assert.equal(s.store.accept(second.checkpointId, { at: 130 }).status, "conflicted", "conflict adjudication remains idempotent until an explicit resolution exists");
  } finally { s.done(); }
});

test("bounded lossless artifacts and terminal transitions fail closed", () => {
  const s = store();
  try {
    assert.throws(() => publish(s.store, { artifact: { value: Number.NaN } }), /finite/);
    const checkpoint = publish(s.store);
    assert.equal(s.store.supersede(checkpoint.checkpointId, "00000000-0000-4000-8000-000000000001", { at: 110 }).status, "superseded");
    assert.throws(() => s.store.accept(checkpoint.checkpointId, { at: 120 }), /cannot accept superseded/);
  } finally { s.done(); }
});
