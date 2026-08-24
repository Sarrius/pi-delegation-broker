import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const LIVE = process.env.RUN_LIVE_PI_CHILD === "1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_AGENT = join(process.env.HOME, ".pi", "agent");
const PAYLOAD_AUDIT = fileURLToPath(new URL("./fixtures/parent-wake-payload-audit.ts", import.meta.url));
const LOCAL_PI = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
const PI_BIN = process.env.PI_BIN || (existsSync(LOCAL_PI) ? LOCAL_PI : "pi");

function assistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("");
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("live parent process did not exit")), timeoutMs);
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

test("live: terminal background task starts an automatic parent turn", { skip: !LIVE, timeout: 270_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "broker-live-parent-wake-"));
  const agent = join(home, ".pi", "agent");
  const brokerState = join(agent, "delegation-broker");
  let child;
  try {
    mkdirSync(brokerState, { recursive: true, mode: 0o700 });
    for (const name of ["auth.json", "models.json", "models-store.json"]) {
      try { copyFileSync(join(SOURCE_AGENT, name), join(agent, name)); } catch { /* optional catalog */ }
    }
    copyFileSync(join(SOURCE_AGENT, "delegation-broker", "preferences.json"), join(brokerState, "preferences.json"));
    writeFileSync(join(brokerState, "enabled.json"), '{"enabled":true}\n', { mode: 0o600 });
    writeFileSync(join(agent, "settings.json"), `${JSON.stringify({
      packages: [
        "/Users/example/.pi/dev/pi-multi-account",
        ROOT,
      ],
      quietStartup: true,
      defaultProvider: process.env.LIVE_PARENT_PROVIDER ?? "openai-codex-account-7",
      defaultModel: process.env.LIVE_PARENT_MODEL ?? "gpt-5.6-sol",
      defaultThinkingLevel: "low",
      retry: { provider: { maxRetries: 0, timeoutMs: 300_000 } },
      defaultProjectTrust: "always",
    })}\n`, { mode: 0o600 });

    const provider = process.env.LIVE_PARENT_PROVIDER ?? "openai-codex-account-7";
    const model = process.env.LIVE_PARENT_MODEL ?? "gpt-5.6-sol";
    const auditPath = join(home, "wake-payload-audit.json");
    child = spawn(PI_BIN, [
      "--mode", "rpc", "--provider", provider, "--model", model, "--thinking", "low",
      "--no-context-files", "--no-skills", "--extension", PAYLOAD_AUDIT,
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PARENT_WAKE_AUDIT_PATH: auditPath },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child.stderr.resume();
    const assistant = [];
    const eventCounts = new Map();
    let buffer = "";
    let sequence = 0;
    let wakeCount = 0;
    let wakeSequence = 0;
    let collectSequence = 0;
    let collectResultVerified = false;
    let initialAssistantBeforeWake = false;
    let assistantCountAtWake = 0;
    let resolveSettled, rejectSettled;
    const settled = new Promise((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const lf = buffer.indexOf("\n");
        if (lf < 0) break;
        const raw = buffer.slice(0, lf);
        sequence += 1;
        buffer = buffer.slice(lf + 1);
        let event;
        try { event = JSON.parse(raw.endsWith("\r") ? raw.slice(0, -1) : raw); } catch { continue; }
        eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
        if (event.type === "message_start" && event.message?.role === "custom"
          && event.message?.customType === "delegation-broker-wake") {
          wakeCount += 1;
          wakeSequence = sequence;
          initialAssistantBeforeWake = assistant.some((text) => text.includes("AWAITING_AUTO_WAKE"));
          assistantCountAtWake = assistant.length;
        }
        if (event.type === "tool_execution_start" && event.toolName === "delegate_collect") {
          collectSequence = sequence;
        }
        if (event.type === "tool_execution_end" && event.toolName === "delegate_collect") {
          collectResultVerified = event.isError !== true && JSON.stringify(event.result).includes("CHILD_WAKE_OK");
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          assistant.push(assistantText(event.message));
        }
        if (event.type === "agent_settled" && wakeCount === 1 && initialAssistantBeforeWake
          && collectSequence > wakeSequence && collectResultVerified
          && assistant.length > assistantCountAtWake) {
          resolveSettled();
        }
      }
    });
    child.once("error", rejectSettled);
    child.once("close", (code) => {
      if (wakeCount !== 1) rejectSettled(new Error(`live parent exited before one wake (${code})`));
    });
    const prompt = [
      "This is a live automatic parent-wake canary. Follow exactly:",
      "1. Call delegate once in default background mode at cheap tier. Ask the child to read package.json directly and return exactly CHILD_WAKE_OK.",
      "2. Do not poll or collect in the first turn. End it with exactly AWAITING_AUTO_WAKE.",
      "3. The controller wake must trigger a later turn. Collect the listed report, verify CHILD_WAKE_OK, and finish with exactly PARENT_AUTO_WAKE_OK.",
      "Never ask for another owner message.",
    ].join("\n");
    child.stdin.write(`${JSON.stringify({ id: "live-parent-wake", type: "prompt", message: prompt })}\n`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `automatic wake timed out; wakes=${wakeCount}; awaitingBeforeWake=${initialAssistantBeforeWake}; collectAfterWake=${collectSequence > wakeSequence}; collectVerified=${collectResultVerified}; assistantStates=${assistant.map((text) => text.includes("AWAITING_AUTO_WAKE") ? "awaiting" : text.includes("PARENT_AUTO_WAKE_OK") ? "parent" : "other").join("|")}; `
        + `agentStarts=${eventCounts.get("agent_start") ?? 0}; turns=${eventCounts.get("turn_start") ?? 0}; tools=${eventCounts.get("tool_execution_start") ?? 0}; extensionErrors=${eventCounts.get("extension_error") ?? 0}`,
      )), 240_000);
      settled.then(
        () => { clearTimeout(timer); resolve(); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
    // Keep the persistent RPC session open past the first qualifying settle so
    // delayed duplicate wakes or extension errors remain observable.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(wakeCount, 1, "one terminal report must produce exactly one typed wake");
    assert.equal(initialAssistantBeforeWake, true, "followUp must not interrupt the initial assistant response");
    assert.ok(collectSequence > wakeSequence, "the later wake turn must call delegate_collect");
    assert.equal(collectResultVerified, true, "controller-owned collection must return the child marker without error");
    assert.ok(assistant.length > assistantCountAtWake, "the typed wake must produce a later assistant turn");
    assert.ok((eventCounts.get("agent_start") ?? 0) >= 1);
    assert.ok((eventCounts.get("turn_start") ?? 0) >= 2);
    assert.ok((eventCounts.get("tool_execution_start") ?? 0) >= 1);
    assert.equal(eventCounts.get("extension_error") ?? 0, 0);
    assert.equal(existsSync(auditPath), true, "wake provider request must be audited");
    assert.deepEqual(JSON.parse(readFileSync(auditPath, "utf8")), {
      wakeMarker: true,
      markerInUserRole: true,
      systemRulePresent: true,
    });
    child.stdin.end();
    assert.equal(await waitForExit(child, 30_000), 0);
  } finally {
    if (child && child.exitCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    rmSync(home, { recursive: true, force: true });
  }
});
