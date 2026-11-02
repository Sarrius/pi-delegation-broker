import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { catalogToBrokerRegistry } from "../src/provider-catalog.mjs";
import { createSelectContract, parseResourceModel } from "../src/model-selector.mjs";
import { signedRegistryMessage } from "../src/signed-registry.mjs";
import { SingleHostBrokerSupervisor } from "../src/supervisor.mjs";
import { BrokeredLaunchResolver } from "../src/trusted-launch-resolver.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const C = "cursor/composer-2.5", G = "openai-codex-account-8/gpt-5.6-sol";
const BRIEF = "Read one code module and explain the branch without modifying any files.";
const EXTENSION = new URL("./isolated-fake-provider.ts", import.meta.url).pathname;
const TOKEN = "r".repeat(48);

async function harness({ codexFirst = false, advise, routePreflight, provisionChildAuth, observeAdmittedRoute, observeEngineHandoff, trackImmediateTasks = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "br-jev-active-"));
  const catalog = [
    { provider:"cursor", baseUrl:"https://cursor.example", api:"openai-completions",
      models:[{id:"composer-2.5",name:"Composer",contextWindow:400_000,maxTokens:32_000,reasoning:true,input:["text"]}] },
    { provider:"openai-codex-account-8",baseUrl:"https://codex.example",api:"openai-codex-responses",
      models:[{id:"gpt-5.6-sol",name:"GPT",contextWindow:400_000,maxTokens:32_000,reasoning:true,input:["text"]}] },
  ];
  const registry = catalogToBrokerRegistry(catalog,{confidence:"measured"});
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now=Date.now();const unsigned={schemaVersion:2,keyId:"active-key",registry:{registryVersion:"active-fixture-v1",
    issuedAt:now-1_000,expiresAt:now+60_000,...registry}};
  const supervisor=new SingleHostBrokerSupervisor({stateDir:root,controllerToken:TOKEN,
    signedRegistry:{...unsigned,signature:sign(null,signedRegistryMessage(unsigned),privateKey).toString("base64url")},
    trustedRegistryKeys:{"active-key":publicKey.export({type:"spki",format:"pem"})},sweepIntervalMs:100});
  await supervisor.start();
  let enabled=true,calls=0;
  const selectContract=createSelectContract({registry,availability:()=>supervisor.inventory(),enforceQuality:true,
    learnedRanker:({resourceIds})=>codexFirst ? [...resourceIds].sort((a,b)=>Number(b===G)-Number(a===G)) : resourceIds});
  const resolver=new BrokeredLaunchResolver({socketPath:supervisor.socketPath,controllerToken:TOKEN,
    agentRoot:join(root,"children"),extensionPaths:[EXTENSION],offline:true,selectContract,
    resolveModelForResource:parseResourceModel,
    ...(provisionChildAuth ? {provisionChildAuth} : {}),
    ...(observeAdmittedRoute ? {observeAdmittedRoute} : {}),
    ...(observeEngineHandoff ? {observeEngineHandoff} : {}),
    routePreflight:routePreflight ?? (async ({resourceId,requestedThinking,requireExactEffortSupport}) =>
      requireExactEffortSupport && requestedThinking==="low" && resourceId!==G
        ? {status:"unavailable",reason:"reasoning_effort_unsupported",scope:"resource"} : {status:"ready"}),
    trackImmediateTasks,queuedTaskVerifier:trackImmediateTasks?{verifyAndFinalize:async()=>({verified:false})}:undefined,
    activeRouteAllowed:({cwd})=>enabled&&cwd===root,
    adviseActiveRoute:async (snapshot,signal)=>{calls++;return advise?.(snapshot,signal);},
  });
  return {root,supervisor,resolver,disable:()=>{enabled=false;},calls:()=>calls,
    request:(childId,extra={})=>({childId,requestedCwd:root,promptDigest:sha(BRIEF),isolation:"none",schemaRequested:false,
      capabilityRequest:{taskId:`task-${childId}`,taskDescription:BRIEF,operationClass:"observe",
        routingRouteMode:"auto",routingThinkingMode:"auto",routingRequestedThinking:"off",
        routingTaskClass:"diagnosis",routingBriefComplete:true,modelTier:"frontier",...extra}}),
    close:async()=>{await supervisor.stop();rmSync(root,{recursive:true,force:true});},
  };
}
const answer = (snapshot, values={}) => ({authority:"none",candidateSetDigest:sha(JSON.stringify(snapshot.resourceIds)),
  digest:"a".repeat(64),modelAnswer:"model_1",effortAnswer:"no_recommendation",...values});

