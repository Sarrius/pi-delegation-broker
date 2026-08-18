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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

function validate(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("report must be an object");
  if (typeof report.taskId !== "string" || !TASK_ID.test(report.taskId)) throw new Error("report requires a bounded task id");
  if (!STATUSES.has(report.status)) throw new Error("report status must be completed or failed");
  if (typeof report.task !== "string" || report.task.length === 0) throw new Error("report requires the delegated task text");
  if (!Number.isSafeInteger(report.startedAt) || !Number.isSafeInteger(report.completedAt) || report.completedAt < report.startedAt) {
    throw new Error("report requires coherent started/completed timestamps");
  }
  if (report.readAt !== null && report.readAt !== undefined && !Number.isSafeInteger(report.readAt)) throw new Error("report readAt must be a timestamp or null");
  for (const field of ["text", "error", "route", "routeExplanation"]) {
    if (report[field] !== undefined && typeof report[field] === "string" && report[field].length > MAX_TEXT) {
      throw new Error(`report ${field} exceeds the bounded size`);
    }
  }
}

function freezeReport(report) {
  return Object.freeze({ ...report, readAt: report.readAt ?? null });
}

/** Persist a settled report atomically. Throws on any schema violation — callers catch. */
export function writeReport(root, report) {
  validate(report);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = reportPath(root, report.taskId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return freezeReport(report);
}

/** Read one report, or undefined when it does not exist or is unreadable/malformed. */
export function readReport(root, taskId) {
  let path;
  try { path = reportPath(root, taskId); } catch { return undefined; }
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    validate(value);
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
  const report = readReport(root, taskId);
  if (!report) return undefined;
  if (report.readAt !== null) return report;
  return writeReport(root, { ...report, readAt: now });
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
      pruned += 1;
    } catch { /* a locked or racing file is left for the next sweep */ }
  }
  return pruned;
}
