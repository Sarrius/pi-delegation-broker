import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  controllerAcceptanceCheckIds,
  createControllerAcceptancePlan,
  normalizeControllerAcceptanceSpecs,
} from "../src/acceptance-plan.mjs";

async function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "acceptance-plan-"));
  try { return await run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("acceptance vocabulary exposes fixed checks without executable argv", async () => {
  await withRoot(async (root) => {
    writeFileSync(join(root, "value.txt"), "two\n");
    const specs = normalizeControllerAcceptanceSpecs([
      { id: "git-diff-check" },
      { id: "file-equals", path: "value.txt", content: "two\n" },
    ]);
    assert.deepEqual([...controllerAcceptanceCheckIds], [
      "git-diff-check", "npm-check", "npm-test", "npm-release-check", "file-equals",
    ]);
    assert.equal("argv" in specs[0], false);
    assert.equal("claim" in specs[0], false);

    const plan = createControllerAcceptancePlan(specs, { cwd: root });
    assert.deepEqual(plan.checks.map((check) => [check.id, check.claim, check.kind]), [
      ["git-diff-check", "git diff --check passes", "command"],
      ["file-equals", "file-equals value.txt", "command"],
    ]);
    assert.equal("argv" in plan.checks[0], false);
    const result = await plan.runCheck(plan.checks[1]);
    assert.equal(result.exitCode, 0);
  });
});

test("caller cannot inject argv, claims, unsafe paths, or symlink targets into a fixed plan", async () => {
  await withRoot(async (root) => {
    writeFileSync(join(root, "real.txt"), "safe\n");
    symlinkSync("real.txt", join(root, "link.txt"));
    assert.throws(() => normalizeControllerAcceptanceSpecs([{ id: "npm-check", argv: ["node", "-e", "process.exit(0)"] }]), /unsupported or missing fields/);
    assert.throws(() => normalizeControllerAcceptanceSpecs([{ id: "npm-check", argv: ["true"] }]), /unsupported or missing fields/);
    assert.throws(() => normalizeControllerAcceptanceSpecs([{ id: "npm-check", claim: "always pass" }]), /unsupported or missing fields/);
    assert.throws(() => normalizeControllerAcceptanceSpecs([{ id: "file-equals", path: "../real.txt", content: "safe\n" }]), /unsafe component/);
    const plan = createControllerAcceptancePlan([{ id: "file-equals", path: "link.txt", content: "safe\n" }], { cwd: root });
    const result = await plan.runCheck(plan.checks[0]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /symlink|real directory|regular file|symbolic links/i);
  });
});

test("fixed command plans run with shell disabled and bounded controller environment", async () => {
  await withRoot(async (root) => {
    execFileSync("git", ["init", "--quiet", root]);
    const plan = createControllerAcceptancePlan([{ id: "git-diff-check", timeoutMs: 5_000 }], { cwd: root });
    const result = await plan.runCheck(plan.checks[0]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length <= 32_000);
    assert.ok(result.stderr.length <= 32_000);
  });
});
