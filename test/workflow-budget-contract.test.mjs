import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskOrchestrator,appendWorkflowNodes} from '../src/workflow-scheduler.mjs';
import {readJob,updateJob,recoverJobs,submitJob,markTaskAdmitted} from '../src/delegation-job-store.mjs';
const modern={inputBudgetPolicy:'metered_default_v1',outputBudgetPolicy:'metered_default_v2'};
function fixture(t,run){const root=mkdtempSync(join(tmpdir(),'workflow-contract-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,runner:new TaskOrchestrator({root,jobId:'team',concurrency:1,run})};}

test('cold recovery refuses unknown capped usage but preserves metered task attempt counts',t=>{
 const {root}=fixture(t,async()=>({status:'completed'}));
 const task=(jobId,extra={})=>({schemaVersion:1,jobId,kind:'task',status:'submitted',task:'inspect',cwd:root,submittedAt:1,updatedAt:1,...modern,...extra});
 submitJob(root,task('metered'));markTaskAdmitted(root,'metered',2,{maxAttempts:2});
 submitJob(root,task('capped',{maxOutputTokens:100}));markTaskAdmitted(root,'capped',2,{maxAttempts:2});
 submitJob(root,task('legacy',{inputBudgetPolicy:undefined,outputBudgetPolicy:undefined,status:'running'}));
 submitJob(root,task('old-queued',{inputBudgetPolicy:undefined,outputBudgetPolicy:undefined,status:'queued',startedAt:2,recoveryCount:1}));
 recoverJobs(root,3);
 assert.equal(readJob(root,'capped').status,'failed');assert.equal(readJob(root,'legacy').status,'failed');
 assert.equal(readJob(root,'old-queued').status,'failed','an old queued state is not proof that nothing was spent');
 assert.equal(readJob(root,'metered').status,'queued');assert.equal(readJob(root,'metered').startedAttempts,1);
 updateJob(root,'metered',j=>({...j,status:'submitted'}),4);markTaskAdmitted(root,'metered',5,{maxAttempts:2});
 assert.throws(()=>markTaskAdmitted(root,'metered',6,{maxAttempts:2}),/attempt.*budget/);
});

test('cold workflow recovery cannot refund an in-flight explicit root budget',t=>{
 const {root,runner}=fixture(t,async()=>assert.fail('must not dispatch'));
 runner.initialize([{id:'one',task:'inspect'}],{...modern,budgets:{maxOutputTokens:100}});
 updateJob(root,'team',j=>({...j,status:'running',nodes:j.nodes.map(n=>({...n,state:'running'}))}));
 recoverJobs(root);assert.equal(readJob(root,'team').status,'failed');
});

test('old graceful pauses without a budget settlement receipt cannot refill a root cap',t=>{
 const {root,runner}=fixture(t,async()=>assert.fail('must not dispatch'));
 runner.initialize([{id:'one',task:'inspect'}],{...modern,budgets:{maxOutputTokens:100}});
 updateJob(root,'team',j=>({...j,terminalReason:'paused for controller shutdown'}));
 recoverJobs(root);assert.equal(readJob(root,'team').status,'failed');
});

test('unknown output usage fails a bounded root without dispatching more work',async t=>{
 let calls=0;const {root,runner}=fixture(t,async()=>{calls++;return {status:'completed'};});
 runner.initialize([{id:'one',task:'one'},{id:'two',task:'two'}],{...modern,budgets:{maxOutputTokens:100}});
 assert.equal((await runner.execute()).status,'failed');assert.equal(calls,1);
 assert.equal(readJob(root,'team').budgetAccountingUncertain,true);
});

test('legacy per-node ceilings cannot be replenished by graceful interruption',async t=>{
 const stop=new AbortController();const {root,runner}=fixture(t,async()=>{stop.abort('shutdown');return {status:'failed',usage:{output:20}};});
 runner.initialize([{id:'one',task:'one'}]);
 updateJob(root,'team',j=>({...j,inputBudgetPolicy:undefined,outputBudgetPolicy:undefined}));
 const result=await runner.execute({signal:stop.signal});assert.equal(result.nodes[0].state,'failed');
 assert.match(result.nodes[0].error,/cannot safely replenish/);
});

test('shutdown usage remains charged when a workflow resumes',async t=>{
 const stop=new AbortController();
 const {root,runner}=fixture(t,async node=>{assert.equal(node.controllerBudget.maxOutputTokens,100);stop.abort('shutdown');return {status:'failed',usage:{output:60}};});
 runner.initialize([{id:'one',task:'inspect source'}],{...modern,budgets:{maxOutputTokens:100}});
 const paused=await runner.execute({signal:stop.signal});
 assert.equal(paused.status,'queued');assert.equal(paused.team.usage.outputTokens,60);
 recoverJobs(root);assert.equal(readJob(root,'team').status,'queued','current accounted pause remains resumable');
 const resumed=new TaskOrchestrator({root,jobId:'team',concurrency:1,run:async node=>{
  assert.equal(node.controllerBudget.maxOutputTokens,40);return {status:'completed',usage:{output:40}};
 }});
 const result=await resumed.execute();assert.equal(result.status,'completed');assert.equal(result.team.usage.outputTokens,100);
});

test('an observed output overshoot is durably recorded, not rejected as invalid state',async t=>{
 const {root,runner}=fixture(t,async()=>({status:'completed',usage:{output:120}}));
 runner.initialize([{id:'one',task:'inspect source'}],{...modern,budgets:{maxOutputTokens:100}});
 const result=await runner.execute();assert.equal(result.status,'failed');
 assert.equal(readJob(root,'team').team.usage.outputTokens,120);
});

test('proposal replay and duplicate admission bind the complete execution contract',t=>{
 const {root,runner}=fixture(t,async()=>({status:'completed'}));
 runner.initialize([{id:'one',task:'one'}],{...modern,dynamic:true,budgets:{maxNodes:8,maxAppends:5}});
 appendWorkflowNodes(root,'team',[{id:'two',task:'two',thinking:'off'}],{proposalId:'p'});
 for(const change of [{thinking:'high'},{tier:'frontier'},{acceptance:[{id:'git-diff-check'}]},
  {work:{taskClass:'review',deliverable:'result',benefit:'audit',parentWork:'integration',maxAttempts:1}}]){
  assert.throws(()=>appendWorkflowNodes(root,'team',[{id:'two',task:'two',thinking:'off',...change}],{proposalId:'p'}),/digest/);
 }
 assert.throws(()=>appendWorkflowNodes(root,'team',[{id:'three',task:'two',thinking:'high'}]),/execution contract/);
 assert.equal(readJob(root,'team').nodes.length,2);
});

test('proposal replay retains the alias mapping for reused work',t=>{
 const {root,runner}=fixture(t,async()=>({status:'completed'}));
 runner.initialize([{id:'a',task:'same'}],{...modern,dynamic:true});
 const nodes=[{id:'b',task:'same'}], options={proposalId:'reuse'};
 const original=appendWorkflowNodes(root,'team',nodes,options);
 const replay=appendWorkflowNodes(root,'team',nodes,options);
 assert.deepEqual(replay.reused.map(({requestedId,existingId})=>({requestedId,existingId})),
  original.reused.map(({requestedId,existingId})=>({requestedId,existingId})));
 assert.equal(replay.reused[0].existingId,'a');
});

test('deduplication cannot persist dependencies on a dropped requested node ID',t=>{
 const {root,runner}=fixture(t,async()=>({status:'completed'}));
 runner.initialize([{id:'a',task:'same'}],{...modern,dynamic:true});
 assert.throws(()=>appendWorkflowNodes(root,'team',[
  {id:'b',task:'same'}, {id:'c',task:'different',dependsOn:['b'],inputs:['b']}
 ]),/unknown.*dependency|dependency.*unknown/);
 assert.deepEqual(readJob(root,'team').nodes.map(n=>n.id),['a']);
});
