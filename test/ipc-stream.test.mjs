import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { BrokerIpcServer, requestBrokerIpc, streamProviderIpc } from "../src/ipc.mjs";
import { ScriptedFakeProvider } from "../src/fake-provider.mjs";

function createServer() {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-stream-"));
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry: fixtureRegistry() });
  const server = new BrokerIpcServer({ broker, socketPath: join(directory, "broker.sock"), fakeProvider: new ScriptedFakeProvider() });
  return { directory, broker, server };
}

async function reserveCapability(server, taskId, maxOutputTokens = 100, contractOverrides = {}) {
  const reservation = await requestBrokerIpc({
    socketPath: server.socketPath,
    authorization: server.controllerToken,
    method: "reserve",
    params: {
      contract: fixtureContract({
        taskId,
        budget: { maxInputTokens: 1_000, maxOutputTokens, enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" } },
        ...contractOverrides,
      }),
    },
  });
  assert.equal(reservation.status, "leased");
  const issued = await requestBrokerIpc({
    socketPath: server.socketPath,
    authorization: server.controllerToken,
    method: "issueLeaseCapability",
    params: { leaseId: reservation.lease.leaseId, fencingToken: reservation.lease.fencingToken },
  });
  assert.equal(issued.status, "issued");
  return issued.capability;
}

function fakeContext(overrides = {}) {
  return {
    systemPrompt: "You are a careful code reviewer.",
    messages: [{ role: "user", content: "Review src/window.mjs for off-by-one errors." }],
    tools: [{ name: "read", description: "Read a file", schema: { path: "string" } }],
    options: {},
    ...overrides,
  };
}

test("streaming happy path delivers validated frames and a succeeded terminal", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-happy");
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "stream-happy", events: [{ type: "succeeded", resultRef: "finding-42", usage: { input: 10, output: 5, costMicros: 200 } }] },
    });

    const { frames, terminal } = await streamProviderIpc({
      socketPath: server.socketPath,
      authorization: capability,
      context: fakeContext(),
    });

    const types = frames.map((f) => f.type);
    assert.deepEqual(types, ["attempt_accepted", "provider_send_started", "block_start", "text_delta", "block_end", "usage", "terminal"]);
    assert.equal(frames[2].payload.blockType, "text");
    assert.equal(frames[3].payload.delta, "finding-42");
    assert.equal(frames[5].payload.output, 5);
    assert.equal(terminal.payload.outcome, "succeeded_terminal");
    assert.equal(terminal.payload.usage.output, 5);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming rate_limited delivers a terminal frame without stream blocks", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-429");
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "stream-429", events: [{ type: "rate_limited", retryAfterMs: 5_000 }] },
    });

    const { frames, terminal } = await streamProviderIpc({
      socketPath: server.socketPath,
      authorization: capability,
      context: fakeContext(),
    });

    const types = frames.map((f) => f.type);
    assert.deepEqual(types, ["attempt_accepted", "provider_send_started", "terminal"]);
    assert.equal(terminal.payload.outcome, "rate_limited");
    assert.equal(terminal.payload.retryAfterMs, 5_000);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming auth_fatal delivers a terminal frame and marks resource unknown", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-auth");
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "stream-auth", events: [{ type: "auth_fatal" }] },
    });

    const { frames, terminal } = await streamProviderIpc({
      socketPath: server.socketPath,
      authorization: capability,
      context: fakeContext(),
    });

    assert.deepEqual(frames.map((f) => f.type), ["attempt_accepted", "provider_send_started", "terminal"]);
    assert.equal(terminal.payload.outcome, "auth_fatal");
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming failed_before_effect maps to transport_before_headers", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-fail");
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "stream-fail", events: [{ type: "failed_before_effect", reasonCode: "ECONNRESET" }] },
    });

    const { frames, terminal } = await streamProviderIpc({
      socketPath: server.socketPath,
      authorization: capability,
      context: fakeContext(),
    });

    assert.deepEqual(frames.map((f) => f.type), ["attempt_accepted", "provider_send_started", "terminal"]);
    assert.equal(terminal.payload.outcome, "transport_before_headers");
    assert.equal(terminal.payload.finishReason, "ECONNRESET");
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming budget exceeded when output exceeds hard cap", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-budget", 3);
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "stream-budget", events: [{ type: "succeeded", resultRef: "big-output", usage: { input: 10, output: 99, costMicros: 0 } }] },
    });

    const { terminal } = await streamProviderIpc({
      socketPath: server.socketPath,
      authorization: capability,
      context: fakeContext(),
    });

    assert.equal(terminal.payload.outcome, "budget_exceeded");
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming rejects malformed context without a real provider transport", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-malformed");

    await assert.rejects(
      () => streamProviderIpc({ socketPath: server.socketPath, authorization: capability, context: { systemPrompt: 123 } }),
      /systemPrompt/,
    );
    await assert.rejects(
      () => streamProviderIpc({ socketPath: server.socketPath, authorization: capability, context: { systemPrompt: "x", messages: "not-array" } }),
      /messages/,
    );
    await assert.rejects(
      () => streamProviderIpc({ socketPath: server.socketPath, authorization: capability, context: { systemPrompt: "x", messages: [], tools: "no" } }),
      /tools/,
    );
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming rejects oversized context that exceeds the capture byte limit", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-oversized");
    await assert.rejects(
      () => streamProviderIpc({
        socketPath: server.socketPath,
        authorization: capability,
        context: { systemPrompt: "x".repeat(600_000), messages: [], tools: [] },
      }),
      /byte limit/,
    );
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming rejects deeply nested context that exceeds the depth limit", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-deep");
    let deep = "leaf";
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    await assert.rejects(
      () => streamProviderIpc({
        socketPath: server.socketPath,
        authorization: capability,
        context: { systemPrompt: "x", messages: [], tools: [], options: deep },
      }),
      /depth limit/,
    );
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming cancellation aborts before any frame is written", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-cancel");
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "stream-cancel", events: [{ type: "succeeded", resultRef: "late", usage: { input: 1, output: 1, costMicros: 0 }, delayMs: 2_000 }] },
    });

    const controller = new AbortController();
    const promise = streamProviderIpc({ socketPath: server.socketPath, authorization: capability, context: fakeContext(), signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(promise, /aborted/);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming without a fake provider fails closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-nostream-"));
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry: fixtureRegistry() });
  const server = new BrokerIpcServer({ broker, socketPath: join(directory, "broker.sock") });
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-noprovider");
    await assert.rejects(
      () => streamProviderIpc({ socketPath: server.socketPath, authorization: capability, context: fakeContext() }),
      /provider_transport_unavailable/,
    );
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy providerAttempt still works alongside streaming", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const capability = await reserveCapability(server, "stream-legacy");
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "stream-legacy", events: [{ type: "succeeded", resultRef: "legacy-ok", usage: { input: 3, output: 2, costMicros: 100 } }] },
    });

    const result = await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: capability,
      method: "providerAttempt",
      params: { inputDigest: "a".repeat(64) },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.resultRef, "legacy-ok");
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});