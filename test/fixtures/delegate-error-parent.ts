import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
 cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function emit(stream:any,model:any,content:any[],reason='stop'){
 const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage,stopReason:reason,timestamp:Date.now()};
 stream.push({type:'start',partial:message});const item=content[0],tool=item.type==='toolCall';
 stream.push({type:tool?'toolcall_start':'text_start',contentIndex:0,partial:message});
 stream.push({type:tool?'toolcall_delta':'text_delta',contentIndex:0,delta:tool?JSON.stringify(item.arguments):item.text,partial:message});
 stream.push(tool?{type:'toolcall_end',contentIndex:0,toolCall:item,partial:message}:{type:'text_end',contentIndex:0,content:item.text,partial:message});
 stream.push({type:'done',reason,message});stream.end(message);
}
export default function errorParent(pi:any){
 pi.registerProvider('error-parent',{name:'Error-only fixture',api:'error-parent-api',baseUrl:'https://not-used.invalid',apiKey:'fake-fixture-only',
  models:[{id:'controller',name:'Error-only fixture',reasoning:false,input:['text'],contextWindow:16000,maxTokens:256,cost:usage.cost}],
  streamSimple(model:any,context:any){
    const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
      const result=context.messages.find((message:any)=>message.role==='toolResult'&&message.toolName==='delegate');
      if(result){
        writeFileSync(process.env.PI_BROKER_ERROR_RESULT!,JSON.stringify({isError:result.isError===true,
          explicitlyRefused:(result.content??[]).some((part:any)=>/read-only acceptance/.test(part.text??''))}),{mode:0o600});
        emit(stream,model,[{type:'text',text:'BROKER_ERROR_CHECK_DONE'}]);return;
      }
      emit(stream,model,[{type:'toolCall',id:'negative-check',name:'delegate',arguments:{
        task:'Read the source and report one fact.',tier:'standard',wait:true,
        work:{taskClass:'lookup',deliverable:'One fact',benefit:'Negative acceptance signaling test',parentWork:'Refuse invalid checks'},
        acceptance:[{id:'file-equals',path:'README.md',content:'unrelated'}],
      }}],'toolUse');
    });return stream;
  },
 });
}
