import { createHash } from "node:crypto";
import { captureLosslessJson } from "./lossless-json.mjs";
import { TOOL_CALL_ID, TOOL_NAME } from "./tool-identity.mjs";

/**
 * Deterministic protocol machinery for the controller-owned provider proxy
 * described in docs/PROVIDER-PROXY-PROTOCOL.md. This module contains no
 * transport, credential, or retry logic: it validates framed stream grammar,
 * freezes immutable attempt routing, and enforces exactly-once settlement.
 */

export const PROVIDER_PROTOCOL_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[a-f0-9]{64}$/;

export class ProviderProtocolError extends Error {
  constructor(reasonCode, detail) {
    super(detail ? `${reasonCode}: ${detail}` : reasonCode);
    this.name = "ProviderProtocolError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, detail) {
  throw new ProviderProtocolError(reasonCode, detail);
}

function boundedId(value, name) {
  if (typeof value !== "string" || !ID.test(value)) fail("snapshot_invalid", `${name} must be a bounded identifier`);
  return value;
}

function boundedText(value, name, max = 160) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\x00-\x1f]/.test(value)) {
    fail("snapshot_invalid", `${name} must be bounded printable text`);
  }
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail("snapshot_invalid", `${name} must be a positive safe integer`);
  return value;
}

/** Closed controller-owned terminal vocabulary. Adapters never invent values. */
export const TERMINAL_OUTCOMES = Object.freeze([
  "succeeded_terminal",
  "rejected_before_send",
  "transport_before_headers",
  "empty_response",
  "stream_truncated",
  "malformed_provider_frame",
  "unknown_finish",
  "rate_limited",
  "quota_fatal",
  "auth_fatal",
  "context_window_exceeded",
  "cancelled_before_send",
  "cancelled_after_send",
  "deadline_exceeded_before_send",
  "deadline_exceeded_after_send",
  "budget_exceeded",
  "controller_failure",
]);

const OUTCOME_SET = new Set(TERMINAL_OUTCOMES);

export function isTerminalOutcome(value) {
  return OUTCOME_SET.has(value);
}

/**
 * Controller policy facts per outcome. providerOwned outcomes are the only
 * ones allowed to mutate cooldown/breaker/account health. effectAmbiguous
 * outcomes may have reached the provider and are never blind-retried.
 * automaticRetryCandidate is restricted to outcomes with a durable proof
 * that no provider effect began.
 */
export const OUTCOME_PROPERTIES = Object.freeze({
  succeeded_terminal: Object.freeze({ success: true, providerOwned: true, effectAmbiguous: false, automaticRetryCandidate: false }),
  rejected_before_send: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: false, automaticRetryCandidate: true }),
  transport_before_headers: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: false, automaticRetryCandidate: false }),
  empty_response: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: false, automaticRetryCandidate: true }),
  stream_truncated: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: true, automaticRetryCandidate: false }),
  malformed_provider_frame: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: true, automaticRetryCandidate: false }),
  unknown_finish: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: true, automaticRetryCandidate: false }),
  rate_limited: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: false, automaticRetryCandidate: false }),
  quota_fatal: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: false, automaticRetryCandidate: false }),
  auth_fatal: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: false, automaticRetryCandidate: false }),
  context_window_exceeded: Object.freeze({ success: false, providerOwned: true, effectAmbiguous: false, automaticRetryCandidate: false }),
  cancelled_before_send: Object.freeze({ success: false, providerOwned: false, effectAmbiguous: false, automaticRetryCandidate: false }),
  cancelled_after_send: Object.freeze({ success: false, providerOwned: false, effectAmbiguous: true, automaticRetryCandidate: false }),
  deadline_exceeded_before_send: Object.freeze({ success: false, providerOwned: false, effectAmbiguous: false, automaticRetryCandidate: false }),
  deadline_exceeded_after_send: Object.freeze({ success: false, providerOwned: false, effectAmbiguous: true, automaticRetryCandidate: false }),
  budget_exceeded: Object.freeze({ success: false, providerOwned: false, effectAmbiguous: false, automaticRetryCandidate: false }),
  controller_failure: Object.freeze({ success: false, providerOwned: false, effectAmbiguous: true, automaticRetryCandidate: false }),
});

