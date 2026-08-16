import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelAffinityJournal } from "../src/model-affinity-journal.mjs";
import { ControllerVerifiedRoutingBoard } from "../src/verified-routing-board.mjs";

const CAPS = ["code_reasoning", "text_generation"];
function journal() {
  const root = mkdtempSync(join(tmpdir(), "affinity-"));
  return { root, path: join(root, "journal.json"), journal: new ModelAffinityJournal({ path: join(root, "journal.json"), now: () => 1000 }) };
}

test("affinity requires sufficient verified evidence before it can reorder a route", () => {
  const setup = journal();
  try {
    const a = "zai/glm-5.3";
    const b = "ollama/kimi-k3";
    setup.journal.recordVerified({ resourceId: a, capabilities: CAPS, outcome: "accepted", latencyMs: 100 });
    setup.journal.recordVerified({ resourceId: a, capabilities: CAPS, outcome: "accepted", latencyMs: 100 });
    assert.deepEqual(setup.journal.rank({ resourceIds: [b, a], capabilities: CAPS }), [b, a], "two observations are not enough to learn");
    setup.journal.recordVerified({ resourceId: a, capabilities: CAPS, outcome: "accepted", latencyMs: 100 });
    assert.deepEqual(setup.journal.rank({ resourceIds: [b, a], capabilities: CAPS }), [a, b]);
    assert.equal(existsSync(setup.path), true);
    const reloaded = new ModelAffinityJournal({ path: setup.path, now: () => 2000 });
    assert.deepEqual(reloaded.rank({ resourceIds: [b, a], capabilities: CAPS }), [a, b], "journal persists controller evidence");
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("a verified routing bridge writes an affinity only after receipt/outcome validation", () => {
  const setup = journal();
  const records = [];
  const board = { record: (entry) => records.push(entry), score: () => undefined, rank: () => [] };
  const authority = { verify: (verification, binding) => verification?.token === "valid" && binding.taskId === "task-a" };
  try {
    const bridge = new ControllerVerifiedRoutingBoard({ routingBoard: board, verificationAuthority: authority, affinityJournal: setup.journal, now: () => 3000 });
    assert.throws(() => bridge.recordFinalized({ taskId: "task-a", leaseId: "lease-a", fencingToken: 1, verification: { status: "accepted", token: "forged" }, outcome: { status: "completed" }, resourceId: "zai/glm-5.3", capabilities: CAPS, latencyMs: 10 }), /authentic/);
    assert.deepEqual(setup.journal.snapshot().observations, {}, "forged receipt changes nothing");
    bridge.recordFinalized({ taskId: "task-a", leaseId: "lease-a", fencingToken: 1, verification: { status: "accepted", token: "valid" }, outcome: { status: "completed" }, resourceId: "zai/glm-5.3", capabilities: CAPS, latencyMs: 10 });
    assert.equal(records.length, CAPS.length, "the existing verified board also receives the observation");
    assert.equal(Object.keys(setup.journal.snapshot().observations).length, 1);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});
test("between equally reliable routes the more efficient one is preferred", () => {
  const setup = journal();
  try {
    const frugal = "zai/glm-5.3";
    const wasteful = "openrouter/deepseek/deepseek-v4-pro";
    for (let i = 0; i < 4; i++) {
      setup.journal.recordVerified({ resourceId: frugal, capabilities: CAPS, outcome: "accepted", latencyMs: 1_000, tokens: 2_000, attempts: 1 });
      setup.journal.recordVerified({ resourceId: wasteful, capabilities: CAPS, outcome: "accepted", latencyMs: 9_000, tokens: 40_000, attempts: 2 });
    }
    // Identical acceptance records, so only observed consumption can separate them.
    assert.deepEqual(setup.journal.rank({ resourceIds: [wasteful, frugal], capabilities: CAPS }), [frugal, wasteful]);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("efficiency never outranks reliability: a frugal route that fails verification loses", () => {
  const setup = journal();
  try {
    const frugalButWrong = "openrouter/google/gemini-3.7-flash";
    const heavyButRight = "anthropic/claude-opus-5";
    for (let i = 0; i < 4; i++) {
      setup.journal.recordVerified({ resourceId: frugalButWrong, capabilities: CAPS, outcome: "rejected", latencyMs: 200, tokens: 500, attempts: 1 });
      setup.journal.recordVerified({ resourceId: heavyButRight, capabilities: CAPS, outcome: "accepted", latencyMs: 8_000, tokens: 60_000, attempts: 1 });
    }
    assert.deepEqual(setup.journal.rank({ resourceIds: [frugalButWrong, heavyButRight], capabilities: CAPS }), [heavyButRight, frugalButWrong]);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("a route with no consumption sample is still ranked on reliability alone", () => {
  const setup = journal();
  try {
    const measured = "zai/glm-5.3";
    for (let i = 0; i < 3; i++) {
      setup.journal.recordVerified({ resourceId: measured, capabilities: CAPS, outcome: "accepted", latencyMs: 500 });
    }
    const record = setup.journal.snapshot().observations[`${[...CAPS].sort().join("+")}\u0000${measured}`];
    assert.equal(record.tokenTotal, 0, "an absent usage report must not be invented");
    assert.deepEqual(setup.journal.rank({ resourceIds: ["ollama/kimi-k3", measured], capabilities: CAPS }), [measured, "ollama/kimi-k3"]);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});
