import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MODES = new Set(["production", "depth2_readonly_canary"]);
const DIFFERENCES = new Set(["provider_diversity", "adversarial_method", "separate_evidence_source", "reviewer_independence", "different_scope"]);
const ACTIVE = new Set(["admitted", "running"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function fail(message) { throw new Error(`recursive admission: ${message}`); }
function bounded(value, label, max = 4096) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) fail(`${label} is invalid`);
  return value.trim();
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function fingerprint(value, label) {
  if (typeof value === "string" && SHA256.test(value)) return value;
  return digest({ [label]: value ?? [] });
}
function normalizePolicy(value = {}, { canaryEnabled = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("policy must be an object");
  const mode = value.mode ?? "production";
  if (!MODES.has(mode)) fail("mode is invalid");
  if (mode === "depth2_readonly_canary" && !canaryEnabled) fail("depth-2 canary is disabled");
  const maxDepth = integer(value.maxDepth ?? (mode === "depth2_readonly_canary" ? 2 : 1), "maxDepth", 1, 2);
  if (mode === "production" && maxDepth > 1) fail("production recursion depth is limited to 1");
  if (mode === "depth2_readonly_canary" && maxDepth !== 2) fail("read-only canary must use depth 2");
  const maxAttempts = integer(value.maxAttempts ?? (mode === "depth2_readonly_canary" ? 1 : 16), "maxAttempts", 1, 256);
  const maxDirectChildren = integer(value.maxDirectChildren ?? (mode === "depth2_readonly_canary" ? 1 : 4), "maxDirectChildren", 1, 64);
  const maxDescendants = integer(value.maxDescendants ?? (mode === "depth2_readonly_canary" ? 1 : 16), "maxDescendants", 1, 256);
  const maxParallel = integer(value.maxParallel ?? (mode === "depth2_readonly_canary" ? 1 : 2), "maxParallel", 1, 64);
  if (mode === "depth2_readonly_canary" && (maxAttempts !== 1 || maxDirectChildren !== 1 || maxParallel !== 1 || maxDescendants !== 1)) fail("read-only canary is limited to one child and one parallel slot");
  return Object.freeze({
    mode,
    maxDepth,
    maxDirectChildren,
    maxDescendants,
    maxParallel,
    maxRedundant: integer(value.maxRedundant ?? 0, "maxRedundant", 0, 64),
    maxAttempts,
    ...(value.deadlineAt === undefined ? {} : { deadlineAt: integer(value.deadlineAt, "deadlineAt", 1, Number.MAX_SAFE_INTEGER) }),
  });
}
function normalizeRequest(request, expected) {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("request must be an object");
  const rootId = bounded(request.rootId, "rootId", 160);
  const parentTaskId = bounded(request.parentTaskId, "parentTaskId", 160);
  const depth = integer(request.depth, "depth", 1, 2);
  if (rootId !== expected.rootId || parentTaskId !== expected.parentTaskId || depth !== expected.depth) fail("request lineage does not match the current lease");
  if (request.maxDepth !== undefined && request.maxDepth !== expected.policy.maxDepth) fail("request maxDepth does not match controller policy");
  const task = bounded(request.task, "task", 256 * 1024);
  const scope = typeof request.scope === "string" ? bounded(request.scope, "scope", 16 * 1024) : "";
  const objective = typeof request.objective === "string" ? bounded(request.objective, "objective", 256 * 1024) : task;
  const purpose = typeof request.purpose === "string" ? bounded(request.purpose, "purpose", 80) : "specialist";
  const materialDifference = request.materialDifference;
  if (materialDifference !== undefined && !DIFFERENCES.has(materialDifference)) fail("materialDifference is invalid");
  const inputFingerprint = fingerprint(request.inputFingerprint ?? request.inputs, "inputs");
  const artifactFingerprint = fingerprint(request.artifactFingerprint, "artifact");
  const identity = { objective, scope, inputFingerprint, artifactFingerprint, purpose, materialDifference: materialDifference ?? null };
  return Object.freeze({
    task, objective, scope, purpose, inputFingerprint, artifactFingerprint,
    objectiveFingerprint: digest({ objective, scope, inputFingerprint, artifactFingerprint }),
    digest: digest(identity),
    ...(materialDifference ? { materialDifference } : {}),
  });
}

export class RecursiveAdmissionStore {
  #db;
  #path;
  #canaryEnabled;
  constructor({ path, canaryEnabled = false } = {}) {
    if (typeof path !== "string" || !isAbsolute(path)) fail("path must be absolute");
    this.#path = path;
    this.#canaryEnabled = canaryEnabled === true;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const dir = statSync(dirname(path));
    if (!dir.isDirectory() || (dir.mode & 0o077) !== 0) fail("store directory must be owner-only");
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS recursive_roots (
        root_id TEXT PRIMARY KEY, policy TEXT NOT NULL, cancelled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recursive_jobs (
        job_id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES recursive_roots(root_id), parent_task_id TEXT NOT NULL,
        depth INTEGER NOT NULL, idempotency_key TEXT NOT NULL, digest TEXT NOT NULL, objective_fingerprint TEXT NOT NULL,
        task TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, terminal_at INTEGER,
        recovery_count INTEGER NOT NULL DEFAULT 0, UNIQUE(root_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS recursive_jobs_root ON recursive_jobs(root_id, status);
      CREATE INDEX IF NOT EXISTS recursive_jobs_parent ON recursive_jobs(root_id, parent_task_id, status);
    `);
  }
  close() { this.#db.close(); }
  registerRoot({ rootId, policy = {}, now = Date.now() } = {}) {
    const id = bounded(rootId, "rootId", 160);
    const normalized = normalizePolicy(policy, { canaryEnabled: this.#canaryEnabled });
    const prior = this.#db.prepare("SELECT policy FROM recursive_roots WHERE root_id = ?").get(id);
    if (prior) {
      if (JSON.stringify(JSON.parse(prior.policy)) !== JSON.stringify(normalized)) fail("root policy is immutable");
      return Object.freeze({ rootId: id, policy: normalized, existing: true });
    }
    this.#db.prepare("INSERT INTO recursive_roots(root_id, policy, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(normalized), now, now);
    return Object.freeze({ rootId: id, policy: normalized, existing: false });
  }
  root(rootId) {
    const row = this.#db.prepare("SELECT * FROM recursive_roots WHERE root_id = ?").get(rootId);
    if (!row) return undefined;
    return Object.freeze({ rootId: row.root_id, policy: Object.freeze(JSON.parse(row.policy)), cancelledAt: row.cancelled_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  admit({ rootId, parentTaskId, parentDepth, request, idempotencyKey, now = Date.now() } = {}) {
    const root = this.root(rootId);
    if (!root) fail("root is not registered");
    if (root.cancelledAt !== undefined) return Object.freeze({ status: "cancelled", reason: "root_cancelled" });
    if (root.policy.deadlineAt !== undefined && now >= root.policy.deadlineAt) return Object.freeze({ status: "expired", reason: "root_deadline" });
    const parent = bounded(parentTaskId, "parentTaskId", 160);
    const parentLevel = integer(parentDepth, "parentDepth", 0, 2);
    const depth = parentLevel + 1;
    if (depth > root.policy.maxDepth) return Object.freeze({ status: "denied_budget", reason: "maxDepth", depth });
    const normalized = normalizeRequest({ ...request, rootId, parentTaskId: parent, depth }, { rootId, parentTaskId: parent, depth, policy: root.policy });
    const key = bounded(idempotencyKey, "idempotencyKey", 200);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#db.prepare("SELECT * FROM recursive_jobs WHERE root_id = ? AND idempotency_key = ?").get(rootId, key);
      if (prior) {
        if (prior.digest !== normalized.digest) fail("idempotency key was reused with a different request");
        this.#db.exec("COMMIT");
        return Object.freeze({ status: "reused", jobId: prior.job_id, rootId, depth: prior.depth });
      }
      const exact = this.#db.prepare("SELECT job_id, depth FROM recursive_jobs WHERE root_id = ? AND digest = ? LIMIT 1").get(rootId, normalized.digest);
      if (exact) {
        this.#db.exec("COMMIT");
        return Object.freeze({ status: "reused", jobId: exact.job_id, rootId, depth: exact.depth });
      }
      const sameObjective = this.#db.prepare("SELECT count(*) AS count FROM recursive_jobs WHERE root_id = ? AND objective_fingerprint = ?").get(rootId, normalized.objectiveFingerprint).count;
      if (sameObjective > 0 && !normalized.materialDifference) { this.#db.exec("COMMIT"); return Object.freeze({ status: "denied_duplicate", reason: "materialDifference_required" }); }
      const count = this.#db.prepare("SELECT count(*) AS count FROM recursive_jobs WHERE root_id = ?").get(rootId).count;
      if (count >= root.policy.maxDescendants) { this.#db.exec("COMMIT"); return Object.freeze({ status: "denied_budget", reason: "maxDescendants" }); }
      const active = this.#db.prepare("SELECT count(*) AS count FROM recursive_jobs WHERE root_id = ? AND status IN ('admitted','running')").get(rootId).count;
      if (active >= root.policy.maxParallel) { this.#db.exec("COMMIT"); return Object.freeze({ status: "capacity_yield", reason: "maxParallel" }); }
      const direct = this.#db.prepare("SELECT count(*) AS count FROM recursive_jobs WHERE root_id = ? AND parent_task_id = ?").get(rootId, parent).count;
      if (direct >= root.policy.maxDirectChildren) { this.#db.exec("COMMIT"); return Object.freeze({ status: "denied_budget", reason: "maxDirectChildren" }); }
      if (sameObjective > root.policy.maxRedundant) { this.#db.exec("COMMIT"); return Object.freeze({ status: "denied_budget", reason: "redundancyBudget" }); }
      const jobId = `desc-${randomUUID()}`;
      this.#db.prepare("INSERT INTO recursive_jobs(job_id, root_id, parent_task_id, depth, idempotency_key, digest, objective_fingerprint, task, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?)").run(jobId, rootId, parent, depth, key, normalized.digest, normalized.objectiveFingerprint, normalized.task, now);
      this.#db.prepare("UPDATE recursive_roots SET updated_at = ? WHERE root_id = ?").run(now, rootId);
      this.#db.exec("COMMIT");
      return Object.freeze({ status: "admitted", jobId, rootId, parentTaskId: parent, depth, request: normalized });
    } catch (error) { try { this.#db.exec("ROLLBACK"); } catch {} throw error; }
  }
  start(jobId, now = Date.now()) {
    const result = this.#db.prepare("UPDATE recursive_jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE job_id = ? AND status = 'admitted'").run(now, jobId);
    return Object.freeze({ status: result.changes === 1 ? "started" : "not_admitted", jobId });
  }
  settle(jobId, status, now = Date.now()) {
    if (!TERMINAL.has(status)) fail("terminal recursive status is invalid");
    const result = this.#db.prepare("UPDATE recursive_jobs SET status = ?, terminal_at = ? WHERE job_id = ? AND status IN ('admitted','running')").run(status, now, jobId);
    return Object.freeze({ status: result.changes === 1 ? "settled" : "already_settled", jobId });
  }
  cancelDescendants(rootId, parentTaskId, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare(`WITH RECURSIVE descendants(job_id) AS (
        SELECT job_id FROM recursive_jobs WHERE root_id = ? AND parent_task_id = ?
        UNION ALL SELECT child.job_id FROM recursive_jobs child JOIN descendants parent ON child.parent_task_id = parent.job_id WHERE child.root_id = ?
      ) UPDATE recursive_jobs SET status = 'cancelled', terminal_at = ? WHERE job_id IN (SELECT job_id FROM descendants) AND status IN ('admitted','running')`).run(rootId, parentTaskId, rootId, now);
      this.#db.exec("COMMIT");
      return Object.freeze({ status: "cancelled", count: result.changes });
    } catch (error) { try { this.#db.exec("ROLLBACK"); } catch {} throw error; }
  }
  cancelRoot(rootId, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE recursive_roots SET cancelled_at = ?, updated_at = ? WHERE root_id = ? AND cancelled_at IS NULL").run(now, now, rootId);
      const result = this.#db.prepare("UPDATE recursive_jobs SET status = 'cancelled', terminal_at = ? WHERE root_id = ? AND status IN ('admitted','running')").run(now, rootId);
      this.#db.exec("COMMIT");
      return Object.freeze({ status: "cancelled", count: result.changes });
    } catch (error) { try { this.#db.exec("ROLLBACK"); } catch {} throw error; }
  }
  reconcile(now = Date.now()) {
    const result = this.#db.prepare("UPDATE recursive_jobs SET status = 'admitted', recovery_count = recovery_count + 1 WHERE status = 'running'").run();
    this.#db.prepare("UPDATE recursive_roots SET updated_at = ?").run(now);
    return Object.freeze({ status: "reconciled", count: result.changes });
  }
  job(jobId) {
    const row = this.#db.prepare("SELECT * FROM recursive_jobs WHERE job_id = ?").get(jobId);
    return row ? Object.freeze({ jobId: row.job_id, rootId: row.root_id, parentTaskId: row.parent_task_id, depth: row.depth, status: row.status, task: row.task, recoveryCount: row.recovery_count }) : undefined;
  }
}

export { normalizePolicy as normalizeRecursivePolicy };
