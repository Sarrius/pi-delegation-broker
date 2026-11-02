import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJevVisualRequest, describeJevVisual } from '../src/jev-visual.mjs';
import { JevAdvisor } from '../src/jev-advisor.mjs';

import {visualFixture as png} from './fixtures/jev-visual-image.mjs';
const cfg={mode:'advisory',consentToSendTaskText:true,visual:true,consentToSendImages:true,visualModel:'jev-1.14.0'};
const request=()=>makeJevVisualRequest({bytes:png(),target:'the red rectangle'});
const response=(present=.95,box={left:.1,right:.8,top:.2,bottom:.9})=>new Response(JSON.stringify({model:'jev-1.14.0',
 answers:{present:{type:'noul',noul:present},target:{type:'box',box,confidence:.9}},usage:{input_tokens:100,output_tokens:20}}));

test('visual requests require separate consent before dispatch',async()=>{
 let keys=0,calls=0;
 const advisor=new JevAdvisor({config:{...cfg,consentToSendImages:false},getApiKey:()=>{keys++;return 'test';},fetchImpl:()=>{calls++;}});
 assert.equal((await advisor.evaluate(request())).reason,'image_consent_required');assert.equal(calls,0);
 // Normal advisory refresh may consult the existing text credential, but cannot send an image.
 assert.ok(keys<=1);
});
test('image and Box use experimental header and a separately pinned model in the ordinary bounded lifecycle',async()=>{
 let calls=0;
 const advisor=new JevAdvisor({config:cfg,getApiKey:()=> 'test',fetchImpl:async(_url,init)=>{
  calls++;const body=JSON.parse(init.body);assert.equal(init.headers['TypeSafe-Danger-Zone-Images'],'true');
  assert.equal(body.model,'jev-1.14.0');assert.equal(Object.keys(body.assets).length,1);
  assert.equal(body.questions.present.type,'noul');assert.equal(body.questions.target.type,'box');
  assert.ok(!JSON.stringify(body).includes('/private/'));return response();
 }});
 const req=request();req.localScopeCwd='/private/project';
 const result=await advisor.evaluate(req);assert.equal(result.status,'evaluated');
 assert.equal(describeJevVisual(result).status,'located');assert.equal(result.authority,'none');
 assert.equal((await advisor.evaluate(req)).cached,true);assert.equal(calls,1);
});
test('absent or uncertain objects never expose usable coordinates',async()=>{
 for(const p of [.01,.5]){
  const advisor=new JevAdvisor({config:cfg,getApiKey:()=> 'test',fetchImpl:async()=>response(p)});
  const evaluated=await advisor.evaluate(request());assert.equal(evaluated.status,'evaluated');
  const result=describeJevVisual(evaluated);
  assert.notEqual(result.status,'located');assert.equal(result.box,undefined);
 }
});
test('malformed coordinates are rejected, not clamped into an apparently valid location',async()=>{
 for(const box of [{left:.8,right:.1,top:0,bottom:1},{left:-.1,right:1,top:0,bottom:1}]){
  const advisor=new JevAdvisor({config:cfg,getApiKey:()=> 'test',fetchImpl:async()=>response(.99,box)});
  assert.equal((await advisor.evaluate(request())).reason,'invalid_response');
 }
});
test('revoking image consent invalidates a cached result and a response already in flight',async()=>{
 let config={...cfg};let release;let calls=0;
 const advisor=new JevAdvisor({config:()=>config,getApiKey:()=> 'test',fetchImpl:async()=>{
  calls++;if(calls===2)await new Promise(resolve=>{release=resolve;});return response();}});
 const first=request();assert.equal((await advisor.evaluate(first)).status,'evaluated');
 config={...cfg,consentToSendImages:false};
 assert.equal((await advisor.evaluate(first)).reason,'image_consent_required');assert.equal(calls,1);
 config={...cfg};const pending=advisor.evaluate(request());
 config={...cfg,consentToSendImages:false};release();
 assert.equal((await pending).reason,'stale_or_cancelled');
});
test('visual shares the request budget and malformed references never dispatch',async()=>{
 let calls=0;const advisor=new JevAdvisor({config:{...cfg,maxRequestsPerSession:1},getApiKey:()=> 'test',fetchImpl:async()=>{calls++;return response();}});
 const malformed=request();malformed.state.image='missing';
 assert.equal((await advisor.evaluate(malformed)).reason,'invalid_input');assert.equal(calls,0);
 assert.equal((await advisor.evaluate(request())).status,'evaluated');
 const other=makeJevVisualRequest({bytes:png(),target:'another rectangle'});
 assert.equal((await advisor.evaluate(other)).reason,'request_allowance');assert.equal(calls,1);
});
test('unsupported and out-of-range images fail locally',()=>{
 assert.throws(()=>makeJevVisualRequest({bytes:Buffer.from('GIF89a'),target:'thing'}));
 const tooSmall=png();tooSmall.writeUInt32BE(279,16);
 assert.throws(()=>makeJevVisualRequest({bytes:tooSmall,target:'thing'}));
 assert.throws(()=>makeJevVisualRequest({bytes:png(),target:' '}));
});
