import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveModelProvenance, evaluateRouteEligibility, freshnessForCurrency, inferModelDeveloper,
  modelPolicyGeneration, providerClassFor,
} from "../src/model-provenance-policy.mjs";

test("provider classes distinguish first-party, mixed subscription, aggregator and direct API", () => {
  assert.equal(providerClassFor("openai-codex-account-4"), "first_party_subscription");
  assert.equal(providerClassFor("anthropic-account-2"), "first_party_subscription");
  assert.equal(providerClassFor("cursor"), "mixed_subscription");
  assert.equal(providerClassFor("openrouter"), "aggregator");
  assert.equal(providerClassFor("openai"), "direct_api");
});

test("model developer is independent from the provider route", () => {
  assert.equal(inferModelDeveloper("anthropic/claude-opus-5"), "anthropic");
  assert.equal(inferModelDeveloper("cursor-grok-4.6"), "xai");
  assert.equal(inferModelDeveloper("composer-2.5"), "cursor");
  assert.equal(inferModelDeveloper("glm-5.3"), "zai");
  assert.equal(inferModelDeveloper("k3"), "moonshot");
});

test("Cursor native billing models are separated from its third-party catalog", () => {
  const grok = deriveModelProvenance({ provider: "cursor", modelId: "cursor-grok-4.6-xhigh" });
  const composer = deriveModelProvenance({ provider: "cursor-account-2", modelId: "composer-2.5" });
  const claude = deriveModelProvenance({ provider: "cursor", modelId: "claude-opus-5-max" });
  assert.equal(grok.billingPool, "native_subscription");
  assert.equal(composer.nativeToRoute, true);
  assert.equal(claude.modelDeveloper, "anthropic");
  assert.equal(claude.billingPool, "third_party_subscription");
  assert.equal(claude.nativeToRoute, false);
});

test("freshness is current-only and previous is not called current", () => {
  assert.equal(freshnessForCurrency({ generation: 0, listed: true, legacy: false }), "current");
  assert.equal(freshnessForCurrency({ generation: 1, listed: true, legacy: false }), "previous");
  assert.equal(freshnessForCurrency({ generation: 2, listed: true, legacy: true }), "deprecated");
  assert.equal(freshnessForCurrency(undefined), "unknown");
});

test("automatic eligibility admits only current subscription-native routes", () => {
  const direct = { provider: "openai-codex", modelId: "gpt-5.6-sol" };
  const directResult = evaluateRouteEligibility({
    identity: direct,
    currencyFact: { generation: 0, listed: true, legacy: false, source: "provider_listing", evaluatedAt: 1234 },
    requestedTier: "frontier",
    meetsQuality: true,
  });
  assert.equal(directResult.eligible, true);
  assert.equal(directResult.provenance.freshnessSource, "provider_listing");
  assert.equal(directResult.provenance.freshnessEvaluatedAt, 1234);

  const aggregator = evaluateRouteEligibility({
    identity: { provider: "openrouter", modelId: "openai/gpt-5.6-sol" },
    currencyFact: { generation: 0, listed: true, legacy: false },
    requestedTier: "frontier",
    meetsQuality: true,
  });
  assert.equal(aggregator.eligible, false);
  assert.ok(aggregator.reasons.includes("provider_not_subscription_native_default"));

  const previous = evaluateRouteEligibility({
    identity: direct,
    currencyFact: { generation: 1, listed: true, legacy: false },
    requestedTier: "frontier",
    meetsQuality: true,
  });
  assert.equal(previous.eligible, false);
  assert.ok(previous.reasons.includes("freshness_previous"));
});

test("an explicit user route can admit an aggregator but cannot revive an old model", () => {
  const identity = { provider: "openrouter", modelId: "x-ai/grok-4.6" };
  assert.equal(evaluateRouteEligibility({
    identity,
    currencyFact: { generation: 0, listed: true, legacy: false },
    explicitlyAllowed: true,
  }).eligible, true);
  assert.equal(evaluateRouteEligibility({
    identity,
    currencyFact: { generation: 1, listed: true, legacy: false },
    explicitlyAllowed: true,
  }).eligible, false);
});

test("policy generation is deterministic and changes with user pools", () => {
  const empty = { schemaVersion: 1, tiers: { frontier: [], standard: [], cheap: [] } };
  assert.equal(modelPolicyGeneration(empty), modelPolicyGeneration(structuredClone(empty)));
  assert.notEqual(modelPolicyGeneration(empty), modelPolicyGeneration({
    schemaVersion: 1, tiers: { frontier: [{ model: "grok-4.6", via: ["openrouter"] }], standard: [], cheap: [] },
  }));
});
