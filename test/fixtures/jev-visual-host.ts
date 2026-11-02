import assert from 'node:assert/strict';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {registerJevAdvisory} from '../../src/jev-pi-advisory.mjs';
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export default function(pi:any){
 let requests=0;
 registerJevAdvisory(pi,{stateDir:process.env.JEV_VISUAL_STATE,engineMode:true,getApiKey:()=> 'synthetic-key',fetchImpl:async(url:any,init:any)=>{
  assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.headers['TypeSafe-Danger-Zone-Images'],'true');
  const request=JSON.parse(init.body);assert.equal(request.model,'jev-1.14.0');assert.equal(Object.keys(request.assets).length,1);requests++;
  return Response.json({model:'jev-1.14.0',answers:{present:{type:'noul',noul:.99},target:{type:'box',box:{top:.3,bottom:.7,left:.25,right:.75},confidence:.95}},usage:{input_tokens:10,output_tokens:10}});
 }});
 pi.registerProvider('visual-fixture',{baseUrl:'https://fixture.invalid',api:'visual-fixture',apiKey:'synthetic-parent',
  models:[{id:'parent',name:'Parent',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1000,cost:usage.cost}],
  streamSimple(model:any,context:any){const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
   const result=context.messages.find((m:any)=>m.role==='toolResult'&&m.toolName==='delegate_visual');
   if(result){assert.equal(result.details.observation.status,'located');assert.equal(requests,1);}
   const content=result?[{type:'text',text:'VISUAL_NATIVE_OK'}]:[{type:'toolCall',id:'visual-call',name:'delegate_visual',arguments:{path:process.env.JEV_VISUAL_IMAGE,target:'the red rectangle'}}];
   const reason=result?'stop':'toolUse';const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage,stopReason:reason,timestamp:Date.now()};
   stream.push({type:'start',partial:message});stream.push({type:result?'text_start':'toolcall_start',contentIndex:0,partial:message});
   stream.push({type:result?'text_delta':'toolcall_delta',contentIndex:0,delta:result?content[0].text:JSON.stringify(content[0].arguments),partial:message});
   stream.push(result?{type:'text_end',contentIndex:0,content:content[0].text,partial:message}:{type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message});
   stream.push({type:'done',reason,message});stream.end(message);
  });return stream;}});
}
