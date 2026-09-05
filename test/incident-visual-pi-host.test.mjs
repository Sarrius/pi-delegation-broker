import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BROKER = fileURLToPath(new URL("../extensions/pi-delegation-broker.ts", import.meta.url));
const INJECTOR = fileURLToPath(new URL("./fixtures/incident-visual-pi-host.ts", import.meta.url));
const PI_BIN = process.env.PI_BIN || "pi";
const WAIT_MARKER = "AWAITING_VISUAL_WAKE";
const PARENT_MARKER = "VISUAL_PARENT_WAKE_OK";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAA9sAAAAQCAYAAAAGTmw2AAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAF4SURBVHja7N27TsMwFAZgu0WMDPRB2HloFl6Ch0DqysJIJSTIoaUSapPYcdoOqPq+JerFlxxHlf+lzpvNU5fmiNhfc25vs0453W2vq30PCQAAAK7YzS42z2qR87ljZmUHAADgmi2UAAAAAIRtAAAAELYBAABA2AYAAACEbQAAABC2AQAAQNg+kwO/AAAAELYvLBQbAAAAYRsAAAAQtgEAAEDYBgAAAGH7ZN+KDQAAgLAtbAMAAMAJ8sv7Z+P/hO/O7orfa/yd4xWDz47f33/28PacPm5X6fX+saHd4Rlh0Ru/JirfiF4fpXEO5xNNYw77GXsdE/dQqkFtni391+5lWNsYXZNzHK7JvLWcfjZKfdZqPVXn47Y5dSnnzq8EDY/69pnJjlyw1uaLtVGL67rniN2+fzGSCfr7sNTbS03tq6OQNVr6LbVLM8avzSEaxijtJ1Nh/LG8kWaMn0b2qsPvLfNXNRFdQhfLGTX7L894y1xOXZe6HwEGAEeJamT41YtiAAAAAElFTkSuQmCC";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function prepareHome(home) {
  const agent = join(home, ".pi", "agent");
  const brokerState = join(agent, "delegation-broker");
  const work = join(home, "work");
  mkdirSync(brokerState, { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".pi"), 0o700);
  chmodSync(agent, 0o700);
  chmodSync(brokerState, 0o700);
  writeFileSync(join(work, "pixel.png"), Buffer.from(PNG_BASE64, "base64"), { mode: 0o600 });
  writeJson(join(agent, "auth.json"), {
    "anthropic-account-91": { type: "api_key", key: "fixture-anthropic-not-a-secret" },
    "openai-codex-account-91": { type: "api_key", key: "fixture-codex-not-a-secret" },
  });
  writeJson(join(agent, "settings.json"), {
    defaultProjectTrust: "always",
    packages: [],
    quietStartup: true,
    defaultProvider: "visual-host",
    defaultModel: "visual-host-v1",
    defaultThinkingLevel: "off",
  });
  writeJson(join(agent, "models-store.json"), {});
  writeJson(join(agent, "models.json"), { providers: {} });
  writeJson(join(brokerState, "enabled.json"), { enabled: true });
  return { agent, brokerState, work };
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
      try { onEvent(JSON.parse(line)); } catch { /* ignore non-JSON diagnostics */ }
    }
  });
}

function assistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("");
}

function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

test("fresh Pi: visual failover preserves the image and one busy-parent wake continues after agent_settled", { timeout: 120_000 }, async () => {
  const home = mkdtempSync("/tmp/vf-");
  const resultPath = join(home, "visual-host-result.json");
  const { agent, brokerState, work } = prepareHome(home);
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
      "--provider", "visual-host", "--model", "visual-host-v1",
      "-e", INJECTOR, "-e", BROKER,
    ], {
      cwd: work,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, VISUAL_HOST_RESULT: resultPath },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child.stdin.setDefaultEncoding("utf8");
    let sequence = 0;
    let wakeCount = 0;
    let wakeSequence = 0;
    let waitingSequence = 0;
    let collectSequence = 0;
    let extensionError;
    const assistant = [];
    const stderr = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr.push(chunk); });
    let finalSettled = false;
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `visual fresh-Pi canary timed out; wake=${wakeCount}; assistant=${assistant.join("|")}; extension=${extensionError ?? ""}; stderr=${stderr.join("").slice(-4000)}`,
      )), 90_000);
      attachJsonl(child.stdout, (event) => {
        sequence += 1;
        if (event.type === "extension_error") extensionError = event.error ?? event.message ?? JSON.stringify(event);
        if (event.type === "message_start" && event.message?.role === "custom" && event.message?.customType === "delegation-broker-wake") {
          wakeCount += 1;
          wakeSequence = sequence;
        }
        if (event.type === "tool_execution_start" && event.toolName === "delegate_collect") collectSequence = sequence;
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = assistantText(event.message);
          assistant.push(text);
          if (text.includes(WAIT_MARKER)) waitingSequence = sequence;
        }
        if (event.type === "agent_settled" && assistant.some((text) => text.includes(PARENT_MARKER))) {
          finalSettled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        if (finalSettled) return;
        clearTimeout(timer);
        reject(new Error(`fresh Pi exited early (${code}); stderr=${stderr.join("").slice(-4000)}`));
      });
    });
    child.stdin.write(`${JSON.stringify({ id: "visual-incident", type: "prompt", message: "Run the visual delegation incident canary." })}\n`);
    await done;
    await new Promise((resolve) => setTimeout(resolve, 500));

    const debugResult = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
    assert.equal(extensionError, undefined, String(extensionError));
    assert.equal(wakeCount, 1, "the terminal report must produce one continuation only");
    assert.ok(waitingSequence > 0, `the busy parent must finish its original turn: ${assistant.join("|")}; observations=${JSON.stringify(debugResult.parentObservations)}`);
    assert.ok(wakeSequence > waitingSequence, "wake must wait until the busy parent turn has settled");
    assert.ok(collectSequence > wakeSequence, "the continuation must collect the terminal report");
    assert.ok(assistant.some((text) => text.includes(PARENT_MARKER)), assistant.join("|"));
    assert.doesNotMatch(stderr.join(""), /Agent is already processing a prompt/);

    assert.equal(existsSync(resultPath), true);
    const result = debugResult;
    assert.match(result.unavailableResource, /^(?:anthropic|openai-codex)-account-91\//);
    assert.match(result.actualResource, /^(?:anthropic|openai-codex)-account-91\//);
    assert.notEqual(result.actualResource, result.unavailableResource, "the unavailable vision route must not dispatch");
    assert.equal(result.childDispatches, 2, "the surviving route must complete a read-tool replay turn");
    assert.match(result.imageDigest, /^[a-f0-9]{64}$/);
    assert.ok(result.childCompletedAt <= result.parentCompletedAt);

    const reportsDir = join(brokerState, "reports");
    const reports = readdirSync(reportsDir).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(reportsDir, name), "utf8")));
    const report = reports.find((entry) => JSON.stringify(entry).includes("VISUAL_CHILD_OK"));
    assert.equal(report?.status, "completed", JSON.stringify(reports).slice(0, 4000));
    assert.ok(Number.isSafeInteger(report?.wakeAt), "custom wake lifecycle must durably acknowledge the report");

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
