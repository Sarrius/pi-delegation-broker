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
