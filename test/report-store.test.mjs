import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listReports, markReportRead, pruneReports, readReport, unreadReports, writeReport,
} from "../src/report-store.mjs";

function store() {
  const root = mkdtempSync(join(tmpdir(), "reports-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function report(taskId, overrides = {}) {
  return { taskId, status: "completed", task: "answer the question", text: "four", startedAt: 100, completedAt: 200, ...overrides };
}

test("a written report round-trips and starts unread", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-a-1"));
    const loaded = readReport(s.root, "delegate-a-1");
    assert.equal(loaded.text, "four");
    assert.equal(loaded.readAt, null);
    assert.deepEqual(unreadReports(s.root).map((r) => r.taskId), ["delegate-a-1"]);
  } finally { s.done(); }
});

test("marking read removes the report from the unread list without deleting it", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-a-1"));
    const marked = markReportRead(s.root, "delegate-a-1", 500);
    assert.equal(marked.readAt, 500);
    assert.deepEqual(unreadReports(s.root), []);
    assert.equal(readReport(s.root, "delegate-a-1")?.readAt, 500, "the report stays on disk");
  } finally { s.done(); }
});

test("pruning deletes only read reports past retention, never unread ones", () => {
  const s = store();
  try {
    const now = 10_000_000_000;
    const retention = 30 * 24 * 3600 * 1000;
    writeReport(s.root, report("old-read", { completedAt: 100 }));
    markReportRead(s.root, "old-read", now - retention - 1000);
    writeReport(s.root, report("old-unread", { completedAt: 100 }));
    writeReport(s.root, report("fresh-read", { completedAt: 100 }));
    markReportRead(s.root, "fresh-read", now - 60_000);
    const pruned = pruneReports(s.root, now, retention);
    assert.equal(pruned, 1, "only the old read report is collected");
    assert.deepEqual(listReports(s.root).map((r) => r.taskId).sort(), ["fresh-read", "old-unread"]);
  } finally { s.done(); }
});

test("a malformed file is skipped by listing instead of crashing the inbox", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-a-1"));
    writeFileSync(join(s.root, "corrupt.json"), "{not json");
    assert.deepEqual(listReports(s.root).map((r) => r.taskId), ["delegate-a-1"]);
    assert.equal(readReport(s.root, "corrupt"), undefined);
  } finally { s.done(); }
});

test("path traversal and invalid shapes are rejected at write time", () => {
  const s = store();
  try {
    assert.throws(() => writeReport(s.root, report("../escape")), /bounded task id/);
    assert.throws(() => writeReport(s.root, report("ok", { status: "running" })), /status/);
    assert.throws(() => writeReport(s.root, report("ok", { completedAt: 99 })), /timestamps/);
    assert.equal(readReport(s.root, "../etc/passwd"), undefined);
  } finally { s.done(); }
});
