import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTENSION = new URL("../extensions/pi-delegation-broker.ts", import.meta.url).pathname;
const PROBE = new URL("./fixtures/extension-async-probe.mjs", import.meta.url).pathname;

function runProbe(home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", PROBE], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, BROKER_EXTENSION_PATH: EXTENSION },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`probe exited ${code}: ${stderr}\n${stdout}`)));
  });
}

test("extension submits task/workflow immediately and exposes durable lifecycle tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "broker-extension-async-"));
  const nodeModules = join(ROOT, "node_modules");
  const globalModules = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules";
  const createdRoot = !existsSync(nodeModules);
  const links = [
    [join(globalModules, "typebox"), join(nodeModules, "typebox")],
    [join(globalModules, "@earendil-works", "pi-ai"), join(nodeModules, "@earendil-works", "pi-ai")],
  ];
  const createdLinks = [];
  try {
    mkdirSync(join(nodeModules, "@earendil-works"), { recursive: true });
    for (const [source, target] of links) if (!existsSync(target)) { symlinkSync(source, target, "dir"); createdLinks.push(target); }
    const { stdout, stderr } = await runProbe(home);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.ok(result.workflowElapsedMs < 500);
    assert.ok(result.taskElapsedMs < 500);
    for (const name of ["delegate", "delegate_workflow", "delegate_workflow_append", "delegate_workflow_close", "delegate_status", "delegate_list", "delegate_collect", "delegate_cancel"]) {
      assert.ok(result.toolNames.includes(name), `${name} must be registered`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const link of createdLinks) rmSync(link, { force: true });
    if (createdRoot) rmSync(nodeModules, { recursive: true, force: true });
  }
});
