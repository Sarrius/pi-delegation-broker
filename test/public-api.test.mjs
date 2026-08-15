import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../src/index.mjs";
import * as testing from "../src/testing.mjs";

test("public API excludes test fixtures and exposes fake transport only through the testing subpath", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "ArtifactPipeline",
    "AttemptSettlement",
    "BehavioralRunMonitor",
    "BrokerIpcServer",
    "BrokeredLaunchResolver",
    "ControllerEvidenceStore",
    "OUTCOME_PROPERTIES",
    "PROVIDER_PROTOCOL_VERSION",
    "ProviderProtocolError",
    "ProviderStreamAssembler",
    "SingleHostBrokerSupervisor",
    "SqliteLeaseBroker",
    "TERMINAL_OUTCOMES",
    "createAttemptRouteSnapshot",
    "isTerminalOutcome",
    "outcomeProperties",
    "provisionBrokeredAgentDir",
    "requestBrokerIpc",
    "signedRegistryMessage",
    "streamProviderIpc",
    "validateResultEvidence",
    "verifySignedRegistry",
  ]);
  assert.equal("ScriptedFakeProvider" in api, false);
  assert.equal(typeof testing.ScriptedFakeProvider, "function");
});
