import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrokeredChildRunner, classifyChildFailure } from "../src/brokered-runner.mjs";
import { Semaphore } from "../src/semaphore.mjs";

// The runner must finish a delegated task across a provider set that changes underneath it.
// A real child process is not needed to prove that: what matters is that a provider failure is
// classified as a routing fact, reported to the broker, excluded, and retried elsewhere.

/**
 * A resolver that hands out resources from a list and records health reports, standing in for
 * the broker without a socket.
 */
function fakeResolver({ resources, health = [] }) {
  return {
    reports: health,
    async resolve(request) {
      // Honour the exclusions the runner threads through: that is the contract under test.
      const excluded = new Set(request.capabilityRequest?.excludeResources ?? []);
      const deadGroups = new Set(health.filter((report) => report.scope === "capacity_group").map((report) => report.resourceId.split("/")[0]));
      const resource = resources.find((entry) => !excluded.has(entry.id) && !deadGroups.has(entry.id.split("/")[0]));
      if (!resource) return { action: "deny", reason: "no compatible broker capacity" };
      return {
        action: "allow",
        resource: { id: resource.id, profile: "caps/text_generation/v1", capacityGroup: `G-${resource.id.split("/")[0]}` },
        resolvedModel: { provider: resource.id.split("/")[0], modelId: resource.id.split("/").slice(1).join("/") },
        policy: {
          policyId: `lease-${request.childId}`,
          agentDir: mkdtempSync(join(tmpdir(), "failover-")),
          environment: {},
          onChildSessionClosed: () => {},
          onChildSessionOpened: () => {},
          onBeforeChildAbandoned: () => {},
        },
      };
    },
    async reportProviderRateLimited(resourceId, retryAfterMs) {
      health.push({ resourceId, kind: "rate_limited", retryAfterMs, excluded: true });
    },
    async reportProviderUnavailable(resourceId, reason, scope) {
      health.push({ resourceId, kind: "unavailable", reason, scope, excluded: true });
    },
  };
}

/** A child that fails with a scripted error the first N times, then succeeds. */
function scriptedSpawn(script) {
  let call = 0;
  return async ({ spec }) => {
    const outcome = script[Math.min(call, script.length - 1)];
    call += 1;
    return {
      resolved: { model: spec.model },
      session: {
        usage: { input: 1, output: 1 },
        latestAssistantMessage: outcome.error
          ? { stopReason: "error", errorMessage: outcome.error, content: [] }
          : { stopReason: "end_turn", content: [{ type: "text", text: outcome.text ?? "done" }] },
        async prompt() {},
        async dispose() {},
        async abort() {},
      },
    };
  };
}

function runnerWith(resolver, spawnChild) {
  const root = mkdtempSync(join(tmpdir(), "failover-root-"));
  const runner = new BrokeredChildRunner({
    resolver,
    semaphore: new Semaphore(2),
    sessionsRoot: join(root, "sessions"),
    spawnChild,
  });
  return { runner, root };
}

test("a provider rate limit is classified as a routing fact, not a child failure", () => {
  assert.equal(classifyChildFailure("HTTP 429 Too Many Requests"), "rate_limited");
  assert.equal(classifyChildFailure("rate limit reached for this account"), "rate_limited");
  assert.equal(classifyChildFailure("401 Unauthorized"), "auth_fatal");
  assert.equal(classifyChildFailure("No API key found for cursor."), "auth_fatal");
  assert.equal(classifyChildFailure('OAuth refresh failed: invalid_grant; Refresh token not found or invalid'), "auth_fatal");
  assert.equal(classifyChildFailure("prompt is too long for the context window"), "context_exhausted");
  assert.equal(classifyChildFailure("503 service unavailable"), "unavailable");
  assert.equal(classifyChildFailure(`404: {"message":"model 'deepseek-v4-pro:0813' not found","type":"not_found_error"}`), "unavailable");
  assert.equal(classifyChildFailure("the tests did not pass"), "fatal");
  assert.equal(classifyChildFailure("child completed without a result"), "unavailable");
  assert.equal(classifyChildFailure("controller lease heartbeat failed"), "unavailable");
  assert.equal(classifyChildFailure("broker behavioral monitor is unavailable"), "unavailable");
});

