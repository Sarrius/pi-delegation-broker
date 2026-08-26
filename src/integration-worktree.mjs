import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const COMMIT = /^[0-9a-f]{7,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

function fail(message) { throw new Error(`integration worktree: ${message}`); }
function bounded(value, label, max = 4096) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0\r\n]/.test(value)) fail(`${label} is invalid`);
  return value;
}
function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) fail(`${label} must be a git object id`);
  return value;
}
function commandError(error) {
  if (!(error instanceof Error)) return String(error);
  return error.stderr?.trim?.() || error.stdout?.trim?.() || error.message;
}
async function git(cwd, args, options = {}) {
  try {
    return await exec("git", ["-C", cwd, ...args], { signal: AbortSignal.timeout(options.timeoutMs ?? GIT_TIMEOUT_MS), maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024 });
  } catch (error) {
    if (options.allowFailure) return { error, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    throw new Error(commandError(error));
  }
}
async function writePatch(patch) {
  const path = join(tmpdir(), `pi-integration-${randomUUID()}.patch`);
  await writeFile(path, patch, { mode: 0o600 });
  return path;
}
async function removePatch(path) { await rm(path, { force: true }).catch(() => undefined); }

function controllerVerifiedProposal(proposal, verificationAuthority) {
  if (!verificationAuthority || typeof verificationAuthority.verify !== "function"
    || !proposal?.controllerVerification || !proposal?.verificationBinding
    || typeof proposal.patch !== "string" || proposal.patch.length === 0) return false;
  const targetDigest = createHash("sha256").update(proposal.patch).digest("hex");
  try {
    return verificationAuthority.verify(proposal.controllerVerification, {
      ...proposal.verificationBinding,
      targetDigest,
      expectedHead: proposal.baseCommit,
    }) === true;
  } catch { return false; }
}

function proposalIdentity(proposal) {
  const id = proposal?.proposalId ?? proposal?.id;
  if (typeof id !== "string" || !ID.test(id)) fail("proposal id is invalid");
  return id;
}

function proposalChanged(proposal) {
  if (!Array.isArray(proposal.changed) || proposal.changed.length > 10_000 || proposal.changed.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes(".."))) {
    fail("proposal changed paths are invalid");
  }
  return [...new Set(proposal.changed)].sort();
}

function integratorTask(proposalId, conflictPaths, applied) {
  return Object.freeze({
    id: `integrator-${proposalId}`,
    kind: "integrator",
    purpose: "integrate_conflicted_proposal",
    blockedBy: proposalId,
    conflictPaths: Object.freeze([...conflictPaths]),
    dependsOn: Object.freeze([...applied]),
    task: "Resolve the integration conflict in the controller-owned integration worktree; child proposals must not silently resolve it.",
  });
}

