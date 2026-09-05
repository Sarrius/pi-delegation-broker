import assert from 'node:assert/strict';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {writeFileSync} from 'node:fs';

const usage={input:8,output:4,cacheRead:0,cacheWrite:0,totalTokens:12,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function emit(stream:any,model:any,content:any[],reason='stop') {
 const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage,stopReason:reason,timestamp:Date.now()};
 stream.push({type:'start',partial:message});
 if(content[0]?.type==='text') {
  stream.push({type:'text_start',contentIndex:0,partial:message});
  stream.push({type:'text_delta',contentIndex:0,delta:content[0].text,partial:message});
  stream.push({type:'text_end',contentIndex:0,content:content[0].text,partial:message});
 }
 if(content[0]?.type==='toolCall') {
  stream.push({type:'toolcall_start',contentIndex:0,partial:message});
  stream.push({type:'toolcall_delta',contentIndex:0,delta:JSON.stringify(content[0].arguments),partial:message});
  stream.push({type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message});
 }
 stream.push({type:'done',reason,message});stream.end(message);
}
export default function standaloneNativeHost(pi:any) {
 let childRequests=0;
 const model={id:'claude-sonnet-4-6',name:'Native fixture',reasoning:false,input:['text'],contextWindow:200000,maxTokens:8192,cost:usage.cost};
 pi.on('session_start',(_event:any,ctx:any)=>assert.equal(ctx.controllerProvider,undefined));
 pi.registerProvider('anthropic',{
  name:'Standalone native fixture',baseUrl:'https://standalone.invalid',api:'anthropic-messages',apiKey:'fixture-native',models:[model],
  streamSimple(model:any,_context:any,options:any) {
   const stream=createAssistantMessageEventStream();
   queueMicrotask(()=>{
    childRequests++;
    options?.onResponse?.({status:200,headers:{'request-id':'standalone-fixture'}});
    emit(stream,model,[{type:'text',text:'STANDALONE_CHILD_OK'}]);
   });
   return stream;
  },
 });
 pi.registerProvider('standalone-parent',{
  name:'Standalone parent fixture',baseUrl:'https://parent.invalid',api:'standalone-parent-api',apiKey:'fixture-parent',models:[{...model,id:'parent'}],
  streamSimple(model:any,context:any) {
   const stream=createAssistantMessageEventStream();
   queueMicrotask(()=>{
    const result=[...context.messages].reverse().find((message:any)=>message.role==='toolResult');
    if(result) {
     const text=JSON.stringify(result.content);
     writeFileSync(process.env.STANDALONE_RESULT!,JSON.stringify({childRequests,result}));
     emit(stream,model,[{type:'text',text:text.includes('STANDALONE_CHILD_OK')?'STANDALONE_PARENT_OK':'STANDALONE_FAILED'}]);
    } else emit(stream,model,[{type:'toolCall',id:'standalone-delegate',name:'delegate',arguments:{
     task:'Return exactly STANDALONE_CHILD_OK',wait:true,thinking:'off',tier:'standard',
     work:{taskClass:'lookup',deliverable:'Return fixture marker',benefit:'Independent acceptance canary',parentWork:'Wait for marker',maxAttempts:1},
    }}],'toolUse');
   });
   return stream;
  },
 });
}
