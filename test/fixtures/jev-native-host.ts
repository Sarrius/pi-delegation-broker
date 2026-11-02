import assert from 'node:assert/strict';
import {qualificationResponse} from './qualification-response.mjs';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {writeFileSync} from 'node:fs';

const usage={input:8,output:4,cacheRead:0,cacheWrite:0,totalTokens:12,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function emit(stream:any,model:any,content:any[],reason='stop') {
 const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage,stopReason:reason,timestamp:Date.now()};
 stream.push({type:'start',partial:message});
 const tool=content[0]?.type==='toolCall';
 stream.push({type:tool?'toolcall_start':'text_start',contentIndex:0,partial:message});
 stream.push({type:tool?'toolcall_delta':'text_delta',contentIndex:0,delta:tool?JSON.stringify(content[0].arguments):content[0].text,partial:message});
 stream.push(tool?{type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message}:{type:'text_end',contentIndex:0,content:content[0].text,partial:message});
 stream.push({type:'done',reason,message});stream.end(message);
}
export default function jevNativeHost(pi:any) {
 let childRequests=0,jevRequests=0,routeRequests=0,activeRequests=0;
 let childModel:string|undefined,childReasoning:string|undefined;
 const scenario=process.env.JEV_FIXTURE_SCENARIO;
 const activeScenario=scenario?.startsWith('active-');
 const realNow=Date.now;
 let timeOffset=0;
 // Only this isolated fixture process advances time, before any child/lease exists.
 if(scenario?.includes('recovery')) Date.now=()=>realNow()+timeOffset;
 globalThis.fetch=async (url:any,init:any)=>{
  assert.equal(String(url),'https://api.typesafe.ai/v1/systemone','fixture forbids all real network');
  jevRequests++;
  const request=JSON.parse(init.body);
  if(request.questions?.effort || request.questions?.model) routeRequests++;
  if(request.state?.autoEffortCeiling!==undefined && request.state?.effortModel) activeRequests++;
  if(scenario==='routing-billing' && (request.questions?.effort || request.questions?.model)) return new Response('fixture routing billing failure',{status:402});
  if(scenario==='active-billing' && request.state?.autoEffortCeiling!==undefined) return new Response('fixture active billing failure',{status:402});
  if(!['routing-billing','active-billing'].includes(scenario??'') && scenario?.includes('billing')
    && (!scenario.includes('recovery') || jevRequests===1)) return new Response('fixture billing failure',{status:402});
  return Response.json({model:'jev-1.13.0',usage:{input_tokens:20,output_tokens:5},answers:Object.fromEntries(Object.entries(request.questions).map(([id,question]:[string,any])=>{
   const options=Object.keys(question.criteria);
   const choice=scenario==='active-model'&&id==='model'?'model_1'
    :scenario==='active-low'&&id==='effort'?'low'
    :options.includes('no_recommendation')?'no_recommendation':'potential_gap';
   return [id,{type:'choice',choice,confidence:0.9,
    probabilities:Object.fromEntries(options.map(key=>[key,key===choice?1:0]))}];
  }))});
 };
 const model={id:activeScenario?(scenario==='active-low'?'claude-haiku-5':'claude-opus-5'):'claude-sonnet-4-6',
  name:'Native fixture',reasoning:Boolean(activeScenario),input:['text'],contextWindow:activeScenario?400000:200000,
  maxTokens:activeScenario?32000:8192,cost:usage.cost};
 const fixtureStream=(model:any,_context:any,options:any)=>{
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
   options?.onResponse?.({status:200,headers:{'request-id':'jev-fixture'}});
   const qualification=qualificationResponse(_context);
   if(qualification){emit(stream,model,qualification.content,qualification.reason);return;}
   childRequests++;childModel=`${model.provider}/${model.id}`;childReasoning=options?.reasoning;
   emit(stream,model,[{type:'text',text:'JEV_CHILD_OK'}]);
  });return stream;
 };
 pi.registerProvider('anthropic',{
  name:'Jev fixture child',baseUrl:'https://standalone.invalid',api:'anthropic-messages',apiKey:'fixture-native',models:[model],
  streamSimple:fixtureStream,
 });
 if(activeScenario) pi.registerProvider('openai-codex-account-2',{
  name:'Jev Codex fixture child',baseUrl:'https://codex.invalid',api:'openai-codex-responses',apiKey:'fixture-codex',
  models:[{id:'gpt-5.6-sol',name:'Native Codex fixture',reasoning:true,input:['text'],contextWindow:400000,
    maxTokens:32000,thinkingLevelMap:{low:'low'},cost:usage.cost}],
  streamSimple:fixtureStream,
 });
 pi.registerProvider('jev-parent',{
  name:'Jev parent fixture',baseUrl:'https://parent.invalid',api:'jev-parent-api',apiKey:'fixture-parent',models:[{...model,id:'parent'}],
  streamSimple(model:any,context:any) {
   const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
    const results=context.messages.filter((message:any)=>message.role==='toolResult');
    const reviewed=results.find((message:any)=>message.toolName==='delegate_review');
    const delegated=results.find((message:any)=>message.toolName==='delegate'||message.toolName==='delegate_workflow');
    const collected=[...results].reverse().find((message:any)=>message.toolName==='delegate_collect'&&message.details?.status==='completed');
    if(delegated && scenario?.startsWith('async') && !collected) {
     setTimeout(()=>emit(stream,model,[{type:'toolCall',id:`jev-collect-${results.length}`,name:'delegate_collect',arguments:{taskId:delegated.details.taskId}}],'toolUse'),50);
    } else if(delegated) {
     const delivered=collected??delegated;
     writeFileSync(process.env.JEV_FIXTURE_RESULT!,JSON.stringify({childRequests,childModel,childReasoning,jevRequests,routeRequests,activeRequests,reviewed,delegated:delivered}));
     const deliveredMarker=scenario==='active-workflow-dependency'
      ? delivered.details?.status==='completed'&&childRequests===2
      : JSON.stringify(delivered.content).includes('JEV_CHILD_OK');
     emit(stream,model,[{type:'text',text:deliveredMarker?'JEV_PARENT_OK':'JEV_PARENT_FAILED'}]);
    } else {
     if(scenario?.includes('recovery')) timeOffset=300_001;
     const workflowNode=(id:string,task:string)=>({id,task,tier:'frontier',thinking:'auto',
      work:{taskClass:'lookup',deliverable:'Return fixture marker',benefit:'Independent canary',parentWork:'Wait for marker',maxAttempts:1}});
     const workflow=scenario==='active-workflow-dependency';
     emit(stream,model,[{type:'toolCall',id:'jev-delegate',name:workflow?'delegate_workflow':'delegate',
      arguments:workflow?{wait:true,nodes:[workflowNode('first','Return exactly JEV_CHILD_OK'),
        {...workflowNode('second','Read the prior node report, then return exactly JEV_CHILD_OK'),dependsOn:['first'],inputs:['first']}]}:
       {task:'Return exactly JEV_CHILD_OK',wait:!scenario?.startsWith('async'),thinking:scenario?.startsWith('routing-')||activeScenario?'auto':'off',
        tier:activeScenario?'frontier':'standard',
        ...(scenario==='routing-role'?{role:{name:'reviewer',mission:'Review this output, then return the exact marker.'}}:{}),
        work:{taskClass:'lookup',deliverable:'Return fixture marker',benefit:'Independent canary',parentWork:'Wait for marker',maxAttempts:1}},
     }],'toolUse');
    }
   });return stream;
  },
 });
}
