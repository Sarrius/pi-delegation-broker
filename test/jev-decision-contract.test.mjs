import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Check} from 'typebox/value';
import {registerJevAdvisory} from '../src/jev-pi-advisory.mjs';
import {makeJevDecision} from '../src/jev-decision.mjs';

const valid={question:'Which file should be inspected first?',context:'Both fixtures and their consumer need correction.',
 purpose:'qualification_fix_order',options:[
  {id:'host_first',meaning:'Inspect the host harness.',actionTool:'read'},
  {id:'fixtures_first',meaning:'Inspect the fixture generator.',actionTool:'read'},
 ]};
function harness(t){
 const stateDir=mkdtempSync(join(tmpdir(),'jev-decision-contract-'));
 writeFileSync(join(stateDir,'jev-engine.json'),JSON.stringify({schemaVersion:1,decisions:true,routing:true,
  consentToSendTaskText:true,scope:'all_cwds',autoThinkingMax:'low'}),{mode:0o600});
 let tool,calls=0;const hooks=new Map();let active=['read'];
 const pi={on(name,fn){const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list);},
  registerTool(value){tool=value;active.push(value.name);},registerCommand(){},
  getActiveTools(){return active;},setActiveTools(value){active=value;},appendEntry(){}};
 const advisor=registerJevAdvisory(pi,{stateDir,engineMode:true,getApiKey:()=> 'fixture-key',fetchImpl:async()=>{
  calls++;return Response.json({model:'jev-1.13.0',usage:{input_tokens:5,output_tokens:2},answers:{next_action:{
   type:'choice',choice:'host_first',confidence:0.8,probabilities:{host_first:0.8,fixtures_first:0.1,undecided:0.1}}}});
 }});
 t.after(()=>{advisor.close();rmSync(stateDir,{recursive:true,force:true});});
 return {tool,advisor,get calls(){return calls;},async emit(event){for(const fn of hooks.get('tool_result')??[])await fn(event,{cwd:stateDir});},ctx:{cwd:stateDir}};
}

test('advertised schema discloses identifier and bare-tool constraints before dispatch',t=>{
 const h=harness(t);assert.equal(Check(h.tool.parameters,valid),true);
 const invalid=[
  {...valid,purpose:'qualification-fix-order'},
  {...valid,purpose:''},
  {...valid,options:[{...valid.options[0],id:'host-first'},valid.options[1]]},
  {...valid,options:[{...valid.options[0],actionTool:'functions.read'},valid.options[1]]},
  {...valid,options:[{...valid.options[0],meaning:'  '},valid.options[1]]},
  {...valid,question:'   '},
 ];
 for(const input of invalid)assert.equal(Check(h.tool.parameters,input),false,'invalid contract must be advertised as invalid');
 assert.equal(h.calls,0);
});

test('direct invalid calls throw actionable non-echoing errors and send no request',async t=>{
 const h=harness(t);
 for(const input of [
  {...valid,purpose:'qualification-fix-order'},
  {...valid,options:[valid.options[0],valid.options[0]]},
  {...valid,options:[{...valid.options[0],id:'undecided'},valid.options[1]]},
  {...valid,options:[{...valid.options[0],actionTool:'functions.read'},valid.options[1]]},
 ]){
  await assert.rejects(h.tool.execute('invalid',input,undefined,undefined,h.ctx),error=>{
   assert.match(error.message,/snake_case/);assert.match(error.message,/No external request/);
   assert.doesNotMatch(error.message,/qualification-fix-order|Both fixtures/);return true;
  });
 }
 assert.equal(h.calls,0);
});

test('runtime does not coerce non-string identifiers or silently lose action accounting',()=>{
 assert.equal(makeJevDecision({...valid,purpose:null}),undefined);
 assert.equal(makeJevDecision({...valid,options:[{...valid.options[0],id:null},valid.options[1]]}),undefined);
 assert.equal(makeJevDecision({...valid,options:[{...valid.options[0],actionTool:'functions.read'},valid.options[1]]}),undefined);
});

test('valid typed decision still applies only after the successful bare named tool',async t=>{
 const h=harness(t);
 const result=await h.tool.execute('valid',valid,undefined,undefined,h.ctx);
 assert.match(result.content[0].text,/Jev chose host_first/);assert.equal(h.calls,1);
 assert.equal(h.advisor.engineMetrics.summary().byFunction.decision.applied,0);
 await h.emit({toolName:'read',isError:true});
 assert.equal(h.advisor.engineMetrics.summary().byFunction.decision.applied,0);
 // A failed first action consumes that observation; a retry needs a new decision.
 await h.tool.execute('retry',{...valid,question:'Which source should the retry inspect?'},undefined,undefined,h.ctx);
 await h.emit({toolName:'read',isError:false});
 assert.equal(h.advisor.engineMetrics.summary().byFunction.decision.applied,1);
});
