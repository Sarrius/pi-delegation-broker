import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyProposedPatch } from "../src/effect-verification.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/** A repository with one commit, plus the patch a child would produce from a worktree on it. */
function repoWithProposal({ childEdit }) {
  const directory = mkdtempSync(join(tmpdir(), "pi-effect-repo-"));
  git(directory, "init", "--quiet", "-b", "main");
  git(directory, "config", "user.email", "controller@example.invalid");
  git(directory, "config", "user.name", "controller");
  writeFileSync(join(directory, "value.txt"), "one\n");
  git(directory, "add", "-A");
  git(directory, "commit", "--quiet", "-m", "base");
  const baseCommit = git(directory, "rev-parse", "HEAD").trim();

  const worktree = join(directory, ".child-worktree");
  git(directory, "worktree", "add", "--quiet", "--detach", worktree, baseCommit);
  childEdit(worktree);
  git(worktree, "add", "-A", "-N");
  const patch = git(worktree, "diff", "--no-ext-diff", "--binary", baseCommit);
  const changed = git(worktree, "diff", "--name-only", baseCommit).split("\n").filter(Boolean);
  git(directory, "worktree", "remove", "--force", worktree);
  return { directory, baseCommit, patch, changed };
}

test("a proposed patch is verified inside a scratch tree, leaving the real repository untouched", async () => {
  const { directory, baseCommit, patch, changed } = repoWithProposal({
    childEdit: (worktree) => writeFileSync(join(worktree, "value.txt"), "two\n"),
  });
  try {
    const receipt = await verifyProposedPatch({
      repoCwd: directory,
      baseCommit,
      patch,
      changed,
      checks: [{ id: "content", claim: "value is two", argv: ["grep", "-q", "two", "value.txt"] }],
    });

    assert.equal(receipt.applied, true);
    assert.equal(receipt.verified, true);
    assert.deepEqual([...receipt.changed], ["value.txt"]);
    assert.deepEqual(receipt.checks.map((entry) => [entry.id, entry.ok]), [["content", true]]);

    // The controller verified an effect without performing it: the caller's tree still reads
    // the base content and carries no leftover worktree.
    assert.equal(git(directory, "status", "--porcelain"), "");
    assert.equal(git(directory, "show", "HEAD:value.txt"), "one\n");
    assert.ok(!readdirSync(directory).some((entry) => entry.startsWith("pi-effect-verify-")));
    assert.ok(!git(directory, "worktree", "list").includes("pi-effect-verify-"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failing controller check denies verification even though the patch applies", async () => {
  const { directory, baseCommit, patch } = repoWithProposal({
    childEdit: (worktree) => writeFileSync(join(worktree, "value.txt"), "two\n"),
  });
  try {
    const receipt = await verifyProposedPatch({
      repoCwd: directory,
      baseCommit,
      patch,
      checks: [{ id: "expected-three", argv: ["grep", "-q", "three", "value.txt"] }],
    });
    assert.equal(receipt.applied, true);
    assert.equal(receipt.verified, false);
    assert.equal(receipt.reason, "check_failed");
    assert.equal(receipt.checks[0].ok, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an effect with no controller check is never reported as verified", async () => {
  const { directory, baseCommit, patch } = repoWithProposal({
    childEdit: (worktree) => writeFileSync(join(worktree, "value.txt"), "two\n"),
  });
  try {
    const receipt = await verifyProposedPatch({ repoCwd: directory, baseCommit, patch, checks: [] });
    assert.equal(receipt.verified, false);
    assert.equal(receipt.applied, false);
    assert.equal(receipt.reason, "no_controller_checks");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a patch that does not apply to its declared base fails closed", async () => {
  const { directory, baseCommit } = repoWithProposal({
    childEdit: (worktree) => writeFileSync(join(worktree, "value.txt"), "two\n"),
  });
  try {
    const receipt = await verifyProposedPatch({
      repoCwd: directory,
      baseCommit,
      patch: "diff --git a/absent.txt b/absent.txt\n--- a/absent.txt\n+++ b/absent.txt\n@@ -1 +1 @@\n-gone\n+changed\n",
      checks: [{ id: "unreachable", argv: ["true"] }],
    });
    assert.equal(receipt.applied, false);
    assert.equal(receipt.verified, false);
    assert.equal(receipt.reason, "patch_does_not_apply");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a child that under-reports the files it touched is not verified", async () => {
  const { directory, baseCommit, patch } = repoWithProposal({
    childEdit: (worktree) => {
      writeFileSync(join(worktree, "value.txt"), "two\n");
      writeFileSync(join(worktree, "extra.txt"), "unannounced\n");
    },
  });
  try {
    const receipt = await verifyProposedPatch({
      repoCwd: directory,
      baseCommit,
      patch,
      changed: ["value.txt"],
      checks: [{ id: "content", argv: ["grep", "-q", "two", "value.txt"] }],
    });
    assert.equal(receipt.verified, false);
    assert.equal(receipt.reason, "changed_set_mismatch");
    assert.deepEqual([...receipt.changed].sort(), ["extra.txt", "value.txt"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
