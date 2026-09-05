import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const extensionPath = process.env.BROKER_EXTENSION_PATH;
if (!extensionPath) throw new Error("BROKER_EXTENSION_PATH is required");
const packageRoot = dirname(dirname(extensionPath));
const { submitJob, requestJobCancellation, readJob } = await import(pathToFileURL(join(packageRoot, "src", "delegation-job-store.mjs")));
const agent = join(process.env.HOME, ".pi", "agent");
const brokerState = join(agent, "delegation-broker");
const jobs = join(brokerState, "jobs");
mkdirSync(jobs, { recursive: true, mode: 0o700 });
for (const [name, value] of Object.entries({
  "auth.json": {}, "settings.json": { packages: [] }, "models-store.json": {}, "models.json": { providers: {} },
})) writeFileSync(join(agent, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
writeFileSync(join(brokerState, "enabled.json"), '{"enabled":false}\n', { mode: 0o600 });
const submittedAt = Date.now() - 100;
submitJob(jobs, {
  schemaVersion: 1, jobId: "delegate-recovered-cancel-1", kind: "task", status: "queued",
  task: "cancel me", cwd: packageRoot, submittedAt, updatedAt: submittedAt,
  ownerSessionId: "recovered-owner",
  idempotencyKey: "recovered-cancel", policyGeneration: "unresolved",
});
requestJobCancellation(jobs, "delegate-recovered-cancel-1", submittedAt + 10, "recovered-owner");
submitJob(jobs, {
  schemaVersion: 1, jobId: "foreign-live", kind: "task", status: "running",
  ownerSessionId: "another-owner", task: "keep working", cwd: packageRoot,
  submittedAt, updatedAt: submittedAt,
});
const { writeReport, readReport } = await import(pathToFileURL(join(packageRoot, "src", "report-store.mjs")));
submitJob(jobs, {
  schemaVersion: 1, jobId: "foreign-done", kind: "task", status: "completed",
  ownerSessionId: "another-owner", task: "foreign result", cwd: packageRoot,
  submittedAt, updatedAt: submittedAt + 20, completedAt: submittedAt + 20,
});
writeReport(join(brokerState, "reports"), {
  taskId: "foreign-done", status: "completed", task: "foreign result", text: "FOREIGN_MARKER",
  startedAt: submittedAt, completedAt: submittedAt + 20,
});

const tools = new Map(), hooks = new Map();
let wakeResolve;
const wakePromise = new Promise((resolve) => { wakeResolve = resolve; });
const pi = {
  events: { on() {}, emit() {} },
  on(name, handler) { hooks.set(name, handler); },
  registerCommand() {},
  registerTool(definition) { tools.set(definition.name, definition); },
  sendUserMessage() { throw new Error("must not forge owner input"); },
  sendMessage(message, options) { wakeResolve({ message, options }); },
};
(await import(extensionPath)).default(pi);
const ctx = { cwd: packageRoot, sessionManager: { getSessionId() { return "recovered-owner"; } }, modelRegistry: { getAll() { return []; } }, ui: { notify() {} } };
await hooks.get("session_start")?.({}, ctx);
const wake = await Promise.race([
  wakePromise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("recovered cancellation did not wake")), 2_000)),
]);
assert.match(wake.message.content, /delegate-recovered-cancel-1: failed/);
assert.doesNotMatch(wake.message.content, /foreign/);
assert.equal(readJob(jobs, "foreign-live").status, "running");
assert.equal(readJob(jobs, "foreign-live").updatedAt, submittedAt);
assert.equal(readReport(join(brokerState, "reports"), "foreign-done").wakeClaimedAt, null);
const unread = await tools.get("delegate_collect").execute("list", {}, new AbortController().signal);
assert.doesNotMatch(JSON.stringify(unread), /foreign/);
assert.equal(wake.options.triggerTurn, true);
await hooks.get("message_start")?.({ message: {
  role: "custom", customType: wake.message.customType, details: wake.message.details,
} }, ctx);
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(readJob(jobs, "delegate-recovered-cancel-1").status, "cancelled");
const report = JSON.parse(await (await import("node:fs/promises")).readFile(
  join(brokerState, "reports", "delegate-recovered-cancel-1.json"), "utf8",
));
assert.equal(report.status, "failed");
assert.ok(Number.isSafeInteger(report.wakeClaimedAt));
assert.ok(Number.isSafeInteger(report.wakeAt));
await hooks.get("session_shutdown")?.();
console.log(JSON.stringify({ status: "cancelled", wake: true }));
