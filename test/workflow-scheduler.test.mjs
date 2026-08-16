import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskOrchestrator } from "../src/workflow-scheduler.mjs";

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
