import { execFileSync } from "node:child_process";

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_ERROR_CHARS = 1_000;

function failure(message) {
  throw new Error(`proposed patch rejected: ${message}`);
}

function safePath(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 1_024 || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

/**
 * Validate a conventional `git diff` before it reaches git. This is deliberately a narrow
 * surface rather than a general shell/write capability: a proposed effect can only alter paths
 * named by a normal patch within the already-isolated worktree.
 */
export function proposedPatchPaths(patch) {
  if (typeof patch !== "string" || patch.length === 0) failure("patch must be a non-empty string");
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) failure(`patch exceeds ${MAX_PATCH_BYTES} bytes`);
  const paths = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match || !safePath(match[1]) || !safePath(match[2]) || match[1] !== match[2]) {
      failure("patch contains an unsafe or non-canonical target path");
    }
    paths.push(match[1]);
  }
  if (paths.length < 1) failure("patch must contain at least one conventional diff --git header");
  if (paths.length > MAX_FILES || new Set(paths).size !== paths.length) failure(`patch must touch 1..${MAX_FILES} distinct files`);
  return Object.freeze(paths);
}

function gitError(error) {
  const text = error && typeof error === "object" && "stderr" in error
    ? String(error.stderr ?? "")
    : error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, MAX_ERROR_CHARS) || "git rejected the patch";
}

/**
 * Apply a declared proposal only to a Git worktree. The caller is expected to be a brokered
 * child with a throwaway worktree; this function refuses a non-Git cwd so it never turns into a
 * generic arbitrary-file writer. `--index` lets the controller later collect an exact diff.
 */
export function applyProposedPatch({ cwd, patch } = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) failure("a worktree cwd is required");
  const changed = proposedPatchPaths(patch);
  let inside;
  try {
    inside = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    failure("cwd is not a Git worktree");
  }
  if (inside !== "true") failure("cwd is not a Git worktree");
  try {
    execFileSync("git", ["-C", cwd, "apply", "--index", "--whitespace=nowarn", "-"], {
      input: patch, encoding: "utf8", maxBuffer: MAX_PATCH_BYTES + 64 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    failure(gitError(error));
  }
  return Object.freeze({ changed });
}
