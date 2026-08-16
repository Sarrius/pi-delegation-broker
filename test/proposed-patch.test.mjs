import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyProposedPatch, proposedPatchPaths } from "../src/proposed-patch.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "proposed-patch-"));
  git(cwd, "init", "--quiet", "-b", "main");
  git(cwd, "config", "user.email", "controller@example.invalid");
  git(cwd, "config", "user.name", "controller");
  writeFileSync(join(cwd, "value.txt"), "one\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "base");
  return cwd;
}

const PATCH = [
  "diff --git a/value.txt b/value.txt",
  "index 5626abf..f719efd 100644",
  "--- a/value.txt",
  "+++ b/value.txt",
  "@@ -1 +1 @@",
  "-one",
  "+two",
  "",
].join("\n");

test("applyProposedPatch changes only the declared file inside a Git worktree", () => {
  const cwd = repo();
  try {
    assert.deepEqual(proposedPatchPaths(PATCH), ["value.txt"]);
    const result = applyProposedPatch({ cwd, patch: PATCH });
    assert.deepEqual(result.changed, ["value.txt"]);
    assert.equal(readFileSync(join(cwd, "value.txt"), "utf8"), "two\n");
    assert.match(git(cwd, "diff", "--cached", "--name-only"), /^value\.txt\n$/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("proposal rejects paths that escape or target Git metadata", () => {
  const cwd = repo();
  try {
    for (const target of ["../outside.txt", ".git/config", "/tmp/outside.txt"]) {
      const patch = `diff --git a/${target} b/${target}\n--- a/${target}\n+++ b/${target}\n@@ -0,0 +1 @@\n+nope\n`;
      assert.throws(() => applyProposedPatch({ cwd, patch }), /unsafe or non-canonical target path/);
    }
    assert.equal(readFileSync(join(cwd, "value.txt"), "utf8"), "one\n");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("proposal cannot become a generic writer outside a Git worktree", () => {
  const cwd = mkdtempSync(join(tmpdir(), "not-worktree-"));
  try {
    assert.throws(() => applyProposedPatch({ cwd, patch: PATCH }), /cwd is not a Git worktree/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
