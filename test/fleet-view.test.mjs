import assert from "node:assert/strict";
import test from "node:test";

import { buildFleetProjection, formatDelegationStatus, formatFleetDetails, formatFleetWidget, terminalWidth } from "../src/fleet-view.mjs";

const NOW = 1_000_000;

test("fleet projection overlays volatile attempts on durable task and workflow nodes", () => {
  const jobs = [
    {
      jobId: "task-a", kind: "task", status: "running", task: "Collect current provider evidence",
      submittedAt: NOW - 20_000, startedAt: NOW - 18_000, updatedAt: NOW - 18_000,
    },
    {
      jobId: "workflow-b", kind: "workflow", status: "running", submittedAt: NOW - 30_000,
      startedAt: NOW - 29_000, updatedAt: NOW - 2_000,
      nodes: [
        { id: "research", task: "Research independently", state: "completed", result: { reportTaskId: "report-r" } },
        { id: "review", task: "Review accepted research", state: "running", dependsOn: ["research"] },
        { id: "merge", task: "Merge findings", state: "pending", dependsOn: ["review"] },
      ],
    },
  ];
  const attempts = [
    {
      attemptId: "task-a", logicalId: "task-a", rootId: "task-a", kind: "task", attempt: 1,
      state: "running", resourceId: "openai-codex-account-4/gpt-5.6-sol", provider: "openai-codex-account-4",
      modelId: "gpt-5.6-sol", requestedThinking: "off", effectiveThinking: "low", startedAt: NOW - 18_000,
      lastProgressAt: NOW - 2_000, usage: { input: 1200, output: 300, cacheRead: 40, cacheWrite: 0, turns: 2 },
    },
    {
      attemptId: "workflow-b-review-r2", logicalId: "workflow-b/review", rootId: "workflow-b",
      workflowId: "workflow-b", nodeId: "review", kind: "workflow_node", attempt: 2, state: "running",
      resourceId: "cursor/composer-2.5", provider: "cursor", modelId: "composer-2.5",
      requestedThinking: "off", effectiveThinking: "off", startedAt: NOW - 8_000,
      lastProgressAt: NOW - 7_000, usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, turns: 1 },
    },
  ];

  const fleet = buildFleetProjection({ jobs, attempts, now: NOW, noProgressTimeoutMs: 5_000 });
  const task = fleet.rows.find((row) => row.id === "task-a");
  const review = fleet.rows.find((row) => row.id === "workflow-b/review");
  assert.equal(task.route, "openai-codex-account-4/gpt-5.6-sol");
  assert.equal(task.effectiveThinking, "low");
  assert.equal(task.liveness, "alive");
  assert.equal(task.persistence, "durable_job+volatile_attempt");
  assert.equal(review.state, "retrying");
  assert.equal(review.liveness, "stalled");
  assert.equal(review.attempt, 2);
  assert.equal(fleet.counts.running, 1);
  assert.equal(fleet.counts.retrying, 1);
  assert.equal(fleet.counts.stalled, 1);
});

