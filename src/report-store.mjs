/**
 * Durable store for verified background-delegation reports.
 *
 * A background delegate returns immediately and the controller verifies the child result on its
 * own. What the main agent later reads is this report — written only after the run settled, so
 * an interrupted process can never leave a half-written "result" that looks complete.
 *
 * Files live in an owner-only directory, one JSON document per task. Writes are atomic
 * (tmp + rename); reads tolerate malformed files because a report must never crash the tool
 * that lists it.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STATUSES = new Set(["completed", "failed"]);
/** Read reports are pruned after this age; unread reports are never deleted automatically. */
export const REPORT_READ_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 64 * 1024;

function reportPath(root, taskId) {
  if (!TASK_ID.test(taskId)) throw new Error("report store requires a bounded task id");
  const path = resolve(join(root, `${taskId}.json`));
  if (!path.startsWith(resolve(root) + sep)) throw new Error("report path escapes the store root");
  return path;
}

function wakeClaimPath(root, taskId) {
  return `${reportPath(root, taskId)}.wake.claim`;
}

function readMarkerPath(root, taskId) {
  return `${reportPath(root, taskId)}.read`;
}

function wakeSentPath(root, taskId) {
  return `${reportPath(root, taskId)}.wake.sent`;
}

function readWakeSentMarker(root, taskId, completedAt) {
  const path = wakeSentPath(root, taskId);
  if (!existsSync(path)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(marker.wakeAt) || marker.wakeAt < completedAt) throw new Error("malformed wake marker");
    return marker.wakeAt;
  } catch {
    // A malformed sent marker follows an accepted host dispatch. Fail closed
    // against a duplicate wake by treating its timestamp as durable.
    try { return Math.max(completedAt, Math.floor(statSync(path).mtimeMs)); }
    catch { return completedAt; }
  }
}

function readReadMarker(root, taskId, completedAt) {
  const path = readMarkerPath(root, taskId);
  if (!existsSync(path)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(marker.readAt) || marker.readAt < completedAt) throw new Error("malformed read marker");
    return marker.readAt;
  } catch {
    // Malformed marker means collection may already have happened. Fail closed
    // against waking by treating file mtime/completion as a durable read.
    try { return Math.max(completedAt, Math.floor(statSync(path).mtimeMs)); }
    catch { return completedAt; }
  }
}

function readWakeClaim(root, taskId, completedAt) {
  const path = wakeClaimPath(root, taskId);
  if (!existsSync(path)) return undefined;
  try {
    const claim = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(claim.createdAt) || claim.createdAt < completedAt
      || typeof claim.token !== "string" || claim.token.length < 16) throw new Error("malformed claim");
    return claim;
  } catch {
    // A malformed durable claim is ambiguous, never permission to replay.
    let createdAt = completedAt;
    try { createdAt = Math.max(completedAt, Math.floor(statSync(path).mtimeMs)); } catch { /* keep completion */ }
    return { createdAt, token: undefined };
  }
}

function validate(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("report must be an object");
  if (typeof report.taskId !== "string" || !TASK_ID.test(report.taskId)) throw new Error("report requires a bounded task id");
  if (!STATUSES.has(report.status)) throw new Error("report status must be completed or failed");
  if (typeof report.task !== "string" || report.task.length === 0) throw new Error("report requires the delegated task text");
  if (!Number.isSafeInteger(report.startedAt) || !Number.isSafeInteger(report.completedAt) || report.completedAt < report.startedAt) {
    throw new Error("report requires coherent started/completed timestamps");
  }
  if (report.readAt !== null && report.readAt !== undefined && !Number.isSafeInteger(report.readAt)) throw new Error("report readAt must be a timestamp or null");
  if (report.wakeClaimedAt !== null && report.wakeClaimedAt !== undefined
    && (!Number.isSafeInteger(report.wakeClaimedAt) || report.wakeClaimedAt < report.completedAt)) {
    throw new Error("report wakeClaimedAt must be null or a timestamp at/after completion");
  }
  if (report.wakeAt !== null && report.wakeAt !== undefined && (!Number.isSafeInteger(report.wakeAt) || report.wakeAt < report.completedAt)) {
    throw new Error("report wakeAt must be null or a timestamp at/after completion");
  }
  if (report.logicalId !== undefined && (typeof report.logicalId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,319}$/.test(report.logicalId))) {
    throw new Error("report logicalId must be a bounded identifier");
  }
  for (const [field, max] of [["resourceId", 500], ["provider", 200], ["modelId", 300], ["effectiveThinking", 40]]) {
    if (report[field] !== undefined && (typeof report[field] !== "string" || report[field].length < 1 || report[field].length > max)) {
      throw new Error(`report ${field} must be a bounded string`);
    }
  }
  if (report.usage !== undefined) {
    if (!report.usage || typeof report.usage !== "object" || Array.isArray(report.usage)) throw new Error("report usage must be an object");
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "turns"]) {
      if (report.usage[field] !== undefined && (!Number.isFinite(report.usage[field]) || report.usage[field] < 0)) {
        throw new Error(`report usage.${field} must be non-negative`);
      }
    }
  }
  for (const field of ["text", "error", "route", "routeExplanation"]) {
    if (report[field] !== undefined && typeof report[field] === "string" && report[field].length > MAX_TEXT) {
      throw new Error(`report ${field} exceeds the bounded size`);
    }
  }
}

