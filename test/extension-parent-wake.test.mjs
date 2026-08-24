import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../extensions/pi-delegation-broker.ts", import.meta.url));
const PROBE = fileURLToPath(new URL("./fixtures/extension-parent-wake-probe.mjs", import.meta.url));
const RECOVERY_PROBE = fileURLToPath(new URL("./fixtures/extension-recovered-cancel-wake-probe.mjs", import.meta.url));
const SYNC_PROBE = fileURLToPath(new URL("./fixtures/extension-sync-workflow-no-wake-probe.mjs", import.meta.url));

function runProbe(home, probe) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", probe], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, BROKER_EXTENSION_PATH: EXTENSION },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`probe exited ${code}: ${stderr}\n${stdout}`)));
  });
}

async function withProbe(prefix, probe) {
  const home = mkdtempSync(join(tmpdir(), prefix));
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
    for (const [source, target] of links) {
      if (!existsSync(target)) { symlinkSync(source, target, "dir"); createdLinks.push(target); }
    }
    return await runProbe(home, probe);
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const link of createdLinks) rmSync(link, { force: true });
    if (createdRoot) rmSync(nodeModules, { recursive: true, force: true });
  }
}

test("extension parent-wake lifecycle covers background, recovery, and synchronous suppression", async (t) => {
  await t.test("a terminal background report automatically triggers a controller custom follow-up", async () => {
    const { stdout, stderr } = await withProbe("broker-parent-wake-", PROBE);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(result.customType, "delegation-broker-wake");
    assert.equal(result.triggerTurn, true);
  });
  await t.test("a cancellation recovered at session start gets a terminal report and automatic wake", async () => {
    const { stdout, stderr } = await withProbe("broker-parent-wake-recovery-", RECOVERY_PROBE);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)), { status: "cancelled", wake: true });
  });
  await t.test("a synchronously awaited workflow never schedules a redundant parent wake", async () => {
    const { stdout, stderr } = await withProbe("broker-sync-no-wake-", SYNC_PROBE);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(result.sends, 0);
    assert.match(result.workflowId, /^workflow-/);
  });
});