test("active model choice is launch-only and can lease only a fresh same-tier selected identity",async()=>{
  const h=await harness({advise:(snapshot)=>answer(snapshot,{model:{provider:"openai-codex",modelId:"gpt-5.6-sol"}})});
  try {
    const preview=await h.resolver.preview(h.request("preview"));
    assert.equal(preview.status,"compatible_quota_unknown");assert.equal(h.calls(),0);assert.equal(h.supervisor.auditSnapshot().leases.length,0);
    const decision=await h.resolver.resolve(h.request("selected"));
    assert.equal(decision.action,"allow",decision.reason);
    assert.equal(h.calls(),1);assert.equal(decision.resource.id,G);
    assert.equal(decision.selection.jevActive.applied,true);
    assert.equal(decision.selection.jevActive.baselineResourceId,C);
    assert.equal(decision.selectedThinking,undefined);
    await decision.policy.onBeforeChildAbandoned();
    h.disable();
    const baseline=await h.resolver.resolve(h.request("disabled"));
    assert.equal(baseline.action,"allow",baseline.reason);assert.equal(baseline.resource.id,C);
    assert.equal(baseline.selection.jevActive,undefined);assert.equal(h.calls(),1);
    await baseline.policy.onBeforeChildAbandoned();
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  } finally { await h.close(); }
});

test('only a successfully handed child records applied model choice; an abandoned lease is not application',async()=>{
 const events=[];
 const h=await harness({observeEngineHandoff:e=>events.push(e),
   advise:snapshot=>answer(snapshot,{model:{provider:'openai-codex',modelId:'gpt-5.6-sol'}})});
 try{
  const abandoned=await h.resolver.resolve(h.request('abandoned'));
  assert.equal(abandoned.action,'allow');await abandoned.policy.onBeforeChildAbandoned();
  assert.equal(events.length,0);
  const handed=await h.resolver.resolve(h.request('handed'));
  assert.equal(handed.selection.jevActive.applied,true);
  await handed.policy.onChildSessionOpened();await handed.policy.onChildSessionOpened();
  assert.equal(events.length,1,'idempotent opening cannot double-count application');
  assert.equal(events[0].baselineResourceId,C);assert.equal(events[0].resourceId,G);
  assert.equal(events[0].applied,true);
  await handed.policy.onChildSessionClosed({status:'failed',attempts:1});
 }finally{await h.close();}
});

test("active low applies only to the attested baseline Codex identity; unsupported or forged suggestions abstain",async()=>{
  const h=await harness({codexFirst:true,advise:(snapshot)=>answer(snapshot,{modelAnswer:"no_recommendation",effortAnswer:"low",thinking:"low"})});
  try {
    const low=await h.resolver.resolve(h.request("low"));
    assert.equal(low.action,"allow",low.reason);assert.equal(low.resource.id,G);
    assert.equal(low.selectedThinking,"low");assert.equal(low.selection.jevActive.requestedThinking,"off");
    assert.equal(low.selection.jevActive.recommendedThinking,"low");
    await low.policy.onBeforeChildAbandoned();
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  } finally { await h.close(); }
  const unavailable=await harness({codexFirst:true,
    routePreflight:async ({resourceId,requireExactEffortSupport})=>requireExactEffortSupport
      ? {status:"unavailable",reason:"reasoning_effort_unsupported",scope:"resource"} : {status:"ready"},
    advise:(snapshot)=>answer(snapshot,{effortAnswer:"low",thinking:"low"})});
  try {
    const baseline=await unavailable.resolver.resolve(unavailable.request("not-attested"));
    assert.equal(baseline.action,"allow",baseline.reason);assert.equal(baseline.selectedThinking,undefined);
    assert.equal(baseline.selection.resourceId,G);
    assert.ok([C,G].includes(baseline.resource.id),"ordinary baseline can lease any eligible resource in its class");
    assert.equal(baseline.selection.jevActive,undefined);
    await baseline.policy.onBeforeChildAbandoned();
    assert.equal(unavailable.supervisor.auditSnapshot().leases.length,0);
  } finally { await unavailable.close(); }
});

