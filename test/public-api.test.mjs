import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../src/index.mjs";
import * as testing from "../src/testing.mjs";

test("public API excludes test fixtures while exposing only unconfigured transport primitives", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "ANTHROPIC_API_VERSION",
    "ANTHROPIC_MESSAGES_ADAPTER_ID",
    "AnthropicMessagesTransport",
    "AnthropicMessagesTransportError",
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
    "RoutingBoard",
    "SingleHostBrokerSupervisor",
    "SqliteLeaseBroker",
    "TERMINAL_OUTCOMES",
    "buildAnthropicMessagesRequest",
    "captureProviderContext",
    "catalogToBrokerRegistry",
    "compileEffectiveChildCapability",
    "createAttemptRouteSnapshot",
    "createEffectiveChildCapability",
    "deriveAllowedTools",
    "fixtureCatalog",
    "isTerminalOutcome",
    "outcomeProperties",
    "provisionBrokeredAgentDir",
    "requestBrokerIpc",
    "signedRegistryMessage",
    "streamProviderIpc",
    "validateResultEvidence",
    "verifySignedRegistry"
  ]);
  assert.equal("ScriptedFakeProvider" in api, false);
  assert.equal(typeof testing.ScriptedFakeProvider, "function");
});
