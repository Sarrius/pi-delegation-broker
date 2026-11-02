// Explicit manual live acceptance canary. One native short preview, then at most one
// tool-using subscription child; no paid parent model or effects. Existing optional
// Jev result advice may append a separate content block when legacy consent is on.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
if(process.env.PI_BROKER_QUALITY_CANARY_ACK!=='1') throw new Error('manual quality canary not authorized');
const report=process.env.PI_BROKER_QUALITY_CANARY_REPORT;
if(!report) throw new Error('quality canary report path required');
const caseId=process.env.PI_BROKER_QUALITY_CANARY_CASE??'answer-check-v1';
if(!['answer-check-v1','broker-terminal-v1'].includes(caseId))throw new Error('unknown frozen quality canary case');
const source=caseId==='broker-terminal-v1'?resolve('src/broker.mjs'):resolve('src/acceptance-plan.mjs');
const expected=caseId==='broker-terminal-v1'?'failed':'answer-equals';
const task=caseId==='broker-terminal-v1'
 ? `Use the read tool to inspect ${source}, starting at line 443 with limit 22. In finalizeVerifiedTask, if an authenticated controller receipt has status rejected, which exact pending_tasks terminal state is written? Reply ONLY with that single state value; no explanation or punctuation.`
 : `Use the read tool to inspect ${source}, starting at line 35 with limit 12. Which fixed check ID verifies the exact final answer of a read-only delegated task? Reply with ONLY that ID: no Markdown, explanation or surrounding whitespace.`;
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function emit(stream:any,model:any,content:any[],reason='stop'){
 const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage,stopReason:reason,timestamp:Date.now()};
 stream.push({type:'start',partial:message});
 const part=content[0],tool=part?.type==='toolCall';
 stream.push({type:tool?'toolcall_start':'text_start',contentIndex:0,partial:message});
 stream.push({type:tool?'toolcall_delta':'text_delta',contentIndex:0,delta:tool?JSON.stringify(part.arguments):part.text,partial:message});
 stream.push(tool?{type:'toolcall_end',contentIndex:0,toolCall:part,partial:message}:{type:'text_end',contentIndex:0,content:part.text,partial:message});
 stream.push({type:'done',reason,message});stream.end(message);
}
export default function verifiedAnswerParent(pi:any){
 pi.registerProvider('verified-answer-controller',{name:'Local acceptance script',api:'verified-answer-api',baseUrl:'https://never-used.invalid',
   apiKey:'local-fake-parent-not-upstream',models:[{id:'controller',name:'Local acceptance script',reasoning:false,input:['text'],contextWindow:16000,maxTokens:256,cost:usage.cost}],
   streamSimple(model:any,context:any){
     const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
       const results=context.messages.filter((m:any)=>m.role==='toolResult');
       const delegated=results.find((m:any)=>m.toolName==='delegate');
       const planned=results.find((m:any)=>m.toolName==='delegate_plan');
       if(delegated){
         // Pi's legacy Jev result advisor can append its own second content block. It is
         // never the child's original final answer and must not overwrite acceptance data.
         const text=(delegated.content??[]).find((x:any)=>x?.type==='text')?.text??'';
         writeFileSync(report,JSON.stringify({caseId,stage:'delegate',isError:delegated.isError===true,
           answerIsExpected:text===expected,answerDigest:createHash('sha256').update(text).digest('hex'),
           legacyJevResultAdvicePresent:Boolean(delegated.details?.jevAdvice),
           taskId:delegated.details?.taskId??null,verificationStatus:delegated.details?.verificationStatus??null,
           route:delegated.details?.route??null,usage:delegated.details?.usage??null,
           previewProof:planned?.details?.quotaReadiness??null,
           proofExpiresAt:planned?.details?.readiness?.find?.((v:any)=>v.status==='verified')?.expiresAt??null}),{mode:0o600});
         emit(stream,model,[{type:'text',text:'QUALITY_CANARY_RECORDED'}]);return;
       }
       if(planned){
         if(planned.isError || planned.details?.quotaReadiness!=='verified_short_probe_only'){
           writeFileSync(report,JSON.stringify({caseId,stage:'preview_only',isError:planned.isError===true,
             status:planned.details?.status??null,quotaReadiness:planned.details?.quotaReadiness??null}),{mode:0o600});
           emit(stream,model,[{type:'text',text:'QUALITY_CANARY_SKIPPED_NO_PROOF'}]);return;
         }
         emit(stream,model,[{type:'toolCall',id:'quality-delegate',name:'delegate',arguments:{
           task,wait:true,tier:'standard',thinking:'off',deadlineMs:120000,
           acceptance:[{id:'answer-equals',content:expected}],
           work:{taskClass:'lookup',maxAttempts:1,deliverable:'One exact source-derived state value',
             benefit:'Controller-verifiable real isolated-child lookup over a genuine Broker implementation file',
             parentWork:'Compare controller receipt and route with the frozen source-derived expected ID'},
         }}],'toolUse');return;
       }
       emit(stream,model,[{type:'toolCall',id:'quality-preview',name:'delegate_plan',arguments:{
         task,tier:'standard',thinking:'off',deadlineMs:120000,
         acceptance:[{id:'answer-equals',content:expected}],
         work:{taskClass:'lookup',maxAttempts:1,deliverable:'One exact source-derived state value',
           benefit:'Pre-delegation live route/readiness check',parentWork:'Continue only after short verified inference'},
       }}],'toolUse');
     });return stream;
   },
 });
}
