// Research-only, fake local parent. Inventory metadata; no child or provider inference.
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {writeFileSync} from 'node:fs';
if(process.env.PI_BROKER_MODEL_EVIDENCE_ACK!=='1')throw Error('metadata inventory requires explicit research acknowledgement');
const destination=process.env.PI_BROKER_MODEL_EVIDENCE_OUTPUT;
const provider=process.env.PI_BROKER_MODEL_EVIDENCE_PROVIDER;
if(!destination||!provider||!/^[-a-z0-9]{1,60}$/.test(provider))throw Error('provider and output path required');
const cost={input:0,output:0,cacheRead:0,cacheWrite:0,total:0};
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost};
function send(stream:any,model:any,content:any[],reason='stop'){
 const msg={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,usage,stopReason:reason,timestamp:Date.now()};
 stream.push({type:'start',partial:msg});const part=content[0];const tool=part.type==='toolCall';
 stream.push({type:tool?'toolcall_start':'text_start',contentIndex:0,partial:msg});
 stream.push({type:tool?'toolcall_delta':'text_delta',contentIndex:0,delta:tool?JSON.stringify(part.arguments):part.text,partial:msg});
 stream.push(tool?{type:'toolcall_end',contentIndex:0,toolCall:part,partial:msg}:{type:'text_end',contentIndex:0,content:part.text,partial:msg});
 stream.push({type:'done',reason,message:msg});stream.end(msg);
}
export default function evidenceInventoryParent(pi:any){
 pi.registerProvider('model-evidence-controller',{name:'No-network inventory controller',api:'model-evidence-api',baseUrl:'https://unused.invalid',apiKey:'not-upstream',
 models:[{id:'controller',name:'No-network inventory controller',reasoning:false,input:['text'],contextWindow:16000,maxTokens:512,cost}],
 streamSimple(model:any,context:any){const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
  const result=[...context.messages].reverse().find((message:any)=>message.role==='toolResult'&&message.toolName==='delegate_inventory');
  if(result){
   const details=result.details??{};
   const rows=Array.isArray(details.rows)?details.rows:[];
   const out={provider,isError:result.isError===true,totalModels:details.totalModels??null,observedAt:details.observedAt??null,
    rows:rows.map((row:any)=>({resourceId:row.resourceId,provider:row.provider,modelId:row.modelId,tier:row.tier,state:row.state,
      reasons:row.reasons,capabilities:row.capabilities,readiness:row.readiness?.status??null,costStatus:row.cost?.status??null}))};
   writeFileSync(destination,JSON.stringify(out,null,2)+'\n',{mode:0o600});send(stream,model,[{type:'text',text:'MODEL_EVIDENCE_METADATA_DONE'}]);
  }else send(stream,model,[{type:'toolCall',id:'inventory-metadata',name:'delegate_inventory',arguments:{provider,verifyLive:false}}],'toolUse');
 });return stream;}});
}
