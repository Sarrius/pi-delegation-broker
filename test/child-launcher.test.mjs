import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  disposeBrokeredChildProcesses,
  parentSettlementShouldReapBrokeredChildren,
  resolveChildLaunchModel,
  spawnBrokeredChild,
} from "../src/child-launcher.mjs";

test("parent settlement reaps only after owner jobs and controller work are idle", () => {
  assert.equal(parentSettlementShouldReapBrokeredChildren({ ownerJobCount: 0, controllerLiveWork: false }), true);
  assert.equal(parentSettlementShouldReapBrokeredChildren({ ownerJobCount: 1, controllerLiveWork: false }), false);
  assert.equal(parentSettlementShouldReapBrokeredChildren({ ownerJobCount: 0, controllerLiveWork: true }), false);
  assert.equal(parentSettlementShouldReapBrokeredChildren({ ownerJobCount: 1, controllerLiveWork: true }), false);
  assert.equal(parentSettlementShouldReapBrokeredChildren({ controllerLiveWork: "unknown" }), false);
});

test("account aliases remain controller identities but launch through a canonical Pi provider", () => {
  assert.deepEqual(resolveChildLaunchModel("anthropic-account-2/claude-opus-5"), {
    leasedProvider: "anthropic-account-2", provider: "anthropic", modelId: "claude-opus-5",
  });
  assert.deepEqual(resolveChildLaunchModel("openai-codex-account-6/gpt-5.6-terra"), {
    leasedProvider: "openai-codex-account-6", provider: "openai-codex", modelId: "gpt-5.6-terra",
  });
  assert.deepEqual(resolveChildLaunchModel("zai/glm-5.3"), {
    leasedProvider: "zai", provider: "zai", modelId: "glm-5.3",
  });
});

test("malformed child model identities fail before a process can launch", () => {
  for (const value of ["", "anthropic", "/claude-opus-5", "anthropic/"]) {
    assert.throws(() => resolveChildLaunchModel(value), /Model must be/);
  }
});

