import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const DIFF_MAX_BUFFER = 256 * 1024 * 1024 + 1;

export class WorktreeCollectionError extends Error {
  constructor(message, worktreePath) {
    super(message);
    this.name = "WorktreeCollectionError";
    this.worktreePath = worktreePath;
  }
}

export async function createWorktree(cwd, path) {
  const worktreePath = resolve(path);
  await mkdir(dirname(worktreePath), { recursive: true });
  let prefix;
  try {
    const result = await exec("git", ["-C", cwd, "rev-parse", "--show-prefix"], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
    prefix = result.stdout.replace(/\r?\n$/, "");
    await exec("git", ["-C", cwd, "worktree", "add", worktreePath, "--detach", "HEAD"], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Failed to create git worktree: ${commandError(error)}`);
  }
  try {
    const { stdout } = await exec("git", ["-C", worktreePath, "rev-parse", "HEAD"], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
    const childCwd = resolve(worktreePath, prefix);
    await mkdir(childCwd, { recursive: true });
    return { path: worktreePath, cwd: childCwd, baseCommit: stdout.trim() };
  } catch (error) {
    await cleanupWorktree(cwd, worktreePath).catch(() => undefined);
    throw new Error(`Failed to record worktree base: ${commandError(error)}`);
  }
}

export async function collectWorktree(worktree) {
  const { path, baseCommit } = worktree;
  try {
    await exec("git", ["-C", path, "add", "-A", "-N"], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
    const [{ stdout: patch }, { stdout: names }] = await Promise.all([
      exec("git", ["-C", path, "diff", "--no-ext-diff", "--binary", baseCommit], { maxBuffer: DIFF_MAX_BUFFER, signal: AbortSignal.timeout(GIT_TIMEOUT_MS) }),
      exec("git", ["-C", path, "diff", "--name-only", "-z", baseCommit], { maxBuffer: DIFF_MAX_BUFFER, signal: AbortSignal.timeout(GIT_TIMEOUT_MS) }),
    ]);
    return { patch, changed: names.split("\0").filter(Boolean) };
  } catch (error) {
    throw new WorktreeCollectionError(`Failed to collect worktree changes: ${commandError(error)}`, path);
  }
}

export async function cleanupWorktree(cwd, path) {
  try {
    await exec("git", ["-C", cwd, "worktree", "remove", "--force", resolve(path)], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
    await exec("git", ["-C", cwd, "worktree", "prune"], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Failed to clean up worktree: ${commandError(error)} - retained at ${resolve(path)}`);
  }
}

function commandError(error) {
  if (!(error instanceof Error)) return String(error);
  const details = error;
  return details.stderr?.trim?.() || details.message;
}