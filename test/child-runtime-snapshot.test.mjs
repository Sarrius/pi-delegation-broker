import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureChildRuntime } from "../src/child-runtime-snapshot.mjs";

test("live child source edits cannot change a captured runtime; a fresh process imports its original graph", () => {
  const temp = mkdtempSync(join(tmpdir(), "broker-snapshot-"));
  const source = join(temp, "source");
  const repo = fileURLToPath(new URL("..", import.meta.url));
  try {
    mkdirSync(source);
    cpSync(join(repo, "src"), join(source, "src"), { recursive: true });
    cpSync(join(repo, "extensions"), join(source, "extensions"), { recursive: true });
    cpSync(join(repo, "package.json"), join(source, "package.json"));
    symlinkSync(join(repo, "node_modules"), join(source, "node_modules"), "dir");
    const captured = captureChildRuntime(source);
    const original = readFileSync(join(source, "src", "proxy-context.mjs"), "utf8");
    writeFileSync(join(source, "src", "proxy-context.mjs"), 'throw new Error("NEW_BROKEN_EDIT");');
    writeFileSync(join(source, "extensions", "controller-provider-proxy.ts"), 'throw new Error("NEW_BROKEN_EDIT");');
    const snapshot = captured.materialize(join(temp, "controller"));
    assert.equal(readFileSync(join(snapshot.root, "src", "proxy-context.mjs"), "utf8"), original);
    assert.doesNotThrow(snapshot.verify);
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      'await import(process.argv[1]); await import(process.argv[2]); console.log("SNAPSHOT_IMPORTED");',
      join(snapshot.root, "src", "proxy-context.mjs"), snapshot.extensionPath("controller-provider-proxy.ts")], { encoding: "utf8" });
    assert.match(output, /SNAPSHOT_IMPORTED/);
    const path = join(snapshot.root, "src", "proxy-context.mjs");
    chmodSync(path, 0o600);
    writeFileSync(path, "export const tampered = true;");
    assert.throws(snapshot.verify, /snapshot changed/);
    assert.throws(() => captured.materialize(join(temp, "controller")), /snapshot changed/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
