// Manual opt-in: real subscription-native provider readiness without launching any child.
// Pi owns credentials. This fake parent makes one inventory tool call; the tool itself
// sends a bounded fixed-text native inference to at most one eligible model.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';
if (process.env.PI_BROKER_LIVE_PROBE_ACK !== '1') throw new Error('manual subscription probe not authorized');
const file = process.env.PI_BROKER_READINESS_PROBE_RESULT;
if (!file) throw new Error('readiness probe report path is required');
const provider = process.env.PI_BROKER_READINESS_PROVIDER ?? 'cursor';
const usage = { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function emit(stream: any, model: any, content: any[], reason = 'stop') {
  const message = {role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage,stopReason:reason,timestamp:Date.now()};
  stream.push({type:'start',partial:message});
  const part = content[0];
  if(part.type==='text'){
    stream.push({type:'text_start',contentIndex:0,partial:message});
    stream.push({type:'text_delta',contentIndex:0,delta:part.text,partial:message});
    stream.push({type:'text_end',contentIndex:0,content:part.text,partial:message});
  }else{
    stream.push({type:'toolcall_start',contentIndex:0,partial:message});
    stream.push({type:'toolcall_delta',contentIndex:0,delta:JSON.stringify(part.arguments),partial:message});
    stream.push({type:'toolcall_end',contentIndex:0,toolCall:part,partial:message});
  }
  stream.push({type:'done',reason,message});stream.end(message);
}
export default function readinessParent(pi: any) {
  const parent={id:'controller',name:'Readiness test parent',reasoning:false,input:['text'],contextWindow:16000,maxTokens:256,cost:usage.cost};
  pi.registerProvider('readiness-controller',{name:'Readiness test parent',api:'readiness-controller-api',baseUrl:'https://readiness-controller.invalid',
    apiKey:'not-a-provider-key',models:[parent],
    streamSimple(model: any,context: any){
      const stream=createAssistantMessageEventStream();
      queueMicrotask(()=>{
        const result=[...context.messages].reverse().find((message:any)=>message.role==='toolResult');
        if(result){
          const text=result.content?.map?.((part:any)=>part?.text??'').join('')??'';
          let rows:any[]=[];
          try{const start=text.indexOf('{"models":');if(start!==-1)rows=JSON.parse(text.slice(start)).models??[];}catch{}
          // Metadata only: no provider reply, task brief or credential is retained.
          const observations=rows.slice(0,8).map((row:any)=>({resourceId:row.resourceId,state:row.state,
            readiness:row.readiness?.status,reason:row.readiness?.reason??null,
            checkedAt:row.readiness?.checkedAt??null,expiresAt:row.readiness?.expiresAt??null}));
          writeFileSync(file,JSON.stringify({isError:result.isError===true,provider,observations}),{mode:0o600});
          emit(stream,model,[{type:'text',text:'READINESS_PROBE_DONE'}]);
        }else emit(stream,model,[{type:'toolCall',id:'readiness-tool',name:'delegate_inventory',arguments:{provider,maxChecks:1}}],'toolUse');
      });
      return stream;
    },
  });
}