test("delegation status reports volatile route waits instead of durable running promises", () => {
  const job = {
    jobId: "workflow-live", kind: "workflow", status: "running", submittedAt: NOW - 10_000, updatedAt: NOW,
    nodes: [
      { id: "working", state: "running", dependsOn: [] },
      { id: "waiting", state: "running", dependsOn: [] },
    ],
  };
  const fleet = buildFleetProjection({
    now: NOW,
    jobs: [job],
    attempts: [{
      attemptId: "workflow-live-working", logicalId: "workflow-live/working", rootId: "workflow-live",
      workflowId: "workflow-live", nodeId: "working", kind: "workflow_node", attempt: 1, state: "running",
      resourceId: "cursor/composer-2.5", provider: "cursor", modelId: "composer-2.5",
      startedAt: NOW - 5_000, lastProgressAt: NOW - 1_000, usage: {},
    }, {
      attemptId: "workflow-live-waiting-r2", logicalId: "workflow-live/waiting", rootId: "workflow-live",
      workflowId: "workflow-live", nodeId: "waiting", kind: "workflow_node", attempt: 2, state: "waiting_capacity",
      startedAt: NOW - 4_000, usage: {},
    }],
  });
  const status = formatDelegationStatus(job, fleet);
  assert.match(status, /working: running \(cursor\/composer-2\.5/);
  assert.match(status, /waiting: waiting_capacity \(route:pending; durable=running/);
  assert.doesNotMatch(status, /waiting: running(?:\n|$)/);
});

test("fleet widget is bounded, identifies real routes, and never includes task prose", () => {
  const secretLikeTask = "Inspect secret prompt with child prose SHOULD_NOT_RENDER";
  const fleet = buildFleetProjection({
    now: NOW,
    jobs: [{ jobId: "task-visible", kind: "task", status: "running", task: secretLikeTask, submittedAt: NOW - 5000, updatedAt: NOW - 5000 }],
    attempts: [{
      attemptId: "task-visible", logicalId: "task-visible", rootId: "task-visible", kind: "task", attempt: 1,
      state: "running", resourceId: "cursor/composer-2.5", provider: "cursor", modelId: "composer-2.5",
      effectiveThinking: "medium", requestedThinking: "medium", startedAt: NOW - 4000, lastProgressAt: NOW - 1000,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, turns: 1 },
    }],
  });
  const lines = formatFleetWidget(fleet, { maxRows: 1, width: 100 });
  assert.equal(lines.length, 2);
  assert.match(lines.join("\n"), /cursor\/composer-2\.5/);
  assert.match(lines.join("\n"), /medium/);
  assert.doesNotMatch(lines.join("\n"), /SHOULD_NOT_RENDER|secret prompt/);
  assert.ok(lines.every((line) => terminalWidth(line) <= 100));
});

test("fleet details distinguish durable terminal state from volatile progress", () => {
  const fleet = buildFleetProjection({
    now: NOW,
    jobs: [
      { jobId: "done", kind: "task", status: "completed", task: "done prose", submittedAt: NOW - 1000, completedAt: NOW, updatedAt: NOW },
      { jobId: "queued", kind: "task", status: "queued", task: "queued prose", submittedAt: NOW, updatedAt: NOW },
      { jobId: "recovered", kind: "task", status: "queued", recoveryCount: 1, task: "lost attempt prose", submittedAt: NOW - 2000, updatedAt: NOW },
    ],
    reports: [{
      taskId: "done", logicalId: "done", status: "completed", route: "completed cursor/composer-2.5",
      resourceId: "cursor/composer-2.5", provider: "cursor", modelId: "composer-2.5",
      effectiveThinking: "medium", usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 0, turns: 1 },
    }, {
      taskId: "legacy-only", status: "failed", task: "LEGACY_PROMPT_MUST_NOT_RENDER", error: "legacy failed",
      route: "failed \u001b]8;;bad\u0007openai/gpt\u001b\\\u202E", startedAt: NOW - 3000, completedAt: NOW - 1000,
    }],
    attempts: [],
  });
  const details = formatFleetDetails(fleet, { selector: "all", maxRows: 10, maxBytes: 4000 });
  assert.match(details, /done.*completed.*durable_job\+durable_report/);
  assert.match(details, /route=cursor\/composer-2\.5.*effort=medium/);
  assert.match(details, /queued.*queued.*durable_job/);
  assert.match(details, /recovered state=reconciling durable=queued persistence=durable_job liveness=lost/);
  assert.match(details, /legacy-only state=failed durable=failed persistence=durable_report/);
  assert.match(details, /route=failed openai\/gpt/);
  assert.doesNotMatch(details, /\u001b|\u0007|\u202E|done prose|queued prose|lost attempt prose|LEGACY_PROMPT/);
});

