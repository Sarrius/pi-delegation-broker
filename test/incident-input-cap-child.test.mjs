import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fixtureRegistry } from "../src/broker.mjs";
import { BrokeredChildRunner } from "../src/brokered-runner.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";
import { createSelectContract } from "../src/model-selector.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";

const CONTROLLER_TOKEN = "incident-child-controller-token-123456789012";
const SHIM_PATH = new URL("../extensions/child-shim.ts", import.meta.url).pathname;
const PROXY_PATH = new URL("../extensions/controller-provider-proxy.ts", import.meta.url).pathname;
const BEHAVIOR_PATH = new URL("../extensions/pi-behavioral-enforcement.ts", import.meta.url).pathname;

const SMALL_CAP = 3_000;
const SMALL_BYTES = 8_000;
const INCIDENT_USED = 804_330;
const INCIDENT_BYTES = 236_663;
const INCIDENT_CAP = 1_000_000;
const INCIDENT_TURN_INPUT = 43_630;
const INCIDENT_TURN_OUTPUT = 453;
const MARKER = "INCIDENT_CHILD_OK";

function testRegistry() {
  const registry = fixtureRegistry();
  registry.profiles["canary-text/v1"] = {
    status: "approved",
    supports: ["text_generation", "code_reasoning", "repo_navigation"],
  };
  registry.resources.R1 = {
    ...registry.resources.R1,
    capacityGroup: "G-cheap",
    profile: "canary-text/v1",
    model: { provider: "fixture", modelId: "fixture-model" },
  };
  return registry;
}

function fixtureRoute() {
  return {
    registryFingerprint: "a".repeat(64),
    registryVersion: 1,
    accountAlias: "fixture",
    provider: "fixture",
    model: "fixture-model",
    reasoningEffort: "off",
    apiDialect: "fixture",
    endpointId: "fixture-incident-child",
    adapterId: "fixture-adapter",
    credentialRefFingerprint: "b".repeat(64),
    cacheRetention: "none",
  };
}

async function runIncidentChild({ enforcement, prompt, cap, seedIncidentTurns = false }) {
  const root = mkdtempSync(join(tmpdir(), "ic-"));
  writeFileSync(join(root, "probe.txt"), "INCIDENT_PROBE\n", { mode: 0o600 });
  let dispatches = 0;
  const providerTransport = {
    async *stream(_snapshot, context, { onSendStarted }) {
      dispatches += 1;
      onSendStarted();
      yield { type: "headers", payload: { httpStatus: 200, providerRequestId: `incident-child-${dispatches}` } };
      const replay = context.messages?.some((message) => message.role === "toolResult");
      if (seedIncidentTurns && !replay) {
        yield { type: "block_start", payload: { index: 0, blockType: "tool_call", id: "call_1", name: "read" } };
        yield { type: "tool_call_delta", payload: { index: 0, delta: '{"path":"probe.txt"}' } };
        yield { type: "block_end", payload: { index: 0, value: '{"path":"probe.txt"}' } };
        yield {
          type: "terminal",
          outcome: "succeeded_terminal",
          payload: { finishReason: "tool_use", usage: { input: INCIDENT_USED, output: 100 } },
        };
        return;
      }
      yield { type: "block_start", payload: { index: 0, blockType: "text" } };
      yield { type: "text_delta", payload: { index: 0, delta: MARKER } };
      yield { type: "block_end", payload: { index: 0, value: MARKER } };
      yield {
        type: "terminal",
        outcome: "succeeded_terminal",
        payload: {
          finishReason: "stop",
          usage: {
            input: seedIncidentTurns ? INCIDENT_TURN_INPUT : 80,
            output: seedIncidentTurns ? INCIDENT_TURN_OUTPUT : 5,
          },
        },
      };
    },
  };
  const registry = testRegistry();
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: join(root, "broker"),
    registry,
    allowUnsignedFixture: true,
    controllerToken: CONTROLLER_TOKEN,
    providerTransport,
    routeResolver: async () => fixtureRoute(),
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
        trustedExtensionDigests: extensionPaths.map((path) =>
          createHash("sha256").update(readFileSync(path)).digest("hex")),
      },
      controllerProxy: { providerId: "broker-proxy" },
      resolveModelForResource: () => ({ provider: "fixture", modelId: "fixture-model" }),
      selectContract: createSelectContract({
        registry,
        availability: () => supervisor.inventory(),
        currency: () => ({}),
        constraints: { budget: { maxInputTokens: cap, maxOutputTokens: seedIncidentTurns ? 16_000 : 128, enforcement } },
      }),
    });
    const runner = new BrokeredChildRunner({ resolver, sessionsRoot: join(root, "sessions") });
    const result = await runner.run({
      childId: `ic-${enforcement.input === "hard" ? "h" : "m"}`,
      prompt,
      promptDigest: createHash("sha256").update(prompt).digest("hex"),
      cwd: root,
      thinkingLevel: "off",
      ...(seedIncidentTurns ? { tools: ["read"] } : {}),
      capabilityRequest: {
        taskDescription: "reply with one exact marker and do not edit files",
        operationClass: "observe",
        requiredCapabilities: ["text_generation"],
        budget: { maxInputTokens: cap, maxOutputTokens: seedIncidentTurns ? 16_000 : 128, maxAttempts: 1, enforcement },
      },
    });
    const resource = supervisor.inventory().find((row) => row.resourceId === "R1");
    await runner.dispose();
    return { result, dispatches, resource };
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

