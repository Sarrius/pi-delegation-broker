import assert from "node:assert/strict";
import test from "node:test";
import {
  AttemptSettlement,
  ProviderProtocolError,
  ProviderStreamAssembler,
  TERMINAL_OUTCOMES,
  createAttemptRouteSnapshot,
  isTerminalOutcome,
  outcomeProperties,
} from "../src/provider-protocol.mjs";

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
    fencingToken: 7,
    registryFingerprint: ZERO64,
    registryVersion: 3,
    resourceId: "res-1",
    capacityGroup: "grp-1",
    accountAlias: "acct-a",
    provider: "openai",
    model: "gpt-5.2",
    reasoningEffort: "high",
    apiDialect: "responses",
    endpointId: "endpoint-1",
    adapterId: "adapter-x@abc123",
    credentialRefFingerprint: ONE64,
    cacheRetention: "short",
    retryOwner: "broker",
    sdkMaxRetries: 0,
    deadlineAt: 1_800_000_000_000,
    maxInputBytes: 1_000_000,
    maxOutputBytes: 1_000_000,
    maxOutputTokens: 8_000,
    ...overrides,
  };
}

const IDENTITY = Object.freeze({
  controllerEpoch: "epoch-1",
  attemptId: "attempt-1",
  streamId: "stream-1",
  leaseId: "lease-1",
  fencingToken: 7,
});

let seqCounter;
function frame(type, payload = {}, overrides = {}) {
  const built = {
    protocolVersion: 1,
    ...IDENTITY,
    seq: seqCounter,
    type,
    payload,
    ...overrides,
  };
  // A fatal frame kills the stream and must not consume a sequence number;
  // tests pass an explicit seq for expected-fatal frames to keep the counter
  // aligned with the frames the assembler actually accepted.
  if (!("seq" in overrides)) seqCounter += 1;
  return built;
}

function newAssembler(limits) {
  seqCounter = 0;
  return new ProviderStreamAssembler(IDENTITY, limits);
}

function succeedStream(assembler) {
  assembler.accept(frame("attempt_accepted"));
  assembler.accept(frame("provider_send_started"));
  assembler.accept(frame("block_start", { index: 0, blockType: "text" }));
  assembler.accept(frame("text_delta", { index: 0, delta: "hello " }));
  assembler.accept(frame("text_delta", { index: 0, delta: "world" }));
  assembler.accept(frame("block_end", { index: 0, value: "hello world" }));
  assembler.accept(frame("usage", { input: 10, output: 5 }));
  return assembler.accept(frame("terminal", { outcome: "succeeded_terminal", usage: { input: 10, output: 5 } }));
}

test("route snapshot is immutable, fingerprinted, and commits to every route fact", () => {
  const snapshot = createAttemptRouteSnapshot(snapshotInput());
  assert.match(snapshot.snapshotFingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => { snapshot.model = "other-model"; }, TypeError);
  const reordered = snapshotInput();
  const again = createAttemptRouteSnapshot(reordered);
  assert.equal(again.snapshotFingerprint, snapshot.snapshotFingerprint);
  const different = createAttemptRouteSnapshot(snapshotInput({ model: "gpt-5.2-mini" }));
  assert.notEqual(different.snapshotFingerprint, snapshot.snapshotFingerprint);
});

test("route snapshot accepts catalog resource identities containing provider/model separators", () => {
  const snapshot = createAttemptRouteSnapshot(snapshotInput({
    resourceId: "openai-codex-account-2/gpt-5.6-luna",
  }));
  assert.equal(snapshot.resourceId, "openai-codex-account-2/gpt-5.6-luna");
});

