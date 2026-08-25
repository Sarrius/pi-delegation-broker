import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,319}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const MAX_ROOTS = 64;

function fail(message) { throw new Error(`session binding store: ${message}`); }
function bounded(value, label, max = 4_096) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) fail(`${label} is invalid`);
  return value;
}
function rootId(value) {
  if (typeof value !== "string" || !ID.test(value)) fail("root id is invalid");
  return value;
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
function key(sessionId) { return createHash("sha256").update(sessionId).digest("hex"); }
function pathFor(root, sessionId) { return join(root, `${key(sessionId)}.json`); }
function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
function validate(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || binding.schemaVersion !== 1) fail("binding schema is invalid");
  if (typeof binding.sessionId !== "string" || !SESSION_ID.test(binding.sessionId)) fail("sessionId is invalid");
  if (binding.sessionFile !== undefined) bounded(binding.sessionFile, "sessionFile");
  if (!Array.isArray(binding.rootIds) || binding.rootIds.length > MAX_ROOTS || new Set(binding.rootIds).size !== binding.rootIds.length) fail("rootIds are invalid");
  binding.rootIds.forEach(rootId);
  if (!new Set(["active", "suspended", "compacted"]).has(binding.status)) fail("binding status is invalid");
  if (binding.cursor !== undefined) bounded(binding.cursor, "cursor", 512);
  for (const field of ["updatedAt", "boundAt"]) if (!Number.isSafeInteger(binding[field]) || binding[field] < 0) fail(`${field} is invalid`);
  return binding;
}
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }

/** Durable owner-session → active delegation roots/cursor binding used to rebuild parent context. */
export class SessionBindingStore {
  #root;
  constructor({ root } = {}) { this.#root = requireRoot(root); }

  bind({ sessionId, sessionFile, rootIds = [], cursor, status = "active", at = Date.now() } = {}) {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) fail("sessionId is invalid");
    if (!Array.isArray(rootIds) || rootIds.length > MAX_ROOTS) fail("rootIds are invalid");
    const binding = {
      schemaVersion: 1,
      sessionId,
      ...(sessionFile === undefined ? {} : { sessionFile: bounded(sessionFile, "sessionFile") }),
      rootIds: [...new Set(rootIds.map(rootId))].slice(0, MAX_ROOTS),
      status,
      ...(cursor === undefined ? {} : { cursor: bounded(cursor, "cursor", 512) }),
      boundAt: at,
      updatedAt: at,
    };
    validate(binding);
    atomicWrite(pathFor(this.#root, sessionId), binding);
    return Object.freeze(structuredClone(binding));
  }

  update(sessionId, patch = {}) {
    const current = this.read(sessionId);
    if (!current) return undefined;
    const next = {
      ...current,
      ...patch,
      sessionId: current.sessionId,
      schemaVersion: 1,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    if (patch.rootIds !== undefined) next.rootIds = [...new Set(patch.rootIds.map(rootId))].slice(0, MAX_ROOTS);
    validate(next);
    atomicWrite(pathFor(this.#root, sessionId), next);
    return Object.freeze(structuredClone(next));
  }

  read(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return undefined;
    const value = readJson(pathFor(this.#root, sessionId));
    if (!value) return undefined;
    try { validate(value); } catch { return undefined; }
    return Object.freeze(value);
  }

  list() {
    const result = [];
    for (const name of readdirSync(this.#root)) {
      if (!name.endsWith(".json")) continue;
      const value = readJson(join(this.#root, name));
      if (!value) continue;
      try { validate(value); } catch { continue; }
      result.push(Object.freeze(value));
    }
    result.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
    return Object.freeze(result);
  }
}

export function sessionIdentity(ctx) {
  const manager = ctx?.sessionManager;
  const id = manager?.getSessionId?.();
  if (typeof id === "string" && SESSION_ID.test(id)) return id;
  const file = manager?.getSessionFile?.();
  if (typeof file === "string" && file.length > 0) return `file:${file}`;
  const cwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : "unknown";
  return `ephemeral:${cwd}`;
}

export function sessionCursor(ctx) {
  const cursor = ctx?.sessionManager?.getLeafId?.();
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

export function formatSessionResumeStatus(binding, jobs = []) {
  if (!binding || !Array.isArray(binding.rootIds) || binding.rootIds.length === 0) return "";
  const byId = new Map(jobs.filter((job) => job && typeof job.jobId === "string").map((job) => [job.jobId, job]));
  const lines = [];
  for (const root of binding.rootIds.slice(0, 12)) {
    const job = byId.get(root);
    if (!job) lines.push(`${root}: durable state unavailable; inspect delegate_status`);
    else if (job.kind === "workflow") {
      const nodes = Array.isArray(job.nodes) ? job.nodes : [];
      const counts = nodes.reduce((out, node) => { out[node.state] = (out[node.state] ?? 0) + 1; return out; }, {});
      lines.push(`${root}: ${job.status}; nodes ${Object.entries(counts).map(([state, count]) => `${state}=${count}`).join(", ")}`);
    } else {
      lines.push(`${root}: ${job.status}${job.terminalReason ? `; ${String(job.terminalReason).slice(0, 160)}` : ""}`);
    }
  }
  return [
    "[delegation-broker durable resume status]",
    "This is controller state, not a user task and not child prose. Preserve the current user request; use delegate_status/collect for details.",
    `session cursor: ${binding.cursor ?? "unknown"}; binding: ${binding.status}`,
    lines.join("\n"),
  ].join("\n");
}
