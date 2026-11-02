import test from 'node:test';
import assert from 'node:assert/strict';
import {criteriaIdentity,modelCriteria,compactModelCriteria,checkedModelOutcomes} from '../src/model-criteria.mjs';
import {RoutingHistoryStore} from '../src/routing-history-store.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('subscription account capacity collapses into one researched model; fast Cursor maps to its explicit sibling only',()=>{
 assert.equal(criteriaIdentity('openai-codex-account-8/gpt-6-sol'),'openai-codex/gpt-6-sol');
 assert.equal(modelCriteria('openai-codex-account-8/gpt-6-sol').manufacturer,'OpenAI');
 assert.equal(modelCriteria('cursor/composer-2.5-fast').manufacturer.startsWith('Cursor'),true);
 assert.equal(modelCriteria('cursor/similar-sounding-composer-2.5-preview').benchmark,null);
 assert.equal(modelCriteria('openai-codex-account-8/gpt-6-luna').benchmark.effortIndices.low,20.92);
 const references=modelCriteria('openai-codex-account-8/gpt-6-luna').sources;
 assert.ok(references.some(source=>source.id==='aa-method'&&source.url.startsWith('https://artificialanalysis.ai/methodology/')
   && /^[a-f0-9]{64}$/.test(source.snapshotSha256)),'installed card has traceable published methods, not opaque source IDs');
 assert.equal(compactModelCriteria('openai-codex-account-8/gpt-6-sol').externalBenchmark.notSuccessProbability,true);
 assert.match(compactModelCriteria('openai-codex-account-8/gpt-6-sol').effortSupport.minimal,/maps to low/);
 assert.match(compactModelCriteria('openai-codex-account-8/gpt-6-sol').effortSupport.off,/not attested/);
 const expired=compactModelCriteria('openai-codex-account-8/gpt-6-sol',{now:Date.UTC(2027,2,25)});
 assert.equal(expired.stale,true);assert.equal(expired.externalBenchmark,null);
 assert.equal(expired.vendorSuitability.length,0);
});

test('many checked cohorts do not erase manufacturer and independent methodology from Jev projection',t=>{
 const dir=mkdtempSync(join(tmpdir(),'jev-cohort-bounds-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new RoutingHistoryStore({path:join(dir,'routing.sqlite')});t.after(()=>store.close());
 const now=Date.now();
 for(let i=0;i<15;i++)store.append({id:`verified:${i.toString(16).padStart(64,'0')}`,
   kind:'quality',timestamp:now-i,data:{resourceId:'openai-codex/gpt-6-sol',context:`routing-v3:lookup:requested-${i}`,
     effectiveThinking:'low',outcome:'accepted'}});
 const projected=compactModelCriteria('openai-codex-account-8/gpt-6-sol',{history:store,now});
 assert.ok(projected.vendorSuitability.length>0);
 assert.equal(projected.externalBenchmark.source,'aa-sol');
 assert.ok(projected.localCheckedOutcomes.length>0);
 assert.ok(JSON.stringify(projected).length<=1800);
});

test('local evidence only uses finalized receipts, excludes append-only invalidations and isolates actual effort',t=>{
 const dir=mkdtempSync(join(tmpdir(),'jev-criteria-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new RoutingHistoryStore({path:join(dir,'routing.sqlite')});t.after(()=>store.close());
 const now=Date.now();
 for(const [n,outcome,effort] of [['0','accepted','low'],['1','rejected','high'],['2','rejected','low']])
  store.append({id:'verified:'+n.repeat(64),kind:'quality',timestamp:now,
   data:{resourceId:'openai-codex/gpt-6-sol',capabilities:['text_generation'],context:'routing-v3:lookup:requested-auto',outcome,latencyMs:10,effectiveThinking:effort}});
 store.append({id:'feedback:untrusted',kind:'feedback',timestamp:now,data:{resourceId:'openai-codex/gpt-6-sol',outcome:'accepted'}});
 store.invalidateQuality({qualityId:'verified:'+'2'.repeat(64),reason:'controller_result_missing',evidenceRef:'controller:00000000-0000-0000-0000-000000000001'});
 const observations=checkedModelOutcomes(store,'openai-codex/gpt-6-sol',{now});
 assert.deepEqual(observations.map(o=>[o.effort,o.accepted,o.rejected]).sort(),[['high',0,1],['low',1,0]]);
});
