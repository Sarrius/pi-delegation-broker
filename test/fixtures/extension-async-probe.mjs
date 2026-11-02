import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeReport, readReport } from "../../src/report-store.mjs";
import { writeJob } from "../../src/delegation-job-store.mjs";

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
const planTool = tools.get("delegate_plan");
assert.ok(workflowTool && delegateTool && planTool);
const jobsTool = tools.get("delegate_list");
const jobsBeforePreview = (await jobsTool.execute("before-plan", {})).details?.jobs?.length ?? 0;
const planned = await planTool.execute("plan-only", {
  task: "Read one named file and return one short version marker.", tier: "cheap",
  work: { taskClass: "lookup", deliverable: "One version marker", benefit: "Check route without paying for a child", parentWork: "Retain the original task" },
}, new AbortController().signal, undefined, ctx);
assert.equal(planned.details.reserved, false);
assert.equal(planned.details.taskId, undefined);
assert.equal(planned.details.budgetSufficiency, "unknown");
assert.equal(planned.details.maxOutputTokens, null, "planning must not invent a cumulative cap");
assert.equal(planned.details.quotaReadiness, "unknown");
assert.equal((await jobsTool.execute("after-plan", {})).details?.jobs?.length ?? 0, jobsBeforePreview,
  "a preview must neither reserve nor submit a child task");

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
assert.equal(taskResult.details.status, "submitted", "a queued job cannot claim child ownership before route admission");
assert.match(taskResult.content[0].text, /Admission pending/);
assert.doesNotMatch(taskResult.content[0].text, /The child owns this deliverable/);

// The child's tools and whether a cumulative cap exists must be visible at submission.
assert.deepEqual(taskResult.details.childTools, ["read", "grep", "ls", "find", "test"]);
assert.ok(!taskResult.details.childTools.includes("bash"));
assert.equal(taskResult.details.maxOutputTokens, null, "a parent without a declared cap must not create a hard cumulative stop");
assert.match(taskResult.content[0].text, /no shell/);
assert.match(taskResult.content[0].text, /no cumulative read-only output cap/);
assert.match(taskResult.content[0].text, /16,000-token per-request hint/);

// A declared requirement no child can satisfy is refused before any provider is paid, instead of
// letting the child discover it has no shell halfway through the task.
const refused = await delegateTool.execute(
  "tool-task-refused",
  { task: "Run the test suite and report failures.", capabilities: ["execution"], idempotencyKey: "probe-execution" },
  new AbortController().signal,
  undefined,
  ctx,
);
assert.equal(refused.isError, true);
assert.equal(refused.details?.cause, "capability_unavailable");
assert.equal(refused.details?.taskId, undefined, "a refused delegation must not create a job");
assert.match(refused.content[0].text, /proposeChangesIn/);

// An explicit cap travels to the durable job rather than being silently replaced by the default.
const budgeted = await delegateTool.execute(
  "tool-task-budget",
  { task: "Read only. Return one word.", maxOutputTokens: 60000, idempotencyKey: "probe-budget" },
  new AbortController().signal,
  undefined,
  ctx,
);
assert.equal(budgeted.details.maxOutputTokens, 60000);
assert.match(budgeted.content[0].text, /caller-supplied hard cumulative output cap/);
assert.doesNotMatch(budgeted.content[0].text, /owner-declared/);
// A raised cap must be a DIFFERENT piece of work, not an idempotent replay of the earlier job
// (which would silently reuse the cap that already ran out).
assert.equal(budgeted.details.idempotentReplay, false, "a different budget is not the same job");
assert.notEqual(budgeted.details.taskId, taskResult.details.taskId, "a different budget must not collapse into the earlier task");
assert.ok(!/raise maxOutputTokens/.test(budgeted.content[0].text), "an explicit cap is not a default warning");

const statusTool = tools.get("delegate_status");
const listTool = tools.get("delegate_list");
const cancelTool = tools.get("delegate_cancel");
assert.ok(statusTool && listTool && cancelTool && tools.get("delegate_collect"));
const status = await statusTool.execute("status", { id: workflowId });
assert.match(status.content[0].text, new RegExp(`^${workflowId}:`));
const listed = await listTool.execute("list", {});
assert.ok(listed.details.jobs.some((job) => job.jobId === workflowId));

