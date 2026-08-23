import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const extensionPath = process.env.BROKER_EXTENSION_PATH;
if (!extensionPath) throw new Error("BROKER_EXTENSION_PATH is required");
const agent = join(process.env.HOME, ".pi", "agent");
mkdirSync(agent, { recursive: true, mode: 0o700 });
const writeJson = (name, value) => writeFileSync(join(agent, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
writeJson("auth.json", { "test-provider": { type: "api-key", key: "not-a-real-key" } });
writeJson("settings.json", { packages: [] });
writeJson("models-store.json", {});
writeJson("models.json", { providers: {} });

const tools = new Map();
const hooks = new Map();
const eventListeners = new Map();
const pi = {
  events: {
    on(name, handler) { eventListeners.set(name, handler); },
    emit(name, payload) { eventListeners.get(name)?.(payload); },
  },
  on(name, handler) { hooks.set(name, handler); },
  registerCommand() {},
  registerTool(definition) { tools.set(definition.name, definition); },
};
const extension = (await import(extensionPath)).default;
extension(pi);

const ctx = {
  cwd: process.cwd(),
  modelRegistry: {
    getAll() {
      return [{
        provider: "test-provider", id: "test-model", name: "Test Model",
        api: "openai-completions", baseUrl: "https://test-provider.invalid/v1",
        contextWindow: 32_000, maxTokens: 2_048, reasoning: false, input: ["text"],
      }];
    },
  },
  ui: { notify() {} },
};
await hooks.get("session_start")?.({}, ctx);

const workflowTool = tools.get("delegate_workflow");
const delegateTool = tools.get("delegate");
assert.ok(workflowTool && delegateTool);

const workflowStarted = Date.now();
const workflowResult = await workflowTool.execute(
  "tool-workflow-1",
  { nodes: [{ id: "read", task: "Read only. Return one word." }], idempotencyKey: "probe-workflow" },
  new AbortController().signal,
  undefined,
  ctx,
);
const workflowElapsedMs = Date.now() - workflowStarted;
assert.ok(workflowElapsedMs < 500, `workflow submission blocked ${workflowElapsedMs}ms`);
const workflowId = workflowResult.details.workflowId;
assert.match(workflowId, /^workflow-/);
assert.equal(workflowResult.details.background, true);

const replay = await workflowTool.execute(
  "tool-workflow-2",
  { nodes: [{ id: "other", task: "This must not replace the original." }], idempotencyKey: "probe-workflow" },
  new AbortController().signal,
  undefined,
  ctx,
);
assert.equal(replay.details.workflowId, workflowId);
assert.equal(replay.details.idempotentReplay, true);

const taskStarted = Date.now();
const taskResult = await delegateTool.execute(
  "tool-task-1",
  { task: "Read only. Return one word.", idempotencyKey: "probe-task" },
  new AbortController().signal,
  undefined,
  ctx,
);
const taskElapsedMs = Date.now() - taskStarted;
assert.ok(taskElapsedMs < 500, `task submission blocked ${taskElapsedMs}ms`);
assert.ok(taskResult.details, JSON.stringify(taskResult));
assert.equal(taskResult.details.background, true);
assert.match(taskResult.details.taskId, /^delegate-/);

const statusTool = tools.get("delegate_status");
const listTool = tools.get("delegate_list");
const cancelTool = tools.get("delegate_cancel");
assert.ok(statusTool && listTool && cancelTool && tools.get("delegate_collect"));
const status = await statusTool.execute("status", { id: workflowId });
assert.match(status.content[0].text, new RegExp(`^${workflowId}:`));
const listed = await listTool.execute("list", {});
assert.ok(listed.details.jobs.some((job) => job.jobId === workflowId));

await cancelTool.execute("cancel", { id: taskResult.details.taskId, reason: "probe cleanup" });
await hooks.get("session_shutdown")?.();
console.log(JSON.stringify({ workflowId, workflowElapsedMs, taskElapsedMs, toolNames: [...tools.keys()].sort() }));
