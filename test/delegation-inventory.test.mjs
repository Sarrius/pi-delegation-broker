import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {delegationInventory,modelLearningIdentity,rankAdmittedResources,prioritizeInventoryRows} from '../src/delegation-inventory.mjs';
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
 assert.ok(rows.cool.reasons.includes('capacity_group_cooldown'));
 assert.ok(rows.busy.reasons.includes('child_slots_busy'));
 assert.ok(rows.unknown.reasons.includes('resource_health_unknown'));
 assert.equal(rows.busy.state,'busy');assert.equal(rows.unknown.state,'probe_eligible');assert.equal(rows.old.state,'excluded');
 assert.equal(snapshot.availabilityGuarantee,false);assert.equal(snapshot.parentQuotaReserve,'not_measurable');
 assert.equal(rows.free.cost.actualMoney,null);
 assert.equal(delegationInventory({registry,currency,inventory:[],now:1000}).rows.find(r=>r.resourceId==='free').state,'unknown');
});
test('resource cooldown is distinguished from account cooldown without inventing a root cause',()=>{
 const id='google-antigravity/gemini-3.8-flash-low';
 const registry={resources:{[id]:{model:{provider:'google-antigravity',modelId:'gemini-3.8-flash-low'}}}};
 const row=delegationInventory({registry,currency:{[id]:{generation:0}},now:1000,
  inventory:[{resourceId:id,state:'unknown',cooldownUntil:2000,groupCooldownUntil:0,
   maxConcurrent:5,controlReserve:1,activeLeases:0}]}).rows[0];
 assert.equal(row.state,'cooling_down');
 assert.ok(row.reasons.includes('resource_cooldown'));
 assert.ok(row.reasons.includes('resource_health_unknown'));
 assert.ok(!row.reasons.includes('capacity_group_cooldown'));
 assert.ok(!row.reasons.includes('provider_endpoint_unreachable'));
});
test('the bounded displayed inventory never hides a live route behind 100 excluded legacy models',()=>{
 const rows=[...Array.from({length:120},(_,i)=>({resourceId:`cursor/old-${i}`,provider:'cursor',state:'excluded'})),
  {resourceId:'cursor/composer-2.5',provider:'cursor',state:'available'},
  {resourceId:'other/current',provider:'other',state:'available'}];
 const visible=prioritizeInventoryRows(rows,{provider:'cursor',limit:100});
 assert.equal(visible.length,100);
 assert.equal(visible[0].resourceId,'cursor/composer-2.5');
 assert.ok(!visible.some(row=>row.provider==='other'));
});

test('inventory reports the same pool-pressure exclusion enforced by selection',()=>{
 const id='cursor/composer-2.5';
 const registry={resources:{[id]:{model:{provider:'cursor',modelId:'composer-2.5'},pool:'cursor.models'}}};
 const health={resourceId:id,state:'healthy',maxConcurrent:5,controlReserve:1,verifyReserve:0,activeLeases:0,confidence:'observed'};
 const currency={[id]:{generation:0,evaluatedAt:1000}};
 const pressured=delegationInventory({registry,inventory:[health],currency,pools:{'cursor.models':{usedPercent:100,resetAt:2000}},now:1000}).rows[0];
 assert.equal(pressured.state,'excluded');assert.ok(pressured.reasons.includes('pool_near_exhausted'));
 assert.equal(pressured.pool,'cursor.models');assert.equal(pressured.poolUsedPercent,100);assert.equal(pressured.poolResetAt,2000);
 const reset=delegationInventory({registry,inventory:[health],currency,pools:{'cursor.models':{usedPercent:100,resetAt:2000}},now:3000}).rows[0];
 assert.equal(reset.state,'available');
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