test("an active low handoff observes caller off and applied low as separate facts",async()=>{
  const observations=[];
  const h=await harness({codexFirst:true,observeAdmittedRoute:(snapshot)=>{observations.push(snapshot);},
    advise:(snapshot)=>answer(snapshot,{modelAnswer:"no_recommendation",effortAnswer:"low",thinking:"low"})});
  try{
    const result=await h.resolver.resolve(h.request("observed-low"));
    assert.equal(result.action,"allow",result.reason);
    assert.equal(result.selectedThinking,"low");
    await result.policy.onChildSessionOpened();
    await Promise.resolve();
    assert.equal(observations.length,1);
    assert.equal(observations[0].requestedThinking,"off");
    assert.equal(observations[0].appliedThinking,"low");
    await result.policy.onChildSessionClosed({status:"failed",attempts:1});
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  }finally{await h.close();}
});

test("a leased account losing effort support is released and ordinary off baseline recovers",async()=>{
  let lowChecks=0;
  const h=await harness({codexFirst:true,
    routePreflight:async({resourceId,requireExactEffortSupport})=>{
      if(requireExactEffortSupport&&resourceId===G&&++lowChecks>=3)
        return {status:"unavailable",reason:"reasoning_effort_unsupported",scope:"resource"};
      return {status:"ready"};
    },
    advise:(snapshot)=>answer(snapshot,{modelAnswer:"no_recommendation",effortAnswer:"low",thinking:"low"}),
  });
  try {
    const result=await h.resolver.resolve(h.request("effort-drift"));
    assert.equal(result.action,"allow",result.reason);
    assert.equal(result.selectedThinking,undefined,"stale low can never be sent to a new child");
    assert.equal(result.selection.jevActive,undefined);
    assert.equal(h.calls(),1,"fallback does not buy another semantic guess");
    assert.ok(lowChecks>=3);
    assert.ok(h.supervisor.inventory().every(row=>row.state==="healthy"),"an effort mismatch is not a provider outage");
    assert.equal(h.supervisor.auditSnapshot().leases.length,1);
    await result.policy.onBeforeChildAbandoned();
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  } finally {await h.close();}
});

test("a controller with immediate-task tracking never offers active advice before its claim",async()=>{
  const h=await harness({trackImmediateTasks:true,advise:()=>{throw Error("must not export");}});
  try{
    const result=await h.resolver.resolve(h.request("tracked"));
    assert.equal(result.action,"allow",result.reason);
    assert.equal(h.calls(),0);
    assert.equal(result.selection.jevActive,undefined);
    await result.policy.onBeforeChildAbandoned();
  }finally{await h.close();}
});

test("explicit intent, incomplete briefs and outside-project cwd never export task text",async()=>{
  const h=await harness({advise:()=>{throw new Error("must not export")}});
  try {
    const cases=[
      {routingRouteMode:"inherit_model"},
      {routingThinkingMode:"high",routingRequestedThinking:"high"},
      {routingBriefComplete:false},
      {routingActiveBriefComplete:false},
      {requireModelIdentity:{provider:"cursor",modelId:"composer-2.5"}},
    ];
    for(let i=0;i<cases.length;i++) {
      const choice=await h.resolver.resolve(h.request(`excluded-${i}`,cases[i]));
      assert.equal(choice.action,"allow",choice.reason);
      assert.equal(choice.selection.jevActive,undefined);
      await choice.policy.onBeforeChildAbandoned();
    }
    const wrongCwd=await h.resolver.resolve({...h.request("outside"),requestedCwd:tmpdir()});
    assert.equal(wrongCwd.action,"allow",wrongCwd.reason);
    await wrongCwd.policy.onBeforeChildAbandoned();
    assert.equal(h.calls(),0);
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  } finally {await h.close();}
});

test("cancellation during post-lease provisioning cannot return allow or retain a lease",async()=>{
  const abort=new AbortController();let provisions=0;
  const h=await harness({advise:(snapshot)=>answer(snapshot,{model:{provider:"openai-codex",modelId:"gpt-5.6-sol"}}),
    provisionChildAuth:async()=>{provisions++;abort.abort();}});
  try{
    const result=await h.resolver.resolve({...h.request("cancel-post-lease"),signal:abort.signal});
    assert.deepEqual(result,{action:"deny",reason:"child launch cancelled"});
    assert.equal(provisions,1);
    assert.equal(h.supervisor.auditSnapshot().leases.length,0,"the reserved provider remains available");
  }finally{await h.close();}
});

