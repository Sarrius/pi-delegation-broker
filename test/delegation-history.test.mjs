import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoutingHistoryStore} from '../src/routing-history-store.mjs';
import {importLegacyAffinity,qualitySummary,historySummary,executionScorecard,ownerKey,routeFact} from '../src/delegation-history.mjs';
import {ModelAffinityJournal} from '../src/model-affinity-journal.mjs';
test('legacy aggregate migration is idempotent and cannot masquerade as comparable quality',t=>{
 const root=mkdtempSync(join(tmpdir(),'history-migration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'controllers','a'.repeat(16));mkdirSync(path,{recursive:true});
 writeFileSync(join(path,'model-affinity.json'),JSON.stringify({schemaVersion:2,observations:{x:{resourceId:'old/model',accepted:10,rejected:2}}}));
 const store=new RoutingHistoryStore({path:join(root,'history.sqlite')});t.after(()=>store.close());
 assert.equal(importLegacyAffinity(store,root),1);assert.equal(importLegacyAffinity(store,root),0);
 assert.equal(store.list()[0].data.comparable,false);assert.equal(store.count('quality'),0);assert.deepEqual(qualitySummary(store),[]);
});
test('route history attributes the leased provider, not the internal broker-proxy transport',()=>{
 const row=routeFact({taskId:'route-proxy',ownerSessionId:'owner',context:'routing-v3:lookup:requested-off',
  result:{status:'completed',resource:{id:'cursor/composer-2.5'},
    resolved:{provider:'broker-proxy',modelId:'composer-2.5',thinkingLevel:'off'},route:[]},
  startedAt:10,completedAt:20});
 assert.equal(row.provider,'cursor');
 assert.equal(row.resourceId,'cursor/composer-2.5');
});

test('route history uses signed receipt status rather than broker terminal completed/failed as the quality label',()=>{
 for(const [outcome,receipt,expected] of [['failed','rejected','rejected'],['completed','accepted','accepted']]) {
  const row=routeFact({taskId:'receipt-task',ownerSessionId:'owner',context:'routing-v3:lookup:requested-off',
   result:{status:outcome,verification:{outcome:{status:outcome},verification:{status:receipt}},route:[]},
   startedAt:10,completedAt:20});
  assert.equal(row.verification,expected);
 }
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
test('agent scorecard separates effective effort, parent usefulness and checked quality without inventing money',t=>{
 const root=mkdtempSync(join(tmpdir(),'history-scorecard-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=new RoutingHistoryStore({path:join(root,'history.sqlite')});t.after(()=>store.close());
 const ours=ownerKey('owner'),other=ownerKey('foreign');
 const accepted=routeFact({taskId:'job-a',ownerSessionId:'owner',context:'routing-v3:review:requested-off',
  result:{status:'completed',resource:{id:'openai-codex-account-2/gpt-6-astra'},
   resolved:{provider:'openai-codex-account-2',modelId:'gpt-6-astra',thinkingLevel:'low'},
   route:[{resourceId:'openai-codex-account-2/gpt-6-astra',outcome:'completed'}],
   verification:{outcome:{status:'accepted'}},childHandoffs:1,
   selection:{modelTier:'frontier',preferenceSource:'user'},
   usage:{input:20,output:5,cacheRead:0,cacheWrite:0}},startedAt:10,completedAt:110});
 const failed=routeFact({taskId:'job-b',ownerSessionId:'owner',context:'routing-v3:review:requested-off',
  result:{status:'failed',resource:{id:'openai-codex-account-3/gpt-6-astra'},
   resolved:{provider:'openai-codex-account-3',modelId:'gpt-6-astra',thinkingLevel:'low'},
   route:[{resourceId:'openai-codex-account-3/gpt-6-astra',outcome:'rate_limit'},
    {resourceId:'openai-codex-account-3/gpt-6-astra',outcome:'provider_error'}],childHandoffs:2,
   selection:{modelTier:'frontier',preferenceSource:'user'}},startedAt:15,completedAt:115});
 const foreign=routeFact({taskId:'job-c',ownerSessionId:'foreign',context:'routing-v3:implementation:requested-high',
  result:{status:'completed',resource:{id:'cursor/composer-2.5'},
   resolved:{provider:'cursor',modelId:'composer-2.5',thinkingLevel:'high'},
   route:[{resourceId:'cursor/composer-2.5',outcome:'completed'}],
   selection:{modelTier:'standard',preferenceSource:'auto'},usage:{input:50,output:30}},startedAt:20,completedAt:120});
 for(const [id,data] of [['job-a',accepted],['job-b',failed],['job-c',foreign]])store.append({id:`route:${id}`,kind:'route',data});
 store.append({id:'feedback:job-a',kind:'feedback',data:{taskId:'job-a',owner:ours,utility:'used',parentIntegrationMs:7,source:'parent_report'}});
 store.append({id:'feedback:job-b',kind:'feedback',data:{taskId:'job-b',owner:ours,utility:'unused',source:'parent_report'}});
 const report=executionScorecard(historySummary(store,{limit:100,owner:ours}),{owner:ours});
 assert.equal(report.routeEvents,2);assert.equal(report.evidence.verifiedAccepted,1);
 assert.equal(report.evidence.verifiedRejected,0);assert.equal(report.evidence.unverified,1);
 assert.equal(report.evidence.parentFeedback,2);assert.equal(report.cohorts.length,1);
 assert.deepEqual(report.cohorts[0].route,{provider:'openai-codex',modelId:'gpt-6-astra',taskClass:'review',
  requestedThinking:'off',effectiveThinking:'low',modelTier:'frontier',preferenceSource:'user'});
 assert.deepEqual(report.cohorts[0].results,{routeEvents:2,completed:1,failed:1,cancelled:0,expired:0,other:0,
  verifiedAcceptedWithSingleRouteHop:1,verifiedAcceptedWithOneChildHandoff:1,
  verifiedAccepted:1,verifiedRejected:0,unverified:1});
 assert.deepEqual(report.cohorts[0].usage,{known:1,totalTokens:25,unknown:1});
 assert.deepEqual(report.cohorts[0].parentUtility,{used:1,reworked:0,redundant:0,unused:1,unreported:0});
 assert.equal(report.cohorts[0].routeHops.known,2);
 assert.equal(report.cohorts[0].routeHops.total,3);
 assert.deepEqual(report.cohorts[0].childHandoffs,{known:2,total:3,unknown:0});
 assert.deepEqual(report.physicalAttempts,{status:'not_observed',actual:null});
 assert.equal(report.money.actual,null);assert.equal(report.money.status,'unavailable');
 assert.equal(qualitySummary(store).length,0,'reported feedback and a route label alone cannot train verified quality');
 assert.doesNotMatch(JSON.stringify(report),/job-a|job-b|job-c|foreign|cursor|fixture-key/);
 assert.deepEqual(executionScorecard(historySummary(store,{limit:100}),{owner:other}).cohorts[0].route,
  {provider:'cursor',modelId:'composer-2.5',taskClass:'implementation',requestedThinking:'high',
   effectiveThinking:'high',modelTier:'standard',preferenceSource:'auto'});
});
test('verified quality observations expose actual effective effort without rewriting requested-effort context',t=>{
 const root=mkdtempSync(join(tmpdir(),'history-effort-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=new RoutingHistoryStore({path:join(root,'history.sqlite')});t.after(()=>store.close());
 for(const effectiveThinking of ['off','low']) store.append({id:`quality:${effectiveThinking}`,kind:'quality',data:{
  resourceId:'anthropic/model',context:'routing-v3:review:requested-off',capabilities:['code_reasoning'],
  effectiveThinking,outcome:'accepted',latencyMs:12}});
 const quality=qualitySummary(store);
 assert.equal(quality.length,2,'effective effort is not a hidden mixture inside reported verified quality');
 assert.deepEqual(quality.map(entry=>entry.effectiveThinking).sort(),['low','off']);
 assert.ok(quality.every(entry=>entry.context==='routing-v3:review:requested-off'
  && entry.requestedThinking==='off' && entry.samples===1 && entry.evidence==='insufficient'));
});
test('a pre-dispatch denial is a route hop, not an additional child or first-attempt failure',()=>{
 const owner=ownerKey('scope');
 const report=executionScorecard([{owner,status:'completed',provider:'cursor-account-2',modelId:'composer-2.5',
  context:'routing-v3:review:requested-off',effectiveThinking:'low',verification:'accepted',
  attempts:2,childHandoffs:1,latencyMs:4,tokens:{input:3,output:2},utility:null}],{owner});
 assert.equal(report.cohorts[0].routeHops.total,2);
 assert.equal(report.cohorts[0].childHandoffs.total,1);
 assert.equal(report.cohorts[0].results.verifiedAcceptedWithSingleRouteHop,0);
 assert.equal(report.cohorts[0].results.verifiedAcceptedWithOneChildHandoff,1);
});
test('scorecard reports missing effort and caps cohort detail without turning unknown into success',()=>{
 const owner=ownerKey('scope');
 const rows=['one','two','three'].map((taskId,i)=>({taskId,owner,status:'failed',context:'legacy',
  provider:`route${i}`,modelId:`model${i}`,effectiveThinking:null,verification:'unverified',
  attempts:0,latencyMs:0,tokens:null,utility:null}));
 const report=executionScorecard(rows,{owner,maxCohorts:1});
 assert.equal(report.routeEvents,3);assert.equal(report.cohorts.length,1);
 assert.equal(report.omittedCohorts,2);assert.equal(report.omittedRouteEvents,2);
 assert.equal(report.cohorts[0].route.requestedThinking,'unknown');
 assert.equal(report.cohorts[0].route.effectiveThinking,'unknown');
 assert.equal(report.cohorts[0].route.modelTier,'unknown');
 assert.equal(report.cohorts[0].route.preferenceSource,'unknown');
 assert.equal(report.cohorts[0].usage.unknown,1);
 assert.equal(report.cohorts[0].routeHops.known,0);
 assert.equal(report.cohorts[0].childHandoffs.unknown,1);
 assert.equal(report.money.actual,null);
});