test("route snapshot refuses competing retry ownership and hidden SDK retries", () => {
  assert.throws(() => createAttemptRouteSnapshot(snapshotInput({ retryOwner: "sdk" })), /retryOwner must be broker/);
  assert.throws(() => createAttemptRouteSnapshot(snapshotInput({ sdkMaxRetries: 2 })), /sdkMaxRetries must be pinned to 0/);
  assert.throws(() => createAttemptRouteSnapshot(snapshotInput({ registryFingerprint: "not-a-digest" })), /registryFingerprint/);
  assert.throws(() => createAttemptRouteSnapshot(snapshotInput({ cacheRetention: "ambient" })), /cacheRetention/);
  assert.throws(() => createAttemptRouteSnapshot(snapshotInput({ maxOutputTokens: 0 })), /maxOutputTokens/);
  assert.throws(() => createAttemptRouteSnapshot(snapshotInput({ surprise: true })), /unknown snapshot field/);
  assert.throws(() => createAttemptRouteSnapshot(snapshotInput({ reasoningEffort: undefined })), /reasoningEffort/);
});

test("terminal outcome vocabulary is closed and classifies provenance and retry eligibility", () => {
  assert.equal(TERMINAL_OUTCOMES.length, 17);
  assert.equal(isTerminalOutcome("provider_custom_xyz"), false);
  assert.equal(outcomeProperties("rejected_before_send").automaticRetryCandidate, true);
  assert.equal(outcomeProperties("empty_response").automaticRetryCandidate, true);
  for (const ambiguous of ["stream_truncated", "cancelled_after_send", "deadline_exceeded_after_send", "controller_failure"]) {
    assert.equal(outcomeProperties(ambiguous).effectAmbiguous, true, ambiguous);
    assert.equal(outcomeProperties(ambiguous).automaticRetryCandidate, false, ambiguous);
  }
  for (const controllerLocal of ["cancelled_before_send", "deadline_exceeded_before_send", "budget_exceeded", "controller_failure"]) {
    assert.equal(outcomeProperties(controllerLocal).providerOwned, false, controllerLocal);
  }
  assert.throws(() => outcomeProperties("nonsense"), /outcome_unknown/);
});

test("happy path stream assembles tentative blocks and settles exactly once", () => {
  const assembler = newAssembler();
  const settled = succeedStream(assembler);
  assert.equal(settled.status, "settled");
  assert.equal(settled.outcome, "succeeded_terminal");
  assert.equal(assembler.settled, true);
  const blocks = assembler.tentativeBlocks();
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].value, "hello world");
  assert.equal(blocks[0].open, false);
  assert.equal(assembler.eof().status, "settled");
});

test("frames with stale incarnation identity are fatal", () => {
  for (const key of ["controllerEpoch", "attemptId", "streamId", "leaseId"]) {
    const assembler = newAssembler();
    assert.throws(
      () => assembler.accept(frame("attempt_accepted", {}, { [key]: "forged" })),
      (error) => error instanceof ProviderProtocolError && error.reasonCode === "stale_identity",
    );
  }
  const assembler = newAssembler();
  assert.throws(
    () => assembler.accept(frame("attempt_accepted", {}, { fencingToken: 8 })),
    (error) => error.reasonCode === "stale_identity",
  );
});

test("sequence gaps, replays, and version mismatch are fatal", () => {
  const assembler = newAssembler();
  assert.throws(() => assembler.accept(frame("attempt_accepted", {}, { seq: 1 })), /sequence_violation/);
  const ok = newAssembler();
  ok.accept(frame("attempt_accepted"));
  assert.throws(() => ok.accept(frame("provider_send_started", {}, { seq: 0 })), /sequence_violation/);
  const versioned = newAssembler();
  assert.throws(() => versioned.accept(frame("attempt_accepted", {}, { protocolVersion: 2 })), /protocol_version_mismatch/);
});

