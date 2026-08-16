import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrokeredChildRunner } from "../src/brokered-runner.mjs";

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };

test("only the terminal successful failover attempt is tracked for controller verification", async () => {
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
    assert.deepEqual(tracks, [2], "the failed first route must never enter the verification ledger");
    assert.deepEqual(closes, [
      { attempt: 1, status: "failed", attempts: 1 },
      { attempt: 2, status: "completed", attempts: 2 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
