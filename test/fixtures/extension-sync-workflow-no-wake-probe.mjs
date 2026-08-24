import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const extensionPath = process.env.BROKER_EXTENSION_PATH;
if (!extensionPath) throw new Error("BROKER_EXTENSION_PATH is required");
const agent = join(process.env.HOME, ".pi", "agent");
mkdirSync(agent, { recursive: true, mode: 0o700 });
for (const [name, value] of Object.entries({
  "auth.json": {}, "settings.json": { packages: [] }, "models-store.json": {}, "models.json": { providers: {} },
})) writeFileSync(join(agent, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
const tools = new Map(), hooks = new Map();
let sends = 0;
const pi = {
  events: { on() {}, emit() {} },
  on(name, handler) { hooks.set(name, handler); },
  registerCommand() {},
  registerTool(definition) { tools.set(definition.name, definition); },
  sendMessage() { sends += 1; },
  sendUserMessage() { throw new Error("must not forge owner input"); },
};
(await import(extensionPath)).default(pi);
const ctx = { cwd: process.cwd(), modelRegistry: { getAll() { return []; } }, ui: { notify() {} } };
await hooks.get("session_start")?.({}, ctx);
const result = await tools.get("delegate_workflow").execute(
  "sync-workflow-tool",
  { nodes: [{ id: "read", task: "Read one file." }], wait: true, deadlineMs: 2_000, idempotencyKey: "sync-no-wake" },
  new AbortController().signal,
  undefined,
  ctx,
);
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(sends, 0, "a synchronously awaited workflow must not schedule a parent follow-up");
const workflowId = result.details.jobId;
const report = JSON.parse(await (await import("node:fs/promises")).readFile(
  join(agent, "delegation-broker", "reports", `${workflowId}.json`), "utf8",
));
assert.ok(Number.isSafeInteger(report.wakeAt), "synchronous report is durably pre-marked non-waking");
await hooks.get("session_shutdown")?.();
console.log(JSON.stringify({ workflowId, sends }));
