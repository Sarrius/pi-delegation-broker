import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Semaphore } from "../src/semaphore.mjs";
import { classifyChildFailure } from "../src/brokered-runner.mjs";

test("route-specific provider policy rejection is failover-eligible", () => {
  assert.equal(classifyChildFailure("OpenAI API error (400): organization must be verified to generate reasoning summaries"), "unavailable");
});

// We test the runner's deny path and semaphore release without spawning a real Pi process.
// The spawn itself is tested through child-launcher's isolated unit, not here.

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };

function fakeResolver(allow = true) {
  return {
    async resolve(request) {
      if (!allow) return { action: "deny", reason: "no capacity" };
      return {
        action: "allow",
        policy: {
          policyId: `lease-${request.childId}`,
          agentDir: mkdtempSync(join(tmpdir(), "br-runner-")),
          environment: {
            PI_BROKER_SOCKET: "/tmp/test-broker.sock",
            PI_BROKER_LEASE_ID: `lease-${request.childId}`,
            PI_BROKER_FENCING_TOKEN: "1",
            PI_BROKER_CAPABILITY: "test-capability",
          },
          onChildSessionClosed: () => {},
          onChildSessionOpened: () => {},
          onBeforeChildAbandoned: () => {},
        },
      };
    },
  };
}

test("brokered runner denies spawn when resolver denies and never takes a semaphore slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-deny-"));
  try {
    const sem = new Semaphore(1);
    const { BrokeredChildRunner } = await import("../src/brokered-runner.mjs");
    const runner = new BrokeredChildRunner({
      resolver: fakeResolver(false),
      semaphore: sem,
      sessionsRoot: join(root, "sessions"),
    });
    await assert.rejects(
      () => runner.spawn({
        childId: "denied-child",
        promptDigest: "a".repeat(64),
        model: MODEL,
        cwd: root,
      }),
      /Broker denied launch/,
    );
    assert.equal(sem.running, 0, "semaphore released after denial");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("brokered runner releases semaphore when child spawn fails after resolver allows", async () => {
  const root = mkdtempSync(join(tmpdir(), "br-spawn-fail-"));
  try {
    const sem = new Semaphore(1);
    const { BrokeredChildRunner } = await import("../src/brokered-runner.mjs");
    const runner = new BrokeredChildRunner({
      resolver: fakeResolver(true),
      semaphore: sem,
      sessionsRoot: join(root, "sessions"),
    });
    // Spawn will fail because pi-coding-agent may not be installed.
    // The key assertion: semaphore is released even after a spawn failure.
    await assert.rejects(
      () => runner.spawn({
        childId: "spawn-fail-child",
        promptDigest: "a".repeat(64),
        model: MODEL,
        cwd: root,
      }),
    );
    assert.equal(sem.running, 0, "semaphore released after spawn failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a spent plan allowance is an account fact, not the end of the task", () => {
  // Observed live from the Codex CLI: no HTTP status, so an unclassified string would read as
  // fatal and stop failover while other accounts were still healthy.
  assert.equal(classifyChildFailure("Codex error: The usage limit has been reached"), "account_exhausted");
  assert.equal(classifyChildFailure("Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage."), "account_exhausted");
  // A genuinely dead task must still be fatal: this must not swallow every unknown error.
  assert.equal(classifyChildFailure("TypeError: cannot read properties of undefined"), "fatal");
});