test("explicit tool selection retains controller behavioral tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "child-tools-"));
  let argv, emit;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const exitListeners = [];
  const rpc = {
    exited,
    onEvent(listener) { emit = listener; },
    onExit(listener) { exitListeners.push(listener); },
    async request(message) {
      if (message.type === "get_state") return { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionFile: "test.jsonl" };
      throw new Error("unexpected request");
    },
    send() {},
    stderrTail() { return ""; },
    kill(signal) {
      const event = { code: null, signal };
      for (const listener of exitListeners) listener(event);
      resolveExit(event);
    },
  };
  try {
    const spawned = await spawnBrokeredChild({
      spec: { model: "zai/glm-5.3", thinkingLevel: "off", tools: ["read"], appendSystemPrompt: "" },
      parentCwd: root,
      sessionsDir: join(root, "sessions"),
      childPiEntry: process.execPath,
      launchPolicy: {
        agentDir: join(root, "agent"),
        environment: { PI_BROKER_EXPECT_BEHAVIORAL_TOOLS: "1" },
        requiredActiveTools: ["broker_declare_action"],
        authorizationPolicy: { effectCapable: true },
        extensionPaths: [],
      },
      spawnRpc(command, options) {
        argv = command.slice(2);
        const shim = JSON.parse(readFileSync(options.env.PI_SUBAGENT_SHIM_SPEC, "utf8"));
        writeFileSync(shim.toolReportPath, JSON.stringify({ activeTools: ["read", "broker_declare_action", "broker_checkpoint", "propose_patch"] }));
        return rpc;
      },
    });
    assert.ok(spawned.session);
    // Broker routing is explicit and never inherits settings.json. This is the independence seam
    // with pi-multi-account: the parent may rotate its live session or Pi may keep selections
    // session-scoped, while every leased child still launches on exactly this provider/model.
    assert.equal(argv[argv.indexOf("--provider") + 1], "zai");
    assert.equal(argv[argv.indexOf("--model") + 1], "glm-5.3");
    const toolsIndex = argv.indexOf("--tools");
    assert.notEqual(toolsIndex, -1);
    assert.equal(argv[toolsIndex + 1], "read,broker_declare_action,broker_checkpoint,propose_patch");
    emit({ type: "tool_execution_end", result: { details: { brokerGuardTerminal: { status: "no_progress" } } } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [] } });
    assert.equal(spawned.session.latestAssistantMessage.errorMessage, "controller behavioral terminal: no_progress");
    // Even a later claimed success cannot erase the fail-closed guard termination.
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "claimed done" }] } });
    assert.equal(spawned.session.latestAssistantMessage.stopReason, "error");
    spawned.session.dispose();
  } finally {
    await disposeBrokeredChildProcesses();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settled-parent cleanup reaps an RPC child left outside runner handles", async () => {
  const root = mkdtempSync(join(tmpdir(), "child-reaper-"));
  const signals = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const exitListeners = [];
  const rpc = {
    exited,
    onEvent() {},
    onExit(listener) { exitListeners.push(listener); },
    async request(message) {
      if (message.type === "get_state") return { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionFile: "test.jsonl" };
      throw new Error("unexpected request");
    },
    send() {},
    stderrTail() { return ""; },
    kill(signal) {
      signals.push(signal);
      const event = { code: null, signal };
      for (const listener of exitListeners) listener(event);
      resolveExit(event);
    },
  };
  try {
    const spawned = await spawnBrokeredChild({
      spec: { model: "zai/glm-5.3", thinkingLevel: "off", appendSystemPrompt: "" },
      parentCwd: root,
      sessionsDir: join(root, "sessions"),
      childPiEntry: process.execPath,
      spawnRpc(_command, options) {
        const shim = JSON.parse(readFileSync(options.env.PI_SUBAGENT_SHIM_SPEC, "utf8"));
        writeFileSync(shim.toolReportPath, JSON.stringify({ activeTools: [] }));
        return rpc;
      },
    });
    assert.ok(spawned.session, "the RPC reached a live session and was intentionally not disposed");
    await disposeBrokeredChildProcesses();
    assert.deepEqual(signals, ["SIGTERM"]);
  } finally {
    await disposeBrokeredChildProcesses();
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeRpc({ afterIdleStates = 0, onPrompt } = {}) {
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const exitListeners = [];
  let emit;
  let idleStates = 0;
  let streaming = false;
  const rpc = {
    exited,
    onEvent(listener) { emit = listener; },
    onExit(listener) { exitListeners.push(listener); },
    async request(message, options) {
      if (message.type === "get_state") {
        if (streaming) {
          options?.onResponse?.({ isStreaming: true, isCompacting: false, pendingMessageCount: 0, sessionFile: "test.jsonl" });
          return { isStreaming: true, isCompacting: false, pendingMessageCount: 0, sessionFile: "test.jsonl" };
        }
        idleStates += 1;
        if (afterIdleStates > 0 && idleStates > afterIdleStates) streaming = true;
        const state = { isStreaming: streaming, isCompacting: false, pendingMessageCount: 0, sessionFile: "test.jsonl" };
        if (streaming) options?.onResponse?.(state);
        return state;
      }
      if (message.type === "prompt") {
        onPrompt?.({ emit, start() { streaming = true; } });
        return {};
      }
      throw new Error(`unexpected request ${message.type}`);
    },
    send() {},
    stderrTail() { return ""; },
    kill(signal) {
      const event = { code: null, signal };
      for (const listener of exitListeners) listener(event);
      resolveExit(event);
    },
  };
  return { rpc, events: () => emit };
}

async function spawnSession(root, rpc) {
  return spawnBrokeredChild({
    spec: { model: "zai/glm-5.3", thinkingLevel: "off", appendSystemPrompt: "" },
    parentCwd: root,
    sessionsDir: join(root, "sessions"),
    childPiEntry: process.execPath,
    spawnRpc(_command, options) {
      const shim = JSON.parse(readFileSync(options.env.PI_SUBAGENT_SHIM_SPEC, "utf8"));
      writeFileSync(shim.toolReportPath, JSON.stringify({ activeTools: ["read"] }));
      return rpc;
    },
  });
}

test("a delayed child agent start is not treated as an empty immediate completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "child-delay-"));
  const { rpc, events } = fakeRpc();
  try {
    const spawned = await spawnSession(root, rpc);
    let settled = false;
    const prompt = spawned.session.prompt("qualify").then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(settled, false, "idle polls without a new assistant message must keep waiting");
    events()({ type: "agent_start" });
    events()({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] } });
    events()({ type: "agent_settled" });
    await prompt;
    assert.equal(spawned.session.latestAssistantMessage.content[0].text, "ok");
    spawned.session.dispose();
  } finally {
    await disposeBrokeredChildProcesses();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn that finished before lifecycle events still completes once the assistant message exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "child-fast-"));
  const { rpc } = fakeRpc({
    onPrompt({ emit }) {
      emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fast" }] } });
    },
  });
  try {
    const spawned = await spawnSession(root, rpc);
    await spawned.session.prompt("qualify");
    assert.equal(spawned.session.latestAssistantMessage.content[0].text, "fast");
    spawned.session.dispose();
  } finally {
    await disposeBrokeredChildProcesses();
    rmSync(root, { recursive: true, force: true });
  }
});
