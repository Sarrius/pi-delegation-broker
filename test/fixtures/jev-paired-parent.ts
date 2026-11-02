import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Opt-in, scripted local parent. It cannot choose an arm-specific brief or provider;
// the controller and frozen comparison-v1.json decide both, and only the child uses inference.
const manifestVersion=process.env.JEV_PAIRED_MANIFEST_VERSION??'v1';
if(!['v1','v2'].includes(manifestVersion))throw Error('Unknown frozen comparison version');
const manifest=JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),
 `../../../../research/jev-active-routing-20260925/comparison-${manifestVersion}.json`),'utf8'));
const caseId=process.env.JEV_PAIRED_CASE_ID;
const item=manifest.cases.find((candidate:any)=>candidate.id===caseId);
if(!item||!manifest.ownerApprovedRoots.includes(item.repo)||basename(process.cwd())!==item.repo)
 throw new Error('Paired canary needs a frozen case and its approved repo cwd');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
 cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function emit(stream:any,model:any,content:any[],reason='stop'){
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
function answerJson(text:string){
 for(let start=0;start<text.length;start++){
  if(text[start]!=='{')continue;
  let depth=0,quoted=false,escape=false;
  for(let end=start;end<text.length;end++){
   const ch=text[end];
   if(quoted){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')quoted=false;continue;}
   if(ch==='"'){quoted=true;continue;}
   if(ch==='{')depth++;
   if(ch==='}'&&--depth===0){try{
    const value=JSON.parse(text.slice(start,end+1));
    if(value&&typeof value==='object'&&('guard' in value||'explanation' in value))return value;
   }catch{}break;}
  }
 }
 return null;
}
export default function pairedParent(pi:any){
 pi.registerProvider('jev-paired-parent',{
  name:'Local comparison script (no parent inference)',baseUrl:'https://never-used.invalid',
  api:'jev-paired-parent-api',apiKey:'local-fixture-not-upstream',
  models:[{id:'parent',name:'Paired script',reasoning:false,input:['text'],contextWindow:128000,
   maxTokens:1000,cost:usage.cost}],
  streamSimple(model:any,context:any){
   const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
    if(process.env.JEV_PAIRED_DRY_RUN==='1'){
     emit(stream,model,[{type:'text',text:'PAIR_PARENT_READY'}]);return;
    }
    const delegated=context.messages.find((message:any)=>message.role==='toolResult'&&message.toolName==='delegate');
    if(!delegated){
     emit(stream,model,[{type:'toolCall',id:'paired-'+caseId,name:'delegate',arguments:{
      task:item.task,wait:true,tier:'frontier',thinking:'auto',route:'auto',deadlineMs:180000,
      work:{taskClass:'diagnosis',maxAttempts:1,deliverable:'Grounded JSON on frozen read-only case',
       benefit:'Independent read-only controller validation',parentWork:'Check answer against source-derived key',purpose:'produce'},
     }}],'toolUse');return;
    }
    const details=delegated.details??{};
    const text=(delegated.content??[]).filter((part:any)=>part?.type==='text').map((part:any)=>part.text).join('\n');
    const output={caseId,isError:delegated.isError===true||/^Delegation failed|Route: incomplete/m.test(text),taskId:details.taskId??null,
     route:details.route??null,routeExplanation:details.routeExplanation??null,
     usage:details.usage??null,answer:answerJson(text)};
    if(!process.env.JEV_PAIRED_RESULT)throw Error('Paired result path required');
    writeFileSync(process.env.JEV_PAIRED_RESULT,JSON.stringify(output)+'\n',{mode:0o600});
    emit(stream,model,[{type:'text',text:'PAIR_RECORDED'}]);
   });return stream;
  },
 });
}
