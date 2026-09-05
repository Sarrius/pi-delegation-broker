/**
 * Fresh `pi` binary parent for the 804330/236663/1000000 class.
 *
 * Default mode spends no provider quota: isolated HOME, fixture parent streamSimple,
 * fixture child controllerProvider. Owner-gated INCIDENT_LIVE_CURSOR=1 keeps the
 * synthetic incident seed but sends the second turn through one approved live Cursor
 * request; the four LIVE_* gates and an owner-only credential file are mandatory.
 * Neither mode is this interactive Pi process; `/reload` remains insufficient there.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BROKER = fileURLToPath(new URL("../extensions/pi-delegation-broker.ts", import.meta.url));
const INJECTOR = fileURLToPath(new URL("./fixtures/incident-input-cap-pi-host.ts", import.meta.url));
const PI_BIN = process.env.PI_BIN || "pi";
const HOST_MARKER = "INCIDENT_HOST_OK";
const LIVE_CURSOR = process.env.INCIDENT_LIVE_CURSOR === "1";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function prepareHome(home) {
  const agent = join(home, ".pi", "agent");
  const work = join(home, "work");
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".pi"), 0o700);
  chmodSync(agent, 0o700);
  chmodSync(work, 0o700);
  writeFileSync(join(work, "probe.txt"), "INCIDENT_PROBE\n", { mode: 0o600 });
  writeJson(join(agent, "auth.json"), {
    cursor: {
      type: "oauth",
      access: "fixture-cursor-access-not-a-secret",
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
    },
  });
  writeJson(join(agent, "settings.json"), {
    defaultProjectTrust: "always",
    packages: [],
    quietStartup: true,
    defaultProvider: "incident-host",
    defaultModel: "incident-v1",
    defaultThinkingLevel: "off",
  });
  writeJson(join(agent, "models-store.json"), {
    cursor: {
      models: [{
        id: "cursor-grok-4.6",
        name: "Grok 4.6",
        provider: "cursor",
        api: "openai-completions",
        baseUrl: "https://cursor.invalid/v1",
        contextWindow: 200_000,
        maxTokens: 8_192,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  });
  writeJson(join(agent, "models.json"), { providers: {} });
  return { agent, work };
}

function attachJsonl(stream, onEvent) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      const line = buffered.slice(0, index).replace(/\r$/, "");
      buffered = buffered.slice(index + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    }
  });
}

function assistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("");
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

test(`fresh pi binary observe path: incident used=804330 requested=236663 cap=1000000 stays metered and completes${LIVE_CURSOR ? " through one live Cursor request" : ""}`, { timeout: 180_000 }, async () => {
  if (LIVE_CURSOR) {
    assert.equal(process.env.LIVE_PROVIDER_TEST, "1", "live Pi-host canary requires LIVE_PROVIDER_TEST=1");
    assert.equal(process.env.LIVE_PROXY_CANARY_APPROVED, "1", "live Pi-host canary requires LIVE_PROXY_CANARY_APPROVED=1");
    assert.ok(process.env.LIVE_CONTROLLER_CREDENTIAL_FILE, "live Pi-host canary requires an owner credential file");
    assert.ok(process.env.LIVE_CURSOR_ENDPOINT, "live Pi-host canary requires an explicit Cursor endpoint");
  }
  const home = mkdtempSync("/tmp/ic-");
  const resultPath = join(home, "incident-host-result.json");
  const { work } = prepareHome(home);
  const nodeModules = join(ROOT, "node_modules");
  const globalModules = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules";
  const createdRoot = !existsSync(nodeModules);
  const links = [
    [join(globalModules, "typebox"), join(nodeModules, "typebox")],
    [join(globalModules, "@earendil-works", "pi-ai"), join(nodeModules, "@earendil-works", "pi-ai")],
  ];
  const createdLinks = [];
  let child;
  try {
    mkdirSync(join(nodeModules, "@earendil-works"), { recursive: true });
    for (const [source, target] of links) {
      if (!existsSync(target)) {
        symlinkSync(source, target, "dir");
        createdLinks.push(target);
      }
    }
    child = spawn(PI_BIN, [
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-skills",
      "--no-builtin-tools", "--thinking", "off",
      "--provider", "incident-host", "--model", "incident-v1",
      "-e", INJECTOR, "-e", BROKER,
    ], {
      cwd: work,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
        INCIDENT_HOST_RESULT: resultPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child.stdin.setDefaultEncoding("utf8");
    const stderr = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr.push(chunk); });
    const events = [];
    const assistant = [];
    let delegateEnd;
    let extensionError;
    let settled = false;
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `fresh pi host timed out; delegate=${JSON.stringify(delegateEnd)}; assistant=${assistant.join("|")}; extensionError=${extensionError ?? ""}; stderr=${stderr.join("").slice(-4000)}`,
      )), 150_000);
      attachJsonl(child.stdout, (event) => {
        events.push(event.type);
        if (event.type === "extension_error") extensionError = event.error ?? event.message ?? JSON.stringify(event);
        if (event.type === "tool_execution_end" && event.toolName === "delegate") delegateEnd = event;
        if (event.type === "message_end" && event.message?.role === "assistant") assistant.push(assistantText(event.message));
        if (event.type === "agent_settled") {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        if (settled) return;
        clearTimeout(timer);
        reject(new Error(`pi exited early (${code}); stderr=${stderr.join("").slice(-4000)}`));
      });
    });
    child.stdin.write(`${JSON.stringify({ id: "incident-host", type: "prompt", message: "Run the incident canary." })}\n`);
    await done;
    assert.equal(extensionError, undefined, extensionError);
    const delegateText = JSON.stringify(delegateEnd?.result ?? delegateEnd ?? {}).slice(0, 2000);
    assert.ok(delegateEnd, `delegate never ran; events=${events.join(",")}`);
    assert.notEqual(delegateEnd.isError, true, delegateText);
    assert.match(delegateText, /INCIDENT_CHILD_OK/);
    assert.ok(assistant.some((text) => text.includes(HOST_MARKER)), assistant.join("|"));
    assert.equal(existsSync(resultPath), true, `fixture parent must persist the lease snapshot after the child returns; delegate=${delegateText}`);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(result.hostMarker, HOST_MARKER);
    assert.equal(result.dispatches, 2, `child transport did not reach the second turn; lease=${JSON.stringify(result)}; delegate=${delegateText}`);
    assert.equal(result.liveCursor, LIVE_CURSOR);
    assert.equal(result.seedInputTokens, 804_330);
    assert.ok(result.seedInputTokens + result.requestedUtf8Bytes > 1_000_000,
      `the second request must reproduce the hard UTF-8 denial boundary: ${JSON.stringify(result)}`);
    if (LIVE_CURSOR) {
      assert.equal(result.liveDispatches, 1, `the second turn must make exactly one live request: ${JSON.stringify(result)}`);
      assert.ok(result.liveUsage?.input > 0 && result.liveUsage.input < 1_000_000 - result.seedInputTokens,
        `live provider usage must reconcile below the remaining token cap: ${JSON.stringify(result.liveUsage)}`);
    } else {
      assert.equal(result.liveDispatches, 0);
    }
    assert.deepEqual(result.leaseEnforcement, { input: "metered_best_effort", output: "hard" });
    assert.equal(result.resourceEnforcement.input, "hard");
    assert.equal(result.maxInputTokens, 1_000_000);
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { killTree(child); resolve(); }, 10_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    killTree(child);
    rmSync(home, { recursive: true, force: true });
    for (const link of createdLinks) rmSync(link, { force: true });
    if (createdRoot) rmSync(nodeModules, { recursive: true, force: true });
  }
});
