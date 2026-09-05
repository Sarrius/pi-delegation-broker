import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  disposeBrokeredChildProcesses,
  resolveChildLaunchModel,
  spawnBrokeredChild,
} from "../src/child-launcher.mjs";

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
  let argv;
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
