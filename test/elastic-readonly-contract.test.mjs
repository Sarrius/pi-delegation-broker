import assert from 'node:assert/strict';
import test from 'node:test';
import {reportOwnerJob} from '../src/report-store.mjs';
import {storedInputCap,storedOutputCap} from '../src/delegation-policy.mjs';
import {writeJob,readJob,recoverJobs,submitJob} from '../src/delegation-job-store.mjs';
import {selectModelForTask} from '../src/model-selector.mjs';
import {fixtureContract,fixtureRegistry,SqliteLeaseBroker} from '../src/broker.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('input budget migration preserves old intent and explicit caps, not just output-v2 marker',()=>{
 assert.equal(storedInputCap({}),1_000_000);
 assert.equal(storedInputCap({outputBudgetPolicy:'metered_default_v2'}),1_000_000);
 assert.equal(storedInputCap({inputBudgetPolicy:'metered_default_v1'}),undefined);
 assert.equal(storedInputCap({inputBudgetPolicy:'metered_default_v1',maxInputTokens:1200}),1200);
 assert.equal(storedInputCap({inputBudgetPolicy:'metered_default_v1',maxInputTokens:1200},{maxInputTokens:600}),600);
});

test('controller allowances intersect rather than replace explicit or legacy task ceilings',()=>{
 assert.equal(storedOutputCap({}, {maxOutputTokens:50_000}),16_000);
 assert.equal(storedOutputCap({maxOutputTokens:1000},{maxOutputTokens:5000}),1000);
 assert.equal(storedOutputCap({maxOutputTokens:50_000},{maxOutputTokens:80_000}),50_000,'legacy explicit intent replaces its old implicit default, not the root bound');
 assert.equal(storedOutputCap({outputBudgetPolicy:'metered_default_v2'},{maxOutputTokens:50_000}),50_000);
 assert.equal(storedInputCap({}, {maxInputTokens:2_000_000}),1_000_000);
 assert.equal(storedInputCap({inputBudgetPolicy:'metered_default_v1',maxInputTokens:1000},{maxInputTokens:5000}),1000);
 assert.equal(storedInputCap({maxInputTokens:2_000_000},{maxInputTokens:3_000_000}),2_000_000);
});

test('durable input policy survives restart, rejects unknown policies/caps and never widens legacy replay',t=>{
 const root=mkdtempSync(join(tmpdir(),'input-migration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const job={schemaVersion:1,jobId:'input-v1',kind:'task',status:'submitted',submittedAt:1000,updatedAt:1000,cwd:'/tmp',task:'review source',ownerSessionId:'owner-a',idempotencyKey:'stable-input',inputBudgetPolicy:'metered_default_v1'};
 writeJob(root,job);
 recoverJobs(root,1001,{ownerSessionId:'owner-a'});
 assert.equal(readJob(root,job.jobId).inputBudgetPolicy,'metered_default_v1');
 assert.throws(()=>writeJob(root,{...job,inputBudgetPolicy:'future_unknown'}),/inputBudgetPolicy/);
 for(const field of ['maxInputTokens','maxOutputTokens']) for(const value of [0,-1,Infinity,'1000']) {
  assert.throws(()=>writeJob(root,{...job,[field]:value}),new RegExp(field));
  assert.throws(()=>selectModelForTask({taskDescription:'review',registry:fixtureRegistry(),constraints:{budget:{[field]:value}}}),new RegExp(field));
 }
 const old={...job,jobId:'old-input',idempotencyKey:'old-input',inputBudgetPolicy:undefined};
 writeJob(root,old);
 const replay=submitJob(root,{...old,jobId:'new-input',inputBudgetPolicy:'metered_default_v1'});
 assert.equal(replay.created,false);
 assert.equal(storedInputCap(replay.job),1_000_000);
});

for (const explicit of [false,true]) test(`observed input beyond 1M respects ${explicit?'explicit limit':'meter-only ordinary read policy'}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'input-policy-'));
 const broker=new SqliteLeaseBroker({path:join(root,'broker.sqlite'),registry:fixtureRegistry()});
 try {
  const contract=fixtureContract({budget:{...(explicit?{maxInputTokens:1_000_000}:{}),maxAttempts:3,enforcement:{input:'metered_best_effort',output:'unavailable'}}});
  const leased=broker.reserve(contract,1000);
  assert.equal(leased.status,'leased');
  const {leaseId,fencingToken}=leased.lease;
  assert.equal(broker.reserveProviderInput(leaseId,fencingToken,1_100_000,1001).status,'reserved');
  const result=broker.recordProviderUsage(leaseId,fencingToken,{input:1_095_445,output:20_000},1002,{inputReserved:true,reservedInputUpperBound:1_100_000});
  assert.equal(result.status,explicit?'budget_exceeded':'recorded');
 } finally {broker.close();rmSync(root,{recursive:true,force:true});}
});

test('workflow report resolves an exact durable node, not a guessed prefix or supplied owner',()=>{
 const workflow={kind:'workflow',jobId:'workflow-a',ownerSessionId:'owner-a',nodes:[{id:'node',result:{reportTaskId:'workflow-a-node'}}]};
 const jobs=new Map([['workflow-a',workflow],['foreign',{kind:'task',jobId:'foreign',ownerSessionId:'owner-b'}]]);
 const read=id=>jobs.get(id);
 const report={taskId:'workflow-a-node',logicalId:'workflow-a/node'};
 assert.equal(reportOwnerJob(report,read),workflow);
 assert.equal(reportOwnerJob({...report,logicalId:'workflow-a/missing'},read),undefined);
 assert.equal(reportOwnerJob({...report,taskId:'workflow-a-node-other'},read),undefined);
 assert.equal(reportOwnerJob({...report,logicalId:'../workflow-a/node'},read),undefined);
 assert.equal(reportOwnerJob({...report,logicalId:undefined,ownerSessionId:'owner-a'},read),undefined);
 assert.equal(reportOwnerJob({...report,taskId:'foreign'},read).ownerSessionId,'owner-b');
 workflow.nodes[0].result.reportTaskId='other-result';
 assert.equal(reportOwnerJob(report,read),undefined);
});