test("a running child that produced no observed progress reads unknown, not alive", () => {
  const fleet = buildFleetProjection({
    now: NOW,
    noProgressTimeoutMs: 180_000,
    jobs: [{ jobId: "silent", kind: "task", status: "running", task: "hidden", submittedAt: NOW - 9000, updatedAt: NOW - 9000 }],
    attempts: [{
      attemptId: "silent", logicalId: "silent", rootId: "silent", state: "running", kind: "task", attempt: 1,
      resourceId: "provider/model", provider: "provider", modelId: "model",
      requestedThinking: "off", effectiveThinking: "off",
      startedAt: NOW - 9000, lastEventAt: NOW - 100, lastEventType: "agent_settled", usage: {},
    }],
  });
  const [row] = fleet.rows;
  assert.equal(row.liveness, "unknown");
  assert.equal(row.progressAgeMs, undefined);
  const widget = formatFleetWidget(fleet, { maxRows: 5, width: 200 }).join("\n");
  assert.match(widget, /\?/);
  assert.match(widget, /obs:—/);
  assert.doesNotMatch(formatFleetDetails(fleet, { selector: "active" }), /liveness=alive|liveness=stalled/);
});

test("detail truncation is byte-bounded without scanning task prose", () => {
  const fleet = buildFleetProjection({
    now: NOW,
    reports: Array.from({ length: 256 }, (_, index) => ({
      taskId: `report-${index}`, status: "failed", task: "X".repeat(10_000),
      route: `provider-${index}/model-${index}`, startedAt: NOW - 2, completedAt: NOW - 1,
    })),
  });
  const details = formatFleetDetails(fleet, { selector: "all", maxRows: 256, maxBytes: 512 });
  assert.ok(Buffer.byteLength(details) <= 512);
  assert.doesNotMatch(details, /XXX/);
});

test("terminal workflow nodes are not rendered as active and exact reserved ids are addressable", () => {
  const fleet = buildFleetProjection({
    now: NOW,
    jobs: [{
      jobId: "all", kind: "workflow", status: "cancelled", submittedAt: NOW - 5000,
      completedAt: NOW - 1000, updatedAt: NOW - 1000,
      nodes: [{ id: "pending", task: "must not appear active", state: "pending", dependsOn: [] }],
    }],
  });
  assert.deepEqual(formatFleetWidget(fleet), []);
  assert.equal(fleet.counts.waiting, 0);
  const byId = formatFleetDetails(fleet, { selector: "all", selectorMode: "id" });
  assert.match(byId, /all state=cancelled/);
  assert.match(byId, /all\/pending state=pending/);
});

test("widget clipping uses terminal cell width for wide Unicode", () => {
  const fleet = buildFleetProjection({
    now: NOW,
    jobs: [{ jobId: "wide", kind: "task", status: "running", task: "hidden", submittedAt: NOW, updatedAt: NOW }],
    attempts: [{
      attemptId: "wide", logicalId: "wide", rootId: "wide", state: "running", kind: "task", attempt: 1,
      resourceId: "provider/模型-😀-very-long", provider: "provider", modelId: "模型-😀-very-long",
      requestedThinking: "off", effectiveThinking: "off", startedAt: NOW - 1000,
      lastProgressAt: NOW - 500, usage: {},
    }],
  });
  const lines = formatFleetWidget(fleet, { maxRows: 1, width: 40 });
  assert.ok(lines.every((line) => terminalWidth(line) <= 40));
  for (const narrow of [1, 2, 3, 5, 8, 12, 20, 31]) {
    const rendered = formatFleetWidget(fleet, { maxRows: 1, width: narrow });
    assert.ok(rendered.every((line) => terminalWidth(line) <= narrow), `width ${narrow} overflowed`);
  }
  for (const fractional of [15.9, 33.2, 7.5]) {
    const rendered = formatFleetWidget(fleet, { maxRows: 1, width: fractional });
    assert.ok(rendered.every((line) => terminalWidth(line) <= Math.floor(fractional)), `width ${fractional} overflowed`);
  }
  for (const degenerate of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined, "80"]) {
    const rendered = formatFleetWidget(fleet, { maxRows: 1, width: degenerate });
    assert.ok(rendered.every((line) => terminalWidth(line) <= 120));
  }
});

test("a bounded input is declared instead of being shown as a complete fleet", () => {
  const fleet = buildFleetProjection({
    now: NOW, inputTruncated: true,
    jobs: [{ jobId: "one", kind: "task", status: "queued", task: "hidden", submittedAt: NOW, updatedAt: NOW }],
  });
  assert.equal(fleet.truncated, true);
  assert.match(formatFleetDetails(fleet, { selector: "all" }), /bounded/);
});
