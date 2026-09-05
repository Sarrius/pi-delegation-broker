import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  apexAdmissionAllows,
  apexAdmissionKind,
  authorizeApexRescue,
  createOwnerModelAdmission,
} from "../src/apex-admission.mjs";

const TASK = "Audit the parser and return the exact failing invariant.";
const DIGEST = createHash("sha256").update(TASK).digest("hex");
const NOW = 2_000_000;

function report(taskId, resourceId, outcome = "semantic_failure") {
  const routeOutcome = outcome === "semantic_rejection" ? "verification_rejected"
    : outcome === "no_progress" ? "no_progress"
      : outcome === "capability_gap" ? "context_exhausted"
        : "fatal";
  return {
    taskId,
    logicalId: taskId,
    status: "failed",
    task: TASK,
    taskDigest: DIGEST,
    failureClass: outcome,
    routeSteps: [{ resourceId, outcome: routeOutcome }],
    startedAt: NOW - 10_000,
    completedAt: NOW - 1_000,
    readAt: null,
    wakeClaimedAt: null,
    wakeAt: null,
  };
}

function evidence(overrides = {}) {
  const reports = {
    first: report("first", "openai-codex-account-2/gpt-5.6-sol", "semantic_rejection"),
    second: report("second", "anthropic-account-2/claude-opus-5", "semantic_failure"),
    ...(overrides.reports ?? {}),
  };
  const jobs = Object.fromEntries(Object.keys(reports).map((id) => [id, { jobId: id, ownerSessionId: "owner-session" }]));
  return {
    task: overrides.task ?? TASK,
    reportIds: overrides.reportIds ?? ["first", "second"],
    loadReport: (id) => reports[id],
    loadJob: (id) => overrides.jobs?.[id] ?? jobs[id],
    ownerSessionId: overrides.ownerSessionId ?? "owner-session",
    now: () => NOW,
  };
}

test("owner model admission is exact and cannot be reused for another apex identity", () => {
  const admission = createOwnerModelAdmission({ provider: "openai-codex-account-2", modelId: "gpt-6-astra" });
  assert.equal(apexAdmissionKind(admission), "owner_primary");
  assert.equal(apexAdmissionAllows(admission, { provider: "openai-codex-account-2", modelId: "gpt-6-astra" }), true);
  assert.equal(apexAdmissionAllows(admission, { provider: "anthropic", modelId: "claude-fable-5-1" }), false);
  assert.equal(apexAdmissionKind(structuredClone(admission)), undefined, "the controller-only brand cannot survive caller serialization");
});

test("two materially distinct verified frontier failures authorize a bounded apex rescue", () => {
  const admission = authorizeApexRescue(evidence());
  assert.equal(apexAdmissionKind(admission), "rescue");
  assert.equal(apexAdmissionAllows(admission, { provider: "anthropic", modelId: "claude-fable-5-1" }), true);
  assert.equal(admission.reportIds.length, 2);
  assert.deepEqual(new Set(admission.failedDevelopers), new Set(["openai", "anthropic"]));
  assert.match(admission.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(admission.maxAttempts, 2);
  assert.ok(admission.expiresAt > NOW);
});

test("transport failures, foreign jobs, mismatched tasks, and prior apex attempts cannot mint rescue authority", () => {
  assert.throws(() => authorizeApexRescue(evidence({ reports: {
    first: { ...report("first", "openai-codex-account-2/gpt-5.6-sol"), failureClass: "route_failure", routeSteps: [{ resourceId: "openai-codex-account-2/gpt-5.6-sol", outcome: "rate_limited" }] },
  } })), /semantic failure evidence/);
  assert.throws(() => authorizeApexRescue(evidence({ task: `${TASK} changed` })), /task digest/);
  assert.throws(() => authorizeApexRescue(evidence({ jobs: { first: { jobId: "first", ownerSessionId: "someone-else" } } })), /owner session/);
  assert.throws(() => authorizeApexRescue(evidence({ reports: {
    second: report("second", "openai-codex-account-2/gpt-6-astra", "semantic_failure"),
  } })), /already used an apex model/);
});

test("one model repeated on multiple reports is not materially distinct evidence", () => {
  assert.throws(() => authorizeApexRescue(evidence({ reports: {
    second: report("second", "openai-codex-account-3/gpt-5.6-sol", "semantic_failure"),
  } })), /two materially distinct frontier models/);
});