test("active off during post-lease provisioning releases the hint and runs baseline once",async()=>{
  let h,provisions=0;
  h=await harness({advise:(snapshot)=>answer(snapshot,{model:{provider:"openai-codex",modelId:"gpt-5.6-sol"}}),
    provisionChildAuth:async()=>{if(++provisions===1)h.disable();}});
  try{
    const result=await h.resolver.resolve(h.request("off-post-lease"));
    assert.equal(result.action,"allow",result.reason);
    assert.equal(result.selection.jevActive,undefined);
    assert.equal(h.calls(),1,"a revoked hint cannot issue another semantic request");
    assert.equal(provisions,2,"one rejected lease followed by one ordinary baseline lease");
    assert.equal(h.supervisor.auditSnapshot().leases.length,1);
    await result.policy.onBeforeChildAbandoned();
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  }finally{await h.close();}
});

test("scope turned off during effort preflight cannot start an external JEV request",async()=>{
  let h;
  h=await harness({routePreflight:async({requireExactEffortSupport})=>{
    if(requireExactEffortSupport)h.disable();
    return {status:"ready"};
  },advise:()=>{throw Error("active brief must not be exported after scope off");}});
  try{
    const result=await h.resolver.resolve(h.request("off-before-advice"));
    assert.equal(result.action,"allow",result.reason);
    assert.equal(result.selection.jevActive,undefined);
    assert.equal(h.calls(),0);
    await result.policy.onBeforeChildAbandoned();
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  }finally{await h.close();}
});

test("scope revoked after resolution refuses handoff and releases an unhanded active lease",async()=>{
  const h=await harness({advise:(snapshot)=>answer(snapshot,{model:{provider:"openai-codex",modelId:"gpt-5.6-sol"}})});
  try{
    const result=await h.resolver.resolve(h.request("off-before-handoff"));
    assert.equal(result.action,"allow",result.reason);
    assert.equal(result.selection.jevActive.applied,true);
    h.disable();
    assert.deepEqual(await result.policy.onChildSessionOpened(),{status:"revoked"});
    await result.policy.onBeforeChildAbandoned();
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  }finally{await h.close();}
});

test("cancellation after resolution refuses session handoff before shadow observation",async()=>{
  const abort=new AbortController();const observations=[];
  const h=await harness({observeAdmittedRoute:(snapshot)=>{observations.push(snapshot);}});
  try{
    const result=await h.resolver.resolve({...h.request("cancel-before-handoff"),signal:abort.signal});
    assert.equal(result.action,"allow",result.reason);
    abort.abort();
    assert.deepEqual(await result.policy.onChildSessionOpened(),{status:"revoked"});
    await result.policy.onBeforeChildAbandoned();
    assert.equal(observations.length,0);
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  }finally{await h.close();}
});

test("late advice after scope off, changed preflight or cancellation cannot change a lease",async()=>{
  const h=await harness({advise:(snapshot)=>{h.disable();return answer(snapshot,{model:{provider:"openai-codex",modelId:"gpt-5.6-sol"}});}});
  try {
    const off=await h.resolver.resolve(h.request("turned-off"));
    assert.equal(off.action,"allow",off.reason);assert.equal(off.resource.id,C);
    assert.equal(off.selection.jevActive,undefined);
    await off.policy.onBeforeChildAbandoned();
    assert.equal(h.supervisor.auditSnapshot().leases.length,0);
  } finally { await h.close(); }
  const cancelled=new AbortController();let started,release;
  const waiting=new Promise((resolve)=>{release=resolve;});const didStart=new Promise((resolve)=>{started=resolve;});
  const j=await harness({advise:async(snapshot)=>{started();await waiting;return answer(snapshot,{model:{provider:"openai-codex",modelId:"gpt-5.6-sol"}});}});
  try {
    const pending=j.resolver.resolve({...j.request("cancelled"),signal:cancelled.signal});
    await didStart;cancelled.abort();release();
    assert.deepEqual(await pending,{action:"deny",reason:"child launch cancelled"});
    assert.equal(j.supervisor.auditSnapshot().leases.length,0);
  } finally {release();await j.close();}
});
