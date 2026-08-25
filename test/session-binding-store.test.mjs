import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionBindingStore, formatSessionResumeStatus, sessionCursor, sessionIdentity } from "../src/session-binding-store.mjs";

function store() {
  const root = mkdtempSync(join(tmpdir(), "session-bindings-"));
  return { store: new SessionBindingStore({ root }), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("session binding persists roots and compaction cursor across a new store instance", () => {
  const root = mkdtempSync(join(tmpdir(), "session-binding-restart-"));
  try {
    const first = new SessionBindingStore({ root });
    first.bind({ sessionId: "session-1", sessionFile: "/tmp/session.jsonl", rootIds: ["root-a", "root-b"], cursor: "entry-1", at: 100 });
    first.update("session-1", { status: "compacted", cursor: "compaction-1", updatedAt: 200 });
    const second = new SessionBindingStore({ root });
    const binding = second.read("session-1");
    assert.deepEqual(binding.rootIds, ["root-a", "root-b"]);
    assert.equal(binding.cursor, "compaction-1");
    assert.equal(binding.status, "compacted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resume status is controller-only, bounded, and includes workflow node state", () => {
  const s = store();
  try {
    const binding = s.store.bind({ sessionId: "session-2", rootIds: ["task-a", "workflow-a"], cursor: "entry-2", at: 100 });
    const status = formatSessionResumeStatus(binding, [
      { jobId: "task-a", kind: "task", status: "queued" },
      { jobId: "workflow-a", kind: "workflow", status: "running", nodes: [{ state: "completed" }, { state: "pending" }] },
    ]);
    assert.match(status, /task-a: queued/);
    assert.match(status, /workflow-a: running; nodes completed=1, pending=1/);
    assert.doesNotMatch(status, /untrusted child report|child narrative/);
  } finally { s.done(); }
});

test("session identity and cursor use SessionManager APIs with safe fallbacks", () => {
  const ctx = { cwd: "/tmp/project", sessionManager: { getSessionId: () => "uuid-1", getLeafId: () => "entry-9" } };
  assert.equal(sessionIdentity(ctx), "uuid-1");
  assert.equal(sessionCursor(ctx), "entry-9");
  assert.match(sessionIdentity({ cwd: "/tmp/project", sessionManager: { getSessionFile: () => "/tmp/a.jsonl" } }), /^file:/);
  assert.match(sessionIdentity({ cwd: "/tmp/project" }), /^ephemeral:/);
});
