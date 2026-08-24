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
