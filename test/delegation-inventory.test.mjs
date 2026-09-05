import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {delegationInventory,modelLearningIdentity,rankAdmittedResources} from '../src/delegation-inventory.mjs';
import {SqliteLeaseBroker,fixtureRegistry,fixtureContract} from '../src/broker.mjs';

test('availability distinguishes cooldown, unknown, busy, exclusions and reserved parent capacity',()=>{
 const model={provider:'anthropic',modelId:'claude-sonnet-4-6'};
 const registry={resources:Object.fromEntries(['free','cool','busy','unknown','old'].map(id=>[id,{model}]))};
 const currency=Object.fromEntries(['free','cool','busy','unknown'].map(id=>[id,{generation:0,evaluatedAt:500}]));
 const base={state:'healthy',maxConcurrent:3,controlReserve:1,verifyReserve:0,activeLeases:0,confidence:'observed',breakerState:'healthy'};
 const snapshot=delegationInventory({registry,currency,now:1000,inventory:[{...base,resourceId:'free'},{...base,resourceId:'cool',groupCooldownUntil:2000},{...base,resourceId:'busy',activeLeases:2},{...base,resourceId:'unknown',state:'unknown'}]});
 const rows=Object.fromEntries(snapshot.rows.map(row=>[row.resourceId,row]));
 assert.equal(rows.free.state,'available');assert.equal(rows.free.freeChildSlots,2);
 assert.equal(rows.cool.state,'cooling_down');assert.equal(rows.cool.retryAt,2000);
 assert.equal(rows.busy.state,'busy');assert.equal(rows.unknown.state,'probe_eligible');assert.equal(rows.old.state,'excluded');
 assert.equal(snapshot.availabilityGuarantee,false);assert.equal(snapshot.parentQuotaReserve,'not_measurable');
 assert.equal(rows.free.cost.actualMoney,null);
 assert.equal(delegationInventory({registry,currency,inventory:[],now:1000}).rows.find(r=>r.resourceId==='free').state,'unknown');
});
test('model quality identity pools account aliases but preserves provider and model identity',()=>{
 assert.equal(modelLearningIdentity('route',{resources:{route:{model:{provider:'anthropic-account-2',modelId:'claude-sonnet-4-6'}}}}),'anthropic/claude-sonnet-4-6');
});
test('actual lease honors selected ordering, then falls back only within admitted resources',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rank-lease-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const broker=new SqliteLeaseBroker({path:join(dir,'broker.sqlite'),registry:fixtureRegistry(),resourceRanker:rankAdmittedResources});t.after(()=>broker.close());
 const contract=fixtureContract();contract.capability.allowedResources=['R2','R1'];
 const a=broker.reserve(contract,1000);assert.equal(a.status,'leased');assert.equal(a.lease.resourceId,'R2');
 const second={...contract,taskId:'next'};const b=broker.reserve(second,1001);assert.equal(b.status,'leased');assert.equal(b.lease.resourceId,'R1');
});