export function outcomeProperties(outcome) {
  const properties = OUTCOME_PROPERTIES[outcome];
  if (!properties) fail("outcome_unknown", "terminal outcome is outside the closed vocabulary");
  return properties;
}

const SNAPSHOT_FIELDS = [
  "schemaVersion", "controllerEpoch", "attemptId", "streamId", "taskId", "leaseId",
  "fencingToken", "registryFingerprint", "registryVersion", "resourceId", "capacityGroup",
  "accountAlias", "provider", "model", "reasoningEffort", "apiDialect", "endpointId",
  "adapterId", "credentialRefFingerprint", "cacheRetention", "retryOwner", "sdkMaxRetries", "deadlineAt",
  "maxInputBytes", "maxOutputBytes", "maxOutputTokens",
];

/**
 * Validate and deep-freeze the one immutable routing decision for a physical
 * attempt. The returned snapshotFingerprint commits to every route fact; a
 * replacement attempt must create a new snapshot rather than mutate this one.
 */
export function createAttemptRouteSnapshot(input) {
  if (!input || typeof input !== "object") fail("snapshot_invalid", "route snapshot input must be an object");
  if (input.schemaVersion !== PROVIDER_PROTOCOL_VERSION) fail("snapshot_invalid", "unsupported schemaVersion");
  const snapshot = {
    schemaVersion: PROVIDER_PROTOCOL_VERSION,
    controllerEpoch: boundedId(input.controllerEpoch, "controllerEpoch"),
    attemptId: boundedId(input.attemptId, "attemptId"),
    streamId: boundedId(input.streamId, "streamId"),
    taskId: boundedId(input.taskId, "taskId"),
    leaseId: boundedId(input.leaseId, "leaseId"),
    fencingToken: positiveSafeInteger(input.fencingToken, "fencingToken"),
    registryFingerprint: typeof input.registryFingerprint === "string" && HEX64.test(input.registryFingerprint)
      ? input.registryFingerprint
      : fail("snapshot_invalid", "registryFingerprint must be a SHA-256 hex digest"),
    registryVersion: positiveSafeInteger(input.registryVersion, "registryVersion"),
    resourceId: boundedText(input.resourceId, "resourceId", 288),
    capacityGroup: boundedId(input.capacityGroup, "capacityGroup"),
    accountAlias: boundedId(input.accountAlias, "accountAlias"),
    provider: boundedText(input.provider, "provider"),
    model: boundedText(input.model, "model"),
    reasoningEffort: input.reasoningEffort === null ? null : boundedText(input.reasoningEffort, "reasoningEffort", 32),
    apiDialect: boundedText(input.apiDialect, "apiDialect", 64),
    endpointId: boundedId(input.endpointId, "endpointId"),
    adapterId: boundedText(input.adapterId, "adapterId"),
    credentialRefFingerprint: typeof input.credentialRefFingerprint === "string" && HEX64.test(input.credentialRefFingerprint)
      ? input.credentialRefFingerprint
      : fail("snapshot_invalid", "credentialRefFingerprint must be a SHA-256 hex digest"),
    cacheRetention: input.cacheRetention,
    retryOwner: input.retryOwner,
    sdkMaxRetries: input.sdkMaxRetries,
    deadlineAt: positiveSafeInteger(input.deadlineAt, "deadlineAt"),
    maxInputBytes: positiveSafeInteger(input.maxInputBytes, "maxInputBytes"),
    maxOutputBytes: positiveSafeInteger(input.maxOutputBytes, "maxOutputBytes"),
    maxOutputTokens: positiveSafeInteger(input.maxOutputTokens, "maxOutputTokens"),
  };
  if (!["none", "short", "long"].includes(snapshot.cacheRetention)) fail("snapshot_invalid", "cacheRetention must be none, short, or long");
  if (snapshot.retryOwner !== "broker") fail("snapshot_invalid", "retryOwner must be broker");
  if (snapshot.sdkMaxRetries !== 0) fail("snapshot_invalid", "sdkMaxRetries must be pinned to 0");
  for (const key of Object.keys(input)) {
    if (!SNAPSHOT_FIELDS.includes(key)) fail("snapshot_invalid", `unknown snapshot field ${key}`);
  }
  const captured = captureLosslessJson(snapshot);
  const snapshotFingerprint = createHash("sha256").update(captured.canonical).digest("hex");
  return Object.freeze({ ...captured.value, snapshotFingerprint });
}