test("unknown frame types are fatal; only explicitly ignorable telemetry is skipped", () => {
  const assembler = newAssembler();
  assembler.accept(frame("attempt_accepted"));
  assert.throws(() => assembler.accept(frame("mystery_frame", {}, { seq: 1 })), /unknown_frame_type/);
  assert.throws(() => assembler.accept(frame("telemetry", { ignorable: false }, { seq: 1 })), /unknown_frame_type/);
  const ignored = assembler.accept(frame("telemetry", { ignorable: true, note: "keepalive" }));
  assert.equal(ignored.status, "ignored");
  assembler.accept(frame("provider_send_started"));
  const settled = assembler.accept(frame("terminal", { outcome: "empty_response" }));
  assert.equal(settled.outcome, "empty_response");
});

test("stream ordering: deltas before send or before block start are fatal", () => {
  const assembler = newAssembler();
  assembler.accept(frame("attempt_accepted"));
  assert.throws(() => assembler.accept(frame("text_delta", { index: 0, delta: "x" })), /sequence_violation/);
  const second = newAssembler();
  second.accept(frame("attempt_accepted"));
  second.accept(frame("provider_send_started"));
  assert.throws(() => second.accept(frame("text_delta", { index: 0, delta: "x" })), /block_not_open/);
});

test("duplicate and retyped blocks are fatal; deltas after close are fatal", () => {
  const assembler = newAssembler();
  assembler.accept(frame("attempt_accepted"));
  assembler.accept(frame("provider_send_started"));
  assembler.accept(frame("block_start", { index: 0, blockType: "text" }));
  assert.throws(() => assembler.accept(frame("block_start", { index: 0, blockType: "reasoning" }, { seq: 3 })), /duplicate_block/);
  assert.throws(() => assembler.accept(frame("reasoning_delta", { index: 0, delta: "x" }, { seq: 3 })), /block_type_mismatch/);
  assembler.accept(frame("text_delta", { index: 0, delta: "done" }));
  assembler.accept(frame("block_end", { index: 0, value: "done" }));
  assert.throws(() => assembler.accept(frame("text_delta", { index: 0, delta: "late" })), /block_not_open/);
});

test("native compound tool_call identity is fixed at block_start and cannot mutate via deltas", () => {
  const assembler = newAssembler();
  assembler.accept(frame("attempt_accepted"));
  assembler.accept(frame("provider_send_started"));
  assert.throws(
    () => assembler.accept(frame("block_start", { index: 0, blockType: "tool_call", name: "bash" }, { seq: 2 })),
    /bounded id/,
  );
  assembler.accept(frame("block_start", { index: 1, blockType: "tool_call", id: "call-1|fc-1", name: "bash" }));
  assert.throws(
    () => assembler.accept(frame("tool_call_delta", { index: 1, delta: "{}", id: "call-2" }, { seq: 3 })),
    (error) => error.reasonCode === "tool_call_identity_mutation",
  );
  assert.throws(
    () => assembler.accept(frame("tool_call_delta", { index: 1, delta: "{}", name: "read" }, { seq: 3 })),
    (error) => error.reasonCode === "tool_call_identity_mutation",
  );
  assembler.accept(frame("tool_call_delta", { index: 1, delta: "{\"command\":\"ls\"}" }));
  const closed = assembler.accept(frame("block_end", { index: 1, value: "{\"command\":\"ls\"}" }));
  assert.equal(closed.status, "tentative");

  const cursor = newAssembler();
  cursor.accept(frame("attempt_accepted"));
  cursor.accept(frame("provider_send_started"));
  const cursorId = "call-1\nfc-1";
  assert.equal(cursor.accept(frame("block_start", { index: 0, blockType: "tool_call", id: cursorId, name: "read" })).status, "tentative");
  cursor.accept(frame("tool_call_delta", { index: 0, delta: "{}" }));
  assert.equal(cursor.accept(frame("block_end", { index: 0, value: "{}" })).status, "tentative");
  const invalid = newAssembler();
  invalid.accept(frame("attempt_accepted"));
  invalid.accept(frame("provider_send_started"));
  assert.throws(
    () => invalid.accept(frame("block_start", { index: 0, blockType: "tool_call", id: "call-1\rfc-1", name: "read" })),
    /bounded id/,
  );
});

