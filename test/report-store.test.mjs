import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  claimReportWake, listReports, markReportRead, markReportWoken, pruneReports,
  readReport, unreadReports, writeReport,
} from "../src/report-store.mjs";

function store() {
  const root = mkdtempSync(join(tmpdir(), "reports-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const CLAIM_PROCESS = fileURLToPath(new URL("./fixtures/report-claim-process.mjs", import.meta.url));

function report(taskId, overrides = {}) {
  return { taskId, status: "completed", task: "answer the question", text: "four", startedAt: 100, completedAt: 200, ...overrides };
}

test("a written report round-trips and starts unread", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-a-1", {
      logicalId: "workflow-1/review", resourceId: "cursor/composer-2.5", provider: "cursor",
      modelId: "composer-2.5", effectiveThinking: "medium",
      usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 0, turns: 1 },
    }));
    const loaded = readReport(s.root, "delegate-a-1");
    assert.equal(loaded.text, "four");
    assert.equal(loaded.logicalId, "workflow-1/review");
    assert.equal(loaded.resourceId, "cursor/composer-2.5");
    assert.equal(loaded.effectiveThinking, "medium");
    assert.deepEqual(loaded.usage, { input: 12, output: 4, cacheRead: 3, cacheWrite: 0, turns: 1 });
    assert.equal(loaded.readAt, null);
    assert.equal(loaded.wakeClaimedAt, null);
    assert.equal(loaded.wakeAt, null);
    assert.deepEqual(unreadReports(s.root).map((r) => r.taskId), ["delegate-a-1"]);
  } finally { s.done(); }
});

test("create-once claim and lifecycle acknowledgement form a durable non-replayable wake outbox", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-wake-1"));
    const firstClaim = claimReportWake(s.root, "delegate-wake-1", 225);
    assert.equal(firstClaim?.wakeClaimedAt, 225);
    assert.equal(claimReportWake(s.root, "delegate-wake-1", 230), undefined, "one dispatcher owns the claim forever");
    assert.equal(markReportWoken(s.root, "delegate-wake-1", 250)?.wakeAt, 250);
    assert.equal(markReportWoken(s.root, "delegate-wake-1", 300)?.wakeAt, 250);
    assert.deepEqual(unreadReports(s.root).map((r) => r.taskId), ["delegate-wake-1"]);
  } finally { s.done(); }
});

test("durable sent marker prevents a stale JSON write from resurrecting wake delivery", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-sent-race"));
    assert.ok(claimReportWake(s.root, "delegate-sent-race", 225));
    const stale = readReport(s.root, "delegate-sent-race");
    assert.equal(markReportWoken(s.root, "delegate-sent-race", 250)?.wakeAt, 250);
    writeReport(s.root, { ...stale, wakeAt: null });
    assert.equal(readReport(s.root, "delegate-sent-race")?.wakeAt, 250);
    assert.equal(claimReportWake(s.root, "delegate-sent-race", 300), undefined);
  } finally { s.done(); }
});

test("a malformed sent marker still fails closed against a duplicate wake", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-sent-corrupt"));
    assert.ok(claimReportWake(s.root, "delegate-sent-corrupt", 225));
    assert.equal(markReportWoken(s.root, "delegate-sent-corrupt", 250)?.wakeAt, 250);
    const marker = join(s.root, "delegate-sent-corrupt.json.wake.sent");
    assert.ok(existsSync(marker));
    for (const corrupt of ["", "{", '{"wakeAt":"later"}', '{"wakeAt":-1}', '{"wakeAt":1}']) {
      writeFileSync(marker, corrupt, { mode: 0o600 });
      const wakeAt = readReport(s.root, "delegate-sent-corrupt")?.wakeAt;
      assert.ok(Number.isSafeInteger(wakeAt), `corrupt marker ${JSON.stringify(corrupt)} lost durable wake state`);
      assert.equal(claimReportWake(s.root, "delegate-sent-corrupt", 400), undefined);
    }
  } finally { s.done(); }
});

test("concurrent controller processes produce exactly one durable wake claim", async () => {
  const s = store();
  const children = [];
  try {
    writeReport(s.root, report("delegate-race-1", { text: "x".repeat(60_000) }));
    const barrier = join(s.root, "claim.start");
    const outputs = [];
    for (let index = 0; index < 12; index += 1) {
      const ready = join(s.root, `ready-${index}`);
      const child = spawn(process.execPath, [CLAIM_PROCESS, s.root, "delegate-race-1", barrier, ready], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push({ child, ready });
      outputs.push(new Promise((resolve, reject) => {
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`claimer ${code}: ${stderr}`)));
      }));
    }
    const readyDeadline = Date.now() + 5_000;
    while (!children.every(({ ready }) => existsSync(ready))) {
      if (Date.now() > readyDeadline) throw new Error("claim processes did not reach the barrier");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeFileSync(barrier, "go\n");
    const results = await Promise.all(outputs);
    assert.equal(results.filter((value) => value === "claimed").length, 1);
    assert.ok(Number.isSafeInteger(readReport(s.root, "delegate-race-1")?.wakeClaimedAt));
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill("SIGTERM");
    s.done();
  }
});