test("observe Pi child: UTF-8 reservation over remaining tokens hard-denies and metered-sends", async () => {
  const prompt = `${"x".repeat(SMALL_BYTES)}\nReply with exactly ${MARKER} and nothing else.`;
  const hard = await runIncidentChild({
    enforcement: { input: "hard", output: "hard" },
    prompt,
    cap: SMALL_CAP,
  });
  assert.equal(hard.resource.enforcement.input, "hard");
  assert.equal(hard.result.status, "failed", hard.result.error ?? hard.result.text);
  assert.match(hard.result.error ?? "", /used=0|input_budget_exceeded|budget_exceeded/);
  assert.match(hard.result.error ?? "", /cap=3000|3000/);
  assert.equal(hard.dispatches, 0, "hard must not reach the provider");

  const metered = await runIncidentChild({
    enforcement: { input: "metered_best_effort", output: "hard" },
    prompt,
    cap: SMALL_CAP,
  });
  assert.equal(metered.resource.enforcement.input, "hard", "catalog ceiling stays hard");
  assert.equal(metered.result.status, "completed", metered.result.error ?? metered.result.text);
  assert.equal(metered.result.text.trim(), MARKER);
  assert.ok(metered.dispatches >= 1, "metered must send the oversized UTF-8 payload");
});

test("observe Pi child: incident used=804330 requested=236663 cap=1000000 hard-denies the next turn and metered-sends", async () => {
  const prompt = `${"x".repeat(INCIDENT_BYTES)}\nUse the read tool on probe.txt, then reply with exactly ${MARKER} and nothing else.`;
  const hard = await runIncidentChild({
    enforcement: { input: "hard", output: "hard" },
    prompt,
    cap: INCIDENT_CAP,
    seedIncidentTurns: true,
  });
  assert.equal(hard.resource.enforcement.input, "hard");
  assert.equal(hard.result.status, "failed", hard.result.error ?? hard.result.text);
  assert.match(hard.result.error ?? "", /used=804330/);
  assert.match(hard.result.error ?? "", /cap=1000000/);
  const requested = Number(/requested=(\d+)/.exec(hard.result.error ?? "")?.[1]);
  assert.ok(requested > INCIDENT_CAP - INCIDENT_USED, `requested=${requested}`);
  assert.equal(hard.dispatches, 1, "hard may complete the seeded turn, then must deny the next send");

  const metered = await runIncidentChild({
    enforcement: { input: "metered_best_effort", output: "hard" },
    prompt,
    cap: INCIDENT_CAP,
    seedIncidentTurns: true,
  });
  assert.equal(metered.resource.enforcement.input, "hard", "catalog ceiling stays hard");
  assert.equal(metered.result.status, "completed", metered.result.error ?? metered.result.text);
  assert.equal(metered.result.text.trim(), MARKER);
  assert.equal(metered.dispatches, 2, "metered must send the seeded turn and the oversized follow-up");
});
