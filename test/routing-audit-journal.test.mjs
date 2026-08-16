import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoutingAuditJournal } from "../src/routing-audit-journal.mjs";

function journal() {
  const root = mkdtempSync(join(tmpdir(), "routing-audit-"));
  let now = 1_000;
  return { root, path: join(root, "audit.json"), journal: new RoutingAuditJournal({ path: join(root, "audit.json"), now: () => now++ }) };
}

test("routing audit persists only controller route facts and summarizes failover efficiency", () => {
  const setup = journal();
  try {
    const event = setup.journal.recordRoute({
      status: "completed",
      resourceId: "openrouter/deepseek/deepseek-v4-flash",
      selection: { modelTier: "cheap", preferenceSource: "auto", legacyExcluded: true },
      route: [
        { resourceId: "minimax/MiniMax-M2.7", outcome: "rate_limited" },
        { resourceId: "openrouter/deepseek/deepseek-v4-flash", outcome: "completed" },
      ],
      usage: { input: 120, output: 30 },
    });
    assert.equal(event.tokens, 150);
    assert.equal(existsSync(setup.path), true);
    const summary = setup.journal.summary();
    assert.deepEqual(summary.metrics, {
      routes: 1, completed: 1, failed: 0, aborted: 0, failovers: 1,
      legacyExcluded: 1, legacyFallback: 0, legacyTransitions: 0,
    });
    assert.equal(summary.recent[0].type, "route");

    const reloaded = new RoutingAuditJournal({ path: setup.path, now: () => 9_000 });
    assert.equal(reloaded.summary().metrics.failovers, 1, "audit survives controller restart");
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("currency audit records a legacy transition only after an observed prior state", () => {
  const setup = journal();
  try {
    setup.journal.recordCurrency({ "zai/glm-5.3": { legacy: false, generation: 0 } });
    setup.journal.recordCurrency({ "zai/glm-5.3": { legacy: true, generation: 2 } });
    const summary = setup.journal.summary();
    assert.equal(summary.metrics.legacyTransitions, 1);
    assert.deepEqual(summary.recent.at(-1), {
      type: "legacy_transition", at: 1001, resourceId: "zai/glm-5.3", fromLegacy: false, toLegacy: true,
    });
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("audit rejects child-shaped or unbounded records instead of becoming a prompt log", () => {
  const setup = journal();
  try {
    assert.throws(() => setup.journal.recordRoute({ status: "completed", resourceId: "zai/glm-5.3", route: [] }), /1\.\.64/);
    assert.throws(() => setup.journal.recordRoute({ status: "completed", resourceId: "zai/glm-5.3", route: [{ resourceId: "bad id", outcome: "completed" }] }), /resource id/);
    assert.throws(() => setup.journal.recordCurrency({ "zai/glm-5.3": { legacy: "no" } }), /boolean legacy/);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});
