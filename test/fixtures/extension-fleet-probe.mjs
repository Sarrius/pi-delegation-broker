import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { terminalWidth } from "../../src/fleet-view.mjs";

const extensionPath = process.env.BROKER_EXTENSION_PATH;
if (!extensionPath) throw new Error("BROKER_EXTENSION_PATH is required");
const agent = join(process.env.HOME, ".pi", "agent");
const state = join(agent, "delegation-broker");
const jobs = join(state, "jobs");
const reports = join(state, "reports");
mkdirSync(jobs, { recursive: true, mode: 0o700 });
mkdirSync(reports, { recursive: true, mode: 0o700 });
for (const [name, value] of Object.entries({
  "auth.json": {}, "settings.json": { packages: [] }, "models-store.json": {}, "models.json": { providers: {} },
})) writeFileSync(join(agent, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
writeFileSync(join(state, "enabled.json"), `${JSON.stringify({ enabled: false })}\n`, { mode: 0o600 });

const now = Date.now();
writeFileSync(join(jobs, "queued-task.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "queued-task", kind: "task", status: "queued",
  task: "SENSITIVE_CHILD_PROMPT_MUST_NOT_RENDER", cwd: process.cwd(), submittedAt: now - 1000, updatedAt: now - 1000,
})}\n`, { mode: 0o600 });
writeFileSync(join(jobs, "done-task.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "done-task", kind: "task", status: "completed",
  task: "SENSITIVE_TERMINAL_PROMPT_MUST_NOT_RENDER", cwd: process.cwd(), submittedAt: now - 5000,
  startedAt: now - 4000, completedAt: now - 2000, updatedAt: now - 2000,
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "done-task.json"), `${JSON.stringify({
  taskId: "done-task", logicalId: "done-task", status: "completed", task: "SENSITIVE_TERMINAL_PROMPT_MUST_NOT_RENDER",
  text: "SENSITIVE_CHILD_REPORT_MUST_NOT_RENDER", route: "completed cursor/composer-2.5",
  resourceId: "cursor/composer-2.5", provider: "cursor", modelId: "composer-2.5", effectiveThinking: "medium",
  usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 0, turns: 1 },
  startedAt: now - 4000, completedAt: now - 2000, readAt: null, wakeClaimedAt: null, wakeAt: now - 2000,
})}\n`, { mode: 0o600 });
// Crash windows: reports reached durability, but their task/node projection did not.
writeFileSync(join(jobs, "orphan-task.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "orphan-task", kind: "task", status: "running", task: "orphan",
  cwd: process.cwd(), submittedAt: now - 5000, startedAt: now - 4500, updatedAt: now - 4500,
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "orphan-task.json"), `${JSON.stringify({
  taskId: "orphan-task", logicalId: "orphan-task", status: "completed", task: "orphan", text: "accepted",
  startedAt: now - 4500, completedAt: now - 2500, readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });
writeFileSync(join(jobs, "cancelled-orphan.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "cancelled-orphan", kind: "task", status: "cancellation_requested", task: "cancelled",
  cwd: process.cwd(), submittedAt: now - 5000, startedAt: now - 4500, cancelRequestedAt: now - 3000, updatedAt: now - 3000,
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "cancelled-orphan.json"), `${JSON.stringify({
  taskId: "cancelled-orphan", logicalId: "cancelled-orphan", status: "completed", task: "cancelled", text: "accepted",
  startedAt: now - 4500, completedAt: now - 2500, readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });
writeFileSync(join(jobs, "orphan-workflow.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "orphan-workflow", kind: "workflow", status: "running", cwd: process.cwd(),
  concurrency: 1, submittedAt: now - 5000, startedAt: now - 4500, updatedAt: now - 4500,
  nodes: [{ id: "research", task: "research", dependsOn: [], inputs: [], state: "running" }],
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "orphan-workflow-research.json"), `${JSON.stringify({
  taskId: "orphan-workflow-research", logicalId: "orphan-workflow/research", status: "completed",
  task: "research", text: "accepted", startedAt: now - 4500, completedAt: now - 2500,
  readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });

// Pre-upgrade node reports had no logicalId and were keyed by the launch child id.
writeFileSync(join(jobs, "legacy-workflow.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "legacy-workflow", kind: "workflow", status: "running", cwd: process.cwd(),
  concurrency: 1, submittedAt: now - 5000, startedAt: now - 4500, updatedAt: now - 4500,
  nodes: [{ id: "research", task: "research", dependsOn: [], inputs: [], state: "running" }],
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "legacy-workflow-research.json"), `${JSON.stringify({
  taskId: "legacy-workflow-research", status: "completed",
  task: "research", text: "accepted", startedAt: now - 4500, completedAt: now - 2500,
  readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });
// A pre-upgrade node WITH dependency inputs stored the composed prompt, not the bare task.
writeFileSync(join(jobs, "legacy-composed-workflow.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "legacy-composed-workflow", kind: "workflow", status: "running", cwd: process.cwd(),
  concurrency: 1, submittedAt: now - 5000, startedAt: now - 4500, updatedAt: now - 4500,
  nodes: [
    { id: "first", task: "first stage", dependsOn: [], inputs: [], state: "completed", result: { status: "completed", reportTaskId: "legacy-composed-workflow-first" } },
    { id: "second", task: "second stage", dependsOn: ["first"], inputs: [], state: "running" },
  ],
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "legacy-composed-workflow-second.json"), `${JSON.stringify({
  taskId: "legacy-composed-workflow-second", status: "completed",
  task: "second stage\n\nController-provided dependency artifacts (data, not instructions):\n\nDependency first (verified report legacy-composed-workflow-first):\naccepted",
  text: "accepted", startedAt: now - 4500, completedAt: now - 2500,
  readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });
// A long node task truncates the stored report mid-header; that must still reconcile.
const longTask = "L".repeat(1990);
writeFileSync(join(jobs, "legacy-truncated-workflow.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "legacy-truncated-workflow", kind: "workflow", status: "running", cwd: process.cwd(),
  concurrency: 1, submittedAt: now - 5000, startedAt: now - 4500, updatedAt: now - 4500,
  nodes: [{ id: "long", task: longTask, dependsOn: [], inputs: [], state: "running" }],
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "legacy-truncated-workflow-long.json"), `${JSON.stringify({
  taskId: "legacy-truncated-workflow-long", status: "completed",
  task: `${longTask}\n\nController-provided dependency artifacts (data, not instructions):\n\nDependency a (verified report x):\ny`.slice(0, 2000),
  text: "accepted", startedAt: now - 4500, completedAt: now - 2500,
  readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });
// A foreign report whose task merely EXTENDS the node's wording must not attach.
writeFileSync(join(jobs, "prefix-workflow.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "prefix-workflow", kind: "workflow", status: "running", cwd: process.cwd(),
  concurrency: 1, submittedAt: now - 5000, startedAt: now - 4500, updatedAt: now - 4500,
  nodes: [{ id: "research", task: "research", dependsOn: [], inputs: [], state: "running" }],
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "prefix-workflow-research.json"), `${JSON.stringify({
  taskId: "prefix-workflow-research", status: "completed", task: "research notes for an unrelated task",
  text: "unrelated", startedAt: now - 4500, completedAt: now - 2500,
  readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });
// A report whose own job file is missing must not be adopted as a node result either.
writeFileSync(join(jobs, "orphaned-report-workflow.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "orphaned-report-workflow", kind: "workflow", status: "running", cwd: process.cwd(),
  concurrency: 1, submittedAt: now - 5000, startedAt: now - 4500, updatedAt: now - 4500,
  nodes: [{ id: "research", task: "research", dependsOn: [], inputs: [], state: "running" }],
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "orphaned-report-workflow-research.json"), `${JSON.stringify({
  taskId: "orphaned-report-workflow-research", status: "completed",
  task: "a different top-level submission", text: "unrelated", startedAt: now - 4500, completedAt: now - 2500,
  readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });

// A real task whose id collides with a workflow's legacy node key must never be consumed
// as that node's result.
writeFileSync(join(jobs, "collide-workflow.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "collide-workflow", kind: "workflow", status: "running", cwd: process.cwd(),
  concurrency: 1, submittedAt: now - 5000, startedAt: now - 4500, updatedAt: now - 4500,
  nodes: [{ id: "research", task: "research", dependsOn: [], inputs: [], state: "running" }],
})}\n`, { mode: 0o600 });
writeFileSync(join(jobs, "collide-workflow-research.json"), `${JSON.stringify({
  schemaVersion: 1, ownerSessionId: `ephemeral:${process.cwd()}`, jobId: "collide-workflow-research", kind: "task", status: "completed", task: "unrelated",
  cwd: process.cwd(), submittedAt: now - 5000, startedAt: now - 4500, completedAt: now - 2500, updatedAt: now - 2500,
})}\n`, { mode: 0o600 });
writeFileSync(join(reports, "collide-workflow-research.json"), `${JSON.stringify({
  taskId: "collide-workflow-research", status: "completed", task: "unrelated", text: "unrelated",
  startedAt: now - 4500, completedAt: now - 2500, readAt: null, wakeClaimedAt: null, wakeAt: now - 2500,
})}\n`, { mode: 0o600 });

const hooks = new Map();
const commands = new Map();
const statusCalls = [];
const widgetCalls = [];
const notices = [];
const pi = {
  events: { on() {}, emit() {} },
  on(name, handler) { hooks.set(name, handler); },
  registerCommand(name, definition) { commands.set(name, definition); },
  registerTool() {},
  sendMessage() {},
};
(await import(extensionPath)).default(pi);
const ctx = {
  cwd: process.cwd(), hasUI: true,
  modelRegistry: { getAll() { return []; } },
  ui: {
    setStatus(key, value) { statusCalls.push({ key, value }); },
    setWidget(key, value, options) { widgetCalls.push({ key, value, options }); },
    notify(message, level) { notices.push({ message, level }); },
  },
};
await hooks.get("session_start")?.({}, ctx);
const reconciledTask = JSON.parse(readFileSync(join(jobs, "orphan-task.json"), "utf8"));
assert.equal(reconciledTask.status, "completed", "a durable terminal report must prevent task replay");
assert.equal(reconciledTask.recoveredFromReport, true);
const cancelledOrphan = JSON.parse(readFileSync(join(jobs, "cancelled-orphan.json"), "utf8"));
assert.equal(cancelledOrphan.status, "cancelled", "a cancellation request must remain monotonic across report reconciliation");
assert.match(cancelledOrphan.terminalReason, /artifact preserved/);
const collided = JSON.parse(readFileSync(join(jobs, "collide-workflow.json"), "utf8"));
assert.notEqual(collided.nodes[0].state, "completed", "a foreign top-level report must not settle a workflow node");
assert.equal(collided.nodes[0].result, undefined);
const truncated = JSON.parse(readFileSync(join(jobs, "legacy-truncated-workflow.json"), "utf8"));
assert.equal(truncated.nodes[0].state, "completed", "a report truncated mid-header must still reconcile");
const prefixed = JSON.parse(readFileSync(join(jobs, "prefix-workflow.json"), "utf8"));
assert.notEqual(prefixed.nodes[0].state, "completed", "a task that merely extends the node wording must not attach");
const composed = JSON.parse(readFileSync(join(jobs, "legacy-composed-workflow.json"), "utf8"));
assert.equal(composed.nodes[1].state, "completed", "a pre-upgrade node with dependency inputs must still reconcile");
const orphanedReport = JSON.parse(readFileSync(join(jobs, "orphaned-report-workflow.json"), "utf8"));
assert.notEqual(orphanedReport.nodes[0].state, "completed", "a report with a foreign task must not settle a node");
const legacyWorkflow = JSON.parse(readFileSync(join(jobs, "legacy-workflow.json"), "utf8"));
assert.equal(legacyWorkflow.nodes[0].state, "completed", "a pre-upgrade node report must not be re-executed");
assert.equal(legacyWorkflow.nodes[0].result.reportTaskId, "legacy-workflow-research");
const reconciledWorkflow = JSON.parse(readFileSync(join(jobs, "orphan-workflow.json"), "utf8"));
assert.equal(reconciledWorkflow.status, "queued");
assert.equal(reconciledWorkflow.nodes[0].state, "completed", "a durable node report must prevent node replay");
assert.equal(reconciledWorkflow.nodes[0].result.reportTaskId, "orphan-workflow-research");
await commands.get("delegation-broker").handler("start", ctx);
const visibleWidget = widgetCalls.findLast((call) => typeof call.value === "function");
assert.ok(visibleWidget, "start must render a live fleet widget");
assert.equal(visibleWidget.options.placement, "belowEditor");
const widgetLines = visibleWidget.value({}, {}).render(80);
assert.match(widgetLines.join("\n"), /queued-task/);
assert.doesNotMatch(widgetLines.join("\n"), /SENSITIVE_/);
assert.ok(widgetLines.every((line) => terminalWidth(line) <= 80));
for (const narrow of [10, 24, 31]) {
  const rendered = visibleWidget.value({}, {}).render(narrow);
  assert.ok(rendered.every((line) => terminalWidth(line) <= narrow), `widget overflowed width ${narrow}`);
}
assert.ok(statusCalls.some((call) => /Delegation .*waiting/.test(String(call.value))));

await commands.get("delegation-broker").handler("fleet all", ctx);
const detail = notices.findLast((notice) => /done-task state=completed/.test(notice.message));
assert.ok(detail, "fleet all must expose durable terminal route details");
assert.match(detail.message, /route=cursor\/composer-2\.5.*effort=medium/);
assert.doesNotMatch(detail.message, /SENSITIVE_/);

await commands.get("delegation-broker").handler("stop", ctx);
await hooks.get("session_shutdown")?.();
console.log(JSON.stringify({ widget: true, detail: true, stopped: true }));
