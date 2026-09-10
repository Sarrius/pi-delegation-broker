import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BrokeredChildRunner } from '../src/brokered-runner.mjs';
import { retainedWork } from '../src/retained-work.mjs';

test('failed isolated child patch survives cleanup and remains unverified', async t => {
 const root=mkdtempSync(join(tmpdir(),'partial-patch-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git('init','-q'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Fixture');
 writeFileSync(join(root,'value.txt'),'before\n'); git('add','.'); git('commit','-qm','initial');
 const model={provider:'broker-fake',modelId:'lease-fake'};
 const runner=new BrokeredChildRunner({sessionsRoot:join(root,'attempts'),resolver:{async resolve(){return {
  action:'allow',resource:{id:'fake/model'},resolvedModel:model,policy:{policyId:'fixture',agentDir:root,environment:{},async onChildSessionOpened(){},async onChildSessionClosed(){}}
 };}},spawnChild:async ({spec})=>{
  writeFileSync(join(spec.cwd,'value.txt'),'unfinished change\n');
  return {resolved:model,session:{usage:{input:1,output:1},async prompt(){throw new Error('fixture crash');},async dispose(){}}};
 }});
 const result=await runner.run({childId:'recover-patch',prompt:'edit',promptDigest:'a'.repeat(64),cwd:root,model,isolation:'worktree',maxAttempts:1});
 assert.notEqual(result.status,'completed');
 const evidence=retainedWork(join(root,'attempts'),'recover-patch');
 const patch=evidence.artifacts.find(a=>a.path.includes('patch-'));
 assert.ok(patch,JSON.stringify(evidence));
 const captured=JSON.parse(readFileSync(patch.path,'utf8'));
 assert.match(captured.patch,/unfinished change/);
 assert.equal(captured.verificationStatus,'unverified');
 assert.equal(readFileSync(join(root,'value.txt'),'utf8'),'before\n');
});
