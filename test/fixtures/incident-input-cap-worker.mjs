#!/usr/bin/env node
/**
 * Fresh Node process: the exact workflow-mtmzxk2i-4-evidence-audit arithmetic
 * through the real controller proxy. This is not a live Pi session and spends
 * no provider quota. Hard input must deny before dispatch; metered input must
 * send and reconcile to the observed prompt tokens.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../../src/broker.mjs";
import { createEffectiveChildCapability } from "../../src/capability-compiler.mjs";
import { BrokerIpcServer, requestBrokerIpc, streamProviderIpc } from "../../src/ipc.mjs";
import { ANTHROPIC_MESSAGES_ADAPTER_ID, AnthropicMessagesTransport } from "../../src/anthropic-messages-transport.mjs";

const USED = 804_330;
const BYTE_RESERVATION = 236_663;
const CAP = 1_000_000;
const OBSERVED_INPUT = 43_630;
const OBSERVED_OUTPUT = 453;

function realContext(overrides = {}) {
  return {
    systemPrompt: "You are a careful code reviewer.",
    messages: [{ role: "user", content: "Review src/window.mjs for off-by-one errors." }],
    tools: [{
      name: "read",
      description: "Read one bounded file",
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
    }],
    ...overrides,
  };
}

function anthropicSse(events) {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req-incident-1" } });
}

function realRoute() {
  return {
    registryFingerprint: "a".repeat(64),
    registryVersion: 1,
    accountAlias: "anthropic-a1",
    provider: "anthropic",
    model: "claude-test",
    reasoningEffort: null,
    apiDialect: "anthropic-messages",
    endpointId: "anthropic-primary",
    adapterId: ANTHROPIC_MESSAGES_ADAPTER_ID,
    credentialRefFingerprint: "b".repeat(64),
    cacheRetention: "long",
  };
}

function createRealServer(fetchImpl) {
  const directory = mkdtempSync(join(tmpdir(), "incident-input-cap-"));
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry: fixtureRegistry() });
  const providerTransport = new AnthropicMessagesTransport({
    credentialResolver: async () => ({ apiKey: "exact-test-key" }),
    endpointResolver: async () => "https://gateway.example/v1/messages",
    fetchImpl,
  });
  const server = new BrokerIpcServer({
    broker,
    socketPath: join(directory, "broker.sock"),
    providerTransport,
    routeResolver: async () => realRoute(),
  });
  return { directory, broker, server };
}

async function reserveCapability(server, taskId, enforcement) {
  const contract = fixtureContract({
    taskId,
    budget: { maxInputTokens: CAP, maxOutputTokens: 16_000, enforcement },
  });
  const reservation = await requestBrokerIpc({
    socketPath: server.socketPath,
    authorization: server.controllerToken,
    method: "reserve",
    params: { contract },
  });
  assert.equal(reservation.status, "leased", JSON.stringify(reservation));
  const issued = await requestBrokerIpc({
    socketPath: server.socketPath,
    authorization: server.controllerToken,
    method: "issueLeaseCapability",
    params: { leaseId: reservation.lease.leaseId, fencingToken: reservation.lease.fencingToken },
  });
  assert.equal(issued.status, "issued");
  const bound = await requestBrokerIpc({
    socketPath: server.socketPath,
    authorization: server.controllerToken,
    method: "bindEffectiveChildCapability",
    params: {
      leaseId: reservation.lease.leaseId,
      fencingToken: reservation.lease.fencingToken,
      capability: createEffectiveChildCapability({
        schemaVersion: 1,
        taskId,
        operationClass: contract.operationClass,
        admissionClass: contract.admissionClass,
        doneWhen: contract.doneWhen,
        allowedTools: ["read"],
        profileSupports: contract.capability.required,
        budget: contract.budget,
        latencyBudgetMs: contract.latencyBudgetMs,
        leaseTtlMs: contract.leaseTtlMs,
        promptDigest: contract.promptDigest,
        behavioralEnforcement: reservation.lease.behavioralEnforcement,
        downgradePolicy: contract.capability.downgradePolicy,
      }),
    },
  });
  assert.equal(bound.status, "bound");
  return issued.capability;
}

function seedObservedUsage(broker) {
  const [lease] = broker.leases();
  const now = Date.now();
  assert.equal(broker.reserveProviderInput(lease.leaseId, lease.fencingToken, USED, now).status, "reserved");
  assert.deepEqual(
    broker.recordProviderUsage(lease.leaseId, lease.fencingToken, { input: USED, output: 7_301 }, now, {
      inputReserved: true,
      reservedInputUpperBound: USED,
    }),
    { status: "recorded", inputTokensUsed: USED, outputTokensUsed: 7_301 },
  );
}

async function withProxy(enforcement, verify) {
  let dispatches = 0;
  const { directory, broker, server } = createRealServer(async () => {
    dispatches += 1;
    return anthropicSse([
      { event: "message_start", data: { message: { usage: { input_tokens: OBSERVED_INPUT } } } },
      { event: "content_block_start", data: { index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "ok" } } },
      { event: "content_block_stop", data: { index: 0 } },
      { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: OBSERVED_OUTPUT } } },
      { event: "message_stop", data: {} },
    ]);
  });
  await server.start();
  try {
    const capability = await reserveCapability(server, `incident-worker-${enforcement.input}`, enforcement);
    seedObservedUsage(broker);
    await verify({ server, capability, dispatches: () => dispatches });
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

const incidentContext = realContext({ systemPrompt: "x".repeat(BYTE_RESERVATION) });

await withProxy({ input: "hard", output: "hard" }, async ({ server, capability, dispatches }) => {
  await assert.rejects(
    () => streamProviderIpc({ socketPath: server.socketPath, authorization: capability, context: incidentContext }),
    (error) => {
      assert.match(error.message, /used=804330/);
      assert.match(error.message, /cap=1000000/);
      const requested = Number(/requested=(\d+)/.exec(error.message)?.[1]);
      assert.ok(requested > CAP - USED, `requested=${requested}`);
      return true;
    },
  );
  assert.equal(dispatches(), 0);
});

await withProxy({ input: "metered_best_effort", output: "hard" }, async ({ server, capability, dispatches }) => {
  const result = await streamProviderIpc({
    socketPath: server.socketPath,
    authorization: capability,
    context: incidentContext,
  });
  assert.equal(result.terminal.payload.outcome, "succeeded_terminal");
  assert.equal(dispatches(), 1);
});

process.stdout.write("PASS: incident 804330/236663/1000000 hard-denies and metered-sends in a fresh process\n");
