import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
