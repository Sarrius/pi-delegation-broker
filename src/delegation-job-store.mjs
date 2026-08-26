import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { assertStoredContract } from "./child-contract.mjs";
import { validateTeamState } from "./team.mjs";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const JOB_KINDS = new Set(["task", "workflow"]);
const JOB_STATUSES = new Set([
  "submitted", "queued", "running", "cancellation_requested", "completed", "failed", "cancelled", "expired",
]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);
const MAX_JOB_BYTES = 32 * 1024 * 1024;

function fail(message) { throw new Error(`delegation job store: ${message}`); }

function jobPath(root, jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) fail("job id is invalid");
  const path = resolve(join(root, `${jobId}.json`));
  if (!path.startsWith(resolve(root) + sep)) fail("job path escapes the store root");
  return path;
}

function validTime(value) { return Number.isSafeInteger(value) && value >= 0; }

function validate(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) fail("job must be an object");
  if (job.schemaVersion !== 1) fail("schemaVersion must equal 1");
  if (typeof job.jobId !== "string" || !JOB_ID.test(job.jobId)) fail("job id is invalid");
  if (!JOB_KINDS.has(job.kind)) fail("kind must be task or workflow");
  if (!JOB_STATUSES.has(job.status)) fail("status is invalid");
  if (!validTime(job.submittedAt) || !validTime(job.updatedAt) || job.updatedAt < job.submittedAt) fail("timestamps are invalid");
  if (job.startedAt !== undefined && (!validTime(job.startedAt) || job.startedAt < job.submittedAt)) fail("startedAt is invalid");
  if (job.completedAt !== undefined && (!validTime(job.completedAt) || job.completedAt < job.submittedAt)) fail("completedAt is invalid");
  if (TERMINAL.has(job.status) !== (job.completedAt !== undefined)) fail("terminal jobs require completedAt and non-terminal jobs forbid it");
  if (job.deadlineAt !== undefined && (!validTime(job.deadlineAt) || job.deadlineAt <= job.submittedAt)) fail("deadlineAt is invalid");
  if (job.idempotencyKey !== undefined && (typeof job.idempotencyKey !== "string" || job.idempotencyKey.length < 1 || job.idempotencyKey.length > 200 || /[\0\r\n]/.test(job.idempotencyKey))) {
    fail("idempotencyKey is invalid");
  }
  if (typeof job.cwd !== "string" || job.cwd.length < 1 || job.cwd.length > 4096 || /\0/.test(job.cwd)) fail("cwd is invalid");
  if (job.ownerSessionId !== undefined && (typeof job.ownerSessionId !== "string" || !SESSION_ID.test(job.ownerSessionId))) fail("ownerSessionId is invalid");
  if (job.kind === "task" && (typeof job.task !== "string" || job.task.length < 1 || job.task.length > 256 * 1024)) fail("task text is invalid");
  // The contract is durable intent: a malformed one must not survive a restart and silently
  // resolve into different spending than the caller asked for. Node contracts are the same
  // allowlist — without this check, a tampered workflow stage would recover and run on defaults.
  if (job.contract !== undefined) {
    try { assertStoredContract(job.contract); }
    catch (error) { fail(String(error.message).replace(/^child contract: /, "")); }
  }
  if (job.kind === "workflow") {
    if (!Array.isArray(job.nodes) || job.nodes.length < 1 || job.nodes.length > 1000) fail("workflow nodes are invalid");
    if (!Number.isSafeInteger(job.concurrency) || job.concurrency < 1 || job.concurrency > 64) fail("workflow concurrency is invalid");
    for (const node of job.nodes) {
      if (node?.contract === undefined) continue;
      try { assertStoredContract(node.contract); }
      catch (error) {
        fail(`node ${node.id ?? "?"} ${String(error.message).replace(/^child contract: /, "")}`);
      }
    }
    if (job.team !== undefined) {
      try { validateTeamState(job.team, job.nodes); }
      catch (error) { fail(String(error.message).replace(/^team admission: /, "")); }
    }
  }
  const serialized = JSON.stringify(job);
  if (Buffer.byteLength(serialized) > MAX_JOB_BYTES) fail("job exceeds the durable size bound");
  return serialized;
}

function freezeJob(job) { return Object.freeze(structuredClone(job)); }

export function isTerminalJobStatus(status) { return TERMINAL.has(status); }

export function writeJob(root, job) {
  const serialized = validate(job);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = jobPath(root, job.jobId);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${serialized}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return freezeJob(job);
}

export function readJob(root, jobId) {
  let path;
  try { path = jobPath(root, jobId); } catch { return undefined; }
  if (!existsSync(path)) return undefined;
  try {
    const job = JSON.parse(readFileSync(path, "utf8"));
    validate(job);
    return freezeJob(job);
  } catch { return undefined; }
}

export function listJobs(root) {
  if (!existsSync(root)) return Object.freeze([]);
  const jobs = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const job = readJob(root, name.slice(0, -5));
    if (job) jobs.push(job);
  }
  jobs.sort((left, right) => right.updatedAt - left.updatedAt || left.jobId.localeCompare(right.jobId));
  return Object.freeze(jobs);
}

export function submitJob(root, job) {
  if (job?.idempotencyKey !== undefined) {
    const existing = listJobs(root).find((candidate) => candidate.idempotencyKey === job.idempotencyKey);
    if (existing) return Object.freeze({ created: false, job: existing });
  }
  if (readJob(root, job?.jobId)) fail("job id already exists");
  return Object.freeze({ created: true, job: writeJob(root, job) });
}

export function updateJob(root, jobId, update, now = Date.now()) {
  if (typeof update !== "function") fail("update must be a function");
  const current = readJob(root, jobId);
  if (!current) return undefined;
  const next = update(structuredClone(current));
  if (!next || next.jobId !== current.jobId || next.kind !== current.kind || next.submittedAt !== current.submittedAt) fail("update changed immutable identity");
  return writeJob(root, { ...next, updatedAt: now });
}

export function requestJobCancellation(root, jobId, now = Date.now(), ownerSessionId) {
  return updateJob(root, jobId, (job) => {
    if (job.ownerSessionId !== undefined && ownerSessionId !== job.ownerSessionId) fail("job owner session does not match");
    if (TERMINAL.has(job.status)) return job;
    return { ...job, status: "cancellation_requested", cancelRequestedAt: now };
  }, now);
}

/**
 * Recover work after a controller process restart. A durable `running` state proves dispatch
 * started, not that the old process still owns it. Read-only work is requeued; an outstanding
 * cancellation is settled rather than relaunched.
 */
export function recoverJobs(root, now = Date.now()) {
  const recovered = [];
  for (const current of listJobs(root)) {
    if (TERMINAL.has(current.status)) continue;
    const next = updateJob(root, current.jobId, (job) => {
      if (job.status === "cancellation_requested") {
        return { ...job, status: "cancelled", completedAt: now, terminalReason: "cancelled during controller restart" };
      }
      const nodes = Array.isArray(job.nodes)
        ? job.nodes.map((node) => node.state === "running" ? { ...node, state: "pending", result: undefined, error: undefined } : node)
        : undefined;
      return {
        ...job,
        status: "queued",
        ...(nodes ? { nodes } : {}),
        recoveryCount: (job.recoveryCount ?? 0) + 1,
      };
    }, now);
    if (next) recovered.push(next);
  }
  return Object.freeze(recovered);
}

export function removeJob(root, jobId) {
  try { rmSync(jobPath(root, jobId), { force: true }); return true; } catch { return false; }
}
