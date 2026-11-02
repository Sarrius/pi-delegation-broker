import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {spawnBrokeredChild} from '../../src/child-launcher.mjs';
import {qualificationResponse,qualificationNativeEvents} from './qualification-response.mjs';

// Observe actual isolated Pi startup, not a timeout guessed to precede tool reporting.
const settlement=process.env.PROBE_SETTLEMENT;
let announceSpawn,announceInference,releaseInference;
const spawned=new Promise(resolve=>{announceSpawn=resolve});
const inferenceStarted=new Promise(resolve=>{announceInference=resolve});
const inferenceReleased=new Promise(resolve=>{releaseInference=resolve});
if(settlement){
 const originalSpawn=childProcess.spawn;
 childProcess.spawn=function(...args){
  const child=originalSpawn.apply(this,args);
  if(args[1]?.includes('--mode')&&args[1]?.includes('rpc')){
   const shim=JSON.parse(readFileSync(args[2].env.PI_SUBAGENT_SHIM_SPEC,'utf8'));
   announceSpawn({child,toolReportPath:shim.toolReportPath});
  }
  return child;
 };
 syncBuiltinESMExports();
}
const agent=join(process.env.HOME,'.pi','agent');mkdirSync(agent,{recursive:true,mode:0o700});
for(const [name,value] of Object.entries({'auth.json':{cursor:{type:'api_key',key:'fixture-parent-only-secret'}},'models-store.json':{},'models.json':{providers:{}},'settings.json':{packages:[]}}))writeFileSync(join(agent,name),JSON.stringify(value),{mode:0o600});
const tools=new Map(),hooks=new Map();
const pi={events:{on(){},emit(){}},on(name,handler){hooks.set(name,handler)},registerCommand(){},registerTool(def){tools.set(def.name,def)}};
(await import(process.env.BROKER_EXTENSION_PATH)).default(pi);
const route={provider:'cursor',id:'composer-2.5',name:'Composer',api:'openai-completions',baseUrl:'https://cursor.fixture.invalid/v1',contextWindow:200_000,maxTokens:32_000,reasoning:true,input:['text']};
let calls=0,qualificationAborted=false;const contexts=[];
const ctx={cwd:process.cwd(),sessionManager:{getSessionId:()=> 'live-probe-owner'},modelRegistry:{
 getAll:()=>[route],find:(provider,id)=>provider===route.provider&&id===route.id?route:undefined,
 getProvider:()=>({streamSimple(_model,context,request){calls++;contexts.push(context);
  if(process.env.PROBE_RESULT!=='transport')request.onResponse?.({status:process.env.PROBE_RESULT==='429'?429:200,headers:{'retry-after':'3'}});
  assert.equal(request.maxRetries,0);assert.equal(request.transport,'sse');
  return(async function*(){
   if(['running','shutdown'].includes(settlement)&&calls===1){
    announceInference();let abort;
    try {await Promise.race([inferenceReleased,new Promise(resolve=>{
     abort=resolve;if(request.signal.aborted)resolve();else request.signal.addEventListener('abort',abort,{once:true});
    })]);} finally {request.signal.removeEventListener('abort',abort)}
    if(request.signal.aborted){qualificationAborted=true;yield {type:'error',error:new Error('qualification cancelled')};return;}
   }
   if(process.env.PROBE_RESULT!=='ok'){yield {type:'error',error:new Error('private provider body')};return;}
   const response=qualificationResponse(context);assert.ok(response,'only a synthetic readiness prompt may reach this fixture');
   yield* qualificationNativeEvents(response);
  })();
 }}),getApiKeyAndHeaders:async()=>({ok:true,apiKey:'fixture-parent-only-secret'}),
},ui:{notify(){}}};
try {
hooks.get('session_start')({},ctx);
const cold=hooks.get('before_agent_start')({prompt:'Ordinary owner input',systemPrompt:'BASE'});
assert.ok(!cold || typeof cold.then!=='function','ordinary Enter never awaits controller startup or qualification');
assert.match(cold?.systemPrompt??'',/cached only/);
assert.match(cold?.systemPrompt??'',/none currently cached/);
assert.equal(calls,0,'constructing the prompt cannot spend provider inference');
// Positive parity: a real visible owner message must warm readiness automatically,
// without a model/tool explicitly asking for inventory and without awaiting inference.
const visible=hooks.get('message_start')?.({message:{role:'user',content:[{type:'text',text:'Ordinary owner input'}]}},ctx);
assert.equal(calls,0,'visible-input notification cannot synchronously run inference');
await visible;
if(settlement){
 let timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('qualification phase was not reached')),8000)});
 try {
  if(settlement==='startup'){
   const child=await Promise.race([spawned,deadline]);
   assert.equal(existsSync(child.toolReportPath),false,'settle while the real RPC is awaiting tool reporting');
  }else await Promise.race([inferenceStarted,deadline]);
 } finally {clearTimeout(timer)}
 if(settlement!=='shutdown'){
  await hooks.get('agent_start')?.({},ctx);
  await hooks.get('agent_end')?.({},ctx);
  await hooks.get('agent_settled')?.({},ctx);
  releaseInference();
 }
}
if(settlement==='shutdown'){
 let timer;
 try {await Promise.race([
  hooks.get('session_shutdown')({},ctx),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('shutdown did not drain qualification')),5000)}),
 ]);} finally {clearTimeout(timer)}
 const {child}=await spawned;
 assert.equal(qualificationAborted,true,'shutdown must abort the live native request');
 assert.ok(child.exitCode!==null||child.signalCode!==null,'shutdown must await actual child exit');
 assert.equal(calls,1,'cancelled qualification must not retry');
 console.log('verified inventory integration: in-flight qualification aborted and child exited on shutdown');
}else{
const warmDeadline=Date.now()+8000;
let warmed;
while(Date.now()<warmDeadline){
 warmed=await tools.get('delegate_inventory').execute('cached-inventory',{provider:'cursor',verifyLive:false},AbortSignal.timeout(20000),undefined,ctx);
 if(warmed.details.rows.length || warmed.details.diagnostics.some(row=>row.readiness.status==='failed'))break;
 await new Promise(resolve=>setTimeout(resolve,25));
}
assert.ok(warmed.details.rows.length || warmed.details.diagnostics.some(row=>row.readiness.status==='failed'),
 'automatic qualification must finish after ordinary input without explicit inference requests');
const result=await tools.get('delegate_inventory').execute('inventory',{provider:'cursor'},AbortSignal.timeout(20000),undefined,ctx);
assert.doesNotMatch(JSON.stringify(result),/fixture-parent-only-secret|private provider body/);
assert.equal(result.details.availabilityGuarantee,false);
const callsBeforePrompt=calls;
for(let i=0;i<3;i++){
 const cached=hooks.get('before_agent_start')({prompt:`Ordinary owner input ${i}`,systemPrompt:'BASE'});
 assert.ok(!cached || typeof cached.then!=='function','warm prompt roster is synchronous too');
 assert.match(cached?.systemPrompt??'',/cached only/);
 assert.match(cached?.systemPrompt??'',/BASE/);
 assert.equal(calls,callsBeforePrompt,'ordinary input never refreshes provider inference after explicit inventory');
 if(process.env.PROBE_RESULT==='ok')assert.match(cached.systemPrompt,/cursor\/composer-2\.5/);
 else assert.match(cached.systemPrompt,/none currently cached/,'failed routes remain diagnostics, never ready');
}
if(process.env.PROBE_RESULT!=='ok'){
 assert.equal(result.details.rows.length,0,'failed first qualification is NEVER offered to an agent');
 const row=result.details.diagnostics.find(r=>r.resourceId==='cursor/composer-2.5');assert.ok(row);
 assert.equal(row.readiness.status,'failed');assert.equal(row.state,'cooling_down');assert.equal(calls,1);
 console.log('verified inventory integration: native failure before owner work; no ready routes and no secret');
}else{
 const row=result.details.rows.find(r=>r.resourceId==='cursor/composer-2.5');assert.ok(row,JSON.stringify(result));
 assert.equal(row.state,'ready');assert.equal(row.readiness.evidence,'isolated_tool_roundtrip');assert.equal(calls,2);
 assert.ok(contexts.some(c=>c.messages.some(m=>m.role==='toolResult')),'real isolated child returned tool result');
 const before=calls;
 const plan=await tools.get('delegate_plan').execute('preview',{
  task:'Review the code PRIVATE_BRIEF_123',tier:'standard',capabilities:['code_reasoning'],
  work:{taskClass:'review',deliverable:'A short finding',benefit:'Independent review',parentWork:'Finish task'},
 },AbortSignal.timeout(20000),undefined,ctx);
 assert.equal(plan.details.reserved,false);assert.equal(plan.details.quotaReadiness,'verified_tool_roundtrip');
 assert.equal(calls,before,'same short-lived qualified route does not spend twice for advisory preview');
 assert.doesNotMatch(JSON.stringify(contexts),/PRIVATE_BRIEF_123/);
 console.log('verified inventory integration: cold isolated tool/result/report canary before owner work');
}
if(settlement){
 // Once controller work settles, the same hook must still reap a genuine orphan.
 // This RPC has no runner owner; preserving canaries must not disable cleanup.
 await new Promise(resolve=>setTimeout(resolve,10));
 let resolveExit;
 const exited=new Promise(resolve=>{resolveExit=resolve});
 const signals=[],exitListeners=[];
 const rpc={exited,onEvent(){},onExit(fn){exitListeners.push(fn)},stderrTail(){return ''},send(){},
  async request(){return {isStreaming:false,isCompacting:false,pendingMessageCount:0}},
  kill(signal){signals.push(signal);const event={code:null,signal};exitListeners.forEach(fn=>fn(event));resolveExit(event);}};
 await spawnBrokeredChild({spec:{model:'cursor/composer-2.5'},parentCwd:process.cwd(),sessionsDir:join(agent,'orphan-sessions'),
  childPiEntry:process.execPath,spawnRpc(_command,options){
   const shim=JSON.parse(readFileSync(options.env.PI_SUBAGENT_SHIM_SPEC,'utf8'));
   writeFileSync(shim.toolReportPath,JSON.stringify({activeTools:[]}));return rpc;
  }});
 await hooks.get('agent_settled')?.({},ctx);
 assert.deepEqual(signals,['SIGTERM'],'idle parent still reaps RPCs outside all live runner ownership');
 console.log(`verified parent settlement: ${settlement} qualification survived; orphan cleanup retained`);
}
}
} finally {
 releaseInference();
 await hooks.get('session_shutdown')?.({},ctx);
}
