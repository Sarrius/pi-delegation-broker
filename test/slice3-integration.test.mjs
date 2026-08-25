import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrokeredChildRunner } from "../src/brokered-runner.mjs";
import { CheckpointStore } from "../src/checkpoint-store.mjs";
import { DefectStore } from "../src/defect-store.mjs";
import { BrokerIpcServer, requestBrokerIpc } from "../src/ipc.mjs";

const MODEL = { provider: "broker-fake", modelId: "lease-fake" };

function root(prefix) {
  const value = mkdtempSync(join(tmpdir(), prefix));
  return { value, done: () => rmSync(value, { recursive: true, force: true }) };
}

test("replacement attempt receives only controller-accepted checkpoints", async () => {
  const r = root("slice3-runner-");
  try {
    const checkpoints = new CheckpointStore({ root: join(r.value, "checkpoints") });
    const accepted = checkpoints.publish({
      taskId: "replacement-task", attemptId: "attempt-old", artifactKey: "cursor", artifact: { line: 41 },
      provenance: { source: "controller" }, publishedAt: 10, autoAccept: true,
    });
    checkpoints.publish({
      taskId: "replacement-task", attemptId: "attempt-old", artifactKey: "unaccepted", artifact: { secret: "withheld" },
      provenance: { source: "controller" }, publishedAt: 11,
    });
    assert.equal(accepted.status, "accepted");
    const prompts = [];
    const digests = [];
    const runner = new BrokeredChildRunner({
      resolver: {
        async resolve(request) {
          digests.push(request.promptDigest);
          return {
            action: "allow", resource: { id: "provider/model" }, resolvedModel: MODEL,
            policy: { agentDir: r.value, environment: {}, async onChildSessionOpened() {}, async onChildSessionClosed() { return { status: "released" }; } },
          };
        },
      },
      sessionsRoot: join(r.value, "sessions"), checkpointStore: checkpoints,
      spawnChild: async ({ spec }) => {
        prompts.push(spec.prompt);
        return {
          resolved: MODEL,
          session: {
            usage: { input: 1, output: 1 },
            latestAssistantMessage: { stopReason: "stop", content: [{ type: "text", text: "done" }] },
            async prompt() {}, async dispose() {},
          },
        };
      },
    });
    const result = await runner.run({
      childId: "replacement-task", promptDigest: "a".repeat(64), cwd: r.value, prompt: "continue work", maxAttempts: 1,
      fleet: { rootId: "replacement-task" },
    });
    assert.equal(result.status, "completed");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /cursor/);
    assert.match(prompts[0], /line/);
    assert.doesNotMatch(prompts[0], /withheld/);
    assert.equal(createHash("sha256").update(prompts[0]).digest("hex"), digests[0]);
  } finally { r.done(); }
});

test("child-scoped checkpoint IPC is lease-bound and controller-accepted", async () => {
  const r = root("slice3-ipc-");
  let server;
  try {
    const checkpoints = new CheckpointStore({ root: join(r.value, "checkpoints") });
    const defects = new DefectStore({ root: join(r.value, "defects") });
    const broker = {
      leaseForCapability() { return { status: "authorized", lease: { leaseId: "lease-1", fencingToken: "fence-1", taskId: "task-1" } }; },
      recordBehavioralEvent() { return { status: "recorded" }; },
    };
    server = new BrokerIpcServer({
      broker, socketPath: join(r.value, "broker.sock"), checkpointStore: checkpoints,
      defectRecorder: (defect) => defects.capture(defect),
    });
    await server.start();
    const result = await requestBrokerIpc({
      socketPath: server.socketPath, authorization: "lease-capability", method: "publishCheckpoint",
      params: { artifactKey: "findings", artifact: { count: 2 }, sequence: 1 },
    });
    assert.equal(result.status, "accepted");
    const [checkpoint] = checkpoints.acceptedFor({ taskId: "task-1" });
    assert.equal(checkpoint.provenance.leaseId, "lease-1");
    assert.equal(checkpoint.attemptId, "lease-1");
    assert.equal(defects.list().length, 0);
  } finally {
    await server?.stop().catch(() => undefined);
    r.done();
  }
});