test("a rate limit mid-run reports the account, reroutes, and the work still completes", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/weak" }, { id: "acct-b/weak" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: "HTTP 429 rate limit exceeded" },
    { text: "the file says hello" },
  ]));

  try {
    const result = await runner.run({
      childId: "job-1",
      promptDigest: "c".repeat(64),
      cwd: root,
      prompt: "read the file",
      capabilityRequest: { taskDescription: "read the file and summarize" },
    });

    assert.equal(result.status, "completed", "the job finished despite the limit");
    assert.equal(result.text, "the file says hello");
    assert.equal(result.route.length, 2, "one failed attempt, one successful");
    assert.equal(result.route[0].outcome, "rate_limited");
    assert.equal(result.route[0].resourceId, "acct-a/weak");
    assert.equal(result.route[1].outcome, "completed");
    assert.equal(result.route[1].resourceId, "acct-b/weak");

    assert.deepEqual(
      resolver.reports.map((report) => [report.resourceId, report.kind]),
      [["acct-a/weak", "rate_limited"]],
      "the throttled account was reported to the broker so every model of it cools down",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expired credential is reported as unavailable rather than merely cooled", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/weak" }, { id: "acct-b/weak" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: "401 Unauthorized: invalid api key" },
    { text: "done" },
  ]));

  try {
    const result = await runner.run({ childId: "job-2", promptDigest: "c".repeat(64), cwd: root, prompt: "x" });
    assert.equal(result.status, "completed");
    assert.equal(resolver.reports[0].kind, "unavailable", "waiting will not fix a revoked credential");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a context overflow re-routes without blaming the provider", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/small" }, { id: "acct-a/big" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: "prompt is too long: maximum context length exceeded" },
    { text: "done" },
  ]));

  try {
    const result = await runner.run({ childId: "job-3", promptDigest: "c".repeat(64), cwd: root, prompt: "x" });
    assert.equal(result.status, "completed");
    assert.equal(result.route[0].outcome, "context_exhausted");
    assert.deepEqual(resolver.reports, [], "the account is healthy; only this route was wrong");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale catalog model 404 is quarantined and retried on another route", async () => {
  const resolver = fakeResolver({ resources: [{ id: "ollama/stale" }, { id: "cursor/live" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: `404: {"message":"model 'stale' not found","type":"not_found_error"}` },
    { text: "done" },
  ]));

  try {
    const result = await runner.run({ childId: "job-stale-model", promptDigest: "c".repeat(64), cwd: root, prompt: "x" });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.route.map((attempt) => [attempt.resourceId, attempt.outcome]), [
      ["ollama/stale", "unavailable"],
      ["cursor/live", "completed"],
    ]);
    assert.deepEqual(resolver.reports.map((report) => [report.resourceId, report.kind]), [["ollama/stale", "unavailable"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two unavailable models on one account quarantine its capacity group before attempts are exhausted", async () => {
  const resolver = fakeResolver({ resources: [
    { id: "cursor/model-a" },
    { id: "cursor/model-b" },
    { id: "cursor/model-c" },
    { id: "openrouter/live" },
  ] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: "child completed without a result" },
    { error: "child completed without a result" },
    { text: "done elsewhere" },
  ]));

  try {
    const result = await runner.run({ childId: "job-dead-group", promptDigest: "c".repeat(64), cwd: root, prompt: "x" });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.route.map((attempt) => attempt.resourceId), ["cursor/model-a", "cursor/model-b", "openrouter/live"]);
    assert.deepEqual(resolver.reports.map((report) => report.scope), ["resource", "capacity_group"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a genuine task failure is not retried on another provider", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/weak" }, { id: "acct-b/weak" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([{ error: "the requested file does not exist" }]));

  try {
    const result = await runner.run({ childId: "job-4", promptDigest: "c".repeat(64), cwd: root, prompt: "x" });
    assert.equal(result.status, "failed");
    assert.equal(result.route.length, 1, "swapping providers cannot fix a task that is simply wrong");
    assert.deepEqual(resolver.reports, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("when every provider is throttled the run stops at its attempt bound and reports the trail", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/weak" }, { id: "acct-b/weak" }, { id: "acct-c/weak" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([{ error: "429 rate limit" }]));

  try {
    const result = await runner.run({ childId: "job-5", promptDigest: "c".repeat(64), cwd: root, prompt: "x", maxAttempts: 3 });
    assert.equal(result.status, "failed");
    assert.equal(result.route.length, 3, "bounded, not an infinite rotation storm");
    assert.ok(result.route.every((step) => step.outcome === "rate_limited"));
    // Every throttled account is reported, including the one that failed on the final attempt:
    // otherwise the last account stays healthy in broker state and the next task picks it first.
    assert.equal(resolver.reports.length, 3, "each throttled account was reported, terminal attempt included");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the semaphore is fully released after a multi-attempt run", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/weak" }, { id: "acct-b/weak" }] });
  const root = mkdtempSync(join(tmpdir(), "failover-sem-"));
  const semaphore = new Semaphore(1);
  const runner = new BrokeredChildRunner({
    resolver,
    semaphore,
    sessionsRoot: join(root, "sessions"),
    spawnChild: scriptedSpawn([{ error: "429 rate limit" }, { text: "done" }]),
  });

  try {
    const result = await runner.run({ childId: "job-6", promptDigest: "c".repeat(64), cwd: root, prompt: "x" });
    assert.equal(result.status, "completed");
    assert.equal(semaphore.running, 0, "a retried run must not leak an admission slot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child that settles with no answer fails over instead of reporting completed", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/weak" }, { id: "acct-b/weak" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { text: "" },
    { text: "name=@sars267/pi-delegation-broker" },
  ]));

  try {
    const result = await runner.run({
      childId: "job-empty",
      promptDigest: "c".repeat(64),
      cwd: root,
      prompt: "read the file",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "name=@sars267/pi-delegation-broker");
    assert.equal(result.route[0].outcome, "unavailable");
    assert.equal(result.route[0].error, "child completed without a result");
    assert.equal(result.route[1].outcome, "completed");
    assert.equal(resolver.reports[0].kind, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
