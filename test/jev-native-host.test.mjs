import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

for(const scenario of ['off','no-key','advice','billing','async-advice','async-billing','billing-recovery','async-billing-recovery','routing-shadow','routing-billing','routing-role','routing-no-consent','active-model','active-low','active-no-consent','active-scope-denied','active-billing','active-no-key','active-workflow-dependency']) test(`fresh Pi: ${scenario} observer preserves real isolated child execution`,{timeout:30000},async t=>{
 // Keep Unix socket paths short on macOS, as in standalone-native-host.test.mjs.
 const home=mkdtempSync('/tmp/pijv-');t.after(()=>rmSync(home,{recursive:true,force:true}));
 const agent=join(home,'.pi/agent'),result=join(home,'result.json');mkdirSync(join(agent,'delegation-broker'),{recursive:true,mode:0o700});
 writeFileSync(join(agent,'auth.json'),JSON.stringify({anthropic:{type:'api_key',key:'fixture-native'},
  ...(scenario.startsWith('active-')?{'openai-codex-account-2':{type:'api_key',key:'fixture-codex'}}:{})}));
 writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[],quietStartup:true,defaultProjectTrust:'always',defaultProvider:'jev-parent',defaultModel:'parent'}));
 writeFileSync(join(agent,'delegation-broker/jev.json'),JSON.stringify({
  mode:scenario==='off'?'off':'advisory',consentToSendTaskText:scenario!=='off',
  ...(scenario==='routing-no-consent'?{routeShadow:true,consentToSendRoutingState:false}
   :scenario.startsWith('routing-')?{routeShadow:true,consentToSendRoutingState:true}:{})
 }));
 if(scenario.startsWith('active-')) writeFileSync(join(agent,'delegation-broker/jev-active.json'),JSON.stringify({
  schemaVersion:1,activeRouting:true,consentToSendActiveRoutingState:scenario!=='active-no-consent',
  activeProjectRoots:[scenario==='active-scope-denied'?join(home,'unapproved'):home],activeAutoThinkingMax:'low',
 }),{mode:0o600});
 // Isolated fixture approval for the NEW engine; historical jev.json/jev-active.json
 // remain present precisely to prove that they cannot silently activate it.
 if(['active-model','active-low','active-billing','active-workflow-dependency','active-no-key'].includes(scenario))
  writeFileSync(join(agent,'delegation-broker/jev-engine.json'),JSON.stringify({schemaVersion:1,
   decisions:true,routing:true,consentToSendTaskText:true,scope:'all_cwds',autoThinkingMax:'low'}),{mode:0o600});
 const env={...process.env,HOME:home,PI_CODING_AGENT_DIR:agent,PI_JEV_API_KEY:'fixture-jev-not-live',JEV_FIXTURE_RESULT:result,JEV_FIXTURE_SCENARIO:scenario};
 if(scenario==='no-key'||scenario==='active-no-key')delete env.PI_JEV_API_KEY;
 const child=spawn(process.env.PI_BIN??'pi',['--offline','--no-context-files','--no-skills','--no-extensions','--no-session',
  '-e',new URL('./fixtures/jev-native-host.ts',import.meta.url).pathname,
  '-e',new URL('../extensions/pi-delegation-broker.ts',import.meta.url).pathname,'-p','--mode','json','Run the optional observer canary'],{
  stdio:['ignore','pipe','pipe'],cwd:home,env,detached:true,
 });
 t.after(()=>{if(child.exitCode===null)try{process.kill(-child.pid,'SIGTERM')}catch{}});
 let output='';child.stdout.on('data',d=>{output+=d});child.stderr.on('data',d=>{output+=d});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
 assert.equal(code,0,output);assert.match(output,/JEV_PARENT_OK/);
 const evidence=JSON.parse(readFileSync(result,'utf8'));
 assert.equal(evidence.childRequests,scenario==='active-workflow-dependency'?2:1,
  'optional observer must not change physical child attempts');
 assert.equal(evidence.delegated.isError,false);
 if(scenario==='off'||scenario==='no-key') {
  assert.equal(evidence.jevRequests,0,'without Jev the same child must complete with no advisor request');
  assert.equal(evidence.routeRequests,0);
  assert.equal(evidence.reviewed,undefined);
  assert.deepEqual(evidence.delegated.content,[{type:'text',text:'JEV_CHILD_OK'}]);
 } else if(scenario.startsWith('active-')) {
  assert.equal(evidence.childRequests,scenario==='active-workflow-dependency'?2:1);
  assert.equal(evidence.activeRequests,['active-model','active-low','active-billing','active-workflow-dependency'].includes(scenario)?1:0,
   'only an authorized scoped launch with a usable key may ask Jev before the child opens');
  if(scenario==='active-model'||scenario==='active-low') {
   assert.equal(evidence.childModel,'openai-codex-account-2/gpt-5.6-sol',
    'the actual native child provider must match the controller-selected identity');
   assert.equal(evidence.childReasoning,scenario==='active-low'?'low':undefined,
    'the underlying native provider receives explicit low only in the supported auto effort arm');
   assert.match(JSON.stringify(evidence.delegated.content),/JEV_CHILD_OK/);
  } else if(scenario==='active-workflow-dependency') {
   assert.equal(evidence.delegated.isError,false);
   assert.equal(evidence.delegated.details?.status,'completed');
  } else if(scenario==='active-billing') {
   assert.equal(evidence.childReasoning,undefined);
   assert.doesNotMatch(evidence.delegated.details?.routeExplanation??'',/jevActive=/);
   assert.equal(evidence.delegated.isError,false,'a Jev HTTP402 cannot cancel a healthy child');
  }
 } else if(scenario.startsWith('routing-')||!scenario.startsWith('active-')) {
  assert.equal(evidence.jevRequests,0,'legacy advisory/shadow files are not engine approval');
  assert.equal(evidence.routeRequests,0);
  assert.match(JSON.stringify(evidence.delegated.content),/JEV_CHILD_OK/);
  assert.equal(evidence.delegated.isError,false);
 }
 assert.doesNotMatch(output,/"type":"extension_error"|fixture-jev-not-live/);
});
