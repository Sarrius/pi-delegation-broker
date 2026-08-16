import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLeaseBroker, fixtureContract, fixtureRegistry } from "../src/broker.mjs";
import { createEffectiveChildCapability, deriveAllowedTools } from "../src/capability-compiler.mjs";
import { BrokerIpcServer, requestBrokerIpc } from "../src/ipc.mjs";

function createServer() {
  const directory = mkdtempSync(join(tmpdir(), "behavioral-ipc-"));
  const broker = new SqliteLeaseBroker({ path: join(directory, "broker.sqlite"), registry: fixtureRegistry() });
  const server = new BrokerIpcServer({ broker, socketPath: join(directory, "broker.sock") });
  return { directory, broker, server };
}

async function issueBoundCapability(server, taskId) {
  const contract = fixtureContract({ taskId });
  const reservation = await requestBrokerIpc({
    socketPath: server.socketPath,
    authorization: server.controllerToken,
    method: "reserve",
    params: { contract },
  });
  assert.equal(reservation.status, "leased");
  const lease = reservation.lease;
  const capability = createEffectiveChildCapability({
    schemaVersion: 1,
    taskId,
    operationClass: contract.operationClass,
    admissionClass: contract.admissionClass,
    doneWhen: contract.doneWhen,
    allowedTools: deriveAllowedTools(contract.operationClass),
    profileSupports: contract.capability.required,
    budget: {
      maxInputTokens: lease.maxInputTokens,
      maxOutputTokens: lease.maxOutputTokens,
      ...(lease.maxCostMicros === undefined ? {} : { maxCostMicros: lease.maxCostMicros }),
      enforcement: lease.enforcement,
    },
    latencyBudgetMs: contract.latencyBudgetMs,
    leaseTtlMs: contract.leaseTtlMs,
    promptDigest: contract.promptDigest,
    behavioralEnforcement: lease.behavioralEnforcement,
    downgradePolicy: contract.capability.downgradePolicy,
  });
  const bound = await requestBrokerIpc({
    socketPath: server.socketPath,
    authorization: server.controllerToken,
    method: "bindEffectiveChildCapability",
    params: { leaseId: lease.leaseId, fencingToken: lease.fencingToken, capability },
  });
  assert.deepEqual(bound, { status: "bound", capabilityFingerprint: capability.capabilityFingerprint });
  const issued = await requestBrokerIpc({
    socketPath: server.socketPath,
    authorization: server.controllerToken,
    method: "issueLeaseCapability",
    params: { leaseId: lease.leaseId, fencingToken: lease.fencingToken },
  });
  assert.equal(issued.status, "issued");
  return { capability, lease, childAuthorization: issued.capability };
}

async function childRequest(server, authorization, method, params = {}) {
  return requestBrokerIpc({ socketPath: server.socketPath, authorization, method, params });
}

test("controller binds the only capability a child can retrieve, then centrally gates and observes tools", async () => {
  const { directory, broker, server } = createServer();
  await server.start();
  try {
    const issued = await issueBoundCapability(server, "behavioral-observed");
    const loaded = await childRequest(server, issued.childAuthorization, "getEffectiveChildCapability");
    assert.equal(loaded.status, "bound");
    assert.equal(loaded.capability.capabilityFingerprint, issued.capability.capabilityFingerprint);
    assert.deepEqual(loaded.capability.allowedTools, issued.capability.allowedTools);
    await assert.rejects(
      () => childRequest(server, issued.childAuthorization, "bindEffectiveChildCapability", {
        leaseId: issued.lease.leaseId, fencingToken: issued.lease.fencingToken, capability: issued.capability,
      }),
      /unauthorized/,
      "a child can retrieve but cannot replace its controller-bound capability",
    );

    const declared = await childRequest(server, issued.childAuthorization, "declareBehavioralAction", {
      stepId: "declare-1", toolName: "read", args: { path: "src/index.mjs" },
    });
    assert.equal(declared.status, "declared");
    const authorized = await childRequest(server, issued.childAuthorization, "authorizeBehavioralAction", {
      stepId: "declare-1", toolName: "read", args: { path: "src/index.mjs" },
    });
    assert.deepEqual(authorized.status, "allowed");
    const observation = await childRequest(server, issued.childAuthorization, "observeBehavioralResult", {
      toolName: "read", args: { path: "src/index.mjs" }, result: { text: "const answer = 42;" }, isError: false,
    });
    assert.deepEqual(observation, { status: "progress_observed", repeated: 1 });

    const events = broker.events();
    assert.equal(events.filter((event) => event.type === "BehavioralEvent").length, 3);
    assert.equal(events.some((event) => event.type === "ProviderEvent" && event.payload.event?.type === "behavioral_tool_result"), false);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("central behavioral monitor blocks undeclared and unauthorized calls and terminates repeated no-progress", async () => {
  const { directory, server } = createServer();
  await server.start();
  try {
    const issued = await issueBoundCapability(server, "behavioral-blocks");
    const undeclared = await childRequest(server, issued.childAuthorization, "authorizeBehavioralAction", {
      stepId: "missing", toolName: "read", args: { path: "src/index.mjs" },
    });
    assert.equal(undeclared.status, "reasoning_action_mismatch");
    assert.equal(undeclared.block, true);
    assert.equal(undeclared.terminate, true, "the default one-mismatch policy makes an undeclared tool terminal");
    await requestBrokerIpc({
      socketPath: server.socketPath, authorization: server.controllerToken, method: "release",
      params: { leaseId: issued.lease.leaseId, fencingToken: issued.lease.fencingToken },
    });

    const second = await issueBoundCapability(server, "behavioral-repeat");
    for (const stepId of ["repeat-1", "repeat-2"]) {
      await childRequest(server, second.childAuthorization, "declareBehavioralAction", {
        stepId, toolName: "read", args: { path: "README.md" },
      });
      const allowed = await childRequest(server, second.childAuthorization, "authorizeBehavioralAction", {
        stepId, toolName: "read", args: { path: "README.md" },
      });
      assert.equal(allowed.status, "allowed");
      const observed = await childRequest(server, second.childAuthorization, "observeBehavioralResult", {
        toolName: "read", args: { path: "README.md" }, result: { text: "same" }, isError: false,
      });
      assert.equal(observed.status, "progress_observed");
    }
    await childRequest(server, second.childAuthorization, "declareBehavioralAction", {
      stepId: "repeat-3", toolName: "read", args: { path: "README.md" },
    });
    await childRequest(server, second.childAuthorization, "authorizeBehavioralAction", {
      stepId: "repeat-3", toolName: "read", args: { path: "README.md" },
    });
    const terminal = await childRequest(server, second.childAuthorization, "observeBehavioralResult", {
      toolName: "read", args: { path: "README.md" }, result: { text: "same" }, isError: false,
    });
    assert.equal(terminal.status, "no_progress");
    assert.equal(terminal.terminate, true);
    await requestBrokerIpc({
      socketPath: server.socketPath, authorization: server.controllerToken, method: "release",
      params: { leaseId: second.lease.leaseId, fencingToken: second.lease.fencingToken },
    });

    const third = await issueBoundCapability(server, "behavioral-disallowed");
    const disallowed = await childRequest(server, third.childAuthorization, "authorizeBehavioralAction", {
      stepId: "bad-tool", toolName: "write", args: { path: "oops", content: "no" },
    });
    assert.equal(disallowed.status, "tool_not_allowed");
    assert.equal(disallowed.block, true);
    assert.equal(disallowed.terminate, true);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
