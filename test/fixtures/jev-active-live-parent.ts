import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';

// Opt-in live canary parent ONLY: no provider credential is read or exported here. The parent
// is scripted, while the normal controller leases one current subscription-native child.
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
 cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function emit(stream:any,model:any,content:any[],reason='stop') {
 const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage,
  stopReason:reason,timestamp:Date.now()};
 stream.push({type:'start',partial:message});
 const tool=content[0]?.type==='toolCall';
 stream.push({type:tool?'toolcall_start':'text_start',contentIndex:0,partial:message});
 stream.push({type:tool?'toolcall_delta':'text_delta',contentIndex:0,
  delta:tool?JSON.stringify(content[0].arguments):content[0].text,partial:message});
 stream.push(tool?{type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message}
  :{type:'text_end',contentIndex:0,content:content[0].text,partial:message});
 stream.push({type:'done',reason,message});stream.end(message);
}
export default function jevActiveLiveParent(pi:any) {
 pi.registerProvider('jev-canary-parent',{
  name:'Controller canary script (no parent inference)',baseUrl:'https://never-used.invalid',
  api:'jev-canary-parent-api',apiKey:'local-fixture-not-upstream',
  models:[{id:'parent',name:'Scripted parent',reasoning:false,input:['text'],contextWindow:128000,
   maxTokens:1000,cost:usage.cost}],
  streamSimple(model:any,context:any) {
   const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
    if(process.env.JEV_ACTIVE_LIVE_DRY_RUN==='1') {
     emit(stream,model,[{type:'text',text:'LIVE_CANARY_PARENT_READY'}]);return;
    }
    const delegated=context.messages.find((message:any)=>message.role==='toolResult'&&message.toolName==='delegate');
    if(!delegated) {
     emit(stream,model,[{type:'toolCall',id:'live-jev-delegate',name:'delegate',arguments:{
      task:'Read only src/behavior-monitor.mjs. A monitor with repeatedNoProgressLimit=3 receives identical read results with unchanged state: one result for modelTurnId=1, then three parallel results for modelTurnId=2, then one for modelTurnId=3. What status does the last result return, how many repeatedNoProgress events occur, and why do the three same-turn results not count as three fresh attempts? Return only JSON {"lastStatus":string,"repeatedNoProgress":number,"explanation":string}. Do not edit files or call external services.',
      wait:true,tier:'frontier',thinking:'auto',route:'auto',deadlineMs:180000,
      work:{taskClass:'diagnosis',maxAttempts:1,deliverable:'Grounded JSON for a frozen read-only monitor case',
       benefit:'Bounded active JEV live canary with independent local answer check',
       parentWork:'Verify actual provider/model, effort and answer key; stop on any regression',purpose:'produce'},
     }}],'toolUse');return;
    }
    const details=delegated.details??{};
    const body=(delegated.content??[]).filter((part:any)=>part?.type==='text').map((part:any)=>part.text).join('\n');
    let answer;
    try {const match=body.match(/\{\s*"lastStatus"\s*:[^{}]*"repeatedNoProgress"\s*:[^{}]*"explanation"\s*:[^{}]*\}/u);
     if(match)answer=JSON.parse(match[0]);}catch{}
    const output={isError:delegated.isError===true,taskId:details.taskId??null,
     routeExplanation:details.routeExplanation??null,route:details.route??null,
     effectiveThinking:details.effectiveThinking??null,requestedThinking:details.requestedThinking??null,
     answer:answer??null};
    if(process.env.JEV_ACTIVE_LIVE_RESULT)writeFileSync(process.env.JEV_ACTIVE_LIVE_RESULT,JSON.stringify(output)+'\n',{mode:0o600});
    emit(stream,model,[{type:'text',text:output.isError?'LIVE_CANARY_CHILD_FAILED':'LIVE_CANARY_REPORTED'}]);
   });return stream;
  },
 });
}
