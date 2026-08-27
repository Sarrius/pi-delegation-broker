import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fixtureRegistry } from "../src/broker.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";
import { createSelectContract } from "../src/model-selector.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";

const CONTROLLER_TOKEN = "tool-proxy-controller-token-123456789012345678";
const SHIM_PATH = new URL("../extensions/child-shim.ts", import.meta.url).pathname;
const PROXY_PATH = new URL("../extensions/controller-provider-proxy.ts", import.meta.url).pathname;
const BEHAVIOR_PATH = new URL("../extensions/pi-behavioral-enforcement.ts", import.meta.url).pathname;
const PROMPT = "Use the read tool on probe.txt, then reply with exactly TOOL_PROXY_OK.";

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function testRegistry() {
  const registry = fixtureRegistry();
  registry.profiles["canary-text/v1"] = { status: "approved", supports: ["text_generation", "code_reasoning", "repo_navigation"] };
  registry.resources.R1 = {
    ...registry.resources.R1,
    capacityGroup: "G-cheap",
    profile: "canary-text/v1",
    model: { provider: "fixture", modelId: "fixture-model" },
  };
  return registry;
}

test("credentialless proxy completes a real local read tool turn and replays its result", async () => {
  const root = mkdtempSync(join(tmpdir(), "tool-proxy-child-"));
  writeFileSync(join(root, "probe.txt"), "TOOL_PROXY_INPUT\n", { mode: 0o600 });
  const registry = testRegistry();
  const requests = [];
  const providerTransport = {
    async *stream(_snapshot, context, { onSendStarted }) {
      requests.push(context);
      onSendStarted();
      yield { type: "headers", payload: { httpStatus: 200, providerRequestId: `tool-proxy-${requests.length}` } };
      const result = context.messages.find((message) => message.role === "toolResult");
      if (!result) {
        yield { type: "block_start", payload: { index: 0, blockType: "tool_call", id: "call_1", name: "read" } };
        yield { type: "tool_call_delta", payload: { index: 0, delta: '{"path":"probe.txt"}' } };
        yield { type: "block_end", payload: { index: 0, value: '{"path":"probe.txt"}' } };
        yield { type: "terminal", outcome: "succeeded_terminal", payload: { finishReason: "tool_use" } };
        return;
      }
      assert.equal(result.content, "TOOL_PROXY_INPUT\n");
      yield { type: "block_start", payload: { index: 0, blockType: "text" } };
      yield { type: "text_delta", payload: { index: 0, delta: "TOOL_PROXY_OK" } };
      yield { type: "block_end", payload: { index: 0, value: "TOOL_PROXY_OK" } };
      yield { type: "terminal", outcome: "succeeded_terminal", payload: { finishReason: "stop" } };
    },
  };
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: join(root, "broker"),
    registry,
    allowUnsignedFixture: true,
    controllerToken: CONTROLLER_TOKEN,
    providerTransport,
    routeResolver: async () => ({
      registryFingerprint: "a".repeat(64), registryVersion: 1, accountAlias: "fixture", provider: "fixture", model: "fixture-model",
      reasoningEffort: "off", apiDialect: "fixture", endpointId: "fixture-tool-proxy", adapterId: "fixture-adapter",
      credentialRefFingerprint: "b".repeat(64), cacheRetention: "none",
    }),
    behavioralEnforcement: "blocking_monitor",
    sweepIntervalMs: 100,
  });
  try {
    await supervisor.start();
    const extensionPaths = [SHIM_PATH, PROXY_PATH, BEHAVIOR_PATH];
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "child-agents"),
      extensionPaths,
      launcherAttestationConfig: {
        behavioralExtensionPath: BEHAVIOR_PATH,
        trustedExtensionDigests: extensionPaths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex")),
      },
      controllerProxy: { providerId: "broker-proxy" },
      resolveModelForResource: () => ({ provider: "fixture", modelId: "fixture-model" }),
      selectContract: createSelectContract({
        registry,
        availability: () => supervisor.inventory(),
        currency: () => ({}),
        constraints: { budget: { maxInputTokens: 20_000, maxOutputTokens: 128 } },
      }),
    });
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions") });
    const result = await runner.run({
      childId: "tool-proxy-child",
      prompt: PROMPT,
      promptDigest: createHash("sha256").update(PROMPT).digest("hex"),
      cwd: root,
      tools: ["read"],
      thinkingLevel: "off",
      capabilityRequest: {
        taskDescription: PROMPT,
        operationClass: "observe",
        requiredCapabilities: ["text_generation", "code_reasoning", "repo_navigation"],
        budget: { maxInputTokens: 20_000, maxOutputTokens: 128, maxAttempts: 1 },
      },
    });
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.text.trim(), "TOOL_PROXY_OK");
    assert.equal(requests.length, 2, "the provider must receive one tool turn and one replay turn");
    assert.ok(requests[0].tools.some((tool) => tool.name === "read"));
    assert.equal(requests[0].messages.some((message) => message.role === "toolResult"), false);
    assert.equal(requests[1].messages.some((message) => message.role === "toolResult"), true);
    const authFiles = filesUnder(join(root, "child-agents")).filter((path) => path.endsWith("auth.json"));
    assert.deepEqual(authFiles, []);
    await runner.dispose();
    assert.equal(supervisor.auditSnapshot().leases.length, 0);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
