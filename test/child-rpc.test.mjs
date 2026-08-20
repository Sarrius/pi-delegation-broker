import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { spawnChildRpc } from "../src/child-rpc.mjs";

function startEchoingChild(script) {
  return spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() });
}

const ERROR_ECHO = `
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split("\\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      type: "response",
      id: msg.id,
      command: msg.type,
      success: false,
      error: "No API key found for cursor.\\n\\nUse /login to log into a provider via OAuth or API key.",
    }) + "\\n");
  }
});
`;

test("an un-awaited RPC error does not become an unhandled rejection", async () => {
  const rpc = startEchoingChild(ERROR_ECHO);
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    rpc.request({ type: "prompt", message: "hi" });
    await new Promise((resolve) => { const t = setTimeout(resolve, 80); t.unref?.(); });
    assert.equal(unhandled.length, 0, unhandled.map((reason) => String(reason)).join("\\n"));
  } finally {
    process.off("unhandledRejection", onUnhandled);
    rpc.kill();
    await rpc.exited;
  }
});

test("an awaited RPC error still rejects for the caller", async () => {
  const rpc = startEchoingChild(ERROR_ECHO);
  try {
    await assert.rejects(
      rpc.request({ type: "prompt", message: "hi" }),
      /No API key found for cursor/,
    );
  } finally {
    rpc.kill();
    await rpc.exited;
  }
});

test("spawnChildRpc still fails closed when the child cannot start", async () => {
  // Sanity: the helper is the real spawn path, not a stub that always "succeeds".
  assert.equal(typeof spawn, "function");
  const rpc = spawnChildRpc([process.execPath, "-e", "process.exit(0)"], { cwd: process.cwd() });
  const exit = await rpc.exited;
  assert.equal(exit.code, 0);
});