test("block_end must carry the canonical value assembled from deltas", () => {
  const assembler = newAssembler();
  assembler.accept(frame("attempt_accepted"));
  assembler.accept(frame("provider_send_started"));
  assembler.accept(frame("block_start", { index: 0, blockType: "text" }));
  assembler.accept(frame("text_delta", { index: 0, delta: "actual" }));
  assert.throws(
    () => assembler.accept(frame("block_end", { index: 0, value: "rewritten" })),
    (error) => error.reasonCode === "block_value_mismatch",
  );
});

test("success cannot leave an open block; EOF without terminal is never success", () => {
  const assembler = newAssembler();
  assembler.accept(frame("attempt_accepted"));
  assembler.accept(frame("provider_send_started"));
  assembler.accept(frame("block_start", { index: 0, blockType: "text" }));
  assembler.accept(frame("text_delta", { index: 0, delta: "partial" }));
  assert.throws(
    () => assembler.accept(frame("terminal", { outcome: "succeeded_terminal" })),
    (error) => error.reasonCode === "open_blocks_at_terminal",
  );
  const eof = assembler.eof();
  assert.equal(eof.status, "incomplete");
  assert.equal(eof.outcome, "stream_truncated");
  assert.equal(eof.effectAmbiguous, true);
});

test("usage is cumulative, monotonic, and capped", () => {
  const assembler = newAssembler();
  assembler.accept(frame("attempt_accepted"));
  assembler.accept(frame("provider_send_started"));
  assembler.accept(frame("usage", { input: 100, output: 50 }));
  assert.throws(
    () => assembler.accept(frame("terminal", { outcome: "stream_truncated", usage: { input: 90, output: 50 } }, { seq: 3 })),
    (error) => error.reasonCode === "usage_regression",
  );
  const second = newAssembler();
  second.accept(frame("attempt_accepted"));
  second.accept(frame("provider_send_started"));
  second.accept(frame("usage", { input: 1 }));
  assert.throws(() => second.accept(frame("usage", { input: 2 }, { seq: 3 })), /only one cumulative usage frame/);
  const capped = newAssembler({ maxUsageValue: 10 });
  capped.accept(frame("attempt_accepted"));
  capped.accept(frame("provider_send_started"));
  assert.throws(() => capped.accept(frame("usage", { input: 11 }, { seq: 2 })), /cap_exceeded/);
});

test("output byte caps fail closed instead of spilling unbounded text", () => {
  const assembler = newAssembler({ maxBlockBytes: 4, maxTotalOutputBytes: 6 });
  assembler.accept(frame("attempt_accepted"));
  assembler.accept(frame("provider_send_started"));
  assembler.accept(frame("block_start", { index: 0, blockType: "text" }));
  assert.throws(() => assembler.accept(frame("text_delta", { index: 0, delta: "12345" }, { seq: 3 })), /cap_exceeded/);
  assembler.accept(frame("text_delta", { index: 0, delta: "1234" }));
  assembler.accept(frame("block_end", { index: 0, value: "1234" }));
  assembler.accept(frame("block_start", { index: 1, blockType: "text" }));
  assert.throws(() => assembler.accept(frame("text_delta", { index: 1, delta: "567" }, { seq: 6 })), /cap_exceeded/);
});

test("no frame may follow a validated terminal, including a second terminal", () => {
  const assembler = newAssembler();
  succeedStream(assembler);
  assert.throws(
    () => assembler.accept(frame("terminal", { outcome: "succeeded_terminal" })),
    (error) => error.reasonCode === "frame_after_terminal",
  );
  assert.throws(() => assembler.accept(frame("telemetry", { ignorable: true })), /frame_after_terminal/);
});

