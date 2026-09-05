import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../extensions/pi-delegation-broker.ts", import.meta.url));
const PROBE = fileURLToPath(new URL("./fixtures/incident-input-cap-parent-probe.mjs", import.meta.url));

function runProbe(home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", PROBE], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, BROKER_EXTENSION_PATH: EXTENSION },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`parent incident probe exited ${code}: ${stderr}\n${stdout}`)));
  });
}

test("fresh parent extension observe path: incident used=804330 requested=236663 cap=1000000 stays metered and completes", { timeout: 120_000 }, async () => {
  const home = mkdtempSync("/tmp/ic-");
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
      if (!existsSync(target)) {
        symlinkSync(source, target, "dir");
        createdLinks.push(target);
      }
    }
    const { stdout, stderr } = await runProbe(home);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(result.marker, "INCIDENT_PARENT_OK");
    assert.equal(result.dispatches, 2);
    assert.deepEqual(result.leaseEnforcement, { input: "metered_best_effort", output: "hard" });
    assert.equal(result.resourceEnforcement.input, "hard");
    assert.equal(result.maxInputTokens, 1_000_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const link of createdLinks) rmSync(link, { force: true });
    if (createdRoot) rmSync(nodeModules, { recursive: true, force: true });
  }
});
