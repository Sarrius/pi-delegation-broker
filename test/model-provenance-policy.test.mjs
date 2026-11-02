import assert from "node:assert/strict";
import test from "node:test";

import {
  cursorBillingPool, deriveModelProvenance, evaluateRouteEligibility, freshnessForCurrency, inferModelDeveloper,
  modelPolicyGeneration, providerClassFor,
} from "../src/model-provenance-policy.mjs";

test("provider classes distinguish first-party, mixed subscription, aggregator and direct API", () => {
  assert.equal(providerClassFor("openai-codex-account-4"), "first_party_subscription");
  assert.equal(providerClassFor("anthropic-account-2"), "first_party_subscription");
  assert.equal(providerClassFor("cursor"), "mixed_subscription");
  assert.equal(providerClassFor("openrouter"), "aggregator");
  assert.equal(providerClassFor("openai"), "metered_native");
  assert.equal(providerClassFor("deepseek"), "metered_native");
  assert.equal(providerClassFor("deepseek-account-2"), "metered_native");
});

test("removed Code Assist aliases and API-key Google do not inherit subscription admission", () => {
  for(const provider of ["google-code-assist", "google-code-assist-account-2", "google"]){
    assert.equal(providerClassFor(provider), "unknown");
    assert.equal(evaluateRouteEligibility({identity:{provider,modelId:"gemini-synthetic"},requestedTier:"standard",meetsQuality:true,
      currencyFact:{listed:true,generation:0}}).eligible,false);
  }
});

test("Antigravity is a mixed subscription with distinct model scopes, not Google API billing", () => {
  const identity = { provider: "google-antigravity-account-2", modelId: "gemini-4-argon-high" };
  const p = deriveModelProvenance(identity);
  assert.equal(p.providerClass, "mixed_subscription"); assert.equal(p.nativeToRoute, true);
  assert.notEqual(p.quotaObservationScope, deriveModelProvenance({ ...identity, modelId: "gemini-3.8-flash-high" }).quotaObservationScope);
  assert.equal(evaluateRouteEligibility({ identity, requestedTier: "standard", meetsQuality: true }).eligible, false);
  assert.equal(evaluateRouteEligibility({ identity, requestedTier: "standard", meetsQuality: true,
    currencyFact: { listed: true, legacy: false, generation: 0 } }).eligible, true);
  assert.equal(deriveModelProvenance({ ...identity, modelId: "claude-opus-4-6-thinking" }).nativeToRoute, false);
});

test("Antigravity included subscription admits current hosted models without falsifying developer provenance", () => {
  for (const modelId of ["gemini-3.8-flash-high", "claude-sonnet-5-5-low", "gpt-oss-120b-medium"]) {
    const identity = { provider: "google-antigravity-account-2", modelId };
    const p = deriveModelProvenance(identity);
    assert.equal(p.billingPool, "included_subscription");
    assert.equal(p.nativeToRoute, modelId.startsWith("gemini-"));
    assert.equal(evaluateRouteEligibility({identity, requestedTier:"standard", meetsQuality:true,
      currencyFact:{listed:true,generation:0}}).eligible,true);
    assert.equal(evaluateRouteEligibility({identity, requestedTier:"standard", meetsQuality:false,
      currencyFact:{listed:true,generation:0}}).eligible,false);
    assert.equal(evaluateRouteEligibility({identity, requestedTier:"standard", meetsQuality:true,
      currencyFact:{listed:true,generation:1}}).eligible,false);
  }
  assert.equal(evaluateRouteEligibility({identity:{provider:"cursor",modelId:"claude-sonnet-5-5"},
    currencyFact:{listed:true,generation:0},requestedTier:"standard",meetsQuality:true}).eligible,false);
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

test("vendor-advertised freshness applies only when the caller marks it authoritative", () => {
  const fact = { generation: 1, listed: true, legacy: false, source: "provider_listing" };
  assert.equal(freshnessForCurrency(fact), "previous");
  assert.equal(freshnessForCurrency(fact, { vendorAdvertisedAuthoritative: true }), "current");
  // A model the vendor no longer advertises is deprecated regardless of the flag.
  assert.equal(
    freshnessForCurrency({ generation: 1, listed: false, legacy: false }, { vendorAdvertisedAuthoritative: true }),
    "deprecated",
  );
});

test("a live alias fact beats the vendor-advertised rule", () => {
  const aliased = { generation: 1, listed: true, legacy: false, aliasOf: "deepseek-flash" };
  assert.equal(freshnessForCurrency(aliased, { vendorAdvertisedAuthoritative: true }), "deprecated");
});

test("a vendor metered API is native to its own models and default-admitted only at cheap/standard", () => {
  const flash = deriveModelProvenance({ provider: "deepseek", modelId: "deepseek-flash" });
  assert.equal(flash.providerClass, "metered_native");
  assert.equal(flash.nativeToRoute, true);
  assert.equal(flash.billingPool, "native_metered");
  const identity = { provider: "deepseek", modelId: "deepseek-flash" };
  // 4.1 Flash is unversioned and the id heuristic ranks it `generation 1`; the vendor's own
  // live listing must still make it current, or the cheap model this class exists for is dead.
  const fact = { generation: 1, listed: true, legacy: false, source: "provider_listing" };
  assert.equal(evaluateRouteEligibility({ identity, currencyFact: fact, requestedTier: "cheap", meetsQuality: true }).eligible, true);
  assert.equal(evaluateRouteEligibility({ identity, currencyFact: fact, requestedTier: "standard", meetsQuality: true }).eligible, true);
  const frontier = evaluateRouteEligibility({ identity, currencyFact: fact, requestedTier: "frontier", meetsQuality: true });
  assert.equal(frontier.eligible, false);
  assert.ok(frontier.reasons.includes("metered_tier_requires_explicit_admission"));
  // An explicit user route admits the metered frontier call.
  assert.equal(evaluateRouteEligibility({ identity, currencyFact: fact, requestedTier: "frontier", meetsQuality: true, explicitlyAllowed: true }).eligible, true);
});

test("a metered route serving another vendor's model is not admitted", () => {
  const result = evaluateRouteEligibility({
    identity: { provider: "deepseek", modelId: "anthropic/claude-opus-5" },
    currencyFact: { generation: 0, listed: true, legacy: false },
    requestedTier: "cheap",
    meetsQuality: true,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("route_not_vendor_native_metered"));
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


test("Cursor's billing pools split included models from the third-party pool", () => {
  // Live fact (2026-09-12): Cursor's GetCurrentPeriodUsage returns auto_bucket_models =
  // composer*, vega*, grok-4.5*. Everything else on the account — including grok-4.6 — draws the
  // third-party pool. The split is billing, not provenance: cursor-grok-4.6 is native to a
  // Cursor route yet bills the third-party pool.
  assert.equal(cursorBillingPool("composer-2.5"), "models");
  assert.equal(cursorBillingPool("composer-2.5-fast"), "models");
  assert.equal(cursorBillingPool("vega-high"), "models");
  assert.equal(cursorBillingPool("grok-4.5-high"), "models");
  assert.equal(cursorBillingPool("cursor-grok-4.5-low-fast"), "models");
  assert.equal(cursorBillingPool("grok-4.6"), "other");
  assert.equal(cursorBillingPool("cursor-grok-4.6"), "other");
  assert.equal(cursorBillingPool("claude-opus-5"), "other");
  assert.equal(cursorBillingPool("gpt-5.6-sol"), "other");
});
