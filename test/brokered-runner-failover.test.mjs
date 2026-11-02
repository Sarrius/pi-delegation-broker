import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrokeredChildRunner, classifyChildFailure } from "../src/brokered-runner.mjs";
import { markTaskAdmitted, readJob, submitJob } from "../src/delegation-job-store.mjs";
import { Semaphore } from "../src/semaphore.mjs";
import { proxyTerminalError } from "../src/proxy-context.mjs";

// The runner must finish a delegated task across a provider set that changes underneath it.
// A real child process is not needed to prove that: what matters is that a provider failure is
// classified as a routing fact, reported to the broker, excluded, and retried elsewhere.

/**
 * A resolver that hands out resources from a list and records health reports, standing in for
 * the broker without a socket.
 */
function fakeResolver({ resources, health = [], authorizationPolicy }) {
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
          ...(authorizationPolicy ? { authorizationPolicy } : {}),
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
          : { stopReason: outcome.stopReason ?? "end_turn", content: [{ type: "text", text: outcome.text ?? "done" }] },
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

for (const [name,policy,retries] of [
  ["bound observe",{operationClass:"observe",effectCapable:false},true],
  ["non-observe policy",{operationClass:"apply",effectCapable:false},false],
  ["missing effect declaration",{operationClass:"observe"},false],
  ["missing authorization policy",undefined,false],
]) test(`a truncated stream retries only safe bound read-only work: ${name}`,async()=>{
 const resolver=fakeResolver({resources:[{id:"cursor/composer"},{id:"other/reviewer"}],authorizationPolicy:policy});
 const {runner,root}=runnerWith(resolver,scriptedSpawn([{error:"controller provider terminal: stream_truncated (200)"},{text:"verified-source findings"}]));
 try {
  const result=await runner.run({childId:"truncated-safe",promptDigest:"c".repeat(64),cwd:root,prompt:"review",maxAttempts:2,
   capabilityRequest:{operationClass:"observe"}}); // Caller claim is not authoritative.
  assert.equal(result.status,retries?"completed":"failed");
  assert.equal(result.route.length,retries?2:1);
  assert.equal(resolver.reports.length,retries?1:0);
  if(retries){assert.equal(result.route[1].resourceId,"other/reviewer");assert.equal(resolver.reports[0].scope,"resource");}
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("parent handoff occurs only after exact route admission and child session construction", async () => {
  const steps = [];
  const base = fakeResolver({ resources: [{ id: "acct-a/model" }] });
  const resolver = {
    ...base,
    async resolve(request) { steps.push("select"); return base.resolve(request); },
  };
  const { runner, root } = runnerWith(resolver, async (options) => {
    steps.push("child_opened");
    const child = await scriptedSpawn([{ text: "accepted" }])(options);
    child.session.prompt = async () => { steps.push("prompt"); };
    return child;
  });
  try {
    const result = await runner.run({
      childId: "job-parent-handoff", promptDigest: "c".repeat(64), cwd: root, prompt: "read a file",
      onAttemptStarted({ resourceId }) { steps.push(`handed_off:${resourceId}`); },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.childHandoffs, 1, "the metric counts a genuine post-admission child handoff");
    assert.deepEqual(steps, ["select", "child_opened", "handed_off:acct-a/model", "prompt"],
      "the provider must not receive the task before durable parent handoff");
  } finally { rmSync(root, { recursive: true, force: true }); }

  let handoffs = 0;
  const denied = runnerWith({ async resolve() { return { action: "deny", reason: "no viable route" }; } },
    () => { throw new Error("unadmitted child launched"); });
  try {
    const result = await denied.runner.run({
      childId: "job-not-admitted", promptDigest: "c".repeat(64), cwd: denied.root, prompt: "read a file",
      onAttemptStarted() { handoffs += 1; },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.childHandoffs, 0, "a pre-handoff denial is not a physical child start");
    assert.equal(handoffs, 0, "a denied route never transfers ownership to a child");
  } finally { rmSync(denied.root, { recursive: true, force: true }); }

  const rejectedHandoff = runnerWith(fakeResolver({ resources: [{ id: "acct-a/model" }] }),
    scriptedSpawn([{ text: "never prompted" }]));
  try {
    const result = await rejectedHandoff.runner.run({
      childId: "job-handoff-not-recorded", promptDigest: "c".repeat(64), cwd: rejectedHandoff.root,
      prompt: "read a file", onAttemptStarted() { throw new Error("durable handoff failed"); },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.route[0].outcome, "controller_handoff_failed");
    assert.equal(result.childHandoffs, 0, "opened-but-rejected sessions must not be counted as handed to the child");
  } finally { rmSync(rejectedHandoff.root, { recursive: true, force: true }); }
});

test("controller verification sees the child-resolved effort, not only the requested effort", async () => {
  let closed;
  const base = fakeResolver({ resources: [{ id: "acct-a/model" }] });
  const resolver = { ...base, async resolve(request) {
    const decision = await base.resolve(request);
    decision.policy.onChildSessionClosed = (observation) => { closed = observation; };
    return decision;
  } };
  const spawn = async (options) => {
    const child = await scriptedSpawn([{text:"accepted"}])(options);
    child.resolved = {...child.resolved,thinkingLevel:"low"};
    return child;
  };
  const {runner,root} = runnerWith(resolver,spawn);
  try {
    const result=await runner.run({childId:"effort-observed",promptDigest:"c".repeat(64),cwd:root,
      prompt:"read a file",thinkingLevel:"off"});
    assert.equal(result.status,"completed");
    assert.equal(result.requestedThinking,"off");
    assert.equal(closed.effectiveThinking,"low", "verified outcome metadata comes from the leased child resolution");
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("read-only default can complete beyond 16k cumulative output; an explicit 6k cap still fails visibly", async () => {
  const spawn = async (options) => {
    const child = await scriptedSpawn([{ text: "evidence-backed answer" }])(options);
    child.session.usage = { input: 1200, output: 19000 };
    return child;
  };
  const live = runnerWith(fakeResolver({ resources: [{ id: "acct-a/model" }] }), spawn);
  try {
    const result = await live.runner.run({
      childId: "read-only-no-cap", promptDigest: "c".repeat(64), cwd: live.root, prompt: "review",
      capabilityRequest: { budget: { maxAttempts: 2, enforcement: { input: "metered_best_effort", output: "unavailable" } } },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.usage.output, 19000);
  } finally { rmSync(live.root, { recursive: true, force: true }); }
  const capped = runnerWith(fakeResolver({ resources: [{ id: "acct-a/model" }] }), spawn);
  try {
    const result = await capped.runner.run({
      childId: "read-only-explicit-cap", promptDigest: "c".repeat(64), cwd: capped.root, prompt: "review",
      capabilityRequest: { budget: { maxOutputTokens: 6000, maxAttempts: 2,
        enforcement: { input: "metered_best_effort", output: "hard" } } },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /19000 > 6000/);
    assert.equal(result.route[0].outcome, "budget_exceeded");
    assert.equal(result.usage.output, 19000);
  } finally { rmSync(capped.root, { recursive: true, force: true }); }
});

test("a 429 failover retains one durable parent handoff while the replacement finishes", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/model" }, { id: "acct-b/model" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: "HTTP 429 Too Many Requests" }, { text: "verified result" },
  ]));
  const jobId = "job-handoff-failover";
  const submittedAt = Date.now();
  submitJob(root, {
    schemaVersion: 1, jobId, kind: "task", status: "submitted", task: "read a file", cwd: root,
    submittedAt, updatedAt: submittedAt,
  });
  const admissions = [];
  try {
    const result = await runner.run({
      childId: jobId, promptDigest: "c".repeat(64), cwd: root, prompt: "read a file",
      onAttemptStarted({ attempt }) {
        admissions.push({ attempt, statusBefore: readJob(root, jobId)?.status });
        markTaskAdmitted(root, jobId);
      },
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(admissions, [
      { attempt: 1, statusBefore: "submitted" }, { attempt: 2, statusBefore: "running" },
    ]);
    assert.equal(readJob(root, jobId)?.status, "running");
    assert.deepEqual(result.route.map((step) => step.outcome), ["rate_limited", "completed"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed durable parent handoff aborts the child without quarantining a healthy provider", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/model" }, { id: "acct-b/model" }] });
  let aborts = 0, prompts = 0;
  const { runner, root } = runnerWith(resolver, async (options) => {
    const child = await scriptedSpawn([{ text: "not accepted" }])(options);
    child.session.abort = async () => { aborts += 1; };
    child.session.prompt = async () => { prompts += 1; };
    return child;
  });
  try {
    const result = await runner.run({
      childId: "job-handoff-rejected", promptDigest: "c".repeat(64), cwd: root, prompt: "read a file",
      onAttemptStarted() { throw new Error("durable job was cancelled"); },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /parent-to-child admission/);
    assert.deepEqual(result.route.map((step) => step.outcome), ["controller_handoff_failed"]);
    assert.equal(aborts, 1);
    assert.equal(prompts, 0, "a rejected handoff must spend zero provider requests");
    assert.deepEqual(resolver.reports, [], "controller-owned state failure is not provider health evidence");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plain provider connection errors are failover-eligible route failures", () => {
  assert.equal(classifyChildFailure("Connection error."), "unavailable");
});

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
  assert.equal(classifyChildFailure("controller lease heartbeat failed"), "controller_failure");
  assert.equal(classifyChildFailure("broker behavioral monitor is unavailable"), "controller_failure");
  assert.equal(classifyChildFailure("child stopped with an unresolved tool request"), "incomplete");
  assert.equal(classifyChildFailure("This operation was aborted"), "fatal");
  assert.equal(classifyChildFailure("controller behavioral terminal: no_progress"), "controller_failure");
  assert.equal(classifyChildFailure("child was aborted before completion"), "fatal");
});

test("a controller-local provider terminal fails visibly without poisoning or hopping routes", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/model" }, { id: "acct-b/model" }] });
  let launches = 0;
  const spawnChild = scriptedSpawn([
    { error: "controller provider terminal: controller_failure" },
    { text: "must not run" },
  ]);
  const { runner, root } = runnerWith(resolver, async (options) => {
    launches += 1;
    return spawnChild(options);
  });

  try {
    const result = await runner.run({
      childId: "job-controller-failure",
      promptDigest: "c".repeat(64),
      cwd: root,
      prompt: "research",
    });
    assert.equal(result.status, "failed");
    assert.equal(launches, 1, "a controller defect must not churn through provider routes");
    assert.deepEqual(result.route.map((attempt) => attempt.outcome), ["controller_failure"]);
    assert.deepEqual(resolver.reports, [], "controller-origin failure is not provider health evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child stopped at a tool request is retried without blaming provider health", async () => {
  const resolver = fakeResolver({ resources: [{ id: "cursor/composer" }, { id: "codex/research" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { stopReason: "toolUse", text: "I'll start by reading the project instructions." },
    { text: "Verified findings with source URLs." },
  ]));

  try {
    const result = await runner.run({
      childId: "job-unresolved-tool",
      promptDigest: "c".repeat(64),
      cwd: root,
      prompt: "research and report findings",
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.route.map((attempt) => attempt.outcome), ["incomplete", "completed"]);
    assert.match(result.route[0].error, /unresolved tool request/);
    assert.deepEqual(resolver.reports, [], "protocol non-completion is not provider downtime");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

for (const [outcome, expected] of [["quota_fatal", "account_exhausted"], ["context_window_exceeded", "context_exhausted"]]) {
  test(`normalized ${outcome} without HTTP prose uses a suitable alternative instead of ending work`, async () => {
    const error = proxyTerminalError({ payload: { outcome, providerReason: outcome === "quota_fatal" ? "quota_exhausted" : outcome } });
    assert.equal(classifyChildFailure(error), expected);
    const resolver = fakeResolver({ resources: [{ id: "acct-a/model" }, ...(outcome === "quota_fatal" ? [{ id: "acct-a/sibling" }] : []), { id: "acct-b/model" }] });
    const selections = [];
    const resolve = resolver.resolve;
    resolver.resolve = (request) => { selections.push(request.capabilityRequest); return resolve(request); };
    const { runner, root } = runnerWith(resolver, scriptedSpawn([{ error }, { text: "completed elsewhere" }]));
    try {
      const result = await runner.run({ childId: `normalized-${outcome}`, promptDigest: "c".repeat(64), cwd: root, prompt: "read source" });
      assert.equal(result.status, "completed");
      assert.deepEqual(result.route.map(entry => entry.outcome), [expected, "completed"]);
      assert.equal(result.route[1].resourceId, "acct-b/model");
      assert.equal(resolver.reports.length, outcome === "quota_fatal" ? 1 : 0);
      if (outcome === "quota_fatal") {
        assert.equal(resolver.reports[0].kind, "unavailable", "missing reset hint uses bounded recovery, not a fabricated multi-hour reset");
        assert.equal(resolver.reports[0].scope, "capacity_group");
      } else assert.deepEqual(selections[1].requiredCapabilities, ["large_context"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

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

test("an unobserved provider response does not quarantine untried sibling models", async () => {
  const resolver = fakeResolver({ resources: [
    { id: "google-antigravity/claude-opus-5-5-high" },
    { id: "google-antigravity/gemini-3.8-flash-low" },
    { id: "other/fallback" },
  ] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: "controller provider terminal: transport_before_headers" },
    { text: "sibling is usable" },
  ]));
  try {
    const result = await runner.run({ childId: "job-unknown-response", promptDigest: "d".repeat(64),
      cwd: root, prompt: "x", capabilityRequest: { budget: { maxAttempts: 2 } } });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.route.map(attempt => attempt.resourceId), [
      "google-antigravity/claude-opus-5-5-high", "google-antigravity/gemini-3.8-flash-low",
    ]);
    assert.deepEqual(resolver.reports.map(report => report.scope), ["resource"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * Incident `workflow-mtoplh4l-7`: the Cursor loopback bridge was dead (nothing listening), so
 * `cursor/composer-2.5` failed before any response header, and the two-attempt budget was then
 * spent on its sibling alias `composer-2.5-fast` behind the same dead endpoint. A failure with no
 * observed response alone does not prove endpoint failure. Explicit connection refusal does,
 * and must leave the remaining attempt for a different account.
 */
test("an unreachable endpoint condemns the account immediately instead of burning the last attempt on a sibling alias", async () => {
  const resolver = fakeResolver({ resources: [
    { id: "cursor/composer-2.5" },
    { id: "cursor/composer-2.5-fast" },
    { id: "anthropic-account-2/claude-sonnet-5" },
  ] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: "connection refused ECONNREFUSED" },
    { text: "served by a live account" },
  ]));

  try {
    const result = await runner.run({
      childId: "job-dead-endpoint", promptDigest: "d".repeat(64), cwd: root, prompt: "x",
      capabilityRequest: { budget: { maxAttempts: 2 } },
    });
    assert.equal(result.status, "completed", "the second attempt must leave the dead account");
    assert.deepEqual(
      result.route.map((attempt) => attempt.resourceId),
      ["cursor/composer-2.5", "anthropic-account-2/claude-sonnet-5"],
      "the sibling alias behind the same dead endpoint must never be attempted",
    );
    assert.deepEqual(resolver.reports.map((report) => report.scope), ["capacity_group"]);
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

test("the default bound crosses eight dead accounts and reaches the ninth live provider", async () => {
  const resources = Array.from({ length: 9 }, (_, index) => ({ id: `provider-${index + 1}/model` }));
  const resolver = fakeResolver({ resources });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    ...Array.from({ length: 8 }, () => ({ error: "503 service unavailable" })),
    { text: "ninth route works" },
  ]));

  try {
    const result = await runner.run({ childId: "job-wide-failover", promptDigest: "c".repeat(64), cwd: root, prompt: "x" });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "ninth route works");
    assert.equal(result.route.length, 9);
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

test("a killed attempt still hands the parent the work its journal already holds", async () => {
  // Real incident: three broad delegated audits were killed for exceeding an output budget and the
  // terminal report said only `Error: controller cumulative output budget exceeded` with `text: ""`.
  // Every token the children spent (23k-36k output) was invisible. The child's fsynced journal holds
  // the public text it had already streamed, so a failure must never surface as an empty result.
  const resolver = fakeResolver({ resources: [{ id: "cursor/composer-2.5" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: "child was aborted before completion" },
  ]));
  const sessionsDir = join(root, "sessions", "job-partial", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, "partial-fixture.jsonl"), [
    JSON.stringify({ type: "text_delta", text: "The rotation stops because" }),
    JSON.stringify({ type: "text_delta", text: " pendingResumeHops hits the budget." }),
    "",
    // Deliberately looks like provider trouble: recovering this text must NOT reclassify the
    // failure, or a budget kill would bench an innocent account as rate limited.
    JSON.stringify({ type: "text_delta", text: " (the upstream 429 rate limit is unrelated)" }),
  ].join("\n") + "\n");

  try {
    const result = await runner.run({
      childId: "job-partial",
      promptDigest: "c".repeat(64),
      cwd: root,
      prompt: "audit the extension",
    });
    assert.notEqual(result.status, "completed", "recovered partial work is never acceptance");
    assert.equal(
      result.text,
      "The rotation stops because pendingResumeHops hits the budget. (the upstream 429 rate limit is unrelated)",
      "the parent must receive the work the child already produced, not an empty failure",
    );
    assert.ok(
      !result.route.some((attempt) => attempt.outcome === "rate_limited"),
      `a child's own prose must not become a provider-health verdict: ${JSON.stringify(result.route)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["This operation was aborted", "controller behavioral terminal: no_progress"])
test(`an unattributed/local guard abort cannot poison a provider or replay terminal work: ${failure}`, async () => {
  const resolver = fakeResolver({ resources: [{ id: "cursor/composer-2.5" }, { id: "kimi-coding/k3" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { error: failure },
    { text: "must not reach the fallback route" },
  ]));

  try {
    const result = await runner.run({
      childId: "job-provider-abort",
      promptDigest: "c".repeat(64),
      cwd: root,
      prompt: "continue the review",
    });
    assert.equal(result.status, "failed");
    assert.equal(result.route.length, 1);
    assert.equal(result.error, failure);
    assert.equal(resolver.reports.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child stopReason aborted is not a completed answer or proof of provider failure", async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/weak" }, { id: "acct-b/weak" }] });
  const { runner, root } = runnerWith(resolver, scriptedSpawn([
    { stopReason: "aborted", text: "I'll start by reading the project instructions." },
    { text: "done elsewhere" },
  ]));

  try {
    const result = await runner.run({
      childId: "job-stop-aborted",
      promptDigest: "c".repeat(64),
      cwd: root,
      prompt: "x",
    });
    assert.equal(result.status, "failed");
    assert.equal(result.route[0].outcome, "fatal");
    assert.match(result.route[0].error, /child was aborted/);
    assert.equal(result.route.length, 1);
    assert.equal(resolver.reports.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const providerError of ["This operation was aborted", "controller provider terminal: stream_truncated (200)"])
test(`an operator abort does not fail over onto another provider: ${providerError}`, async () => {
  const resolver = fakeResolver({ resources: [{ id: "acct-a/weak" }, { id: "acct-b/weak" }], authorizationPolicy: { operationClass: "observe", effectCapable: false } });
  let releasePrompt;
  let spawned = 0;
  const { runner, root } = runnerWith(resolver, async ({ spec }) => {
    spawned += 1;
    return {
      resolved: { model: spec.model },
      session: {
        usage: { input: 1, output: 1 },
        latestAssistantMessage: {
          stopReason: "error",
          errorMessage: providerError,
          content: [],
        },
        async prompt() {
          await new Promise((resolve) => { releasePrompt = resolve; });
        },
        async abort() { releasePrompt?.(); },
        async dispose() {},
      },
    };
  });

  try {
    const completion = runner.run({
      childId: "job-operator-abort",
      promptDigest: "c".repeat(64),
      cwd: root,
      prompt: "x",
    });
    for (let i = 0; i < 100 && runner.activeAttempts()[0]?.state !== "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(runner.activeAttempts()[0]?.state, "running");
    await runner.abort("job-operator-abort");
    const result = await completion;
    assert.equal(result.status, "aborted");
    assert.equal(spawned, 1, "cancelled work must not hop onto the next account");
    assert.equal(result.route.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
