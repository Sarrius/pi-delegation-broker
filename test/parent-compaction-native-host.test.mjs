import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const HOST = new URL("./fixtures/parent-compaction-native-host.ts", import.meta.url).pathname;
const BROKER = new URL("../extensions/pi-delegation-broker.ts", import.meta.url).pathname;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function textOf(content) { return typeof content === "string" ? content : (content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n"); }

async function runScenario(t, scenario) {
  const home = mkdtempSync("/tmp/pibc-");
  const agent = join(home, ".pi", "agent"), resultPath = join(home, "result.json");
  const state = join(agent, "delegation-broker");
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries({
    "auth.json": { anthropic: { type: "api_key", key: "fixture-native" } },
    "settings.json": { packages: [], quietStartup: true, defaultProjectTrust: "always", defaultProvider: "compaction-parent", defaultModel: "parent", defaultThinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 64, timeoutMs: 30_000 } },
    "models-store.json": {}, "models.json": { providers: {} },
  })) writeFileSync(join(agent, name), JSON.stringify(value), { mode: 0o600 });
  // Use the pinned public dev host by default, including in clean CI without a global Pi.
  // An explicit PI_BIN can qualify another host; keep parent and child on the same PATH.
  const piBin = process.env.PI_BIN ?? new URL('../node_modules/.bin/pi', import.meta.url).pathname;
  const installedPath = (process.env.PATH ?? "").split(delimiter).filter((path) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(path)).join(delimiter);
  const hostPath = isAbsolute(piBin) ? `${dirname(piBin)}${delimiter}${installedPath}` : installedPath;
  const child = spawn(piBin, [
    "--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-context-files", "--no-skills",
    "--thinking", "off", "--provider", "compaction-parent", "--model", "parent",
    "-e", HOST, "-e", BROKER,
  ], { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: hostPath, HOME: home, TMPDIR: home, LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_NO_LOCAL_LLM: "1",
    PI_DELEGATION_BROKER_STATE_DIR: state, COMPACTION_SCENARIO: scenario, COMPACTION_RESULT: resultPath,
  } });
  const exited = new Promise((resolve) => child.once("close", resolve));
  let killed = false;
  const kill = () => { if (killed || child.exitCode !== null) return; killed = true; try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } };
  t.after(async () => { kill(); await Promise.race([exited, delay(5000)]); rmSync(home, { recursive: true, force: true }); });
  const events = [], responses = new Map(), assistant = [];
  let stderr = "", buffered = "", wakeCount = 0, settled = 0, sequence = 0;
  let wakeSequence = 0, collectSequence = 0, compactEndSequence = 0, ownerSequence = 0, doneSequence = 0, settledSequence = 0;
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const index = buffered.indexOf("\n"); if (index < 0) break;
      const line = buffered.slice(0, index).replace(/\r$/, ""); buffered = buffered.slice(index + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      sequence++;
      if (event.type === "response") responses.set(event.id, event);
      if (event.type === "agent_settled") { settled++; settledSequence = sequence; }
      if (event.type === "compaction_end") compactEndSequence = sequence;
      if (event.type === "message_start" && event.message?.customType === "delegation-broker-wake") { wakeCount++; wakeSequence = sequence; }
      if (event.type === "tool_execution_start" && event.toolName === "delegate_collect") collectSequence = sequence;
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = textOf(event.message.content); assistant.push(text);
        if (text.includes("NEW_OWNER_HANDLED")) ownerSequence = sequence;
        if (text.includes("COMPACTION_PARENT_COLLECTED")) doneSequence = sequence;
      }
      if (["extension_error", "compaction_start", "compaction_end", "agent_settled"].includes(event.type)) events.push(event);
    }
  });
  const send = (id, command) => child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  const evidence = () => { try { return JSON.parse(readFileSync(resultPath, "utf8")); } catch { return {}; } };
  async function until(predicate, label, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (evidence().providerErrors?.length || events.some((event) => event.type === "extension_error") || child.exitCode !== null || Date.now() >= deadline) throw Error(`${scenario}: ${label}; exit=${child.exitCode}; evidence=${JSON.stringify(evidence()).slice(-5000)}; events=${JSON.stringify(events).slice(-4000)}; assistant=${assistant.join("|")}; stderr=${stderr}`);
      await delay(20);
    }
  }
  send("initial", { type: "prompt", message: `ORIGINAL_OWNER_GOAL: run the offline delegation compaction canary.\n${"old-context ".repeat(500)}` });
  if (!["automatic", "new-owner", "overflow-active"].includes(scenario)) {
    await until(() => settled > 0 && assistant.some((value) => value.includes("COMPACTION_PARENT_WAITING")), "initial owner run must settle while the child remains live");
    send("manual-compact", { type: "compact" });
  }
  if (scenario === "abort" || scenario === "new-owner") {
    await until(() => evidence().reportDuringCompaction === true, "child result must settle during the native compaction");
    if (scenario === "abort") send("abort-compact", { type: "abort" });
    else send("new-owner", { type: "follow_up", message: "NEW_OWNER_INTENT: this newer instruction must finish before the broker wake." });
  }
  await until(() => doneSequence > 0 && settledSequence > doneSequence, "automatic report collection and final settlement after compaction");
  await delay(400); // A late duplicate wake remains observable while the host stays alive.
  const result = evidence();
  assert.equal(result.providerErrors.length, 0, JSON.stringify(result));
  assert.equal(events.filter((event) => event.type === "extension_error").length, 0, JSON.stringify(events));
  assert.equal(result.childRequests, 1, "compaction cannot relaunch or retry the original child");
  assert.equal(result.childAborts, 0, "parent compaction cannot abort the independently owned child");
  assert.equal(new Set(result.childSessionIds).size, 1);
  if (scenario !== "workflow") assert.equal(result.childSessionIds[0], result.taskId, "the same original leased child owns the only provider request");
  assert.equal(result.compactions, 1);
  assert.equal(result.compactionBusy, true);
  assert.equal(wakeCount, 1, "exactly one hidden lifecycle wake must be consumed");
  assert.ok(wakeSequence > compactEndSequence && compactEndSequence > 0);
  assert.ok(collectSequence > wakeSequence);
  assert.equal(result.collected, 1);
  assert.deepEqual(result.afterJob.contract, result.beforeJob.contract);
  assert.equal(result.afterJob.task, result.beforeJob.task);
  assert.equal(result.afterJob.admittedAt, result.beforeJob.admittedAt);
  if (scenario === "workflow") {
    assert.deepEqual(result.afterJob.nodes[0].contract, result.beforeJob.nodes[0].contract);
    assert.equal(result.afterJob.nodes[0].task, result.beforeJob.nodes[0].task);
  }
  assert.equal(result.afterJob.deadlineAt, result.beforeJob.deadlineAt);
  assert.equal(result.afterJob.inputBudgetPolicy, result.beforeJob.inputBudgetPolicy);
  assert.equal(result.afterJob.outputBudgetPolicy, result.beforeJob.outputBudgetPolicy);
  assert.equal(result.afterJob.status, "completed");
  assert.equal(existsSync(join(home, "owned.txt")), false);
  if (scenario === "failure" || scenario === "abort") {
    assert.equal(result.compactionFailure.aborted, scenario === "abort");
    assert.equal(responses.get("manual-compact")?.success, false);
  } else assert.equal(result.savedHookBusy, true, "saved-summary notification is not the actual idle boundary");
  if (scenario === "new-owner") {
    assert.equal(responses.get("new-owner")?.success, true);
    assert.equal(result.ownerHandled, true);
    assert.ok(ownerSequence > compactEndSequence && ownerSequence < wakeSequence, "newer queued owner intent must run before the broker wake");
  }
  if (scenario === "overflow-active") {
    assert.equal(result.reason, "overflow");
    assert.equal(result.activeContextRecovered, true);
    assert.equal(result.ownershipStillBlocked, true);
    assert.equal(result.ownerStarts, 1, "the active assignment recovered without another before_agent_start");
    assert.equal(result.startsAtContextRecovery, 1, "per-request recovery cannot depend on another prompt preflight");
  }
  const report = JSON.parse(readFileSync(join(state, "reports", `${result.taskId}.json`), "utf8"));
  assert.equal(report.status, "completed");
  assert.ok(Number.isSafeInteger(report.wakeAt), "actual message_start must durably acknowledge wake consumption");
  assert.ok(Number.isSafeInteger(report.readAt), "collection must durably mark the original report read");
  if (scenario !== "workflow") assert.equal(report.verificationStatus, "accepted");
  send("entries", { type: "get_entries" });
  await until(() => responses.has("entries"), "session entries");
  assert.equal(responses.get("entries").data.entries.filter((entry) => entry.type === "custom_message" && entry.customType === "delegation-broker-context").length, 0, "per-request projections must never grow persistent history");
  assert.doesNotMatch(stderr, /Agent is already processing a prompt|Cannot submit a prompt while compaction/);
  child.stdin.end();
  await Promise.race([exited, delay(5000).then(kill)]);
}

test("fresh installed Pi: independently owned children and parent recovery survive native compaction", { timeout: 360_000 }, async (t) => {
  const scenarios = ["manual", "failure", "abort", "automatic", "new-owner", "overflow-active", "workflow"];
  const selected = process.env.COMPACTION_TEST_SCENARIO;
  assert.ok(!selected || scenarios.includes(selected), "unknown targeted compaction scenario");
  for (const scenario of selected ? [selected] : scenarios) {
    await t.test(scenario, { timeout: 90_000 }, (t) => runScenario(t, scenario));
  }
});
