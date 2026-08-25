import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJob, requestJobCancellation } from "../src/delegation-job-store.mjs";
import { TaskOrchestrator, formatWorkflowSummary, workflowObserveCapabilityRequest } from "../src/workflow-scheduler.mjs";

test("workflow stages stay read-only even when their prompt says do not modify files", () => {
  const request = workflowObserveCapabilityRequest({
    task: "Audit the repository. Do not modify files or create a report on disk.",
    tier: "frontier",
    capabilities: ["large_context"],
  }, "workflow-safe-read");
  assert.equal(request.operationClass, "observe");
  assert.equal(request.modelTier, "frontier");
  assert.deepEqual(request.requiredCapabilities, ["large_context"]);
});

test("orchestrator runs independent work in parallel and blocks dependents after failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-"));
  const seen = [];
  try {
    const o = new TaskOrchestrator({ path: join(root, "tasks.json"), concurrency: 2, run: async (node) => {
      seen.push(node.id); return { status: node.id === "bad" ? "failed" : "completed" };
    }});
    o.initialize([{ id: "research-a", task: "a" }, { id: "research-b", task: "b" }, { id: "bad", task: "c" }, { id: "synthesis", task: "s", dependsOn: ["research-a", "research-b"] }, { id: "blocked", task: "x", dependsOn: ["bad"] }]);
    const state = await o.execute();
    assert.equal(state.nodes.find((x) => x.id === "synthesis").state, "completed");
    assert.equal(state.nodes.find((x) => x.id === "blocked").state, "blocked");
    assert.ok(seen.includes("research-a") && seen.includes("research-b"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orchestrator keeps per-node tier and capabilities for the runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-tier-"));
  const seen = [];
  try {
    const o = new TaskOrchestrator({
      path: join(root, "tasks.json"),
      concurrency: 2,
      run: async (node) => {
        seen.push({ id: node.id, tier: node.tier, capabilities: node.capabilities });
        return { status: "completed" };
      },
    });
    o.initialize([
      { id: "read", task: "summarize", tier: "cheap", capabilities: ["text_generation"] },
      { id: "hard", task: "reason", tier: "frontier" },
    ]);
    const state = await o.execute();
    assert.equal(state.nodes.every((node) => node.state === "completed"), true);
    assert.deepEqual(seen.find((node) => node.id === "read"), { id: "read", tier: "cheap", capabilities: ["text_generation"] });
    assert.equal(seen.find((node) => node.id === "hard").tier, "frontier");
    assert.equal(state.nodes.find((node) => node.id === "read").tier, "cheap");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("declared dependency inputs carry only completed predecessor result references", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-inputs-"));
  const seen = [];
  try {
    const o = new TaskOrchestrator({
      root,
      jobId: "workflow-inputs",
      concurrency: 1,
      run: async (node) => {
        seen.push({ id: node.id, inputResults: node.inputResults });
        return { status: "completed", reportTaskId: `report-${node.id}` };
      },
    });
    o.initialize([
      { id: "research", task: "research" },
      { id: "synthesis", task: "synthesize", dependsOn: ["research"], inputs: ["research"] },
    ]);
    const state = await o.execute();
    assert.equal(state.status, "completed");
    assert.deepEqual(seen.find((entry) => entry.id === "research").inputResults, []);
    assert.deepEqual(seen.find((entry) => entry.id === "synthesis").inputResults, [{
      fromNode: "research",
      result: { status: "completed", reportTaskId: "report-research" },
    }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("controller cancellation pauses in-flight nodes and settles the workflow cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-cancel-"));
  const controller = new AbortController();
  try {
    const o = new TaskOrchestrator({
      root,
      jobId: "workflow-cancel",
      run: async () => new Promise((resolve) => setTimeout(() => resolve({ status: "completed" }), 10)),
    });
    o.initialize([{ id: "slow", task: "wait" }]);
    const pending = o.execute({ signal: controller.signal });
    controller.abort("cancel");
    const state = await pending;
    assert.equal(state.status, "cancelled");
    assert.equal(state.nodes[0].state, "pending");
    assert.equal(Number.isSafeInteger(state.completedAt), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a durable cancellation racing node completion cannot be overwritten by stale scheduler state", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-cancel-race-"));
  let release;
  let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const o = new TaskOrchestrator({
      root,
      jobId: "workflow-cancel-race",
      run: async () => { announceStarted(); await gate; return { status: "completed", reportTaskId: "late-report" }; },
    });
    o.initialize([{ id: "slow", task: "wait" }]);
    const pending = o.execute();
    await started;
    assert.equal(requestJobCancellation(root, "workflow-cancel-race", Date.now()).status, "cancellation_requested");
    release();
    const state = await pending;
    assert.equal(state.status, "cancelled");
    assert.equal(readJob(root, "workflow-cancel-race").status, "cancelled");
    assert.equal(state.nodes[0].state, "completed", "accepted terminal node work is preserved while the workflow cancels");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("per-node contract axes survive normalization and invalid ones are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-"));
  try {
    const orchestrator = new TaskOrchestrator({
      root, jobId: "workflow-contract", concurrency: 2,
      run: async () => ({ status: "completed" }),
    });
    const skills = [{ path: "/tmp/reviewer.md", digest: "ab".repeat(32), bytes: 24 }];
    const { job } = orchestrator.initialize([
      { id: "cheap", task: "summarize" },
      { id: "hard", task: "reason", thinking: "high", route: "inherit_model", role: { name: "reviewer" }, skills },
    ], { cwd: root, submittedAt: Date.now() });
    // A stage that asked for peer-level effort must not silently run on defaults.
    assert.equal(job.nodes[0].contract, undefined);
    assert.equal(job.nodes[1].contract.thinking, "high");
    assert.equal(job.nodes[1].contract.route, "inherit_model");
    assert.equal(job.nodes[1].contract.role.name, "reviewer");
    assert.equal(job.nodes[1].contract.role.schemaVersion, 1);
    assert.deepEqual(job.nodes[1].contract.skills, skills);

    const rejecting = new TaskOrchestrator({
      root, jobId: "workflow-contract-bad", concurrency: 1,
      run: async () => ({ status: "completed" }),
    });
    assert.throws(
      () => rejecting.initialize([{ id: "n", task: "t", thinking: "very hard" }], { cwd: root, submittedAt: Date.now() }),
      /thinking mode is invalid/,
    );
    assert.throws(
      () => rejecting.initialize([{ id: "n", task: "t", skills: ["relative.md"] }], { cwd: root, submittedAt: Date.now() }),
      /absolute filesystem path/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow validation rejects cycles and undeclared dependency inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-graph-"));
  try {
    const cycle = new TaskOrchestrator({ root, jobId: "workflow-cycle", run: async () => ({ status: "completed" }) });
    assert.throws(() => cycle.initialize([
      { id: "a", task: "a", dependsOn: ["b"] },
      { id: "b", task: "b", dependsOn: ["a"] },
    ]), /cycle/);
    const input = new TaskOrchestrator({ root, jobId: "workflow-input", run: async () => ({ status: "completed" }) });
    assert.throws(() => input.initialize([
      { id: "a", task: "a" },
      { id: "b", task: "b", inputs: ["a"] },
    ]), /input must also be a dependency/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow failure summary exposes the terminal reason and route instead of only a count", () => {
  const text = formatWorkflowSummary("workflow-diagnostic", {
    nodes: [{
      id: "research",
      state: "failed",
      result: {
        status: "failed",
        error: "controller prompt deadline exceeded",
        route: [{ resourceId: "openai-codex/gpt-5.6-sol", outcome: "unavailable" }],
      },
    }],
  });
  assert.match(text, /research: failed — controller prompt deadline exceeded/);
  assert.match(text, /openai-codex\/gpt-5\.6-sol:unavailable/);
});

test("orchestrator rejects an invalid tier before any work starts", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-bad-tier-"));
  try {
    const o = new TaskOrchestrator({ path: join(root, "tasks.json"), run: async () => ({ status: "completed" }) });
    assert.throws(() => o.initialize([{ id: "x", task: "t", tier: "premium" }]), /tier is invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
