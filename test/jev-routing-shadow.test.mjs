import assert from "node:assert/strict";
import test from "node:test";
import { JEV_ROUTING_SHADOW_VERSION, makeJevRoutingShadow, describeJevRoutingShadow } from "../src/jev-routing-shadow.mjs";

const input = (overrides = {}) => ({
  task: "Compare two approved implementations without changing project files.",
  resourceIds: ["slot-account-2/model-a", "slot-account-3/model-a", "slot-account-4/model-b"],
  baselineResourceId: "slot-account-2/model-a", leasedResourceId: "slot-account-3/model-a",
  routeMode: "auto", thinkingMode: "auto", requestedThinking: "off", effectiveThinking: "off",
  taskClass: "review", policyGeneration: "fixture-policy-1",
  ...overrides,
});

test("only controller-vetted model identities are choices; account aliases are not semantic choices", () => {
  const request = makeJevRoutingShadow(input());
  assert.equal(request.version, JEV_ROUTING_SHADOW_VERSION);
  assert.equal(request.phase, "routing");
  assert.deepEqual(Object.keys(request.questions), ["model", "effort"]);
  assert.deepEqual(request.state.candidateModels.map(({id,provider,modelId}) => ({id,provider,modelId})), [
    {id: "model_0", provider: "slot", modelId: "model-a"},
    {id: "model_1", provider: "slot", modelId: "model-b"},
  ]);
  assert.ok(request.questions.model.criteria.no_recommendation);
  assert.ok(request.questions.effort.criteria.no_recommendation);
  assert.match(request.state.provenance, /not authenticated owner policy/);
  assert.notDeepEqual(request.state.candidateSetDigest,
    makeJevRoutingShadow(input({resourceIds: ["slot-account-4/model-b", "slot-account-3/model-a", "slot-account-2/model-a"]})).state.candidateSetDigest);
});

test("an exact route or explicit effort is never a semantic-choice question", () => {
  const routeOnly = makeJevRoutingShadow(input({routeMode: "inherit_model"}));
  assert.deepEqual(Object.keys(routeOnly.questions), ["effort"]);
  const effortOnly = makeJevRoutingShadow(input({thinkingMode: "high", requestedThinking: "high"}));
  assert.deepEqual(Object.keys(effortOnly.questions), ["model"]);
  assert.equal(makeJevRoutingShadow(input({routeMode: "inherit_model", thinkingMode: "inherit"})), undefined);
});

test("incomplete, malformed or oversize controller snapshots abstain rather than sample candidates", () => {
  for (const changes of [
    { task: "" }, { task: "x".repeat(24_001) },
    { resourceIds: [] }, { resourceIds: ["slot-account-2/model-a", "slot-account-2/model-a"] },
    { resourceIds: Array.from({length: 129}, (_, i) => `slot-${i}/model-a`) },
    { leasedResourceId: "outside/model" }, { baselineResourceId: "outside/model" },
    { routeMode: "unverified" }, { thinkingMode: "bogus" }, { requestedThinking: "superhigh" }, { effectiveThinking: "superhigh" },
  ]) assert.equal(makeJevRoutingShadow(input(changes)), undefined);
});

test("a response can describe only an inert, bounded hypothesis, never an executable route", () => {
  const request = makeJevRoutingShadow(input());
  const result = { status: "evaluated", version: JEV_ROUTING_SHADOW_VERSION, digest: "digest",
    assessments: [{id: "model", assessment: "model_1"}, {id: "effort", assessment: "medium"}] };
  assert.deepEqual(describeJevRoutingShadow(result, request), {
    authority: "none", candidateSetDigest: request.state.candidateSetDigest,
    modelHypothesis: "model_1", effortHypothesis: "medium",
  });
  assert.equal(describeJevRoutingShadow({...result, assessments: [{id:"model",assessment:"external/model"}]}, request), undefined);
  assert.equal(describeJevRoutingShadow({...result, status: "skipped"}, request), undefined);
});