function freezeReport(report) {
  return Object.freeze({ ...report, readAt: report.readAt ?? null });
}

function normalizeForWrite(report) {
  return {
    ...report,
    readAt: report.readAt ?? null,
    wakeClaimedAt: report.wakeClaimedAt ?? null,
    wakeAt: report.wakeAt ?? null,
  };
}

/** Persist a settled report atomically. Throws on any schema violation — callers catch. */
export function writeReport(root, report) {
  const normalized = normalizeForWrite(report);
  validate(normalized);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = reportPath(root, normalized.taskId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return freezeReport(normalized);
}

/** Read one report, or undefined when it does not exist or is unreadable/malformed. */
export function readReport(root, taskId) {
  let path;
  try { path = reportPath(root, taskId); } catch { return undefined; }
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    validate(value);
    const readAt = readReadMarker(root, taskId, value.completedAt);
    if (readAt !== undefined) value.readAt = value.readAt === null || value.readAt === undefined
      ? readAt : Math.min(value.readAt, readAt);
    const wakeAt = readWakeSentMarker(root, taskId, value.completedAt);
    if (wakeAt !== undefined) value.wakeAt = value.wakeAt === null || value.wakeAt === undefined
      ? wakeAt : Math.min(value.wakeAt, wakeAt);
    const claim = readWakeClaim(root, taskId, value.completedAt);
    if (claim && value.wakeAt === null) value.wakeClaimedAt = claim.createdAt;
    return freezeReport(value);
  } catch { return undefined; }
}

/** All readable reports, newest completion first. Malformed files are skipped, not fatal. */
export function listReports(root) {
  if (!existsSync(root)) return Object.freeze([]);
  const reports = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const report = readReport(root, name.slice(0, -".json".length));
    if (report) reports.push(report);
  }
  reports.sort((a, b) => b.completedAt - a.completedAt);
  return Object.freeze(reports);
}

export function unreadReports(root) {
  return Object.freeze(listReports(root).filter((report) => report.readAt === null));
}

/** Mark a report read. Returns the updated report, or undefined when it does not exist. */
export function markReportRead(root, taskId, now = Date.now()) {
  const initial = readReport(root, taskId);
  if (!initial) return undefined;
  if (initial.readAt !== null) return initial;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const readAt = Math.max(now, initial.completedAt);
  const path = readMarkerPath(root, taskId);
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (fd !== undefined) {
    try { writeFileSync(fd, `${JSON.stringify({ readAt })}\n`); }
    finally { closeSync(fd); }
  }
  const current = readReport(root, taskId);
  if (!current) return undefined;
  writeReport(root, { ...current, readAt: current.readAt ?? readAt });
  return readReport(root, taskId);
}

/** Claim one pending wake before dispatch. Claimed-but-unmarked wakes never auto-replay. */
export function claimReportWake(root, taskId, now = Date.now()) {
  const initial = readReport(root, taskId);
  if (!initial || initial.readAt !== null || initial.wakeAt !== null || initial.wakeClaimedAt !== null) return undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const createdAt = Math.max(now, initial.completedAt);
  const path = wakeClaimPath(root, taskId);
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") return undefined;
    throw error;
  }
  try { writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt, token })}\n`); }
  catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    // Never unlink a claim pathname: a malformed partial claim is ambiguous and
    // intentionally blocks automatic replay rather than racing a successor.
    throw error;
  }
  closeSync(fd);
  const current = readReport(root, taskId);
  if (!current || current.readAt !== null || current.wakeAt !== null) return undefined;
  try {
    writeReport(root, { ...current, wakeClaimedAt: createdAt });
    const persisted = readReport(root, taskId);
    return persisted?.readAt === null ? persisted : undefined;
  } catch (error) {
    // The create-once claim remains durable on persistence failure. This may
    // defer liveness to the genuine-owner fallback, but can never spend twice.
    throw error;
  }
}

/** Mark a terminal report's automatic parent wake as dispatched. */
export function markReportWoken(root, taskId, now = Date.now()) {
  const report = readReport(root, taskId);
  if (!report) return undefined;
  if (report.wakeAt !== null && report.wakeAt !== undefined) return report;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const wakeAt = Math.max(now, report.completedAt);
  let fd;
  try { fd = openSync(wakeSentPath(root, taskId), "wx", 0o600); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (fd !== undefined) {
    try { writeFileSync(fd, `${JSON.stringify({ wakeAt })}\n`); }
    finally { closeSync(fd); }
  }
  const current = readReport(root, taskId);
  if (!current) return undefined;
  writeReport(root, { ...current, wakeAt: current.wakeAt ?? wakeAt });
  return readReport(root, taskId);
}

/**
 * Delete read reports past the retention window. Unread reports are never pruned: a background
 * result the owner has not seen yet is not garbage, however old it is.
 */
export function pruneReports(root, now = Date.now(), retentionMs = REPORT_READ_RETENTION_MS) {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000) throw new Error("report retention must be at least one minute");
  let pruned = 0;
  for (const report of listReports(root)) {
    if (report.readAt === null || report.readAt + retentionMs > now) continue;
    try {
      rmSync(reportPath(root, report.taskId), { force: true });
      // Durable create-once wake claims are never unlinked automatically. Task
      // ids are unique; a tiny orphan is safer than deleting a successor claim.
      pruned += 1;
    } catch { /* a locked or racing file is left for the next sweep */ }
  }
  return pruned;
}
