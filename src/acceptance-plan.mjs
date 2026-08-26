import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_CHECKS = 20;
const MAX_PATH_LENGTH = 1_024;
const MAX_CONTENT_BYTES = 1 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 32_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const FIXED_DEFINITIONS = Object.freeze({
  "git-diff-check": Object.freeze({
    claim: "git diff --check passes",
    argv: Object.freeze(["git", "diff", "--check"]),
  }),
  "npm-check": Object.freeze({
    claim: "npm run check passes",
    argv: Object.freeze(["npm", "run", "check"]),
  }),
  "npm-test": Object.freeze({
    claim: "npm test passes",
    argv: Object.freeze(["npm", "test"]),
  }),
  "npm-release-check": Object.freeze({
    claim: "npm run release:check passes",
    argv: Object.freeze(["npm", "run", "release:check"]),
  }),
});

export const controllerAcceptanceCheckIds = Object.freeze([
  ...Object.keys(FIXED_DEFINITIONS),
  "file-equals",
]);

function fail(message) {
  throw new Error(`controller acceptance plan: ${message}`);
}

function exactKeys(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !actual.includes(key))) {
    fail(`${label} has unsupported or missing fields`);
  }
}

function boundedTimeout(value) {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    fail(`timeoutMs must be an integer between 100 and ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PATH_LENGTH
    || value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    fail("file-equals path must be a bounded relative POSIX path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part === ".git")) {
    fail("file-equals path contains an unsafe component");
  }
  return value;
}

function normalizeSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || typeof spec.id !== "string" || !ID.test(spec.id)) {
    fail("check id is invalid");
  }
  if (!controllerAcceptanceCheckIds.includes(spec.id)) fail(`unsupported fixed check id: ${spec.id}`);
  const keys = spec.id === "file-equals"
    ? ["id", "path", "content", "timeoutMs"]
    : ["id", "timeoutMs"];
  exactKeys(spec, keys, spec.id === "file-equals" ? ["id", "path", "content"] : ["id"], `check ${spec.id}`);
  const timeoutMs = boundedTimeout(spec.timeoutMs);
  if (spec.id === "file-equals") {
    const path = safeRelativePath(spec.path);
    if (typeof spec.content !== "string" || spec.content.includes("\0") || Buffer.byteLength(spec.content, "utf8") > MAX_CONTENT_BYTES) {
      fail("file-equals content must be bounded UTF-8 text without NUL bytes");
    }
    return Object.freeze({ id: spec.id, path, content: spec.content, timeoutMs });
  }
  return Object.freeze({ id: spec.id, timeoutMs });
}

/**
 * Normalize the public acceptance vocabulary. Callers choose a fixed controller check,
 * but can never supply an executable, claim, kind, or expected shell output.
 */
export function normalizeControllerAcceptanceSpecs(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_CHECKS) {
    fail(`checks must contain 0..${MAX_CHECKS} fixed entries`);
  }
  const normalized = value.map(normalizeSpec);
  if (new Set(normalized.map((check) => check.id)).size !== normalized.length) fail("check ids must be unique");
  return Object.freeze(normalized);
}

function validateCwd(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) fail("cwd must be an absolute path");
  return resolve(cwd);
}

function outputChunk(value) {
  return typeof value === "string" ? value.slice(0, MAX_OUTPUT_CHARS) : "";
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 || /[\0\r\n]/.test(text) ? "controller check failed" : text;
}

function controllerEnvironment() {
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (typeof process.env[key] === "string" && process.env[key].length > 0) environment[key] = process.env[key];
  }
  environment.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  environment.HOME ??= homedir();
  // Acceptance checks must not turn into package installation or an audit/network side effect.
  environment.CI = "1";
  environment.NPM_CONFIG_OFFLINE = "true";
  environment.NPM_CONFIG_AUDIT = "false";
  environment.NPM_CONFIG_FUND = "false";
  environment.GIT_TERMINAL_PROMPT = "0";
  return Object.freeze(environment);
}

function spawnFixedCommand({ argv, cwd, timeoutMs, signal }) {
  return new Promise((resolveResult) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
      resolveResult(Object.freeze({
        exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : 1,
        stdout: outputChunk(stdout),
        stderr: outputChunk(stderr),
      }));
    };
    const abort = () => {
      if (settled) return;
      stderr = (stderr + "controller check aborted").slice(0, MAX_OUTPUT_CHARS);
      child?.kill?.("SIGTERM");
    };
    try {
      child = spawn(argv[0], [...argv.slice(1)], {
        cwd,
        env: controllerEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (data) => { stdout = (stdout + String(data)).slice(0, MAX_OUTPUT_CHARS); });
      child.stderr?.on("data", (data) => { stderr = (stderr + String(data)).slice(0, MAX_OUTPUT_CHARS); });
      child.once("error", (error) => {
        stderr = (stderr + safeError(error)).slice(0, MAX_OUTPUT_CHARS);
        finish({ exitCode: timedOut ? 124 : 127 });
      });
      child.once("close", (code) => finish({ exitCode: timedOut ? 124 : (code ?? 1) }));
      timer = setTimeout(() => {
        timedOut = true;
        stderr = (stderr + "controller check timed out").slice(0, MAX_OUTPUT_CHARS);
        child.kill?.("SIGTERM");
        setTimeout(() => child.kill?.("SIGKILL"), 250).unref?.();
      }, timeoutMs);
      timer.unref?.();
      if (signal?.aborted) abort();
      else signal?.addEventListener?.("abort", abort, { once: true });
    } catch (error) {
      stderr = safeError(error);
      finish({ exitCode: 127 });
    }
  });
}

async function readFileWithoutSymlinks(cwd, relativePath) {
  const target = resolve(cwd, relativePath);
  const escaped = relative(cwd, target);
  if (!escaped || escaped.startsWith("..") || isAbsolute(escaped)) fail("file-equals path escapes cwd");
  const parts = relativePath.split("/");
  let current = cwd;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    const parent = await lstat(current);
    if (parent.isSymbolicLink() || !parent.isDirectory()) fail("file-equals parent path is not a real directory");
  }
  const handle = await open(target, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) fail("file-equals target is not a bounded regular file");
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function runFileEquals(spec, cwd) {
  try {
    const actual = await readFileWithoutSymlinks(cwd, spec.path);
    const expected = Buffer.from(spec.content, "utf8");
    const matches = actual.length === expected.length && actual.equals(expected);
    const digest = createHash("sha256").update(actual).digest("hex");
    return Object.freeze({
      exitCode: matches ? 0 : 1,
      stdout: `${spec.path}: ${actual.length} bytes sha256=${digest}`,
      stderr: matches ? "" : "file content mismatch",
    });
  } catch (error) {
    return Object.freeze({ exitCode: 1, stdout: "", stderr: safeError(error) });
  }
}

/**
 * Build a fixed controller-owned plan for a particular verification cwd. The returned closure
 * rejects tampered check descriptors and has no path to execute caller-provided argv.
 */
export function createControllerAcceptancePlan(specs, { cwd } = {}) {
  const normalized = normalizeControllerAcceptanceSpecs(specs);
  const root = validateCwd(cwd);
  const checks = normalized.map((spec) => {
    const definition = FIXED_DEFINITIONS[spec.id];
    return Object.freeze({
      id: spec.id,
      claim: definition?.claim ?? `file-equals ${spec.path}`,
      kind: "command",
      timeoutMs: spec.timeoutMs,
    });
  });
  const byId = new Map(normalized.map((spec) => [spec.id, spec]));
  const runCheck = async (check, { signal } = {}) => {
    const spec = byId.get(check?.id);
    if (!spec) throw new Error("controller acceptance check is not in the fixed plan");
    const expected = checks.find((entry) => entry.id === spec.id);
    if (!expected || check.kind !== expected.kind || check.claim !== expected.claim) {
      throw new Error("controller acceptance check descriptor was mutated");
    }
    if (spec.id === "file-equals") return runFileEquals(spec, root);
    return spawnFixedCommand({ argv: FIXED_DEFINITIONS[spec.id].argv, cwd: root, timeoutMs: spec.timeoutMs, signal });
  };
  return Object.freeze({
    cwd: root,
    specs: normalized,
    checks: Object.freeze(checks),
    runCheck,
  });
}
