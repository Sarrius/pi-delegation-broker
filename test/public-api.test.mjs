import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../src/index.mjs";
import * as testing from "../src/testing.mjs";

test("public API excludes test fixtures while exposing controller-gated transport primitives", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "ANTHROPIC_API_VERSION",
    "ANTHROPIC_MESSAGES_ADAPTER_ID",
    "AnthropicMessagesTransport",
    "AnthropicMessagesTransportError",
    "ArtifactPipeline",
    "AttemptSettlement",
    "BehavioralRunMonitor",
    "BrokerIpcServer",
    "BrokeredChildRunner",
    "BrokeredLaunchResolver",
    "ControllerAcceptanceVerifier",
    "ControllerAccountInventory",
    "ControllerCredentialStore",
    "ControllerEvidenceStore",
    "ControllerLiveProviderApproval",
    "ControllerQueuedTaskVerifier",
    "ControllerRouteTable",
    "ControllerVerificationAuthority",
    "ControllerVerifiedRoutingBoard",
    "OUTCOME_PROPERTIES",
    "PROVIDER_PROTOCOL_VERSION",
    "ProviderProtocolError",
    "ProviderStreamAssembler",
    "RoutingBoard",
    "Semaphore",
    "SingleHostBrokerSupervisor",
    "SqliteLeaseBroker",
    "TERMINAL_OUTCOMES",
    "WorktreeCollectionError",
    "buildAnthropicMessagesRequest",
    "captureProviderContext",
    "catalogToBrokerRegistry",
    "cleanupWorktree",
    "collectWorktree",
    "compileEffectiveChildCapability",
    "controllerVerificationReceipt",
    "createApprovedAnthropicProviderRoute",
    "createAttemptRouteSnapshot",
    "createControllerVerifierRunId",
    "createEffectiveChildCapability",
    "createWorktree",
    "deriveAllowedTools",
    "fixtureCatalog",
    "isTerminalOutcome",
    "loadControllerRouteConfiguration",
    "outcomeProperties",
    "provisionBrokeredAgentDir",
    "requestBrokerIpc",
    "signedRegistryMessage",
    "spawnBrokeredChild",
    "streamProviderIpc",
    "validateResultEvidence",
    "verifySignedRegistry"
  ]);
  assert.equal("ScriptedFakeProvider" in api, false);
  assert.equal(typeof testing.ScriptedFakeProvider, "function");
});
