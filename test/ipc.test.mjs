import assert from "node:assert/strict";
import test from "node:test";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { BrokerIpcServer, requestBrokerIpc } from "../src/ipc.mjs";
import { ScriptedFakeProvider } from "../src/fake-provider.mjs";

function createServer() {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-ipc-"));
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
        budget: {
          maxOutputTokens,
          enforcement: { input: "hard", output: "hard", cost: "metered_best_effort" },
        },
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
  return { reservation, issued };
}

test("IPC gives child only a lease-scoped capability, not controller authority", async () => {
  const { directory, broker, server } = createServer();
  await server.start();
  try {
    assert.equal(lstatSync(server.socketPath).mode & 0o077, 0);
    await assert.rejects(
      () => requestBrokerIpc({ socketPath: server.socketPath, authorization: "wrong", method: "reserve", params: { contract: fixtureContract() } }),
      /unauthorized/,
    );

    const { reservation, issued } = await reserveCapability(server, "ipc-task");
    assert.match(issued.capability, /^[A-Za-z0-9_-]{40,}$/);

    const heartbeated = await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: issued.capability,
      method: "heartbeat",
      params: { ttlMs: 1_000 },
    });
    assert.equal(heartbeated.status, "leased");

    await assert.rejects(
      () => requestBrokerIpc({ socketPath: server.socketPath, authorization: issued.capability, method: "reserve", params: { contract: fixtureContract() } }),
      /unauthorized/,
    );
    await assert.rejects(
      () => requestBrokerIpc({ socketPath: server.socketPath, authorization: "wrong", method: "heartbeat" }),
      /unauthorized/,
    );

    const released = await requestBrokerIpc({ socketPath: server.socketPath, authorization: issued.capability, method: "release" });
    assert.equal(released.status, "released");
    await assert.rejects(
      () => requestBrokerIpc({ socketPath: server.socketPath, authorization: issued.capability, method: "heartbeat" }),
      /unauthorized/,
    );

    const serializedLedger = JSON.stringify(broker.events());
    assert.equal(serializedLedger.includes(issued.capability), false);
    assert.equal(serializedLedger.includes(server.controllerToken), false);
  } finally {
    await server.stop();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("IPC without an explicitly supplied provider transport fails closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "delegation-broker-ipc-no-provider-"));
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry: fixtureRegistry() });
  const server = new BrokerIpcServer({ broker, socketPath: join(directory, "broker.sock") });
  try {
    await server.start();
    const { issued } = await reserveCapability(server, "no-provider");
    await assert.rejects(
      () => requestBrokerIpc({
        socketPath: server.socketPath,
        authorization: issued.capability,
        method: "providerAttempt",
        params: { inputDigest: "f".repeat(64) },
      }),
      /provider_transport_unavailable/,
    );
    assert.equal(broker.events().some((event) => event.type === "ProviderEvent"), false);
  } finally {
    await server.stop();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scripted fake provider reports only classified outcomes and enforces a hard output cap", async () => {
  const { directory, broker, server } = createServer();
  const digest = "a".repeat(64);
  try {
    await server.start();
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "success", events: [{ type: "succeeded", resultRef: "result-1", usage: { input: 3, output: 7, costMicros: 2 } }] },
    });
    const success = await reserveCapability(server, "success", 10);
    const completed = await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: success.issued.capability,
      method: "providerAttempt",
      params: { inputDigest: digest },
    });
    assert.deepEqual(completed, { status: "succeeded", resultRef: "result-1", usage: { input: 3, output: 7, costMicros: 2 } });
    await requestBrokerIpc({ socketPath: server.socketPath, authorization: success.issued.capability, method: "release" });

    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "over-cap", events: [{ type: "succeeded", resultRef: "result-2", usage: { input: 1, output: 11, costMicros: 0 } }] },
    });
    const overCap = await reserveCapability(server, "over-cap", 10);
    const stopped = await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: overCap.issued.capability,
      method: "providerAttempt",
      params: { inputDigest: digest },
    });
    assert.deepEqual(stopped, { status: "budget_exceeded", maxOutputTokens: 10 });
    await assert.rejects(
      () => requestBrokerIpc({ socketPath: server.socketPath, authorization: overCap.issued.capability, method: "heartbeat" }),
      /unauthorized/,
    );

    const serializedLedger = JSON.stringify(broker.events());
    assert.equal(serializedLedger.includes("raw user prompt"), false);
    assert.equal(serializedLedger.includes(digest), true);
  } finally {
    await server.stop();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("aborting a delayed fake IPC attempt consumes no outcome or telemetry", async () => {
  const { directory, broker, server } = createServer();
  try {
    await server.start();
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: {
        taskId: "abort-before-effect",
        events: [{ type: "succeeded", resultRef: "still-pending", delayMs: 500, usage: { input: 1, output: 1, costMicros: 0 } }],
      },
    });
    const { issued } = await reserveCapability(server, "abort-before-effect");
    const abort = new AbortController();
    const pending = requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: issued.capability,
      method: "providerAttempt",
      params: { inputDigest: "c".repeat(64) },
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 30);
    await assert.rejects(() => pending, /aborted/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(broker.events().filter((event) => event.type === "ProviderEvent").length, 0);

    // The exact same capability is still live and obtains the unconsumed
    // scripted success, proving cancellation happened before fake effect.
    const completed = await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: issued.capability,
      method: "providerAttempt",
      params: { inputDigest: "c".repeat(64) },
    });
    assert.equal(completed.resultRef, "still-pending");
    assert.equal(broker.events().filter((event) => event.type === "ProviderEvent").length, 1);
  } finally {
    await server.stop();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a fake result arriving after lease TTL is not recorded or returned", async () => {
  const { directory, broker, server } = createServer();
  try {
    await server.start();
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: {
        taskId: "expire-during-attempt",
        events: [{ type: "succeeded", resultRef: "late-must-not-return", delayMs: 350, usage: { input: 1, output: 1, costMicros: 0 } }],
      },
    });
    const { issued } = await reserveCapability(server, "expire-during-attempt", 100, { leaseTtlMs: 200 });
    await assert.rejects(
      () => requestBrokerIpc({
        socketPath: server.socketPath,
        authorization: issued.capability,
        method: "providerAttempt",
        params: { inputDigest: "d".repeat(64) },
      }),
      /lease no longer active/,
    );
    assert.equal(broker.events().filter((event) => event.type === "ProviderEvent").length, 0);
    broker.expire(Date.now());
    assert.equal(broker.leases().length, 0);
  } finally {
    await server.stop();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scripted 429 releases the lease and cools its capacity group", async () => {
  const { directory, broker, server } = createServer();
  try {
    await server.start();
    await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: server.controllerToken,
      method: "configureFakeProvider",
      params: { taskId: "rate", events: [{ type: "rate_limited", retryAfterMs: 60_000 }] },
    });
    const first = await reserveCapability(server, "rate");
    const result = await requestBrokerIpc({
      socketPath: server.socketPath,
      authorization: first.issued.capability,
      method: "providerAttempt",
      params: { inputDigest: "b".repeat(64) },
    });
    assert.equal(result.status, "rate_limited");
    await assert.rejects(
      () => requestBrokerIpc({ socketPath: server.socketPath, authorization: first.issued.capability, method: "heartbeat" }),
      /unauthorized/,
    );
    const replacement = await reserveCapability(server, "replacement");
    assert.equal(replacement.reservation.lease.resourceId, "R2");
  } finally {
    await server.stop();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
