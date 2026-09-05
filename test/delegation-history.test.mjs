import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoutingHistoryStore} from '../src/routing-history-store.mjs';
import {importLegacyAffinity,qualitySummary,historySummary,ownerKey,routeFact} from '../src/delegation-history.mjs';
import {ModelAffinityJournal} from '../src/model-affinity-journal.mjs';
test('legacy aggregate migration is idempotent and cannot masquerade as comparable quality',t=>{
 const root=mkdtempSync(join(tmpdir(),'history-migration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'controllers','a'.repeat(16));mkdirSync(path,{recursive:true});
 writeFileSync(join(path,'model-affinity.json'),JSON.stringify({schemaVersion:2,observations:{x:{resourceId:'old/model',accepted:10,rejected:2}}}));
 const store=new RoutingHistoryStore({path:join(root,'history.sqlite')});t.after(()=>store.close());
 assert.equal(importLegacyAffinity(store,root),1);assert.equal(importLegacyAffinity(store,root),0);
 assert.equal(store.list()[0].data.comparable,false);assert.equal(store.count('quality'),0);assert.deepEqual(qualitySummary(store),[]);
});
test('transport failures and parent feedback never change verified model quality; missing consumption is unknown',t=>{
 const root=mkdtempSync(join(tmpdir(),'history-utility-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=new RoutingHistoryStore({path:join(root,'history.sqlite')});t.after(()=>store.close());
 const journal=new ModelAffinityJournal({store});journal.recordVerified({resourceId:'a/model',capabilities:['text_generation'],outcome:'accepted',latencyMs:50});
 const before=qualitySummary(store);
 const fact=routeFact({taskId:'job',ownerSessionId:'owner',context:'legacy',result:{status:'failed',route:[{resourceId:'a/model',outcome:'rate_limit'}]},startedAt:Date.now()-10});
 store.append({id:'route:job',kind:'route',data:fact});store.append({id:'feedback:job',kind:'feedback',data:{taskId:'job',owner:ownerKey('owner'),utility:'redundant',source:'parent_report'}});
 assert.deepEqual(qualitySummary(store),before);
 assert.equal(before[0].tokensPerAcceptedResult,null);assert.equal(before[0].samples,1);assert.equal(before[0].evidence,'insufficient');
 const rows=historySummary(store,{owner:ownerKey('owner')});assert.equal(rows[0].utility.utility,'redundant');assert.equal(rows[0].tokens,null);assert.deepEqual(historySummary(store,{owner:ownerKey('another')}),[]);
});