export async function createIntegrationWorktree(repoCwd, path, { baseCommit } = {}) {
  if (typeof repoCwd !== "string" || !isAbsolute(repoCwd)) fail("repoCwd must be absolute");
  if (typeof path !== "string" || !isAbsolute(path)) fail("integration path must be absolute");
  const resolved = resolve(path);
  const base = baseCommit ? commit(baseCommit, "baseCommit") : (await git(repoCwd, ["rev-parse", "HEAD"])).stdout.trim();
  await mkdir(dirname(resolved), { recursive: true });
  try {
    await git(repoCwd, ["worktree", "add", "--detach", resolved, base]);
  } catch (error) {
    throw new Error(`failed to create integration worktree: ${error.message}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    repoCwd: resolve(repoCwd),
    path: resolved,
    baseCommit: base,
    currentCommit: base,
    appliedProposals: Object.freeze([]),
  });
}

export async function applyAcceptedProposal(integration, proposal, { verificationAuthority } = {}) {
  if (!integration || typeof integration.path !== "string" || !isAbsolute(integration.path)) fail("integration state is invalid");
  const proposalId = proposalIdentity(proposal);
  if (integration.appliedProposals?.includes(proposalId)) return Object.freeze({ status: "already_applied", proposalId, currentCommit: integration.currentCommit });
  const baseCommit = commit(proposal.baseCommit, "proposal baseCommit");
  if (typeof proposal.patch !== "string" || !proposal.patch) return Object.freeze({ status: "blocked", reason: "empty_patch", proposalId });
  if (!controllerVerifiedProposal(proposal, verificationAuthority)) {
    return Object.freeze({ status: "blocked", reason: "controller_verification_required", proposalId });
  }
  if (Buffer.byteLength(proposal.patch, "utf8") > MAX_PATCH_BYTES) return Object.freeze({ status: "blocked", reason: "patch_too_large", proposalId });
  const changed = proposalChanged(proposal);
  const patchPath = await writePatch(proposal.patch);
  try {
    const applied = await git(integration.path, ["apply", "--3way", "--index", patchPath], { allowFailure: true });
    if (applied.error) {
      const conflict = await git(integration.path, ["diff", "--name-only", "--diff-filter=U", "-z"], { allowFailure: true });
      const paths = String(conflict.stdout ?? "").split("\0").filter(Boolean);
      await git(integration.path, ["reset", "--hard", "HEAD"], { allowFailure: true });
      return Object.freeze({
        status: "blocked",
        reason: "integration_conflict",
        proposalId,
        proposalBaseCommit: baseCommit,
        integrationCommit: integration.currentCommit,
        conflictPaths: Object.freeze(paths),
        error: String(applied.stderr || applied.error?.message || "patch does not apply").slice(0, 2000),
        integratorTask: integratorTask(proposalId, paths, integration.appliedProposals ?? []),
      });
    }
    const staged = (await git(integration.path, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean).sort();
    if (staged.join("\0") !== changed.join("\0")) {
      await git(integration.path, ["reset", "--hard", "HEAD"], { allowFailure: true });
      return Object.freeze({ status: "blocked", reason: "changed_set_mismatch", proposalId, changed: Object.freeze(staged) });
    }
    const commitResult = await git(integration.path, [
      "-c", "user.name=Pi Integration Controller", "-c", "user.email=pi-integration@localhost",
      "commit", "--no-verify", "-m", `Integrate accepted proposal ${proposalId}`,
    ], { allowFailure: true });
    if (commitResult.error) {
      await git(integration.path, ["reset", "--hard", "HEAD"], { allowFailure: true });
      return Object.freeze({ status: "blocked", reason: "integration_commit_failed", proposalId, error: String(commitResult.stderr || commitResult.error?.message || "commit failed").slice(0, 2000) });
    }
    const currentCommit = (await git(integration.path, ["rev-parse", "HEAD"])).stdout.trim();
    return Object.freeze({
      status: "integrated",
      proposalId,
      baseCommit,
      currentCommit,
      changed: Object.freeze(staged),
      integration: Object.freeze({
        ...integration,
        currentCommit,
        appliedProposals: Object.freeze([...(integration.appliedProposals ?? []), proposalId]),
      }),
    });
  } finally {
    await removePatch(patchPath);
  }
}

function orderProposals(proposals) {
  if (!Array.isArray(proposals) || proposals.length > 1000) fail("proposals must be a bounded array");
  const byId = new Map();
  for (const proposal of proposals) {
    const id = proposalIdentity(proposal);
    if (byId.has(id)) fail("proposal ids must be unique");
    byId.set(id, proposal);
  }
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (id) => {
    if (visiting.has(id)) fail("proposal dependency graph contains a cycle");
    if (visited.has(id)) return;
    const proposal = byId.get(id);
    if (!proposal) fail(`proposal dependency ${id} is unknown`);
    visiting.add(id);
    for (const dependency of proposal.dependsOn ?? []) {
      if (typeof dependency !== "string" || !ID.test(dependency)) fail("proposal dependency is invalid");
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(proposal);
  };
  for (const proposal of proposals) visit(proposalIdentity(proposal));
  return ordered;
}

export async function integrateAcceptedProposals(integration, proposals, { verificationAuthority } = {}) {
  let current = integration;
  const applied = [];
  for (const proposal of orderProposals(proposals)) {
    const result = await applyAcceptedProposal(current, proposal, { verificationAuthority });
    if (result.status === "blocked") return Object.freeze({ status: "blocked", integration: current, applied: Object.freeze(applied), conflict: result });
    if (result.status === "integrated") {
      current = result.integration;
      applied.push(result.proposalId);
    }
  }
  return Object.freeze({ status: "integrated", integration: current, applied: Object.freeze(applied) });
}

export async function collectIntegrationPatch(integration) {
  if (!integration?.path || !integration?.baseCommit) fail("integration state is invalid");
  const result = await git(integration.path, ["diff", "--no-ext-diff", "--binary", integration.baseCommit], { maxBuffer: MAX_PATCH_BYTES + 1 });
  return Object.freeze({ patch: result.stdout, baseCommit: integration.baseCommit, currentCommit: (await git(integration.path, ["rev-parse", "HEAD"])).stdout.trim() });
}

function receiptPathFor({ receiptPath, idempotencyKey }) {
  if (receiptPath !== undefined) {
    if (typeof receiptPath !== "string" || !isAbsolute(receiptPath)) fail("receiptPath must be absolute");
    return receiptPath;
  }
  return join(tmpdir(), `pi-integration-receipt-${createHash("sha256").update(idempotencyKey).digest("hex")}.json`);
}

function readReceipt(path) {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return Object.freeze(receipt);
}

export async function applyIntegrationToTarget({
  repoCwd, integration, expectedHead, idempotencyKey, receiptPath,
  verificationAuthority, verification, verificationBinding,
} = {}) {
  if (typeof repoCwd !== "string" || !isAbsolute(repoCwd)) fail("repoCwd must be absolute");
  if (!integration?.path || !integration.baseCommit) fail("integration state is invalid");
  bounded(idempotencyKey, "idempotencyKey", 200);
  const expected = commit(expectedHead, "expectedHead");
  const path = receiptPathFor({ receiptPath, idempotencyKey });
  const previous = readReceipt(path);
  if (previous) {
    if (previous.idempotencyKey !== idempotencyKey) fail("effect receipt idempotency key mismatch");
    return Object.freeze({ status: "already_applied", receipt: previous });
  }
  const targetHead = (await git(repoCwd, ["rev-parse", "HEAD"])).stdout.trim();
  if (targetHead !== expected) return Object.freeze({ status: "compare_and_swap_conflict", expectedHead: expected, actualHead: targetHead });
  const { patch, baseCommit } = await collectIntegrationPatch(integration);
  const patchDigest = createHash("sha256").update(patch).digest("hex");
  if (!patch) return Object.freeze({ status: "empty", baseCommit, targetHead });
  if (!verificationAuthority || typeof verificationAuthority.verify !== "function"
    || !verification || !verificationBinding) {
    return Object.freeze({ status: "blocked", reason: "controller_verification_required", patchDigest });
  }
  let authenticated = false;
  try {
    authenticated = verificationAuthority.verify(verification, {
      ...verificationBinding,
      targetDigest: patchDigest,
      expectedHead: expected,
    }) === true;
  } catch { authenticated = false; }
  if (!authenticated) return Object.freeze({ status: "blocked", reason: "controller_verification_failed", patchDigest });
  const staged = (await git(repoCwd, ["diff", "--cached", "--binary"])).stdout;
  if (staged && createHash("sha256").update(staged).digest("hex") === patchDigest) {
    const receipt = writeReceipt(path, { schemaVersion: 1, idempotencyKey, baseCommit, expectedHead: expected, targetHead, patchDigest, reconciled: true, appliedAt: Date.now() });
    return Object.freeze({ status: "applied", receipt });
  }
  const patchPath = await writePatch(patch);
  try {
    const result = await git(repoCwd, ["apply", "--index", patchPath], { allowFailure: true });
    if (result.error) {
      return Object.freeze({ status: "blocked", reason: "target_apply_conflict", error: String(result.stderr || result.error?.message || "target patch conflict").slice(0, 2000) });
    }
    const changed = (await git(repoCwd, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean).sort();
    try {
      const receipt = writeReceipt(path, { schemaVersion: 1, idempotencyKey, baseCommit, expectedHead: expected, targetHead, patchDigest, changed, appliedAt: Date.now() });
      return Object.freeze({ status: "applied", receipt });
    } catch (error) {
      return Object.freeze({ status: "unknown", reason: "effect_applied_receipt_unpersisted", error: String(error.message).slice(0, 500), changed });
    }
  } finally {
    await removePatch(patchPath);
  }
}