test("settlement enforces phase/outcome consistency and exactly-once CAS", () => {
  const snapshot = createAttemptRouteSnapshot(snapshotInput());
  const settlement = new AttemptSettlement(snapshot);
  assert.equal(settlement.crashRepairClass(), "not_started");
  assert.throws(() => settlement.transition("headers_seen"), /illegal phase transition/);
  settlement.transition("admitted");
  assert.throws(() => settlement.settleTerminal("succeeded_terminal", { observedAt: 1 }), /not reachable from phase/);
  settlement.transition("provider_send_started");
  assert.equal(settlement.crashRepairClass(), "outcome_unknown");
  assert.throws(() => settlement.settleTerminal("succeeded_terminal", { observedAt: 1 }), /not reachable from phase/);
  settlement.transition("headers_seen");
  settlement.transition("streaming_tentative");
  const terminal = settlement.settleTerminal("succeeded_terminal", { facts: { providerRequestId: "req-1" }, observedAt: 42 });
  assert.equal(terminal.outcome, "succeeded_terminal");
  assert.equal(terminal.snapshotFingerprint, snapshot.snapshotFingerprint);
  assert.throws(
    () => settlement.settleTerminal("stream_truncated", { observedAt: 43 }),
    (error) => error.reasonCode === "duplicate_terminal",
  );
  assert.equal(settlement.crashRepairClass(), "terminal_unpersisted");
  settlement.markPersisted();
  assert.equal(settlement.crashRepairClass(), "terminal_persisted");
  settlement.markReconciled();
  assert.equal(settlement.crashRepairClass(), "reconciled");
  assert.throws(() => settlement.markPersisted(), /requires terminal_validated/);
});

test("terminal eligibility preview is side-effect free and rejects impossible phase/outcome pairs", () => {
  const settlement = new AttemptSettlement(createAttemptRouteSnapshot(snapshotInput()));
  settlement.transition("admitted");
  assert.deepEqual(settlement.canSettleTerminal("cancelled_before_send", { observedAt: 10 }), { status: "eligible", outcome: "cancelled_before_send" });
  assert.equal(settlement.phase, "admitted");
  assert.equal(settlement.settled, false);
  assert.throws(() => settlement.canSettleTerminal("succeeded_terminal", { observedAt: 10 }), /phase_invalid/);
  assert.equal(settlement.phase, "admitted");
  settlement.settleTerminal("cancelled_before_send", { observedAt: 10 });
  assert.equal(settlement.phase, "terminal_validated");
});

test("before-send and after-send cancellation settle in their own phases", () => {
  const before = new AttemptSettlement(createAttemptRouteSnapshot(snapshotInput()));
  before.transition("admitted");
  const cancelled = before.settleTerminal("cancelled_before_send", { observedAt: 5 });
  assert.equal(outcomeProperties(cancelled.outcome).effectAmbiguous, false);

  const after = new AttemptSettlement(createAttemptRouteSnapshot(snapshotInput({ attemptId: "attempt-2" })));
  after.transition("admitted");
  after.transition("provider_send_started");
  const late = after.settleTerminal("cancelled_after_send", { observedAt: 9 });
  assert.equal(outcomeProperties(late.outcome).effectAmbiguous, true);
  assert.equal(after.crashRepairClass(), "terminal_unpersisted");
});

test("settlement facts are detached, bounded, and frozen", () => {
  const settlement = new AttemptSettlement(createAttemptRouteSnapshot(snapshotInput()));
  settlement.transition("admitted");
  const facts = { nested: { retryAfterMs: 1000 } };
  const terminal = settlement.settleTerminal("rejected_before_send", { facts, observedAt: 3 });
  facts.nested.retryAfterMs = 99_999;
  assert.equal(terminal.facts.nested.retryAfterMs, 1000);
  assert.throws(() => { terminal.facts.nested.retryAfterMs = 1; }, TypeError);

  const cyclic = {};
  cyclic.self = cyclic;
  const other = new AttemptSettlement(createAttemptRouteSnapshot(snapshotInput({ attemptId: "attempt-3" })));
  other.transition("admitted");
  assert.throws(() => other.settleTerminal("rejected_before_send", { facts: cyclic, observedAt: 3 }), /cycles/);
});
