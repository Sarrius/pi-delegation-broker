import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactPipeline } from "../src/artifact-pipeline.mjs";
import { AttemptSettlement, createAttemptRouteSnapshot } from "../src/provider-protocol.mjs";

const ZERO64 = "0".repeat(64);
const ONE64 = "1".repeat(64);

function snapshotInput(overrides = {}) {
  return {
    schemaVersion: 1,
    controllerEpoch: "epoch-1",
    attemptId: "attempt-1",
    streamId: "stream-1",
    taskId: "task-1",
    leaseId: "lease-1",
    fencingToken: 1,
    registryFingerprint: ZERO64,
    registryVersion: 1,
    resourceId: "res-1",
    capacityGroup: "grp-1",
    accountAlias: "acct-a",
    provider: "fake",
    model: "test-model",
    reasoningEffort: null,
    apiDialect: "fake-stream",
    endpointId: "endpoint-1",
    adapterId: "adapter-1@abc",
    credentialRefFingerprint: ONE64,
    cacheRetention: "short",
    retryOwner: "broker",
    sdkMaxRetries: 0,
    deadlineAt: 1_800_000_000_000,
    maxInputBytes: 1_000_000,
    maxOutputBytes: 1_000_000,
    maxOutputTokens: 8_000,
    maxCostMicros: 500_000,
    ...overrides,
  };
}

test("pipeline enqueues and drains work in order", () => {
  const pipeline = new ArtifactPipeline();
  const executed = [];
  pipeline.enqueue({ execute: () => executed.push("a"), bytes: 100, label: "first" });
  pipeline.enqueue({ execute: () => executed.push("b"), bytes: 200, label: "second" });
  assert.equal(pipeline.pending, 2);
  assert.equal(pipeline.pendingBytes, 300);

  const result = pipeline.drain();
  assert.equal(result.status, "drained");
  assert.equal(pipeline.drained, true);
  assert.equal(pipeline.pending, 0);
  assert.deepEqual(executed, ["a", "b"]);
});

test("pipeline queue overflow fails closed", () => {
  const pipeline = new ArtifactPipeline({ maxPending: 2 });
  pipeline.enqueue({ execute: () => {}, bytes: 0 });
  pipeline.enqueue({ execute: () => {}, bytes: 0 });
  assert.throws(() => pipeline.enqueue({ execute: () => {}, bytes: 0 }), /artifact_queue_full/);
});

test("pipeline byte cap overflow fails closed", () => {
  const pipeline = new ArtifactPipeline({ maxTotalBytes: 100 });
  pipeline.enqueue({ execute: () => {}, bytes: 60 });
  pipeline.enqueue({ execute: () => {}, bytes: 30 });
  assert.throws(() => pipeline.enqueue({ execute: () => {}, bytes: 20 }), /artifact_queue_bytes_exceeded/);
});

test("pipeline drain failure leaves work pending and marks failure", () => {
  const pipeline = new ArtifactPipeline();
  let drained = false;
  pipeline.enqueue({ execute: () => { drained = true; }, bytes: 0 });
  pipeline.enqueue({ execute: () => { throw new Error("disk full"); }, bytes: 0 });
  pipeline.enqueue({ execute: () => {}, bytes: 0 });

  const result = pipeline.drain();
  assert.equal(result.status, "failed");
  assert.equal(result.error, "disk full");
  assert.equal(drained, true);
  assert.equal(pipeline.pending, 2);
  assert.equal(pipeline.drained, false);
  assert.equal(pipeline.failure instanceof Error, true);
});

test("pipeline failed drain is re-attemptable from the failed item", () => {
  const pipeline = new ArtifactPipeline();
  let attempts = 0;
  pipeline.enqueue({ execute: () => {}, bytes: 0 });
  pipeline.enqueue({ execute: () => { attempts += 1; if (attempts === 1) throw new Error("transient"); }, bytes: 0 });
  pipeline.enqueue({ execute: () => {}, bytes: 0 });

  assert.equal(pipeline.drain().status, "failed");
  assert.equal(attempts, 1);
  const result = pipeline.drain();
  assert.equal(result.status, "drained");
  assert.equal(attempts, 2);
  assert.equal(pipeline.drained, true);
  assert.equal(pipeline.failure, null);
});

test("pipeline double drain is idempotent", () => {
  const pipeline = new ArtifactPipeline();
  pipeline.enqueue({ execute: () => {}, bytes: 0 });
  pipeline.drain();
  const second = pipeline.drain();
  assert.equal(second.status, "drained");
  assert.equal(pipeline.pending, 0);
});

test("pipeline barrier throws on drain failure, blocking settlement persist", () => {
  const pipeline = new ArtifactPipeline();
  pipeline.enqueue({ execute: () => { throw new Error("evidence write failed"); }, bytes: 0 });

  assert.throws(() => pipeline.barrier(), /artifact_pipeline_barrier_failed/);
  assert.equal(pipeline.drained, false);
  assert.equal(pipeline.pending, 1);
});

test("pipeline barrier passes and allows settlement markPersisted", () => {
  const snapshot = createAttemptRouteSnapshot(snapshotInput());
  const settlement = new AttemptSettlement(snapshot);
  settlement.transition("admitted");
  settlement.transition("provider_send_started");
  settlement.transition("headers_seen");
  settlement.transition("streaming_tentative");
  settlement.settleTerminal("succeeded_terminal", { observedAt: 42 });
  assert.equal(settlement.crashRepairClass(), "terminal_unpersisted");

  const pipeline = new ArtifactPipeline();
  let evidenceStored = false;
  pipeline.enqueue({ execute: () => { evidenceStored = true; }, bytes: 256, label: "store-evidence" });

  pipeline.barrier();
  assert.equal(evidenceStored, true);
  settlement.markPersisted();
  assert.equal(settlement.crashRepairClass(), "terminal_persisted");
});

test("pipeline barrier failure keeps settlement at terminal_unpersisted", () => {
  const snapshot = createAttemptRouteSnapshot(snapshotInput());
  const settlement = new AttemptSettlement(snapshot);
  settlement.transition("admitted");
  settlement.transition("provider_send_started");
  settlement.transition("headers_seen");
  settlement.transition("streaming_tentative");
  settlement.settleTerminal("succeeded_terminal", { observedAt: 42 });

  const pipeline = new ArtifactPipeline();
  pipeline.enqueue({ execute: () => { throw new Error("disk full"); }, bytes: 0 });

  assert.throws(() => pipeline.barrier(), /disk full/);
  assert.equal(settlement.phase, "terminal_validated");
  assert.equal(settlement.crashRepairClass(), "terminal_unpersisted");
  assert.equal(pipeline.drained, false);
  assert.equal(pipeline.pending, 1);
});

test("pipeline rejects enqueue after drain", () => {
  const pipeline = new ArtifactPipeline();
  pipeline.enqueue({ execute: () => {}, bytes: 0 });
  pipeline.drain();
  assert.throws(() => pipeline.enqueue({ execute: () => {}, bytes: 0 }), /already_drained/);
});

test("pipeline constructor validates bounds", () => {
  assert.throws(() => new ArtifactPipeline({ maxPending: 0 }), /maxPending/);
  assert.throws(() => new ArtifactPipeline({ maxTotalBytes: 0 }), /maxTotalBytes/);
  assert.throws(() => new ArtifactPipeline({ maxPending: 200_000 }), /maxPending/);
});