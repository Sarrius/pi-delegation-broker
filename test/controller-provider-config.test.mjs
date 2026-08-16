import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControllerAccountInventory,
  ControllerCredentialStore,
  ControllerLiveProviderApproval,
  ControllerRouteTable,
  createApprovedAnthropicProviderRoute,
  loadControllerRouteConfiguration,
} from "../src/controller-provider-config.mjs";
import { ANTHROPIC_MESSAGES_ADAPTER_ID } from "../src/anthropic-messages-transport.mjs";
import { fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { requestBrokerIpc, streamProviderIpc } from "../src/ipc.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { createAttemptRouteSnapshot } from "../src/provider-protocol.mjs";
import { fixtureCatalog } from "../src/provider-catalog.mjs";

const ZERO64 = "0".repeat(64);

function routes(overrides = {}) {
  return [{
    resourceId: "R1",
    capacityGroup: "G-shared",
    profile: "reasoning-high/v1",
    accountAlias: "anthropic-a1",
    provider: "anthropic",
    model: "claude-test",
    reasoningEffort: null,
    apiDialect: "anthropic-messages",
    endpointId: "anthropic-primary",
    endpoint: "https://gateway.example/v1/messages",
    adapterId: ANTHROPIC_MESSAGES_ADAPTER_ID,
    credentialRef: "anthropic-primary-key",
    cacheRetention: "short",
    ...overrides,
  }];
}

function table(options = {}) {
  return new ControllerRouteTable({ registryFingerprint: ZERO64, registryVersion: 1, routes: routes(), ...options });
}

function lease() {
  return { resourceId: "R1", capacityGroup: "G-shared", profile: "reasoning-high/v1" };
}

function context() {
  return {
    systemPrompt: "Carefully respond.",
    messages: [{ role: "user", content: "Say done." }],
    tools: [],
  };
}

function sseSuccess() {
  const events = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

test("controller credential store and route table resolve one exact credential-free route", async () => {
  const credentials = new ControllerCredentialStore({ entries: [{ credentialRef: "anthropic-primary-key", apiKey: "sk-controller-only-test-key" }] });
  const routeTable = table();
  const route = routeTable.resolveForLease(lease(), credentials);
  assert.equal(route.accountAlias, "anthropic-a1");
  assert.equal(route.credentialRefFingerprint, credentials.status()[0].credentialRefFingerprint);
  assert.equal(routeTable.endpointFor(route), "https://gateway.example/v1/messages");
  assert.deepEqual(routeTable.credentialFor(route, credentials), { apiKey: "sk-controller-only-test-key" });
  assert.equal(routeTable.credentialFor({ ...route, model: "other" }, credentials), undefined);
  assert.throws(() => routeTable.resolveForLease({ ...lease(), profile: "other" }, credentials), /not bound/);
  assert.equal(JSON.stringify(routeTable.routes()).includes("sk-controller-only-test-key"), false);

  let now = 1_000;
  const approval = new ControllerLiveProviderApproval({ routeTableFingerprint: routeTable.fingerprint, expiresAt: 2_000, now: () => now });
  let sends = 0;
  const approved = createApprovedAnthropicProviderRoute({
    routeTable, credentialStore: credentials, liveApproval: approval,
    fetchImpl: async () => { sends += 1; return sseSuccess(); }, now: () => now,
  });
  const snapshot = createAttemptRouteSnapshot({
    schemaVersion: 1, controllerEpoch: "epoch-1", attemptId: "attempt-1", streamId: "stream-1",
    taskId: "task-1", leaseId: "lease-1", fencingToken: 1, resourceId: "R1", capacityGroup: "G-shared",
    ...route, retryOwner: "broker", sdkMaxRetries: 0, deadlineAt: 2_000,
    maxInputBytes: 1024, maxOutputBytes: 1024, maxOutputTokens: 100, maxCostMicros: 100,
  });
  const events = await Array.fromAsync(approved.providerTransport.stream(snapshot, context(), { onSendStarted() {} }));
  assert.equal(events.at(-1).outcome, "succeeded_terminal");
  assert.equal(sends, 1);
  await assert.rejects(() => Array.fromAsync(approved.providerTransport.stream(snapshot, context())), /live_provider_approval_unavailable/);
  now = 2_000;
  assert.equal(approval.status().remaining, 0);
});

test("approved route pair is the sole real transport accepted by the controller supervisor", async () => {
  const root = mkdtempSync(join(tmpdir(), "ap-"));
  const credentials = new ControllerCredentialStore({ entries: [{ credentialRef: "anthropic-primary-key", apiKey: "controller-test-key" }] });
  const routeTable = table();
  const approval = new ControllerLiveProviderApproval({ routeTableFingerprint: routeTable.fingerprint, expiresAt: Date.now() + 30_000 });
  let sent = 0;
  const approved = createApprovedAnthropicProviderRoute({
    routeTable, credentialStore: credentials, liveApproval: approval,
    fetchImpl: async (url, options) => {
      sent += 1;
      assert.equal(url, "https://gateway.example/v1/messages");
      assert.equal(options.headers["x-api-key"], "controller-test-key");
      return sseSuccess();
    },
  });
  const supervisor = new SingleHostBrokerSupervisor({
    stateDir: root, registry: fixtureRegistry(), allowUnsignedFixture: true,
    controllerToken: "p".repeat(48), ...approved,
  });
  try {
    await supervisor.start();
    const reservation = await requestBrokerIpc({
      socketPath: supervisor.socketPath, authorization: supervisor.controllerToken, method: "reserve",
      params: { contract: fixtureContract({ taskId: "approved-real-path" }) },
    });
    const capability = await requestBrokerIpc({
      socketPath: supervisor.socketPath, authorization: supervisor.controllerToken, method: "issueLeaseCapability",
      params: { leaseId: reservation.lease.leaseId, fencingToken: reservation.lease.fencingToken },
    });
    const result = await streamProviderIpc({ socketPath: supervisor.socketPath, authorization: capability.capability, context: context() });
    assert.equal(result.terminal.payload.outcome, "succeeded_terminal");
    assert.equal(sent, 1);
    assert.equal(supervisor.auditSnapshot().leases.length, 1, "provider success does not turn child output into task completion");
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("route configuration is owner-only, has no secret field, and inventory is observed not authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "controller-route-config-"));
  const configPath = join(root, "routes.json");
  try {
    writeFileSync(configPath, JSON.stringify({ registryFingerprint: ZERO64, registryVersion: 1, routes: routes() }), { mode: 0o600 });
    const loaded = loadControllerRouteConfiguration(configPath);
    assert.equal(loaded.routes()[0].credentialRef, "anthropic-primary-key");
    chmodSync(configPath, 0o644);
    assert.throws(() => loadControllerRouteConfiguration(configPath), /owner-only/);

    const inventory = new ControllerAccountInventory({ readCatalog: async () => fixtureCatalog(), now: () => 123 });
    const observed = await inventory.refresh();
    assert.equal(observed.capturedAt, 123);
    assert.equal(observed.registryCandidate.resources["fake-anthropic"].confidence, "observed");
    assert.equal(Object.hasOwn(observed, "credential"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller route config rejects fallback-like ambiguity and secrets", () => {
  assert.throws(() => table({ routes: [...routes(), { ...routes()[0], accountAlias: "second", endpointId: "second" }] }), /unique/);
  assert.throws(() => new ControllerCredentialStore({ entries: [{ credentialRef: "bad", apiKey: "x\nkey" }] }), /apiKey/);
  assert.throws(() => table({ routes: routes({ endpoint: "https://key:secret@gateway.example/v1/messages" }) }), /credential-free/);
  assert.throws(() => table({ routes: routes({ adapterId: "other" }) }), /approved Anthropic/);
});
