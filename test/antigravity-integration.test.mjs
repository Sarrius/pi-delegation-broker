import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteLeaseBroker} from '../src/broker.mjs';
import {catalogToBrokerRegistry} from '../src/provider-catalog.mjs';
import {signedRegistryMessage} from '../src/signed-registry.mjs';
import {assignGenerations} from '../src/provider-probe.mjs';
const ids=['gemini-4-argon-high','gemini-3.8-flash-low','claude-sonnet-5-5-low'];
const registry=()=>catalogToBrokerRegistry([{provider:'google-antigravity',baseUrl:'https://daily-cloudcode-pa.googleapis.com',api:'google-antigravity',models:ids.map(id=>({id,name:id,contextWindow:100000,maxTokens:8192,reasoning:true,input:['text']}))}]);

test('Argon quota cooldown does not change sibling health or multiply account concurrency',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ag-quota-')),b=new SqliteLeaseBroker({path:join(dir,'broker.sqlite'),registry:registry()});
 try{
  b.markRateLimited('google-antigravity/'+ids[0],60000,1000);
  const rows=b.inventory(1001),argon=rows.find(r=>r.resourceId.endsWith(ids[0]));
  assert.equal(argon.state,'unknown');assert.equal(argon.cooldownUntil,61000);
  assert.equal(new Set(rows.map(r=>r.capacityGroup)).size,1);
  for(const row of rows){assert.equal(row.groupCooldownUntil,0);assert.equal(row.breakerState,'healthy');}
  for(const row of rows.filter(r=>r!==argon))assert.equal(row.state,'healthy');
  b.markAvailabilityObserved('google-antigravity/'+ids[0],1002);
  assert.equal(b.inventory(1003).find(r=>r.resourceId.endsWith(ids[0])).state,'unknown');
 }finally{b.close();rmSync(dir,{recursive:true,force:true});}
});
for(const evidence of [true,false])test(`legacy scope migration preserves exhaustion; exact evidence=${evidence}`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'ag-migration-')),path=join(dir,'broker.sqlite');const r=registry(),now=Date.now(),until=now+60000;
 const first=new SqliteLeaseBroker({path,registry:r});first.close();const db=new DatabaseSync(path);
 db.prepare("UPDATE capacity_groups SET cooldown_until=?,breaker_state='cooling_down'").run(until);
 if(evidence)db.prepare('INSERT INTO events(at,type,payload) VALUES(?,?,?)').run(now,'CapacityGroupCooldown',JSON.stringify({resourceId:'google-antigravity/'+ids[0],capacityGroup:'G-google-antigravity',until,source:'registry_default'}));
 db.close();const second=new SqliteLeaseBroker({path,registry:r});
 try{
  const rows=second.inventory(Date.now());
  assert.equal(rows[0].groupCooldownUntil,evidence?0:until);
  if(evidence){assert.equal(rows.find(r=>r.resourceId.endsWith(ids[0])).cooldownUntil,until);assert.equal(rows.find(r=>r.resourceId.endsWith(ids[1])).state,'healthy');}
 }finally{second.close();rmSync(dir,{recursive:true,force:true});}
});
test('Gemini product families retain independent current generations',()=>{
 const g=assignGenerations([...ids,'gemini-3.5-flash-high','gemini-3.5-flash-lite']);
 assert.equal(g.get('gemini-3.8-flash-low').generation,0);
 assert.equal(g.get('gemini-3.5-flash-high').generation,1);
 assert.equal(g.get('gemini-3.5-flash-lite').generation,0);
 assert.equal(g.get('gemini-4-argon-high').generation,0);
});
test('signed catalog accepts exact model quota scope, not a sibling scope',()=>{
 const r={...registry(),registryVersion:'fixture-v1',issuedAt:1000,expiresAt:2000};
 assert.doesNotThrow(()=>signedRegistryMessage({schemaVersion:2,keyId:'fixture',registry:r}));
 const bad=structuredClone(r);bad.resources['google-antigravity/'+ids[0]].provenance.quotaObservationScope='model:'+ids[1];
 assert.throws(()=>signedRegistryMessage({schemaVersion:2,keyId:'fixture',registry:bad}),/quotaObservationScope/);
});
