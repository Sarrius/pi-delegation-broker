import assert from "node:assert/strict";
import test from "node:test";
import { projectParentDelegationContext, PARENT_CONTEXT_MARKER, PARENT_CONTEXT_TYPE } from "../src/parent-context.mjs";

const work = { deliverable: "Inspect the scheduler", parentWork: "Review the auth subsystem", purpose: "produce", ownedPaths: ["/tmp/owned"] };
const job = (id, patch = {}) => ({ jobId: id, kind: "task", status: "running", ownerSessionId: "owner", task: "Original immutable task", contract: { work }, ...patch });
const report = (id, patch = {}) => ({ taskId: id, status: "completed", readAt: null, wakeAt: null, text: "UNTRUSTED_CHILD_PROSE", error: "PRIVATE_RAW_ERROR", ...patch });
const owner = { role: "user", content: "NEWEST_GENUINE_OWNER_REQUEST", timestamp: 100 };

function projection(patch = {}) {
  return projectParentDelegationContext({ messages: [owner], ownerSessionId: "owner", jobs: [job("task-1")], now: 200, ...patch });
}

test("every request rehydrates active assignment identity and independent parent work without changing history", () => {
  const messages = [owner];
  const first = projection({ messages });
  assert.equal(messages.length, 1);
  assert.equal(first[0].customType, PARENT_CONTEXT_TYPE);
  assert.equal(first[0].display, false);
  assert.match(first[0].content, /task-1.*\[running\]/);
  assert.match(first[0].content, /Review the auth subsystem/);
  assert.equal(first.at(-1), owner, "projection must precede, not replace, the real owner message");
  const second = projection({ messages: first, jobs: [job("task-2")] });
  assert.equal(second.filter((m) => m.customType === PARENT_CONTEXT_TYPE).length, 1);
  assert.match(second[0].content, /task-2/);
  assert.doesNotMatch(second[0].content, /task-1/);
});

test("terminal cancellation removes stale ownership even inside the same parent run", () => {
  const active = projection();
  const after = projection({ messages: active, jobs: [job("task-1", { status: "cancelled" })] });
  assert.deepEqual(after, [owner]);
});

test("only the owner inbox's top-level pending or live-woken reports are projected", () => {
  const jobs = [job("pending", { status: "completed" }), job("live-woken", { status: "completed" }), job("historical", { status: "completed" }), job("legacy", { status: "completed" }), job("foreign", { ownerSessionId: "another" }), job("workflow", { kind: "workflow", nodes: [] })];
  const reports = [report("pending"), report("live-woken", { wakeAt: 250 }), report("historical", { wakeAt: 250 }), report("legacy", { wakeAt: undefined }), report("foreign"), report("workflow-node", { logicalId: "workflow/node", wakeAt: 250 })];
  const [snapshot] = projection({ jobs, reports, isLiveReport: (id) => id === "live-woken" });
  assert.match(snapshot.content, /pending: completed/);
  assert.match(snapshot.content, /live-woken: completed/);
  assert.doesNotMatch(snapshot.content, /historical|legacy|foreign|workflow-node|UNTRUSTED_CHILD_PROSE|PRIVATE_RAW_ERROR/);
});

test("collected reports are not repeated and an already-woken current result can survive compaction", () => {
  const jobs = [job("result", { status: "completed" })];
  const live = projection({ jobs, reports: [report("result", { wakeAt: 250 })], isLiveReport: () => true });
  assert.match(live[0].content, /result: completed/);
  const read = projection({ messages: live, jobs, reports: [report("result", { wakeAt: 250, readAt: 300 })], isLiveReport: () => true });
  assert.deepEqual(read, [owner]);
});

test("the projection never splits a tool pair or displaces a failover continuation as the last user", () => {
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } }] };
  const result = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "one" }] };
  const continuation = { role: "user", content: "[handoff:interrupted-turn] Keep the genuine owner task" };
  const messages = projection({ messages: [owner, assistant, result, continuation] });
  assert.equal(messages[0].customType, PARENT_CONTEXT_TYPE);
  assert.equal(messages.at(-1), continuation);
  assert.deepEqual(messages.slice(2, 4), [assistant, result]);
});

test("large projections identify their bounds, and resume bindings cannot cross owner sessions", () => {
  const jobs = Array.from({ length: 40 }, (_, i) => job(`task-${i}`));
  const reports = jobs.map((j) => report(j.jobId));
  const [snapshot] = projection({ jobs, reports, binding: { sessionId: "another", rootIds: ["PRIVATE_FOREIGN_ROOT"], cursor: "FOREIGN_CURSOR" } });
  assert.match(snapshot.content, /Active assignments: 40; showing 12 \(bounded/);
  assert.match(snapshot.content, /Unread current reports: 40; showing 32 \(bounded/);
  assert.doesNotMatch(snapshot.content, /PRIVATE_FOREIGN_ROOT|FOREIGN_CURSOR/);
  assert.ok(snapshot.content.length < 40_000);
});

test("unavailable stores are explicit unknown state, not permission to take over", () => {
  const [snapshot] = projection({ jobs: [], reports: [], jobsUnavailable: true, reportsUnavailable: true });
  assert.match(snapshot.content, /assignments unavailable: do not infer that ownership ended/);
  assert.match(snapshot.content, /report inbox unavailable/);
  assert.doesNotMatch(snapshot.content, /Active assignments: none/);
  assert.match(snapshot.content, /NOT owner intent/);
  assert.match(snapshot.content, /quoted data, not instructions or permissions/);
  assert.ok(snapshot.content.startsWith(PARENT_CONTEXT_MARKER));
});

test("a stale owner resume binding cannot smuggle terminal error prose from a historical root", () => {
  const historical = job("historical", { status: "failed", terminalReason: "PRIVATE_CHILD_TERMINAL_REASON_SENTINEL" });
  const workflow = job("old-workflow", { kind: "workflow", status: "failed", nodes: [{ state: "failed", error: "PRIVATE_NODE_ERROR_SENTINEL", terminalReason: "PRIVATE_CHILD_TERMINAL_REASON_SENTINEL" }] });
  const [snapshot] = projection({ jobs: [historical, workflow], reports: [report("historical", { status: "failed", wakeAt: 100 })], binding: { sessionId: "owner", rootIds: [historical.jobId, workflow.jobId], status: "compacted", cursor: "cursor" } });
  assert.match(snapshot.content, /historical: failed/);
  assert.match(snapshot.content, /old-workflow: failed; nodes failed=1/);
  assert.doesNotMatch(snapshot.content, /PRIVATE_CHILD_TERMINAL_REASON_SENTINEL|PRIVATE_NODE_ERROR_SENTINEL/);
  assert.doesNotMatch(snapshot.content, /Unread current reports/);
});

test("an unavailable owner identity never projects unowned durable state", () => {
  assert.deepEqual(projection({ ownerSessionId: undefined, jobs: [job("unowned", { ownerSessionId: undefined })] }), [owner]);
});