const FRAME_TYPES = new Set([
  "attempt_accepted", "provider_send_started",
  "block_start", "text_delta", "reasoning_delta", "tool_call_delta", "block_end",
  "usage", "terminal", "telemetry",
]);

const BLOCK_TYPES = new Set(["text", "reasoning", "tool_call"]);
const DELTA_FOR_BLOCK = Object.freeze({ text: "text_delta", reasoning: "reasoning_delta", tool_call: "tool_call_delta" });

function frameIdentity(value, name) {
  if (typeof value !== "string" || !ID.test(value)) fail("frame_payload_invalid", `${name} must be a bounded identifier`);
  return value;
}

function usageValue(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail("frame_payload_invalid", `${name} must be a non-negative safe integer`);
  return value;
}

function validateUsage(payload, limits) {
  if (!payload || typeof payload !== "object") fail("frame_payload_invalid", "usage payload must be an object");
  for (const key of Object.keys(payload)) {
    if (!["input", "output", "cacheRead", "cacheWrite"].includes(key)) fail("frame_payload_invalid", `unknown usage field ${key}`);
  }
  const usage = {
    input: usageValue(payload.input ?? 0, "usage.input"),
    output: usageValue(payload.output ?? 0, "usage.output"),
    cacheRead: usageValue(payload.cacheRead ?? 0, "usage.cacheRead"),
    cacheWrite: usageValue(payload.cacheWrite ?? 0, "usage.cacheWrite"),
  };
  for (const [key, value] of Object.entries(usage)) {
    if (value > limits.maxUsageValue) fail("cap_exceeded", `usage.${key} exceeds the configured cap`);
  }
  return usage;
}

function checkUsageMonotonic(previous, next) {
  if (!previous) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (next[key] < previous[key]) fail("usage_regression", `usage.${key} decreased`);
  }
}

function validateTerminalPayload(payload) {
  if (!payload || typeof payload !== "object") fail("frame_payload_invalid", "terminal payload must be an object");
  const allowed = new Set(["outcome", "finishReason", "providerRequestId", "providerReason", "httpStatus", "retryAfterMs", "usage", "evidenceRefs"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) fail("frame_payload_invalid", `unknown terminal field ${key}`);
  }
  if (!isTerminalOutcome(payload.outcome)) fail("outcome_unknown", "terminal outcome is outside the closed vocabulary");
  if (payload.finishReason !== undefined) boundedText(payload.finishReason, "finishReason", 64);
  if (payload.providerRequestId !== undefined && (typeof payload.providerRequestId !== "string" || !ID.test(payload.providerRequestId))) {
    fail("frame_payload_invalid", "providerRequestId must be a bounded identifier");
  }
  if (payload.providerReason !== undefined && (typeof payload.providerReason !== "string" || !/^[a-z_]{1,64}$/.test(payload.providerReason))) {
    fail("frame_payload_invalid", "providerReason must be a bounded classification");
  }
  if (payload.httpStatus !== undefined && (!Number.isInteger(payload.httpStatus) || payload.httpStatus < 100 || payload.httpStatus > 599)) {
    fail("frame_payload_invalid", "httpStatus must be an integer between 100 and 599");
  }
  if (payload.retryAfterMs !== undefined && (!Number.isInteger(payload.retryAfterMs) || payload.retryAfterMs < 1 || payload.retryAfterMs > 86_400_000)) {
    fail("frame_payload_invalid", "retryAfterMs must be a positive bounded integer");
  }
  if (payload.evidenceRefs !== undefined) {
    if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length > 16) fail("frame_payload_invalid", "evidenceRefs must be a bounded array");
    for (const ref of payload.evidenceRefs) frameIdentity(ref, "evidenceRefs[]");
  }
}

/**
 * Validates the controller-to-child framed stream for exactly one attempt.
 * Grammar errors throw ProviderProtocolError with a closed reasonCode; the
 * caller must settle the attempt with a matching terminal outcome instead of
 * patching or skipping malformed frames. Output assembled here is tentative
 * until a terminal frame is accepted and durably persisted by the controller.
 */
export class ProviderStreamAssembler {
  #identity;
  #limits;
  #seq = 0;
  #acceptedSeen = false;
  #sendStartedSeen = false;
  #usageSeen = false;
  #lastUsage = null;
  #blocks = new Map();
  #startedBlocks = 0;
  #totalOutputBytes = 0;
  #settled = false;

