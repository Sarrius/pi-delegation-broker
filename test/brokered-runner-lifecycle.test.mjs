import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrokeredChildRunner } from "../src/brokered-runner.mjs";

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };

test("every attempt is tracked while its lease lives, but only a completed one is verified", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-lifecycle-"));
  const tracks = [];
  const closes = [];
  const healthy = [];
  let resolved = 0;
  let spawned = 0;
  const resolver = {
    async resolve(request) {
      const attempt = ++resolved;
      return {
        action: "allow",
        resource: { id: `provider/model-${attempt}` },
        resolvedModel: MODEL,
        selection: { modelTier: "cheap", preferenceSource: "auto" },
        policy: {
          policyId: `lease-${attempt}`,
          agentDir: root,
          environment: {},
          async onChildSessionOpened() {},
          async onBeforeChildAbandoned() {},
          async onProviderSucceeded() { healthy.push(`provider/model-${attempt}`); },
          async trackForVerification() { tracks.push(attempt); return { status: "tracked" }; },
          async onChildSessionClosed(result) { closes.push({ attempt, status: result.status, attempts: result.attempts }); return { status: "released" }; },
        },
      };
    },
    async reportProviderRateLimited() {},
  };
  const spawnChild = async () => {
    const attempt = ++spawned;
    const message = attempt === 1
      ? { stopReason: "error", errorMessage: "429 rate limit" }
      : { stopReason: "stop", content: [{ type: "text", text: "done" }] };
    return {
      resolved: MODEL,
      session: {
        usage: { input: 10, output: 5 },
        latestAssistantMessage: message,
        async prompt() {},
        async dispose() {},
      },
    };
  };
  try {
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild });
    const result = await runner.run({
      childId: "logical-task",
      promptDigest: "a".repeat(64),
      model: MODEL,
      cwd: root,
      prompt: "do work",
      trackForVerification: true,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.route.map((hop) => hop.outcome), ["rate_limited", "completed"]);
    // Tracking happens at handoff because the child releases its own lease when it exits, so a
    // post-run write would arrive too late. Tracking is bookkeeping, not acceptance: the failed
    // route requeues the task and only the completed route is closed toward verification.
    assert.deepEqual(tracks, [1, 2], "each attempt registers its own live lease");
    assert.deepEqual(closes, [
      { attempt: 1, status: "failed", attempts: 1 },
      { attempt: 2, status: "completed", attempts: 2 },
    ]);
    assert.deepEqual(healthy, ["provider/model-2"], "a completed child must rehabilitate the route it proved live");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("temporary broker capacity waits for the live account instead of consuming an attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-capacity-wait-"));
  let resolutions = 0;
  let delays = 0;
  const waitSnapshots = [];
  let runner;
  const resolver = {
    async resolve() {
      resolutions += 1;
      if (resolutions < 3) return { action: "deny", reason: "compatible broker capacity is temporarily busy" };
      return {
        action: "allow", resource: { id: "cursor/composer", capacityGroup: "G-cursor" }, resolvedModel: MODEL,
        policy: {
          policyId: "lease-capacity", agentDir: root, environment: {},
          async onChildSessionOpened() {}, async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { return { status: "released" }; },
        },
      };
    },
  };
  const spawnChild = async () => ({
    resolved: MODEL,
    session: {
      usage: { input: 1, output: 1 },
      latestAssistantMessage: { stopReason: "stop", content: [{ type: "text", text: "capacity recovered" }] },
      async prompt() {}, async dispose() {},
    },
  });
  try {
    runner = new BrokeredChildRunner({
      resolver, sessionsRoot: join(root, "sessions"), spawnChild,
      delay: async () => { delays += 1; waitSnapshots.push(runner.activeAttempts()[0]); },
      capacityWaitMs: 5_000, capacityRetryMs: 1,
    });
    const result = await runner.run({
      childId: "capacity-task", promptDigest: "a".repeat(64), cwd: root, prompt: "work", maxAttempts: 1,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "capacity recovered");
    assert.equal(result.route.length, 1, "capacity contention must not consume route attempts");
    assert.equal(result.route[0].attempt, 1);
    assert.equal(resolutions, 3);
    assert.equal(delays, 2);
    assert.equal(waitSnapshots.length, 2);
    assert.ok(waitSnapshots.every((snapshot) => snapshot.state === "waiting_capacity"));
    assert.ok(waitSnapshots.every((snapshot) => snapshot.resourceId === undefined));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real progress resets the watchdog while the absolute attempt ceiling stays separate", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-progress-"));
  let listener;
  const resolver = {
    async resolve() {
      return {
        action: "allow", resource: { id: "provider/model" }, resolvedModel: MODEL,
        policy: {
          policyId: "lease", agentDir: root, environment: {},
          async onChildSessionOpened() {}, async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { return { status: "released" }; },
        },
      };
    },
  };
  const spawnChild = async () => ({
    resolved: MODEL,
    session: {
      usage: { input: 1, output: 1 },
      latestAssistantMessage: { stopReason: "stop", content: [{ type: "text", text: "done" }] },
      subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
      async prompt() {
        await new Promise((resolve) => setTimeout(resolve, 600)); listener?.({ type: "message_update" });
        await new Promise((resolve) => setTimeout(resolve, 600)); listener?.({ type: "tool_execution_update" });
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      async abort() {}, async dispose() {},
    },
  });
  try {
    const runner = new BrokeredChildRunner({
      resolver, sessionsRoot: join(root, "sessions"), spawnChild,
      noProgressTimeoutMs: 1_000, attemptMaxRunMs: 2_500,
    });
    const result = await runner.run({ childId: "progress-task", promptDigest: "a".repeat(64), model: MODEL, cwd: root, prompt: "work", maxAttempts: 1 });
    assert.equal(result.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("active attempt projection reports actual route, effort, usage and positive progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-fleet-"));
  const fleetListeners = new Set();
  let now = 10_000;
  let releasePrompt;
  let markPromptStarted;
  const promptStarted = new Promise((resolve) => { markPromptStarted = resolve; });
  const promptReleased = new Promise((resolve) => { releasePrompt = resolve; });
  const resolver = {
    async resolve() {
      return {
        action: "allow",
        resource: { id: "openai-codex-account-4/gpt-5.6-sol", capacityGroup: "G-openai-4" },
        resolvedModel: { provider: "openai-codex-account-4", modelId: "gpt-5.6-sol" },
        selection: { modelTier: "frontier", preferenceSource: "owner" },
        policy: {
          policyId: "lease-fleet", agentDir: root, environment: {},
          async onChildSessionOpened() {}, async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { return { status: "released" }; },
        },
      };
    },
  };
  const spawnChild = async () => ({
    resolved: { provider: "openai-codex-account-4", modelId: "gpt-5.6-sol", thinkingLevel: "low", tools: ["read"] },
    session: {
      usage: { input: 33, output: 7, cacheRead: 4, cacheWrite: 0, turns: 1 },
      latestAssistantMessage: { stopReason: "stop", content: [{ type: "text", text: "done" }] },
      subscribe(fn) { fleetListeners.add(fn); return () => fleetListeners.delete(fn); },
      async prompt() { markPromptStarted(); await promptReleased; },
      async abort() {}, async dispose() {},
    },
  });
  try {
    const runner = new BrokeredChildRunner({
      resolver, sessionsRoot: join(root, "sessions"), spawnChild, now: () => now,
      noProgressTimeoutMs: 10_000, attemptMaxRunMs: 20_000,
    });
    const completion = runner.run({
      childId: "fleet-task", promptDigest: "a".repeat(64), cwd: root, prompt: "work", maxAttempts: 1,
      thinkingLevel: "off",
      fleet: { logicalId: "workflow-1/review", rootId: "workflow-1", workflowId: "workflow-1", nodeId: "review", kind: "workflow_node", role: "worker" },
    });
    await promptStarted;
    let [attempt] = runner.activeAttempts();
    assert.equal(attempt.logicalId, "workflow-1/review");
    assert.equal(attempt.resourceId, "openai-codex-account-4/gpt-5.6-sol");
    assert.equal(attempt.provider, "openai-codex-account-4");
    assert.equal(attempt.modelId, "gpt-5.6-sol");
    assert.equal(attempt.requestedThinking, "off");
    assert.equal(attempt.effectiveThinking, "low");
    assert.equal(attempt.state, "running");
    assert.deepEqual(attempt.usage, { input: 33, output: 7, cacheRead: 4, cacheWrite: 0, turns: 1 });

    now = 12_000;
    for (const notify of fleetListeners) notify({ type: "tool_execution_end" });
    [attempt] = runner.activeAttempts();
    assert.equal(attempt.lastProgressAt, 12_000);
    assert.equal(attempt.lastEventType, "tool_execution_end");
    now = 13_000;
    for (const notify of fleetListeners) notify({ type: "agent_settled" });
    [attempt] = runner.activeAttempts();
    assert.equal(attempt.lastEventAt, 13_000);
    assert.equal(attempt.lastEventType, "agent_settled");
    assert.equal(attempt.lastProgressAt, 12_000, "lifecycle chatter must not fake useful progress");

    releasePrompt();
    const result = await completion;
    assert.equal(result.status, "completed");
    assert.deepEqual(runner.activeAttempts(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("abort by logical child id reaches the active failover retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-abort-retry-"));
  let resolution = 0;
  let spawn = 0;
  let aborted = 0;
  let releaseRetry;
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  const resolver = {
    async resolve() {
      const id = ++resolution;
      return {
        action: "allow",
        resource: { id: `provider/model-${id}`, capacityGroup: `group-${id}` },
        resolvedModel: MODEL,
        policy: {
          policyId: `lease-${id}`, agentDir: root, environment: {},
          async onChildSessionOpened() {}, async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { return { status: "released" }; },
        },
      };
    },
    async reportProviderRateLimited() {},
  };
  const spawnChild = async () => {
    const number = ++spawn;
    if (number === 1) return {
      resolved: MODEL,
      session: {
        usage: { input: 1, output: 0 },
        latestAssistantMessage: { stopReason: "error", errorMessage: "429 rate limit" },
        async prompt() {}, async abort() {}, async dispose() {},
      },
    };
    return {
      resolved: MODEL,
      session: {
        usage: { input: 1, output: 0 }, latestAssistantMessage: undefined,
        async prompt() { await retryGate; },
        async abort() { aborted += 1; releaseRetry(); },
        async dispose() {},
      },
    };
  };
  try {
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild });
    const completion = runner.run({
      childId: "logical-task", promptDigest: "a".repeat(64), cwd: root, prompt: "work", maxAttempts: 2,
    });
    for (let i = 0; i < 100 && runner.activeAttempts()[0]?.attemptId !== "logical-task-r2"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(runner.activeAttempts()[0]?.attemptId, "logical-task-r2");
    await runner.abort("logical-task");
    assert.equal(aborted, 1);
    const result = await completion;
    assert.notEqual(result.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("disposing during capacity wait clears volatile fleet state and prevents later spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-dispose-wait-"));
  let releaseDelay;
  let spawned = 0;
  try {
    const runner = new BrokeredChildRunner({
      resolver: { async resolve() { return { action: "deny", reason: "compatible broker capacity is temporarily busy" }; } },
      sessionsRoot: join(root, "sessions"),
      spawnChild: async () => { spawned += 1; throw new Error("must not spawn"); },
      delay: async () => new Promise((resolve) => { releaseDelay = resolve; }),
      capacityWaitMs: 60_000, capacityRetryMs: 60_000,
    });
    const completion = runner.run({
      childId: "capacity-task", promptDigest: "a".repeat(64), cwd: root, prompt: "work", maxAttempts: 1,
    });
    for (let i = 0; i < 100 && runner.activeAttempts()[0]?.state !== "waiting_capacity"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(runner.activeAttempts()[0]?.state, "waiting_capacity");
    await runner.dispose();
    assert.deepEqual(runner.activeAttempts(), []);
    releaseDelay();
    const result = await completion;
    assert.equal(result.status, "aborted");
    assert.equal(spawned, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("abort during a capacity wait stops the run instead of paying for a later slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-abort-capacity-"));
  let releaseDelay;
  let spawned = 0;
  try {
    const runner = new BrokeredChildRunner({
      resolver: { async resolve() { return { action: "deny", reason: "compatible broker capacity is temporarily busy" }; } },
      sessionsRoot: join(root, "sessions"),
      spawnChild: async () => { spawned += 1; throw new Error("must not spawn"); },
      delay: async () => new Promise((resolve) => { releaseDelay = resolve; }),
      capacityWaitMs: 60_000, capacityRetryMs: 60_000,
    });
    const completion = runner.run({
      childId: "cancel-task", promptDigest: "a".repeat(64), cwd: root, prompt: "work", maxAttempts: 1,
    });
    for (let i = 0; i < 100 && runner.activeAttempts()[0]?.state !== "waiting_capacity"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(runner.activeAttempts()[0]?.state, "waiting_capacity");
    await runner.abort("cancel-task");
    releaseDelay();
    const result = await completion;
    assert.equal(result.status, "aborted");
    assert.match(result.error, /aborted before a child was launched/);
    assert.equal(spawned, 0);
    assert.deepEqual(runner.activeAttempts(), []);
    // An abort recorded for a finished id must not pre-kill a later run that reuses it.
    await runner.abort("cancel-task");
    const replay = runner.run({
      childId: "cancel-task", promptDigest: "a".repeat(64), cwd: root, prompt: "work", maxAttempts: 1,
    });
    for (let i = 0; i < 100 && runner.activeAttempts()[0]?.state !== "waiting_capacity"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(runner.activeAttempts()[0]?.state, "waiting_capacity", "a stale abort must not kill a reused id");
    await runner.dispose();
    releaseDelay();
    await replay;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancel between the capacity grant and the handle stops the newborn child and frees its lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-abort-postacquire-"));
  let closed = 0;
  let aborts = 0;
  let releaseResolve;
  const resolveGate = new Promise((resolve) => { releaseResolve = resolve; });
  let resolveEntered;
  const entered = new Promise((resolve) => { resolveEntered = resolve; });
  const resolver = {
    async resolve() {
      resolveEntered();
      await resolveGate;
      return {
        action: "allow",
        resource: { id: "provider/model", capacityGroup: "group" },
        resolvedModel: MODEL,
        policy: {
          policyId: "lease-1", agentDir: root, environment: {},
          async onChildSessionOpened() {},
          async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { closed += 1; return { status: "released" }; },
        },
      };
    },
  };
  const spawnChild = async () => ({
    resolved: MODEL,
    session: {
      usage: { input: 1, output: 0 }, latestAssistantMessage: undefined,
      async prompt() { await new Promise((resolve) => setTimeout(resolve, 50)); },
      async abort() { aborts += 1; }, async dispose() {},
    },
  });
  try {
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild });
    const completion = runner.run({
      childId: "post-acquire", promptDigest: "a".repeat(64), cwd: root, prompt: "work", maxAttempts: 1,
    });
    await entered;
    await runner.abort("post-acquire");
    releaseResolve();
    const result = await completion;
    assert.equal(result.status, "aborted");
    assert.match(result.error, /aborted after launch admission/);
    assert.ok(aborts >= 1, "the newborn child must be aborted");
    assert.equal(closed, 1, "the lease must be closed exactly once");
    assert.deepEqual(runner.activeAttempts(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dispose waits for a launch already past admission instead of orphaning it", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-dispose-inflight-"));
  let disposed = 0;
  let releaseResolve;
  const resolveGate = new Promise((resolve) => { releaseResolve = resolve; });
  let resolveEntered;
  const entered = new Promise((resolve) => { resolveEntered = resolve; });
  const resolver = {
    async resolve() {
      resolveEntered();
      await resolveGate;
      return {
        action: "allow",
        resource: { id: "provider/model", capacityGroup: "group" },
        resolvedModel: MODEL,
        policy: {
          policyId: "lease-1", agentDir: root, environment: {},
          async onChildSessionOpened() {}, async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { return { status: "released" }; },
        },
      };
    },
  };
  const spawnChild = async () => ({
    resolved: MODEL,
    session: {
      usage: { input: 1, output: 0 }, latestAssistantMessage: undefined,
      async prompt() { await new Promise((resolve) => setTimeout(resolve, 50)); },
      async abort() {}, async dispose() { disposed += 1; },
    },
  });
  try {
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild });
    const completion = runner.run({
      childId: "inflight", promptDigest: "a".repeat(64), cwd: root, prompt: "work", maxAttempts: 1,
    });
    await entered;
    const disposal = runner.dispose();
    releaseResolve();
    await disposal;
    assert.ok(disposed >= 1, "dispose must not return while a child is still being born");
    assert.deepEqual(runner.activeAttempts(), []);
    const result = await completion;
    assert.equal(result.status, "aborted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no-progress deadline aborts a silent route and reports it failover-eligible", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-no-progress-"));
  let aborted = 0;
  const resolver = {
    async resolve() {
      return {
        action: "allow", resource: { id: "provider/model" }, resolvedModel: MODEL,
        policy: {
          policyId: "lease", agentDir: root, environment: {},
          async onChildSessionOpened() {}, async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { return { status: "released" }; },
        },
      };
    },
    async reportProviderUnavailable() {},
  };
  const spawnChild = async () => ({
    resolved: MODEL,
    session: {
      usage: { input: 0, output: 0 }, latestAssistantMessage: undefined,
      async prompt() { return new Promise(() => {}); },
      async abort() { aborted += 1; }, async dispose() {},
    },
  });
  try {
    const runner = new BrokeredChildRunner({
      resolver, sessionsRoot: join(root, "sessions"), spawnChild,
      noProgressTimeoutMs: 1_000, attemptMaxRunMs: 2_000,
    });
    const result = await runner.run({ childId: "silent-task", promptDigest: "a".repeat(64), model: MODEL, cwd: root, prompt: "work", maxAttempts: 1 });
    assert.equal(result.status, "failed");
    assert.match(result.error, /no-progress deadline/);
    assert.equal(result.route[0].outcome, "unavailable");
    assert.equal(aborted, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the account that fails on the final attempt is still reported as cooled", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-final-health-"));
  const cooled = [];
  const condemned = [];
  let resolved = 0;
  const resolver = {
    async resolve() {
      const attempt = ++resolved;
      return {
        action: "allow",
        resource: { id: `provider/model-${attempt}` },
        resolvedModel: MODEL,
        policy: {
          policyId: `lease-${attempt}`, agentDir: root, environment: {},
          async onChildSessionOpened() {},
          async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { return { status: "released" }; },
        },
      };
    },
    async reportProviderRateLimited(resourceId) { cooled.push(resourceId); },
    async reportProviderUnavailable(resourceId, _reason, scope) { condemned.push({ resourceId, scope }); },
  };
  const spawnChild = async () => ({
    resolved: MODEL,
    session: {
      usage: { input: 1, output: 1 },
      latestAssistantMessage: { stopReason: "error", errorMessage: "429 rate limit" },
      async prompt() {}, async dispose() {},
    },
  });
  try {
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild, delay: async () => {} });
    const result = await runner.run({
      childId: "exhaust-all", promptDigest: "a".repeat(64), model: MODEL, cwd: root,
      prompt: "work", maxAttempts: 2,
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(cooled, ["provider/model-1", "provider/model-2"], "the terminal attempt's account must not stay healthy");
    assert.deepEqual(condemned, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a task-owned fatal error never blames the provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-fatal-health-"));
  const cooled = [];
  const condemned = [];
  const resolver = {
    async resolve() {
      return {
        action: "allow",
        resource: { id: "provider/model-1" },
        resolvedModel: MODEL,
        policy: {
          policyId: "lease-1", agentDir: root, environment: {},
          async onChildSessionOpened() {},
          async onBeforeChildAbandoned() {},
          async onChildSessionClosed() { return { status: "released" }; },
        },
      };
    },
    async reportProviderRateLimited(resourceId) { cooled.push(resourceId); },
    async reportProviderUnavailable(resourceId) { condemned.push(resourceId); },
  };
  const spawnChild = async () => ({
    resolved: MODEL,
    session: {
      usage: { input: 1, output: 1 },
      latestAssistantMessage: { stopReason: "error", errorMessage: "TypeError: undefined is not a function" },
      async prompt() {}, async dispose() {},
    },
  });
  try {
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions"), spawnChild, delay: async () => {} });
    const result = await runner.run({ childId: "fatal-task", promptDigest: "a".repeat(64), model: MODEL, cwd: root, prompt: "work", maxAttempts: 3 });
    assert.equal(result.status, "failed");
    assert.equal(result.route.length, 1, "a fatal task error must not retry other accounts");
    assert.deepEqual(cooled, []);
    assert.deepEqual(condemned, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
