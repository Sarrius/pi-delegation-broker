import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { JEV_ACTIVE_ROUTING_VERSION, jevActiveScopeAllowed, makeJevActiveRouting, describeJevActiveRouting } from "../src/jev-active-routing.mjs";

const input = (changes = {}) => ({
  task: "Read and explain one controller module; do not edit files.",
  resourceIds: ["cursor-account-2/composer-2.5", "cursor-account-3/composer-2.5", "openai-codex-account-8/gpt-6-sol"],
  baselineResourceId: "openai-codex-account-8/gpt-6-sol",
  routeMode: "auto", thinkingMode: "auto", requestedThinking: "off",
  taskClass: "diagnosis", policyGeneration: "current-generation", baselineEffortSupported: true,
  autoEffortCeiling: "low", ...changes,
});
const result = (request, choices) => ({status:"evaluated", version:JEV_ACTIVE_ROUTING_VERSION,
  digest:"a".repeat(64), model:"jev-1.13.0", assessments:Object.entries(choices).map(([id,assessment])=>({id,assessment})),
  elapsedMs:45,usage:{inputTokens:40,outputTokens:2}});

test("active choice collapses accounts and bounds effort to the attested baseline model", () => {
  const request = makeJevActiveRouting(input());
  assert.equal(request.version,JEV_ACTIVE_ROUTING_VERSION);
  assert.equal(request.phase,"routing_active");
  assert.deepEqual(Object.keys(request.questions),["model","effort"]);
  assert.deepEqual(request.state.candidateModels.map(({provider,modelId})=>`${provider}/${modelId}`),
    ["cursor/composer-2.5","openai-codex/gpt-6-sol"]);
  assert.deepEqual(describeJevActiveRouting(result(request,{model:"no_recommendation",effort:"low"}),request).thinking,"low");
  const switched = describeJevActiveRouting(result(request,{model:"model_0",effort:"low"}),request);
  assert.deepEqual(switched.model,{provider:"cursor",modelId:"composer-2.5"});
  assert.equal(switched.thinking,undefined,"effort about the baseline cannot be applied to a changed model");
  assert.deepEqual(describeJevActiveRouting(result(request,{model:"no_recommendation",effort:"no_recommendation"}),request).model,undefined);
});

test('active model choice receives controller-curated comparative evidence rather than names alone',()=>{
 const facts={'cursor/composer-2.5':{identity:'cursor/composer-2.5',vendorSuitability:[{task:'codebase tasks',kind:'attributed_vendor_claim'}]},
   'openai-codex/gpt-6-sol':{identity:'openai-codex/gpt-6-sol',vendorSuitability:[{task:'complex coding',kind:'attributed_vendor_claim'}],
     externalBenchmark:{notSuccessProbability:true,indexPoints:{low:33.9}},localCheckedOutcomes:[]}};
 const request=makeJevActiveRouting(input({candidateEvidence:facts}));
 assert.deepEqual(request.state.candidateEvidence,facts);
 assert.match(request.questions.model.criteria.model_1,/complex coding/);
 assert.match(request.questions.model.criteria.model_1,/not a Pi success probability/i);
 assert.doesNotMatch(request.questions.model.criteria.model_1,/account-8/);
});

test("explicit route, high/inherited effort, incomplete candidates and unavailable support cannot create authority", () => {
  const absent=[{routeMode:"inherit_model"},{task:""},{resourceIds:[]},{resourceIds:["cursor/model"],baselineResourceId:"elsewhere/model"},
    {resourceIds:["cursor/model","cursor/model"]},{task:"x".repeat(24001)}];
  for (const changes of absent) assert.equal(makeJevActiveRouting(input(changes)),undefined);
  for (const changes of [{baselineEffortSupported:false},{autoEffortCeiling:"off"},{thinkingMode:"inherit"},
    {thinkingMode:"high",requestedThinking:"high"}]) {
    const request=makeJevActiveRouting(input(changes));
    assert.deepEqual(Object.keys(request.questions),["model"]);
  }
  const request=makeJevActiveRouting(input());
  assert.equal(describeJevActiveRouting(result(request,{model:"external",effort:"low"}),request),undefined);
  assert.equal(describeJevActiveRouting(result(request,{model:"model_0",effort:"high"}),request),undefined);
  assert.equal(describeJevActiveRouting({...result(request,{model:"model_0",effort:"low"}),status:"skipped"},request),undefined);
});

test("active export is tied to canonical project directory, not task wording", () => {
  const root=mkdtempSync(join(tmpdir(),"jev-active-scope-"));
  try {
    const allowed=join(root,"repo");const other=join(root,"repo-other");const nested=join(allowed,"src");
    mkdirSync(nested,{recursive:true});mkdirSync(other);
    symlinkSync(other,join(root,"pretend-repo"));
    const config={mode:"advisory",activeRouting:true,consentToSendActiveRoutingState:true,activeProjectRoots:[allowed]};
    assert.equal(jevActiveScopeAllowed(config,allowed),true);
    assert.equal(jevActiveScopeAllowed(config,nested),true);
    assert.equal(jevActiveScopeAllowed(config,other),false);
    assert.equal(jevActiveScopeAllowed({...config,activeProjectRoots:[],activeScopeAll:true},other),true,
      'new separately consented engine covers the actual parent cwd rather than two legacy roots');
    assert.equal(jevActiveScopeAllowed({...config,activeProjectRoots:[],activeScopeAll:true,consentToSendActiveRoutingState:false},other),false);
    assert.equal(jevActiveScopeAllowed(config,join(root,"pretend-repo")),false);
    assert.equal(jevActiveScopeAllowed({...config,consentToSendActiveRoutingState:false},allowed),false);
    assert.equal(jevActiveScopeAllowed({...config,mode:"shadow"},allowed),false);
    assert.equal(jevActiveScopeAllowed(config,join(root,"missing")),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
