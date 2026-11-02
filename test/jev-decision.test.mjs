import test from 'node:test';
import assert from 'node:assert/strict';
import {makeJevDecision,describeJevDecision,JEV_DECISION_VERSION} from '../src/jev-decision.mjs';
import {JevAdvisor} from '../src/jev-advisor.mjs';
import {jevConfigFromEngine,engineNextState} from '../src/jev-engine-settings.mjs';
const input={question:'Which next step?',context:'The child states tests pass but provides no test output.',purpose:'result_followup',
 options:[{id:'verify',meaning:'Run the relevant tests before claiming success.'},{id:'accept',meaning:'Accept an authenticated controller receipt.'}]};

test('one typed parent action is chosen; its confidence is not a verified child-task probability',()=>{
 const request=makeJevDecision(input);assert.equal(request.version,JEV_DECISION_VERSION);
 assert.equal(makeJevDecision({...input,options:[{id:'verify',meaning:'a'},{id:'verify',meaning:'b'}]}),undefined);
 const result={status:'evaluated',version:JEV_DECISION_VERSION,model:'jev-1.13.0',assessments:[{id:'next_action',assessment:'verify',confidence:0.74}],usage:{inputTokens:12,outputTokens:2}};
 const advice=describeJevDecision(result,request);
 assert.equal(advice.selected,'verify');assert.equal(advice.qualityEvidence,false);
 assert.equal(describeJevDecision({...result,status:'skipped'},request),undefined);
});

test('operational decision switch makes actual bounded Jev API request; OFF never reads key or calls provider',async()=>{
 let calls=0,keys=0;
 const on=engineNextState(undefined,'decisions-on');let enabled=jevConfigFromEngine(on);
 const adviser=new JevAdvisor({config:()=>enabled,getApiKey:()=>{keys++;return 'fixture-key';},fetchImpl:async(_url,init)=>{
  calls++;const question=JSON.parse(init.body).questions.next_action;
  assert.equal(question.criteria.verify.includes('Run'),true);
  return Response.json({model:'jev-1.13.0',usage:{input_tokens:22,output_tokens:5},answers:{next_action:{type:'choice',choice:'verify',confidence:0.8,
    probabilities:{verify:0.8,accept:0.1,undecided:0.1}}}});
 }});
 const request={...makeJevDecision(input),localScopeCwd:process.cwd()};
 const chosen=await adviser.evaluate(request);assert.equal(chosen.status,'evaluated');assert.equal(calls,1);
 const keyReads=keys;
 enabled=jevConfigFromEngine(engineNextState(on,'off'));
 assert.equal((await adviser.evaluate({...request,state:{...request.state,question:'different'}})).status,'skipped');
 assert.equal(keys,keyReads,'OFF must not read a credential again');assert.equal(calls,1);
});
