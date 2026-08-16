import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTENSION = new URL("../extensions/pi-delegation-broker.ts", import.meta.url).pathname;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function syntheticAgent(home) {
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  // `api-key` is intentionally not `api_key`: it is enough for the catalog reader but never
  // enters controller probeRoutes, so this test cannot make a network call or carry a secret.
  writeJson(join(agent, "auth.json"), { "test-provider": { type: "api-key", key: "not-a-real-key" } });
  writeJson(join(agent, "models-store.json"), {
    "test-provider": {
      models: [{
        id: "test-model", name: "Test Model", provider: "test-provider", api: "openai-completions",
        baseUrl: "https://test-provider.invalid/v1", contextWindow: 32_000, maxTokens: 2_048,
        reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  });
  // Prevent package discovery/install from the real agent settings during the subprocess test.
  writeJson(join(agent, "settings.json"), { defaultProjectTrust: "always", packages: [] });
}

async function rpcCommand(process, id, message) {
  process.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  const notices = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC command timed out: ${message}`)), 15_000);
    const onLine = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "extension_ui_request" && event.method === "notify") notices.push(event.message);
      if (event.type === "response" && event.id === id) {
        clearTimeout(timer);
        process.stdout.off("data", onData);
        if (!event.success) reject(new Error(`RPC command failed: ${message}`));
        else resolve(notices.join("\n"));
      }
    };
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk;
      for (;;) {
        const index = buffered.indexOf("\n");
        if (index < 0) break;
        const line = buffered.slice(0, index).replace(/\r$/, "");
        buffered = buffered.slice(index + 1);
        if (line) onLine(line);
      }
    };
    process.stdout.on("data", onData);
  });
}

test("live extension RPC: models and validated tier commands work without model/provider calls", { skip: !process.env.LIVE_EXTENSION_TEST }, async () => {
  const home = mkdtempSync(join(tmpdir(), "broker-extension-rpc-"));
  syntheticAgent(home);
  const child = spawn("pi", ["--mode", "rpc", "--no-session", "-ne", "-e", EXTENSION], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.setDefaultEncoding("utf8");
  try {
    // The extension's session_start asynchronously starts the controller; the command itself is
    // immediate and proves its parser/UI boundary independent of an LLM request.
    const models = await rpcCommand(child, "models", "/delegation-broker models test-provider");
    assert.match(models, /test-provider\/test-model/);
    const added = await rpcCommand(child, "add", "/delegation-broker tier standard add glm-5.3 zai");
    assert.match(added, /Saved standard preference/);
    const listed = await rpcCommand(child, "list", "/delegation-broker tier standard list");
    assert.match(listed, /glm-5\.3 via zai/);
    const removed = await rpcCommand(child, "remove", "/delegation-broker tier standard remove glm-5.3 zai");
    assert.match(removed, /removed glm-5\.3 via zai/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
