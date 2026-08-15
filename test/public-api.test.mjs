import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../src/index.mjs";
import * as testing from "../src/testing.mjs";

test("public API excludes test fixtures and exposes fake transport only through the testing subpath", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "BrokerIpcServer",
    "BrokeredLaunchResolver",
    "ControllerEvidenceStore",
    "SingleHostBrokerSupervisor",
    "SqliteLeaseBroker",
    "provisionBrokeredAgentDir",
    "requestBrokerIpc",
    "signedRegistryMessage",
    "validateResultEvidence",
    "verifySignedRegistry",
  ]);
  assert.equal("ScriptedFakeProvider" in api, false);
  assert.equal(typeof testing.ScriptedFakeProvider, "function");
});
