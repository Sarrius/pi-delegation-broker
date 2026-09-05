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

function testRegistry({ vision = false } = {}) {
  const registry = fixtureRegistry();
  const profile = vision ? "canary-vision/v1" : "canary-text/v1";
  const supports = ["text_generation", "code_reasoning", "repo_navigation", ...(vision ? ["vision_input"] : [])];
  registry.profiles[profile] = { status: "approved", supports };
  registry.resources.R1 = {
    ...registry.resources.R1,
    capacityGroup: "G-cheap",
    profile,
    model: { provider: "fixture", modelId: "fixture-model" },
  };
  return registry;
}

test("credentialless proxy completes and replays a Cursor LF compound-id read tool turn", async () => {
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
        yield { type: "block_start", payload: { index: 0, blockType: "tool_call", id: "call_1\nfc_1", name: "read" } };
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

test("credentialless vision proxy preserves a read-tool image block into the controller replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "vp-"));
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAA9sAAAAQCAYAAAAGTmw2AAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAF4SURBVHja7N27TsMwFAZgu0WMDPRB2HloFl6Ch0DqysJIJSTIoaUSapPYcdoOqPq+JerFlxxHlf+lzpvNU5fmiNhfc25vs0453W2vq30PCQAAAK7YzS42z2qR87ljZmUHAADgmi2UAAAAAIRtAAAAELYBAABA2AYAAACEbQAAABC2AQAAQNg+kwO/AAAAELYvLBQbAAAAYRsAAAAQtgEAAEDYBgAAAGH7ZN+KDQAAgLAtbAMAAMAJ8sv7Z+P/hO/O7orfa/yd4xWDz47f33/28PacPm5X6fX+saHd4Rlh0Ru/JirfiF4fpXEO5xNNYw77GXsdE/dQqkFtni391+5lWNsYXZNzHK7JvLWcfjZKfdZqPVXn47Y5dSnnzq8EDY/69pnJjlyw1uaLtVGL67rniN2+fzGSCfr7sNTbS03tq6OQNVr6LbVLM8avzSEaxijtJ1Nh/LG8kWaMn0b2qsPvLfNXNRFdQhfLGTX7L894y1xOXZe6HwEGAEeJamT41YtiAAAAAElFTkSuQmCC";
  writeFileSync(join(root, "pixel.png"), Buffer.from(pngBase64, "base64"), { mode: 0o600 });
  const registry = testRegistry({ vision: true });
  const requests = [];
  const providerTransport = {
    async *stream(_snapshot, context, { onSendStarted }) {
      requests.push(context);
      onSendStarted();
      yield { type: "headers", payload: { httpStatus: 200, providerRequestId: `vision-proxy-${requests.length}` } };
      const result = context.messages.find((message) => message.role === "toolResult");
      if (!result) {
        yield { type: "block_start", payload: { index: 0, blockType: "tool_call", id: "call_image", name: "read" } };
        yield { type: "tool_call_delta", payload: { index: 0, delta: '{"path":"pixel.png"}' } };
        yield { type: "block_end", payload: { index: 0, value: '{"path":"pixel.png"}' } };
        yield { type: "terminal", outcome: "succeeded_terminal", payload: { finishReason: "tool_use" } };
        return;
      }
      yield { type: "block_start", payload: { index: 0, blockType: "text" } };
      yield { type: "text_delta", payload: { index: 0, delta: "VISION_PROXY_OK" } };
      yield { type: "block_end", payload: { index: 0, value: "VISION_PROXY_OK" } };
      yield { type: "terminal", outcome: "succeeded_terminal", payload: { finishReason: "stop" } };
    },
  };
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: root,
    registry,
    allowUnsignedFixture: true,
    controllerToken: CONTROLLER_TOKEN,
    providerTransport,
    routeResolver: async () => ({
      registryFingerprint: "c".repeat(64), registryVersion: 1, accountAlias: "fixture", provider: "fixture", model: "fixture-model",
      reasoningEffort: "off", apiDialect: "fixture", endpointId: "fixture-vision-proxy", adapterId: "fixture-adapter",
      credentialRefFingerprint: "d".repeat(64), cacheRetention: "none",
    }),
    behavioralEnforcement: "blocking_monitor",
    sweepIntervalMs: 100,
  });
  let runner;
  try {
    await supervisor.start();
    const extensionPaths = [SHIM_PATH, PROXY_PATH, BEHAVIOR_PATH];
    const resolver = new BrokeredLaunchResolver({
      socketPath: supervisor.socketPath,
      controllerToken: supervisor.controllerToken,
      agentRoot: join(root, "a"),
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
    const originalResolve = resolver.resolve.bind(resolver);
    resolver.resolve = async (request) => {
      const decision = await originalResolve(request);
      if (decision.action === "allow") {
        assert.equal(decision.policy.environment.PI_BROKER_PROXY_INPUT_MODALITIES, "text,image");
      }
      return decision;
    };
    runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "s") });
    const prompt = "Use the read tool on pixel.png, inspect the image, then reply with exactly VISION_PROXY_OK.";
    const result = await runner.run({
      childId: "vision-proxy-child",
      prompt,
      promptDigest: createHash("sha256").update(prompt).digest("hex"),
      cwd: root,
      tools: ["read"],
      thinkingLevel: "off",
      capabilityRequest: {
        taskDescription: prompt,
        operationClass: "observe",
        requiredCapabilities: ["text_generation", "code_reasoning", "repo_navigation", "vision_input"],
        budget: { maxInputTokens: 20_000, maxOutputTokens: 128, maxAttempts: 1 },
      },
    });
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.text.trim(), "VISION_PROXY_OK");
    assert.equal(requests.length, 2);
    const replay = requests[1].messages.find((message) => message.role === "toolResult");
    assert.ok(Array.isArray(replay?.content), `image tool result must remain a block array: ${JSON.stringify(replay?.content)}`);
    const image = replay.content.find((block) => block.type === "image");
    assert.equal(image?.mimeType, "image/png");
    assert.match(image?.data ?? "", /^[A-Za-z0-9+/]+={0,2}$/);
  } finally {
    await runner?.dispose().catch(() => undefined);
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
