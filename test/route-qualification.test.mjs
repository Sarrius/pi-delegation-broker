import test from 'node:test';
import assert from 'node:assert/strict';
import {RouteQualification,qualifiedInventory} from '../src/route-qualification.mjs';

function fixture(overrides={}) {
 let time=1000,fingerprint='one',healthy=true,canaries=0,pings=0;
 const gate=new RouteQualification({now:()=>time,health:()=>healthy,
  preflight:async()=>({status:'ready',routeFingerprint:fingerprint}),
  canary:async()=>{canaries++;return {status:'verified',evidence:'isolated_tool_roundtrip',canaryId:'canary'};},
  probe:async()=>{pings++;return {status:'verified'};},...overrides});
 return {gate,advance:ms=>time+=ms,change:()=>fingerprint='two',unhealthy:()=>healthy=false,counts:()=>({canaries,pings})};
}
test('cold route cannot be offered before isolated tool/report evidence; every admission rechecks availability',async()=>{
 const f=fixture();const snapshot={rows:[{resourceId:'p/m',state:'available'}]};
 assert.equal(qualifiedInventory(snapshot,f.gate,{now:1000}).rows.length,0);
 assert.equal((await f.gate.check('p/m')).status,'verified');
 assert.equal(qualifiedInventory(snapshot,f.gate,{now:1000}).rows.length,1);
 await f.gate.check('p/m',{fresh:true});assert.deepEqual(f.counts(),{canaries:1,pings:1});
 f.advance(60_001);assert.equal(f.gate.cached('p/m').status,'not_checked');
 await f.gate.check('p/m');assert.deepEqual(f.counts(),{canaries:1,pings:2});
 f.advance(600_001);await f.gate.check('p/m');assert.equal(f.counts().canaries,2);
 await f.gate.close();
});
test('binding and effort changes invalidate cached compatibility; restarts start cold',async()=>{
 const f=fixture();await f.gate.check('p/m');f.change();await f.gate.check('p/m');await f.gate.check('p/m',{thinking:'high'});
 assert.equal(f.counts().canaries,3);assert.equal(fixture().gate.cached('p/m').status,'not_checked');await f.gate.close();
});
test('a successful text reply cannot certify tool compatibility',async()=>{
 const f=fixture({canary:async()=>({status:'verified',evidence:'native_inference'})});
 const result=await f.gate.check('p/m');assert.equal(result.status,'failed');assert.equal(result.reason,'canary_evidence_missing');
 assert.equal(qualifiedInventory({rows:[{resourceId:'p/m',state:'available'}]},f.gate,{now:1000}).rows.length,0);await f.gate.close();
});
test('network/auth/quota/model failures and health changes are never ready choices',async()=>{
 for(const reason of ['transport_before_headers','auth_failed','quota_exhausted','model_unavailable']) {
  const f=fixture({canary:async()=>({status:'failed',reason})});assert.equal((await f.gate.check('p/m')).reason,reason);
  assert.equal(f.gate.cached('p/m').status,'failed');await f.gate.close();
 }
 const f=fixture();await f.gate.check('p/m');f.unhealthy();assert.equal(f.gate.cached('p/m').status,'not_checked');await f.gate.close();
});
test('concurrent first callers share one canary, while cancellation stops only that waiter',async()=>{
 let finish;let calls=0;
 const f=fixture({canary:async()=>{calls++;await new Promise(r=>finish=r);return {status:'verified',evidence:'isolated_tool_roundtrip'};}});
 const controller=new AbortController();const a=f.gate.check('p/m',{signal:controller.signal});const b=f.gate.check('p/m');
 while(!finish)await new Promise(r=>setTimeout(r,1));controller.abort();assert.equal((await a).reason,'cancelled');
 finish();assert.equal((await b).status,'verified');assert.equal(calls,1);await f.gate.close();
});
test('shutdown bounds an uncooperative canary and cannot create proof',async()=>{
 const f=fixture({canary:async()=>new Promise(()=>{})});const result=f.gate.check('p/m');
 await new Promise(r=>setTimeout(r,1));await f.gate.close();assert.notEqual((await result).status,'verified');
});
test('partial sweeps and catalog-only views never advertise untested routes',async()=>{
 const f=fixture();const rows=['a','b','c'].map(resourceId=>({resourceId,state:'available'}));
 await f.gate.verifyRows(rows,{maxChecks:1});const view=qualifiedInventory({rows},f.gate,{now:1000});
 assert.deepEqual(view.rows.map(r=>r.resourceId),['a']);assert.equal(view.diagnostics.length,2);await f.gate.close();
});
test('internal off qualification raises only to an attested minimum; explicit high remains high',async()=>{
 const calls=[];
 const f=fixture({preflight:async()=>({status:'ready',routeFingerprint:'bound',minimumReadinessThinking:'low'}),
  canary:async input=>{calls.push(input.thinking);return {status:'verified',evidence:'isolated_tool_roundtrip'};}});
 const off=await f.gate.check('p/m');assert.equal(off.status,'verified');assert.deepEqual(calls,['low']);assert.equal(off.effectiveQualificationThinking,'low');
 for(const level of ['high','xhigh']){const work=await f.gate.check('p/m',{thinking:level});assert.equal(work.status,'verified');assert.equal(calls.at(-1),level);assert.equal(work.effectiveQualificationThinking,level);}assert.deepEqual(calls,['low','high','xhigh']);
 await f.gate.close();
});
test('unknown readiness minimum cannot certify a route or invoke a canary',async()=>{
 let calls=0;
 const f=fixture({preflight:async()=>({status:'ready',routeFingerprint:'bound',minimumReadinessThinking:'unsupported'}),
  canary:async()=>{calls++;return {status:'verified',evidence:'isolated_tool_roundtrip'};}});
 const result=await f.gate.check('p/m');assert.equal(result.status,'failed');assert.equal(result.reason,'readiness_effort_unattested');assert.equal(calls,0);await f.gate.close();
});
test('a route change during canary cannot mint readiness',async()=>{
 let generation=0;const f=fixture({preflight:async()=>({status:'ready',routeFingerprint:String(generation++)})});
 assert.equal((await f.gate.check('p/m')).reason,'route_changed_during_check');assert.equal(f.gate.cached('p/m').status,'not_checked');await f.gate.close();
});