// Budget intent must be durable: explicit caps stay hard, while only new unbudgeted jobs
// adopt the metered default. Jobs submitted before this change keep their old hard cap.
const allJobs = listTool.execute("list", {});
const durable = (await allJobs).details.jobs;
const budgetedJob = durable.find((job) => job.idempotencyKey === "probe-budget");
assert.ok(budgetedJob, `the budgeted delegation must have its own durable job: ${JSON.stringify(durable.map((j) => j.idempotencyKey))}`);
assert.equal(budgetedJob.maxOutputTokens, 60000, JSON.stringify(budgetedJob));
const defaultJob = durable.find((job) => job.idempotencyKey === "probe-task");
assert.ok(defaultJob, "the default delegation must be listed");
assert.equal(defaultJob.maxOutputTokens, undefined, "no caller cap must remain absent in the durable job");
assert.equal(defaultJob.outputBudgetPolicy, "metered_default_v2");
assert.equal(defaultJob.inputBudgetPolicy, "metered_default_v1");
assert.equal(durable.find((job) => job.jobId === workflowId)?.outputBudgetPolicy, "metered_default_v2");
assert.equal(durable.find((job) => job.jobId === workflowId)?.inputBudgetPolicy, "metered_default_v1");

// Cross-session read surfaces must not expose another owner's pending task or terminal report.
const collectTool = tools.get("delegate_collect");
writeJob(join(agent, "delegation-broker/jobs"), { ...defaultJob, jobId: "foreign-job", ownerSessionId: "foreign-owner", task: "PRIVATE_OTHER_SESSION", idempotencyKey: "foreign" });
assert.equal((await collectTool.execute("foreign-pending", { taskId: "foreign-job" })).isError, true);
assert.equal((await statusTool.execute("foreign-status", { id: "foreign-job" })).isError, true);
assert.ok(!(await listTool.execute("private-list", {})).details.jobs.some(job => job.jobId === "foreign-job"));
const reportTime = Date.now();
writeReport(join(agent, "delegation-broker/reports"), { taskId: "foreign-job", task: "PRIVATE_OTHER_SESSION", status: "failed", error: "private failure", startedAt: reportTime, completedAt: reportTime });
assert.equal((await collectTool.execute("foreign-terminal", { taskId: "foreign-job" })).isError, true);

// A workflow node has no standalone job: its exact durable node result binds it to the owner.
const ownWorkflow = durable.find(job => job.jobId === workflowId);
const reportId = "workflow-owned-report-read";
writeJob(join(agent, "delegation-broker/jobs"), { ...ownWorkflow, jobId: "workflow-owned-report", team: { ...ownWorkflow.team, rootId: "workflow-owned-report" }, completedAt: reportTime, updatedAt: reportTime, idempotencyKey: "owned-report", status: "failed", nodes: [{ ...ownWorkflow.nodes[0], state: "failed", result: { status: "failed", reportTaskId: reportId } }] });
writeReport(join(agent, "delegation-broker/reports"), { taskId: reportId, logicalId: "workflow-owned-report/read", task: "Owned node", status: "failed", error: "expected fixture failure", startedAt: reportTime, completedAt: reportTime });
const ownReport = await collectTool.execute("owned-node", { taskId: reportId });
assert.notEqual(ownReport.isError, true, JSON.stringify(ownReport));
assert.equal(ownReport.details.taskId, reportId);

await cancelTool.execute("cancel", { id: taskResult.details.taskId, reason: "probe cleanup" });
await cancelTool.execute("cancel", { id: budgeted.details.taskId, reason: "probe cleanup" });
await hooks.get("session_shutdown")?.();
// A recovered budget failure is terminal work too: expose its report/wake instead
// of silently leaving a failed job with no collectable result.
writeJob(join(agent, "delegation-broker/jobs"), { ...defaultJob, jobId: "recovery-budget",
  idempotencyKey: "recovery-budget", status: "running", completedAt: undefined, startedAt: reportTime,
  admittedAt: reportTime, startedAttempts: 1, maxOutputTokens: 100 });
await hooks.get("session_start")?.({}, ctx);
const recoveredBudgetReport = readReport(join(agent, "delegation-broker/reports"), "recovery-budget");
assert.equal(recoveredBudgetReport?.status, "failed");
assert.match(recoveredBudgetReport.error, /unaccounted.*budget/);
assert.notEqual((await collectTool.execute("recovered-budget", {taskId:"recovery-budget"})).isError, true);
await hooks.get("session_shutdown")?.();
console.log(JSON.stringify({ workflowId, workflowElapsedMs, taskElapsedMs, toolNames: [...tools.keys()].sort() }));
