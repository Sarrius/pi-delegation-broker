import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyIntegrationToTarget,
  collectIntegrationPatch,
  createIntegrationWorktree,
  integrateAcceptedProposals,
} from "../src/integration-worktree.mjs";
import { ControllerEvidenceStore } from "../src/evidence.mjs";
import { ControllerVerificationAuthority, createControllerVerifierRunId } from "../src/verification-authority.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function cleanupIntegrationWorktree(integration) {
  git(integration.repoCwd, "worktree", "remove", "--force", integration.path);
  git(integration.repoCwd, "worktree", "prune");
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), "integration-team-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "value.txt"), "base\n");
  git(root, "add", "value.txt");
  git(root, "commit", "--quiet", "-m", "base");
  return root;
}
function verificationContext(root) {
  const evidenceStore = new ControllerEvidenceStore({ root: join(root, ".evidence") });
  return Object.freeze({ evidenceStore, verificationAuthority: new ControllerVerificationAuthority({ evidenceStore }) });
}

async function proposal(root, base, id, file, text, context) {
  const path = join(root, `.proposal-${id}`);
  git(root, "worktree", "add", "--quiet", "--detach", path, base);
  writeFileSync(join(path, file), text);
  git(path, "add", "-A", "-N");
  const patch = execFileSync("git", ["-C", path, "diff", "--no-ext-diff", "--binary", base], { encoding: "utf8" });
  const changed = git(path, "diff", "--name-only").split("\n").filter(Boolean);
  git(root, "worktree", "remove", "--force", path);
  const targetDigest = createHash("sha256").update(patch).digest("hex");
  const binding = { taskId: `task-${id}`, leaseId: `lease-${id}`, fencingToken: 1 };
  const evidence = context.evidenceStore.capture({ kind: "command", claim: `controller verified ${id}`, artifact: "fixed controller evidence" });
  const controllerVerification = context.verificationAuthority.attest({
    status: "accepted", runId: createControllerVerifierRunId(), checks: [{ status: "passed" }],
    validation: { status: "accepted" }, result: { evidence: [evidence] },
  }, { ...binding, targetDigest, expectedHead: base });
  return {
    proposalId: id, baseCommit: base, patch, changed,
    controllerVerification, verificationBinding: binding,
  };
}

async function integrationVerification(integration, base, context) {
  const { patch } = await collectIntegrationPatch(integration);
  const targetDigest = createHash("sha256").update(patch).digest("hex");
  const binding = { taskId: "integration-task", leaseId: "integration-lease", fencingToken: 1 };
  const evidence = context.evidenceStore.capture({ kind: "command", claim: "controller verified integration", artifact: "fixed integration evidence" });
  const verification = context.verificationAuthority.attest({
    status: "accepted", runId: createControllerVerifierRunId(), checks: [{ status: "passed" }],
    validation: { status: "accepted" }, result: { evidence: [evidence] },
  }, { ...binding, targetDigest, expectedHead: base });
  return { verification, verificationBinding: binding };
}

test("caller semantic status cannot integrate without controller verification authority evidence", async () => {
  const root = repo();
  const base = git(root, "rev-parse", "HEAD");
  const context = verificationContext(root);
  const first = await proposal(root, base, "unverified", "one.txt", "one\n", context);
  const integration = await createIntegrationWorktree(root, join(root, ".integration"), { baseCommit: base });
  const result = await integrateAcceptedProposals(integration, [{ ...first, acceptanceStatus: "accepted", semanticStatus: "accepted" }]);
  assert.equal(result.status, "blocked");
  assert.equal(result.conflict.reason, "controller_verification_required");
  assert.equal(result.applied.length, 0);
  await cleanupIntegrationWorktree(result.integration);
});

test("accepted proposals integrate in dependency order and final application is idempotent", async () => {
  const root = repo();
  const base = git(root, "rev-parse", "HEAD");
  const context = verificationContext(root);
  const first = await proposal(root, base, "first", "one.txt", "one\n", context);
  const second = await proposal(root, base, "second", "two.txt", "two\n", context);
  const integration = await createIntegrationWorktree(root, join(root, ".integration"), { baseCommit: base });
  const result = await integrateAcceptedProposals(integration, [
    { ...second, dependsOn: ["first"] }, first,
  ], { verificationAuthority: context.verificationAuthority });
  assert.equal(result.status, "integrated");
  assert.deepEqual(result.applied, ["first", "second"]);
  const collected = await collectIntegrationPatch(result.integration);
  assert.match(collected.patch, /one\.txt/);
  assert.match(collected.patch, /two\.txt/);
  const receiptPath = join(root, ".receipts", "integration.json");
  const finalVerification = await integrationVerification(result.integration, base, context);
  const applied = await applyIntegrationToTarget({ repoCwd: root, integration: result.integration, expectedHead: base, idempotencyKey: "team-apply", receiptPath, verificationAuthority: context.verificationAuthority, ...finalVerification });
  assert.equal(applied.status, "applied");
  const replay = await applyIntegrationToTarget({ repoCwd: root, integration: result.integration, expectedHead: base, idempotencyKey: "team-apply", receiptPath, verificationAuthority: context.verificationAuthority, ...finalVerification });
  assert.equal(replay.status, "already_applied");
  assert.equal(readFileSync(join(root, "one.txt"), "utf8"), "one\n");
  await cleanupIntegrationWorktree(result.integration);
});

test("three-way integration conflict blocks the join and creates an explicit integrator task", async () => {
  const root = repo();
  const base = git(root, "rev-parse", "HEAD");
  const context = verificationContext(root);
  const first = await proposal(root, base, "first", "value.txt", "first\n", context);
  const second = await proposal(root, base, "second", "value.txt", "second\n", context);
  const integration = await createIntegrationWorktree(root, join(root, ".integration"), { baseCommit: base });
  const result = await integrateAcceptedProposals(integration, [first, second], { verificationAuthority: context.verificationAuthority });
  assert.equal(result.status, "blocked");
  assert.equal(result.conflict.reason, "integration_conflict");
  assert.equal(result.conflict.integratorTask.kind, "integrator");
  assert.deepEqual(result.applied, ["first"]);
  assert.equal(git(result.integration.path, "status", "--porcelain"), "");
  await cleanupIntegrationWorktree(result.integration);
});

test("target compare-and-swap refuses a changed target before applying an integration", async () => {
  const root = repo();
  const base = git(root, "rev-parse", "HEAD");
  const context = verificationContext(root);
  const first = await proposal(root, base, "first", "one.txt", "one\n", context);
  const integration = await createIntegrationWorktree(root, join(root, ".integration"), { baseCommit: base });
  const result = await integrateAcceptedProposals(integration, [first], { verificationAuthority: context.verificationAuthority });
  assert.equal(result.status, "integrated");
  writeFileSync(join(root, "unrelated.txt"), "changed target\n");
  git(root, "add", "unrelated.txt");
  git(root, "commit", "--quiet", "-m", "target moved");
  const cas = await applyIntegrationToTarget({ repoCwd: root, integration: result.integration, expectedHead: base, idempotencyKey: "cas" });
  assert.equal(cas.status, "compare_and_swap_conflict");
  await cleanupIntegrationWorktree(result.integration);
});
