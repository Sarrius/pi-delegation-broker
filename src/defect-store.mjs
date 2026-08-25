import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { captureLosslessJson } from "./lossless-json.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,319}$/;
const KINDS = new Set(["tool", "controller", "protocol", "lifecycle", "recovery", "checkpoint"]);
const ORIGINS = new Set(["child", "controller", "provider", "verifier"]);
const STATUSES = new Set(["open", "queued", "triaged", "resolved", "duplicate"]);
const TRANSITIONS = new Map([
  ["open", new Set(["queued", "triaged", "resolved", "duplicate"])],
  ["queued", new Set(["triaged", "resolved", "duplicate"])],
  ["triaged", new Set(["queued", "resolved", "duplicate"])],
  ["resolved", new Set()],
  ["duplicate", new Set()],
]);
const MAX_MESSAGE = 8 * 1024;
const MAX_DETAILS = 256 * 1024;

function fail(message) { throw new Error(`defect store: ${message}`); }

function boundedText(value, label, max = MAX_MESSAGE) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) fail(`${label} is invalid`);
  return value;
}

function safeId(value, label, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function redact(text) {
  return text
    .replace(/((?:api[_-]?key|token|authorization|secret))\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

function requireRoot(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("root must be an absolute path");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const link = lstatSync(path);
  if (link.isSymbolicLink()) fail("root must not be a symbolic link");
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) fail("root must be owner-only");
  return canonical;
}

function durableExclusive(path, content) {
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return true;
}

function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function fileName(id) { return createHash("sha256").update(id).digest("hex"); }
function recordPath(root, id) { return join(root, "records", `${fileName(id)}.json`); }
function statePath(root, id) { return join(root, "states", `${fileName(id)}.json`); }

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("record must be an object");
  if (record.schemaVersion !== 1 || typeof record.defectId !== "string" || !UUID.test(record.defectId)) fail("record identity is invalid");
  if (!KINDS.has(record.kind) || !ORIGINS.has(record.origin)) fail("record kind or origin is invalid");
  if (!STATUSES.has(record.status)) fail("record status is invalid");
  boundedText(record.message, "record message");
  safeId(record.rootId, "rootId", true);
  safeId(record.taskId, "taskId", true);
  safeId(record.attemptId, "attemptId", true);
  if (record.tool !== undefined) boundedText(record.tool, "tool", 256);
  if (record.phase !== undefined) boundedText(record.phase, "phase", 128);
  if (typeof record.retryable !== "boolean") fail("retryable must be boolean");
  if (!Number.isSafeInteger(record.observedAt) || record.observedAt < 0) fail("observedAt is invalid");
  if (!Number.isSafeInteger(record.capturedAt) || record.capturedAt < record.observedAt) fail("capturedAt is invalid");
  if (!record.provenance || typeof record.provenance !== "object" || Array.isArray(record.provenance)) fail("provenance is invalid");
  const captured = captureLosslessJson(record.details ?? {}, { maxBytes: MAX_DETAILS, maxDepth: 24, maxNodes: 10_000 });
  if (captured.canonical !== record.detailsCanonical) fail("details digest snapshot is invalid");
  return record;
}

function validateState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)
    || typeof state.defectId !== "string" || !UUID.test(state.defectId)
    || !STATUSES.has(state.status) || !Number.isSafeInteger(state.at) || state.at < 0) {
    fail("state marker is invalid");
  }
  if (state.reason !== undefined) boundedText(state.reason, "state reason", 1_000);
  return state;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/**
 * Append-only controller defect corpus. Defect records are immutable; lifecycle status is a
 * separate monotonic projection so a repair workflow cannot rewrite the original observation.
 */
export class DefectStore {
  #root;
  #records;
  #states;
  #maxDetails;

  constructor({ root, maxDetailsBytes = MAX_DETAILS } = {}) {
    this.#root = requireRoot(root);
    this.#records = requireRoot(join(this.#root, "records"));
    this.#states = requireRoot(join(this.#root, "states"));
    if (!Number.isSafeInteger(maxDetailsBytes) || maxDetailsBytes < 1 || maxDetailsBytes > 4 * 1024 * 1024) {
      fail("maxDetailsBytes must be between 1 and 4194304");
    }
    this.#maxDetails = maxDetailsBytes;
  }