test("an arbitrarily old or dead-owner durable claim is never stale-reclaimed", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-orphan-claim-1"));
    const claimPath = join(s.root, "delegate-orphan-claim-1.json.wake.claim");
    const token = "orphan-owner-token-0000000000000000";
    writeFileSync(claimPath, `${JSON.stringify({ pid: 999_999, createdAt: 200, token })}\n`);
    assert.equal(claimReportWake(s.root, "delegate-orphan-claim-1", 999_999), undefined);
    assert.equal(readReport(s.root, "delegate-orphan-claim-1")?.wakeClaimedAt, 200);
    assert.equal(existsSync(claimPath), true, "no process may stale-reap an ambiguous claim");
  } finally { s.done(); }
});

test("durable read marker prevents a stale claimant write from resurrecting collection", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-a-1"));
    const stale = readReport(s.root, "delegate-a-1");
    const marked = markReportRead(s.root, "delegate-a-1", 500);
    assert.equal(marked.readAt, 500);
    writeReport(s.root, { ...stale, wakeClaimedAt: 550 });
    assert.deepEqual(unreadReports(s.root), []);
    assert.equal(readReport(s.root, "delegate-a-1")?.readAt, 500, "stale JSON cannot override the read marker");
    assert.equal(claimReportWake(s.root, "delegate-a-1", 600), undefined);
  } finally { s.done(); }
});

test("a collection that lands after claim remains monotonic and blocks every later claim", () => {
  const s = store();
  try {
    writeReport(s.root, report("delegate-claimed-then-read"));
    assert.ok(claimReportWake(s.root, "delegate-claimed-then-read", 225));
    assert.equal(markReportRead(s.root, "delegate-claimed-then-read", 250)?.readAt, 250);
    assert.equal(claimReportWake(s.root, "delegate-claimed-then-read", 300), undefined);
    assert.deepEqual(unreadReports(s.root), []);
  } finally { s.done(); }
});

test("pruning deletes only read reports past retention, never unread ones", () => {
  const s = store();
  try {
    const now = 10_000_000_000;
    const retention = 30 * 24 * 3600 * 1000;
    writeReport(s.root, report("old-read", { completedAt: 100 }));
    claimReportWake(s.root, "old-read", 200);
    const oldClaimPath = join(s.root, "old-read.json.wake.claim");
    markReportRead(s.root, "old-read", now - retention - 1000);
    writeReport(s.root, report("old-unread", { completedAt: 100 }));
    writeReport(s.root, report("fresh-read", { completedAt: 100 }));
    markReportRead(s.root, "fresh-read", now - 60_000);
    const pruned = pruneReports(s.root, now, retention);
    assert.equal(pruned, 1, "only the old read report is collected");
    assert.deepEqual(listReports(s.root).map((r) => r.taskId).sort(), ["fresh-read", "old-unread"]);
    assert.equal(existsSync(oldClaimPath), true, "pruning must never unlink a claim pathname");
  } finally { s.done(); }
});

test("legacy reports remain distinguishable until migration marks them woken", () => {
  const s = store();
  try {
    writeFileSync(join(s.root, "legacy-1.json"), `${JSON.stringify(report("legacy-1"))}\n`);
    assert.equal(readReport(s.root, "legacy-1")?.wakeAt, undefined);
    assert.equal(markReportWoken(s.root, "legacy-1", 250)?.wakeAt, 250);
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
    assert.throws(() => writeReport(s.root, report("ok", { wakeClaimedAt: 199 })), /wakeClaimedAt/);
    assert.throws(() => writeReport(s.root, report("ok", { wakeAt: 199 })), /wakeAt/);
    assert.throws(() => writeReport(s.root, report("ok", { logicalId: "x".repeat(321) })), /logicalId/);
    assert.throws(() => writeReport(s.root, report("ok", {
      usage: { input: 1, output: -1, cacheRead: 0, cacheWrite: 0, turns: 1 },
    })), /usage.output/);
    assert.throws(() => writeReport(s.root, report("ok", { requestedThinking: "x".repeat(41) })), /requestedThinking/);
    assert.throws(() => writeReport(s.root, report("ok", { role: "r".repeat(81) })), /role/);
    assert.equal(readReport(s.root, "../etc/passwd"), undefined);
  } finally { s.done(); }
});
