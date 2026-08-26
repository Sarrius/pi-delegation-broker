import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createControllerAcceptancePlan, normalizeControllerAcceptanceSpecs } from "./acceptance-plan.mjs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_CHECKS = 20;
const COMMIT = /^[0-9a-f]{7,64}$/;

export class EffectVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EffectVerificationError";
  }
}

function truncate(text) {
  return typeof text === "string" ? text.slice(0, MAX_OUTPUT_CHARS) : "";
}

function commandError(error) {
  if (!(error instanceof Error)) return String(error);
  return error.stderr?.trim?.() || error.message;
}

/**
 * Verify a child-proposed patch without letting it reach the real tree.
 *
 * A child that edits files has produced a *claim*, not an effect: its own report that the change
 * is good is exactly the evidence this broker refuses to trust. So the controller rebuilds the
 * child's starting point in a scratch worktree at the same base commit, applies the patch there,
 * and runs its own checks inside that scratch tree. The caller's repository is never written to,
 * and a patch that does not apply cleanly fails closed instead of being reported as verified.
 *
 * Returns a receipt; it never throws for a failing patch or a failing check, because both are
 * ordinary verification outcomes rather than controller faults.
 */
export async function verifyProposedPatch({
  repoCwd, baseCommit, patch, changed, checks = [], runArgv, scratchRoot,
} = {}) {
  if (typeof repoCwd !== "string" || repoCwd.length === 0) throw new EffectVerificationError("repoCwd is required");
  if (typeof baseCommit !== "string" || !COMMIT.test(baseCommit)) throw new EffectVerificationError("baseCommit must be a git object id");
  if (patch !== undefined && typeof patch !== "string") throw new EffectVerificationError("patch must be a string");
  if (runArgv !== undefined) throw new EffectVerificationError("caller-provided acceptance executors are not supported");
  if (!Array.isArray(checks) || checks.length > MAX_CHECKS) throw new EffectVerificationError(`checks must be an array of at most ${MAX_CHECKS} entries`);
  let normalizedChecks;
  try { normalizedChecks = normalizeControllerAcceptanceSpecs(checks); }
  catch (error) { throw new EffectVerificationError(error instanceof Error ? error.message : "acceptance checks are invalid"); }

  const receipt = (fields) => Object.freeze({
    baseCommit, applied: false, verified: false, checks: Object.freeze([]), ...fields,
  });

  if (!patch) return receipt({ reason: "empty_patch" });
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) return receipt({ reason: "patch_too_large" });
  // An effect nobody checked is an unverified effect. Saying otherwise would let a child's own
  // word become the acceptance signal, which is the failure this whole broker exists to prevent.
  if (checks.length === 0) return receipt({ reason: "no_controller_checks" });

  const scratch = join(scratchRoot ?? tmpdir(), `pi-effect-verify-${randomUUID()}`);
  const patchFile = `${scratch}.patch`;
  let created = false;
  try {
    await writeFile(patchFile, patch, { mode: 0o600 });
    try {
      await exec("git", ["-C", repoCwd, "worktree", "add", "--detach", scratch, baseCommit], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
      created = true;
    } catch (error) {
      return receipt({ reason: "scratch_unavailable", error: commandError(error) });
    }

    try {
      await exec("git", ["-C", scratch, "apply", "--index", "--whitespace=nowarn", patchFile], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
    } catch (error) {
      return receipt({ reason: "patch_does_not_apply", error: commandError(error) });
    }

    let applied = [];
    try {
      const { stdout } = await exec("git", ["-C", scratch, "diff", "--name-only", "-z", baseCommit], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
      applied = stdout.split("\0").filter(Boolean);
    } catch (error) {
      return receipt({ reason: "scratch_unreadable", error: commandError(error) });
    }

    // The child also reports which files it touched. If that report disagrees with what the
    // patch actually does, the report is wrong about the effect and must not be verified.
    if (Array.isArray(changed)) {
      const claimed = [...changed].sort().join("\0");
      if (claimed !== [...applied].sort().join("\0")) {
        return receipt({ applied: true, reason: "changed_set_mismatch", changed: Object.freeze(applied) });
      }
    }

    const plan = createControllerAcceptancePlan(normalizedChecks, { cwd: scratch });
    const results = [];
    for (const check of plan.checks) {
      const outcome = await plan.runCheck(check);
      results.push(Object.freeze({
        id: check.id,
        claim: check.claim,
        exitCode: outcome.exitCode,
        ok: outcome.exitCode === 0,
        stdout: truncate(outcome.stdout),
        stderr: truncate(outcome.stderr),
      }));
    }

    const verified = results.every((entry) => entry.ok);
    return receipt({
      applied: true,
      verified,
      ...(verified ? {} : { reason: "check_failed" }),
      changed: Object.freeze(applied),
      checks: Object.freeze(results),
    });
  } finally {
    await rm(patchFile, { force: true }).catch(() => undefined);
    if (created) {
      await exec("git", ["-C", repoCwd, "worktree", "remove", "--force", resolve(scratch)], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) }).catch(() => undefined);
      await exec("git", ["-C", repoCwd, "worktree", "prune"], { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) }).catch(() => undefined);
    }
  }
}
