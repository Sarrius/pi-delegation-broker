import test from 'node:test';
import assert from 'node:assert/strict';
import {delegationInventory} from '../src/delegation-inventory.mjs';
import {reportVerificationEvidence} from '../src/report-store.mjs';
import {RouteQualification} from '../src/route-qualification.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteLeaseBroker,fixtureRegistry} from '../src/broker.mjs';

test('fresh admission cannot inherit a concurrently cached inventory result',async t=>{
 let probes=0,canaries=0;
 const q=new RouteQualification({preflight:async()=>({status:'ready',routeFingerprint:'same-route'}),
  canary:async()=>{canaries++;return{status:'verified',evidence:'isolated_tool_roundtrip'};},
  probe:async()=>{probes++;return{status:'verified'};}});t.after(()=>q.close());
 await q.check('p/m');
 const inventory=q.check('p/m');
 const launch=q.check('p/m',{fresh:true});
 assert.equal((await inventory).status,'verified');assert.equal((await launch).status,'verified');
 assert.equal(canaries,1);assert.equal(probes,1,'launch needs new availability, not an in-flight cached answer');
});

test('a second controller narrow catalog cannot withdraw peer routes or erase their health',t=>{
 const root=mkdtempSync(join(tmpdir(),'broker-shared-catalog-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'broker.sqlite'),registry=fixtureRegistry();
 const first=new SqliteLeaseBroker({path,registry,preserveUnlistedResources:true});t.after(()=>first.close());
 const now=Date.now();first.markRateLimited('R1',600000,now);first.markUnknown('R1',now,'observed_failure','resource',600000,'dispatch');
 const before=first.inventory(now).find(r=>r.resourceId==='R1');
 const second=new SqliteLeaseBroker({path,registry:{...registry,resources:{R2:registry.resources.R2}},
  reconcileRegistryOnStart:true,preserveUnlistedResources:true});t.after(()=>second.close());
 assert.deepEqual(second.inventory(now).find(r=>r.resourceId==='R1'),before);
 second.updateRegistry({...registry,resources:{}},now+1);
 assert.equal(first.inventory(now+1).length,4,'a local empty view is not global withdrawal authority');
});

test('expired throttle is probe eligible, never advertised as already healthy',()=>{
 const id='cursor/composer-2.5';
 const row=delegationInventory({registry:{resources:{[id]:{model:{provider:'cursor',modelId:'composer-2.5'}}}},
  currency:{[id]:{generation:0,evaluatedAt:1000}},now:3000,
  inventory:[{resourceId:id,state:'healthy',breakerState:'cooling_down',groupCooldownUntil:2000,maxConcurrent:5,activeLeases:0}]}).rows[0];
 assert.equal(row.state,'probe_eligible');
});
test('background reports preserve accepted verifier receipt rather than relabel execution completed as verification',()=>{
 assert.deepEqual(reportVerificationEvidence({status:'completed',verification:{outcome:{status:'completed'}}}),{});
 const verification={status:'accepted',evidenceRefs:['controller:fixture'],receipt:{id:'fixture'}};
 assert.deepEqual(reportVerificationEvidence({verification:{outcome:{status:'completed'},verification}}),{verificationStatus:'accepted',verification});
});
test('owner-injected adapters without a cache fingerprint qualify but are never reused as stable conformance',async()=>{
 let calls=0;const gate=new RouteQualification({preflight:async()=>({status:'ready'}),
  probe:async()=>({status:'verified'}),canary:async()=>{calls++;return {status:'verified',evidence:'isolated_tool_roundtrip'};}});
 assert.equal((await gate.check('p/m')).status,'verified');assert.equal((await gate.check('p/m')).status,'verified');assert.equal(calls,2);await gate.close();
});
test('aborting the final waiter cancels its underlying qualification rather than spending invisibly',async()=>{
 let began,aborted=false;const entered=new Promise(r=>began=r);
 const gate=new RouteQualification({preflight:async()=>({status:'ready'}),probe:async()=>({status:'verified'}),
  canary:async({signal})=>{began();await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return {status:'unknown'};}});
 const controller=new AbortController();const result=gate.check('p/m',{signal:controller.signal});await entered;controller.abort();
 assert.equal((await result).reason,'cancelled');await new Promise(r=>setTimeout(r,1));assert.equal(aborted,true);await gate.close();
});
