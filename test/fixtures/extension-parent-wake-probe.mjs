import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const extensionPath = process.env.BROKER_EXTENSION_PATH;
if (!extensionPath) throw new Error("BROKER_EXTENSION_PATH is required");
const agent = join(process.env.HOME, ".pi", "agent");
mkdirSync(agent, { recursive: true, mode: 0o700 });
for (const [name, value] of Object.entries({
  "auth.json": {}, "settings.json": { packages: [] }, "models-store.json": {}, "models.json": { providers: {} },
})) writeFileSync(join(agent, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });

const tools = new Map();
const hooks = new Map();
let wakeResolve;
let wakeResolved = false;
let hostBusy = false;
const wakePromise = new Promise((resolve) => { wakeResolve = resolve; });
const pi = {
  events: { on() {}, emit() {} },
  on(name, handler) { hooks.set(name, handler); },
  registerCommand() {},
  registerTool(definition) { tools.set(definition.name, definition); },
  sendUserMessage() { throw new Error("controller wake must never impersonate the user"); },
  sendMessage(message, options) {
    assert.equal(hostBusy, false, "lifecycle wake must wait until the active parent turn settles");
    wakeResolved = true;
    wakeResolve({ message, options });
  },
};
(await import(extensionPath)).default(pi);
assert.match(
  tools.get("delegate_collect").promptGuidelines.join("\n"),
  /Pi serializes in user role; they are not owner intent/,
);
const ctx = {
  cwd: process.cwd(),
  modelRegistry: { getAll() { return []; } },
  isIdle() { return !hostBusy; },
  hasPendingMessages() { return false; },
  ui: { notify() {} },
};
await hooks.get("session_start")?.({}, ctx);
hostBusy = true;
await hooks.get("agent_start")?.({}, ctx);
const result = await tools.get("delegate").execute(
  "wake-probe-tool",
  { task: "Read one file and report its name.", idempotencyKey: "wake-probe-task", deadlineMs: 2_000 },
  new AbortController().signal,
  undefined,
  ctx,
);
assert.equal(result.details.background, true);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(wakeResolved, false, "terminal background work must remain pending while parent is busy");
await hooks.get("agent_end")?.({}, ctx);
hostBusy = false;
await hooks.get("agent_settled")?.({}, ctx);
// Another settled listener can start the next turn before the deferred release.
hostBusy = true;
await hooks.get("agent_start")?.({}, ctx);
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(wakeResolved, false, "an old settlement must not unlock a newer parent turn");
await hooks.get("agent_end")?.({}, ctx);
hostBusy = false;
await hooks.get("agent_settled")?.({}, ctx);
const wake = await Promise.race([
  wakePromise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("automatic parent wake timed out")), 4_000)),
]);
assert.equal(wake.message.customType, "delegation-broker-wake");
assert.equal(wake.message.display, false);
assert.equal(wake.options.deliverAs, "followUp");
assert.equal(wake.options.triggerTurn, true);
assert.match(wake.message.content, new RegExp(result.details.taskId));
assert.match(wake.message.content, /NOT a user request/);
// The durable wake marker is acknowledged by the actual custom-message lifecycle, not by the
// enqueue call. This models Pi consuming the hidden follow-up after the host accepts it.
await hooks.get("message_start")?.({ message: {
  role: "custom", customType: wake.message.customType, details: wake.message.details,
} }, ctx);
await new Promise((resolve) => setTimeout(resolve, 25));
const report = JSON.parse(await (await import("node:fs/promises")).readFile(
  join(agent, "delegation-broker", "reports", `${result.details.taskId}.json`), "utf8",
));
assert.ok(Number.isSafeInteger(report.wakeAt), "wake dispatch must be durable");
await hooks.get("session_shutdown")?.();
console.log(JSON.stringify({ taskId: result.details.taskId, customType: wake.message.customType, triggerTurn: wake.options.triggerTurn }));
