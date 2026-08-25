import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefectStore, defectFingerprint } from "../src/defect-store.mjs";

function store() {
  const root = mkdtempSync(join(tmpdir(), "defects-"));
  return { store: new DefectStore({ root }), root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("defect capture is structured, redacted, immutable, and queryable", () => {
  const s = store();
  try {
    const first = s.store.capture({
      rootId: "root-1", taskId: "task-1", attemptId: "attempt-1", kind: "tool", origin: "child",
      tool: "read_file", phase: "tool_result", message: "token=super-secret tool failed", retryable: true,
      observedAt: 100, details: { code: "ENOENT", path: "relative.txt" },
      provenance: { leaseId: "lease-1" },
    });
    assert.equal(first.status, "open");
    assert.equal(first.message, "token=[REDACTED] tool failed");
    assert.equal(s.store.read(first.defectId).taskId, "task-1");
    assert.equal(s.store.list({ taskId: "task-1" }).length, 1);
    assert.equal(s.store.summary({ rootId: "root-1" }).open, 1);
    assert.equal(typeof defectFingerprint(first), "string");
    assert.equal(defectFingerprint(first).length, 64);

    const recordFile = s.store.list()[0];
    const recordPath = join(s.root, "records", `${createHash("sha256").update(recordFile.defectId).digest("hex")}.json`);
    const records = readFileSync(recordPath, "utf8");
    assert.match(records, /detailsCanonical/);
  } finally { s.done(); }
});

test("defect state transitions are monotonic and survive a new store instance", () => {
  const root = mkdtempSync(join(tmpdir(), "defect-restart-"));
  try {
    const firstStore = new DefectStore({ root });
    const defect = firstStore.capture({ taskId: "task-2", kind: "controller", origin: "controller", message: "ipc dispatch failed", observedAt: 10 });
    assert.equal(firstStore.transition(defect.defectId, "queued", { reason: "repair budget is not available", at: 20 }).status, "queued");
    assert.equal(firstStore.transition(defect.defectId, "triaged", { at: 30 }).status, "triaged");
    const secondStore = new DefectStore({ root });
    assert.equal(secondStore.read(defect.defectId).status, "triaged");
    assert.throws(() => secondStore.transition(defect.defectId, "open", { at: 40 }), /transition status is invalid/);
    assert.equal(secondStore.transition(defect.defectId, "resolved", { at: 50 }).status, "resolved");
    assert.throws(() => secondStore.transition(defect.defectId, "queued", { at: 60 }), /not allowed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defect input rejects unbounded or non-lossless details", () => {
  const s = store();
  try {
    assert.throws(() => s.store.capture({ message: "bad\nmessage" }), /message is invalid/);
    assert.throws(() => s.store.capture({ message: "bad", details: { value: Number.NaN } }), /finite/);
  } finally { s.done(); }
});