  capture(input = {}) {
    const observedAt = input.observedAt ?? Date.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail("observedAt is invalid");
    const defectId = input.defectId ?? randomUUID();
    if (!UUID.test(defectId)) fail("defectId is invalid");
    const details = captureLosslessJson(input.details ?? {}, { maxBytes: this.#maxDetails, maxDepth: 24, maxNodes: 10_000 });
    const message = redact(boundedText(input.message ?? "controller defect observed", "message"));
    const record = {
      schemaVersion: 1,
      defectId,
      rootId: safeId(input.rootId, "rootId", true),
      taskId: safeId(input.taskId, "taskId", true),
      attemptId: safeId(input.attemptId, "attemptId", true),
      kind: input.kind ?? "controller",
      origin: input.origin ?? "controller",
      tool: input.tool === undefined ? undefined : redact(boundedText(input.tool, "tool", 256)),
      phase: input.phase === undefined ? undefined : redact(boundedText(input.phase, "phase", 128)),
      message,
      retryable: input.retryable === true,
      observedAt,
      capturedAt: Math.max(observedAt, input.capturedAt ?? observedAt),
      provenance: {
        source: "controller_observation",
        ...(input.provenance && typeof input.provenance === "object" ? input.provenance : {}),
      },
      details: details.value,
      detailsCanonical: details.canonical,
      status: "open",
    };
    // Remove optional undefined fields before the immutable record is hashed/written.
    for (const key of ["rootId", "taskId", "attemptId", "tool", "phase"]) if (record[key] === undefined) delete record[key];
    validateRecord(record);
    const serialized = `${JSON.stringify(record)}\n`;
    const path = recordPath(this.#root, defectId);
    if (!durableExclusive(path, serialized)) {
      const existing = this.read(defectId);
      if (!existing || existing.detailsCanonical !== record.detailsCanonical || existing.message !== record.message) {
        fail("defect id already exists with different content");
      }
      return existing;
    }
    return Object.freeze(structuredClone(record));
  }

  read(defectId) {
    if (!UUID.test(defectId ?? "")) return undefined;
    const record = readJson(recordPath(this.#root, defectId));
    if (!record) return undefined;
    try { validateRecord(record); } catch { return undefined; }
    const state = readJson(statePath(this.#root, defectId));
    if (state) {
      try { validateState(state); } catch { return undefined; }
      return Object.freeze({ ...record, status: state.status, statusAt: state.at, ...(state.reason ? { statusReason: state.reason } : {}) });
    }
    return Object.freeze(record);
  }

  list({ rootId, taskId, statuses } = {}) {
    const wanted = statuses === undefined ? undefined : new Set(statuses);
    const result = [];
    for (const name of readdirSync(this.#records)) {
      if (!name.endsWith(".json")) continue;
      const raw = readJson(join(this.#records, name));
      if (!raw) continue;
      const record = this.read(raw.defectId);
      if (!record) continue;
      if (rootId !== undefined && record.rootId !== rootId) continue;
      if (taskId !== undefined && record.taskId !== taskId) continue;
      if (wanted && !wanted.has(record.status)) continue;
      result.push(record);
    }
    result.sort((a, b) => b.observedAt - a.observedAt || a.defectId.localeCompare(b.defectId));
    return Object.freeze(result);
  }

  transition(defectId, status, { reason, at = Date.now() } = {}) {
    if (!STATUSES.has(status) || status === "open") fail("transition status is invalid");
    const current = this.read(defectId);
    if (!current) return undefined;
    if (!Number.isSafeInteger(at) || at < current.observedAt) fail("transition time is invalid");
    if (current.status === status) return current;
    if (!TRANSITIONS.get(current.status)?.has(status)) fail(`transition ${current.status} -> ${status} is not allowed`);
    const marker = { schemaVersion: 1, defectId, status, at, ...(reason === undefined ? {} : { reason: redact(boundedText(reason, "reason", 1_000)) }) };
    validateState(marker);
    const path = statePath(this.#root, defectId);
    if (existsSync(path)) {
      const existing = readJson(path);
      if (existing) {
        validateState(existing);
        if (existing.status === status) return this.read(defectId);
        if (existing.status !== current.status) fail("defect status was concurrently transitioned");
      }
    }
    atomicWrite(path, `${JSON.stringify(marker)}\n`);
    return this.read(defectId);
  }

  summary({ rootId } = {}) {
    const counts = Object.fromEntries([...STATUSES].map((status) => [status, 0]));
    for (const defect of this.list({ rootId })) counts[defect.status] += 1;
    return Object.freeze({ total: Object.values(counts).reduce((sum, value) => sum + value, 0), ...counts });
  }
}

export function defectFingerprint(defect) {
  if (!defect || typeof defect !== "object") throw new Error("defect fingerprint requires a defect");
  return createHash("sha256").update(JSON.stringify({
    kind: defect.kind, origin: defect.origin, tool: defect.tool, phase: defect.phase,
    message: defect.message, detailsCanonical: defect.detailsCanonical,
  })).digest("hex");
}