  constructor(identity, limits = {}) {
    if (!identity || typeof identity !== "object") fail("frame_payload_invalid", "assembler identity is required");
    this.#identity = Object.freeze({
      controllerEpoch: frameIdentity(identity.controllerEpoch, "controllerEpoch"),
      attemptId: frameIdentity(identity.attemptId, "attemptId"),
      streamId: frameIdentity(identity.streamId, "streamId"),
      leaseId: frameIdentity(identity.leaseId, "leaseId"),
      fencingToken: positiveSafeInteger(identity.fencingToken, "fencingToken"),
    });
    const maxBlocks = limits.maxBlocks ?? 64;
    const maxBlockBytes = limits.maxBlockBytes ?? 1024 * 1024;
    const maxTotalOutputBytes = limits.maxTotalOutputBytes ?? 4 * 1024 * 1024;
    const maxUsageValue = limits.maxUsageValue ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 4096) fail("frame_payload_invalid", "maxBlocks out of range");
    if (!Number.isSafeInteger(maxBlockBytes) || maxBlockBytes < 1) fail("frame_payload_invalid", "maxBlockBytes out of range");
    if (!Number.isSafeInteger(maxTotalOutputBytes) || maxTotalOutputBytes < 1) fail("frame_payload_invalid", "maxTotalOutputBytes out of range");
    if (!Number.isSafeInteger(maxUsageValue) || maxUsageValue < 1) fail("frame_payload_invalid", "maxUsageValue out of range");
    this.#limits = Object.freeze({ maxBlocks, maxBlockBytes, maxTotalOutputBytes, maxUsageValue });
  }

  get settled() { return this.#settled; }

  #checkEnvelope(frame) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) fail("frame_payload_invalid", "frame must be an object");
    if (frame.protocolVersion !== PROVIDER_PROTOCOL_VERSION) fail("protocol_version_mismatch", "unsupported protocolVersion");
    for (const [key, expected] of Object.entries(this.#identity)) {
      if (frame[key] !== expected) fail("stale_identity", `frame ${key} does not match the admitted attempt`);
    }
    if (!Number.isSafeInteger(frame.seq) || frame.seq !== this.#seq) fail("sequence_violation", "frame seq must increment by one from zero");
    if (typeof frame.type !== "string" || !FRAME_TYPES.has(frame.type)) fail("unknown_frame_type", "frame type is outside the closed vocabulary");
  }

  accept(frame) {
    if (this.#settled) fail("frame_after_terminal", "no frame may follow a validated terminal");
    this.#checkEnvelope(frame);
    const previousSeq = this.#seq;
    this.#seq += 1;
    const payload = frame.payload ?? {};
    try {
      return this.#dispatch(frame, payload);
    } catch (error) {
      // A malformed frame kills the stream but does not advance its position.
      this.#seq = previousSeq;
      throw error;
    }
  }

  #dispatch(frame, payload) {
    switch (frame.type) {
      case "telemetry": {
        if (payload.ignorable !== true) fail("unknown_frame_type", "telemetry must be explicitly marked ignorable");
        return Object.freeze({ status: "ignored", type: "telemetry" });
      }
      case "attempt_accepted": {
        if (this.#acceptedSeen || frame.seq !== 0) fail("sequence_violation", "attempt_accepted must be the first frame");
        this.#acceptedSeen = true;
        return Object.freeze({ status: "accepted", type: frame.type });
      }
      case "provider_send_started": {
        if (!this.#acceptedSeen || this.#sendStartedSeen || this.#startedBlocks > 0) {
          fail("sequence_violation", "provider_send_started must follow attempt_accepted and precede stream blocks");
        }
        this.#sendStartedSeen = true;
        return Object.freeze({ status: "accepted", type: frame.type });
      }
      case "block_start": return this.#blockStart(payload);
      case "text_delta":
      case "reasoning_delta":
      case "tool_call_delta": return this.#delta(frame.type, payload);
      case "block_end": return this.#blockEnd(payload);
      case "usage": return this.#usage(payload);
      case "terminal": return this.#terminal(payload);
      default: fail("unknown_frame_type", "unreachable frame type");
    }
  }

  #requireStreaming() {
    if (!this.#sendStartedSeen) fail("sequence_violation", "stream frames require provider_send_started");
  }

  #blockStart(payload) {
    this.#requireStreaming();
    if (!payload || typeof payload !== "object") fail("frame_payload_invalid", "block_start payload must be an object");
    const { index, blockType } = payload;
    if (!Number.isSafeInteger(index) || index < 0 || index > 4095) fail("frame_payload_invalid", "block index out of range");
    if (!BLOCK_TYPES.has(blockType)) fail("frame_payload_invalid", "unknown blockType");
    if (this.#blocks.has(index)) fail("duplicate_block", "block index was already started");
    if (this.#startedBlocks >= this.#limits.maxBlocks) fail("cap_exceeded", "block count cap exceeded");
    let id = null;
    let name = null;
    if (blockType === "tool_call") {
      if (typeof payload.id !== "string" || !TOOL_CALL_ID.test(payload.id)) fail("frame_payload_invalid", "tool_call block requires a bounded id");
      if (typeof payload.name !== "string" || !TOOL_NAME.test(payload.name)) fail("frame_payload_invalid", "tool_call block requires a bounded name");
      id = payload.id;
      name = payload.name;
    } else if (payload.id !== undefined || payload.name !== undefined) {
      fail("frame_payload_invalid", "id/name are only valid on tool_call blocks");
    }
    const allowedKeys = new Set(["index", "blockType", "id", "name"]);
    for (const key of Object.keys(payload)) {
      if (!allowedKeys.has(key)) fail("frame_payload_invalid", `unknown block_start field ${key}`);
    }
    this.#startedBlocks += 1;
    this.#blocks.set(index, { blockType, id, name, open: true, accumulated: "", bytes: 0 });
    return Object.freeze({ status: "tentative", type: "block_start", index, blockType });
  }

  #delta(type, payload) {
    this.#requireStreaming();
    if (!payload || typeof payload !== "object") fail("frame_payload_invalid", "delta payload must be an object");
    const allowedKeys = new Set(["index", "delta", "id", "name"]);
    for (const key of Object.keys(payload)) {
      if (!allowedKeys.has(key)) fail("frame_payload_invalid", `unknown delta field ${key}`);
    }
    const block = this.#blocks.get(payload.index);
    if (!block || !block.open) fail("block_not_open", "delta addresses a block that is not open");
    if (DELTA_FOR_BLOCK[block.blockType] !== type) fail("block_type_mismatch", "delta type does not match the open block");
    if (payload.id !== undefined || payload.name !== undefined) {
      fail("tool_call_identity_mutation", "tool_call id/name are fixed at block_start");
    }
    if (typeof payload.delta !== "string" || payload.delta.length === 0) fail("frame_payload_invalid", "delta must be a non-empty string");
    const bytes = Buffer.byteLength(payload.delta);
    if (block.bytes + bytes > this.#limits.maxBlockBytes) fail("cap_exceeded", "block byte cap exceeded");
    if (this.#totalOutputBytes + bytes > this.#limits.maxTotalOutputBytes) fail("cap_exceeded", "total output byte cap exceeded");
    block.bytes += bytes;
    block.accumulated += payload.delta;
    this.#totalOutputBytes += bytes;
    return Object.freeze({ status: "tentative", type, index: payload.index });
  }

  #blockEnd(payload) {
    this.#requireStreaming();
    if (!payload || typeof payload !== "object") fail("frame_payload_invalid", "block_end payload must be an object");
    for (const key of Object.keys(payload)) {
      if (!["index", "value"].includes(key)) fail("frame_payload_invalid", `unknown block_end field ${key}`);
    }
    const block = this.#blocks.get(payload.index);
    if (!block || !block.open) fail("block_not_open", "block_end addresses a block that is not open");
    if (typeof payload.value !== "string") fail("frame_payload_invalid", "block_end value must be the canonical completed string");
    if (payload.value !== block.accumulated) fail("block_value_mismatch", "block_end value diverges from accumulated deltas");
    if (block.blockType === "tool_call") {
      let args;
      try { args = JSON.parse(payload.value); } catch { fail("frame_payload_invalid", "tool_call value must be valid JSON"); }
      if (!args || typeof args !== "object" || Array.isArray(args)) fail("frame_payload_invalid", "tool_call value must be a JSON object");
    }
    block.open = false;
    return Object.freeze({ status: "tentative", type: "block_end", index: payload.index, bytes: block.bytes });
  }

  #usage(payload) {
    this.#requireStreaming();
    if (this.#usageSeen) fail("frame_payload_invalid", "only one cumulative usage frame is allowed");
    const usage = validateUsage(payload, this.#limits);
    this.#usageSeen = true;
    this.#lastUsage = usage;
    return Object.freeze({ status: "usage", usage: Object.freeze(usage) });
  }

  #terminal(payload) {
    if (!this.#acceptedSeen) fail("sequence_violation", "terminal requires attempt_accepted");
    validateTerminalPayload(payload);
    if (payload.usage !== undefined) {
      const usage = validateUsage(payload.usage, this.#limits);
      checkUsageMonotonic(this.#lastUsage, usage);
    }
    if (payload.outcome === "succeeded_terminal") {
      if (!this.#sendStartedSeen) fail("sequence_violation", "success requires provider_send_started");
      for (const block of this.#blocks.values()) {
        if (block.open) fail("open_blocks_at_terminal", "success cannot leave an open block");
      }
    }
    this.#settled = true;
    return Object.freeze({
      status: "settled",
      outcome: payload.outcome,
      terminal: Object.freeze({
        outcome: payload.outcome,
        finishReason: payload.finishReason ?? null,
        providerRequestId: payload.providerRequestId ?? null,
        ...(payload.providerReason === undefined ? {} : { providerReason: payload.providerReason }),
        httpStatus: payload.httpStatus ?? null,
        retryAfterMs: payload.retryAfterMs ?? null,
        usage: payload.usage ? Object.freeze(validateUsage(payload.usage, this.#limits)) : null,
        evidenceRefs: Object.freeze([...(payload.evidenceRefs ?? [])]),
      }),
    });
  }

  /**
   * EOF is never success. A caller that observed connection teardown without
   * a validated terminal must settle with stream_truncated (or a more precise
   * cancellation/deadline outcome) and treat the effect as ambiguous.
   */
  eof() {
    if (this.#settled) return Object.freeze({ status: "settled" });
    return Object.freeze({ status: "incomplete", outcome: "stream_truncated", effectAmbiguous: true });
  }

  /** Tentative assembled blocks; never authoritative before settlement. */
  tentativeBlocks() {
    const blocks = [];
    for (const [index, block] of [...this.#blocks.entries()].sort((a, b) => a[0] - b[0])) {
      blocks.push(Object.freeze({
        index,
        blockType: block.blockType,
        id: block.id,
        name: block.name,
        open: block.open,
        value: block.accumulated,
      }));
    }
    return Object.freeze(blocks);
  }
}

const PHASES = Object.freeze([
  "prepared", "admitted", "provider_send_started", "headers_seen",
  "streaming_tentative", "terminal_validated", "terminal_persisted", "result_reconciled",
]);

const PHASE_EDGES = Object.freeze({
  prepared: Object.freeze(["admitted"]),
  admitted: Object.freeze(["provider_send_started", "terminal_validated"]),
  provider_send_started: Object.freeze(["headers_seen", "terminal_validated"]),
  headers_seen: Object.freeze(["streaming_tentative", "terminal_validated"]),
  streaming_tentative: Object.freeze(["terminal_validated"]),
  terminal_validated: Object.freeze(["terminal_persisted"]),
  terminal_persisted: Object.freeze(["result_reconciled"]),
  result_reconciled: Object.freeze([]),
});

/** Outcomes each non-terminal phase may settle with. */
const PHASE_OUTCOMES = Object.freeze({
  admitted: Object.freeze(new Set([
    "rejected_before_send", "cancelled_before_send", "deadline_exceeded_before_send", "budget_exceeded", "controller_failure",
  ])),
  provider_send_started: Object.freeze(new Set([
    "transport_before_headers", "cancelled_after_send", "deadline_exceeded_after_send", "budget_exceeded", "controller_failure",
  ])),
  headers_seen: Object.freeze(new Set([
    "rejected_before_send", "succeeded_terminal", "empty_response", "stream_truncated", "malformed_provider_frame", "unknown_finish",
    "rate_limited", "quota_fatal", "auth_fatal", "context_window_exceeded",
    "cancelled_after_send", "deadline_exceeded_after_send", "budget_exceeded", "controller_failure",
  ])),
  streaming_tentative: Object.freeze(new Set([
    "succeeded_terminal", "empty_response", "stream_truncated", "malformed_provider_frame", "unknown_finish",
    "rate_limited", "quota_fatal", "auth_fatal", "context_window_exceeded",
    "cancelled_after_send", "deadline_exceeded_after_send", "budget_exceeded", "controller_failure",
  ])),
});

const CRASH_CLASSES = Object.freeze({
  prepared: "not_started",
  admitted: "not_started",
  provider_send_started: "outcome_unknown",
  headers_seen: "outcome_unknown",
  streaming_tentative: "outcome_unknown",
  terminal_validated: "terminal_unpersisted",
  terminal_persisted: "terminal_persisted",
  result_reconciled: "reconciled",
});

/**
 * Controller-side attempt lifecycle with exactly-once terminal settlement.
 * The first settleTerminal wins; any second attempt is a protocol error.
 * crashRepairClass() drives recovery: only not_started may be re-driven
 * automatically; outcome_unknown requires reconciliation or escalation.
 */
export class AttemptSettlement {
  #snapshot;
  #phase = "prepared";
  #terminal = null;

  constructor(snapshot) {
    if (!snapshot || typeof snapshot.snapshotFingerprint !== "string" || !HEX64.test(snapshot.snapshotFingerprint)) {
      fail("snapshot_invalid", "AttemptSettlement requires a snapshot from createAttemptRouteSnapshot");
    }
    this.#snapshot = snapshot;
  }

  get snapshot() { return this.#snapshot; }
  get phase() { return this.#phase; }
  get settled() { return this.#terminal !== null; }
  get terminal() { return this.#terminal; }

  transition(target) {
    if (!PHASES.includes(target)) fail("phase_unknown", "target phase is outside the closed vocabulary");
    if (target === "terminal_validated") fail("phase_invalid", "use settleTerminal to reach terminal_validated");
    if (this.#terminal) fail("phase_invalid", "a settled attempt cannot move between pre-terminal phases");
    if (!PHASE_EDGES[this.#phase].includes(target)) {
      fail("phase_invalid", `illegal phase transition ${this.#phase} -> ${target}`);
    }
    this.#phase = target;
    return Object.freeze({ status: "transitioned", phase: target });
  }

  #validateTerminal(outcome, { facts = {}, observedAt } = {}) {
    if (this.#terminal) fail("duplicate_terminal", "terminal settlement is exactly-once");
    if (!isTerminalOutcome(outcome)) fail("outcome_unknown", "terminal outcome is outside the closed vocabulary");
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail("frame_payload_invalid", "observedAt must be a non-negative safe integer");
    const allowed = PHASE_OUTCOMES[this.#phase];
    if (!allowed || !allowed.has(outcome)) {
      fail("phase_invalid", `outcome ${outcome} is not reachable from phase ${this.#phase}`);
    }
    return captureLosslessJson(facts, { maxBytes: 16 * 1024, maxNodes: 2_000, maxDepth: 16 });
  }

  /** Validate a proposed terminal without changing durable lifecycle state.
   * A controller uses this before accepting the matching child-visible frame,
   * so an impossible phase/outcome cannot be emitted then discovered later. */
  canSettleTerminal(outcome, options = {}) {
    this.#validateTerminal(outcome, options);
    return Object.freeze({ status: "eligible", outcome });
  }

  settleTerminal(outcome, options = {}) {
    const captured = this.#validateTerminal(outcome, options);
    this.#terminal = Object.freeze({
      outcome,
      facts: captured.value,
      observedAt: options.observedAt,
      snapshotFingerprint: this.#snapshot.snapshotFingerprint,
    });
    this.#phase = "terminal_validated";
    return this.#terminal;
  }

  markPersisted() {
    if (this.#phase !== "terminal_validated") fail("phase_invalid", "markPersisted requires terminal_validated");
    this.#phase = "terminal_persisted";
    return Object.freeze({ status: "transitioned", phase: this.#phase });
  }

  markReconciled() {
    if (this.#phase !== "terminal_persisted") fail("phase_invalid", "markReconciled requires terminal_persisted");
    this.#phase = "result_reconciled";
    return Object.freeze({ status: "transitioned", phase: this.#phase });
  }

  crashRepairClass() {
    return CRASH_CLASSES[this.#phase];
  }
}
