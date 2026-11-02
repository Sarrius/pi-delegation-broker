// Scripted protocol provider for offline host tests. It must really request read and
// echo the tool result; it cannot read the challenge itself or mint controller proof.
export function qualificationResponse(context) {
 const texts=(context.messages??[]).filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:(m.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));
 if(texts.length===1&&texts[0]==='Reply OK.')return {content:[{type:'text',text:'OK'}],reason:'stop'};
 const match=texts.join('\n').match(/Use the read tool once to read (.+\/challenge\.txt)\. Reply with ONLY/);
 if(!match)return undefined;
 const result=(context.messages??[]).findLast(m=>m.role==='toolResult'&&m.toolName==='read'&&!m.isError);
 if(!result)return {content:[{type:'toolCall',id:'qualification-read',name:'read',arguments:{path:match[1]}}],reason:'toolUse'};
 const text=typeof result.content==='string'?result.content:result.content.map(c=>c.text??'').join('\n');
 return {content:[{type:'text',text:text.match(/\b[a-f0-9]{48}\b/)?.[0]??'MISSING_CHALLENGE'}],reason:'stop'};
}
export function* qualificationNativeEvents(response) {
 const block=response.content[0],tool=block.type==='toolCall';
 yield {type:'start'};yield {type:tool?'toolcall_start':'text_start',contentIndex:0};
 if(tool)yield {type:'toolcall_delta',contentIndex:0,delta:''};
 yield {type:tool?'toolcall_delta':'text_delta',contentIndex:0,delta:tool?JSON.stringify(block.arguments):block.text};
 yield tool?{type:'toolcall_end',contentIndex:0,toolCall:block}:{type:'text_end',contentIndex:0,content:block.text};
 yield {type:'done',reason:response.reason,message:{content:response.content,usage:{input:5,output:2}}};
}
export function* qualificationNormalizedEvents(context) {
 const response=qualificationResponse(context);if(!response)return;
 const block=response.content[0],tool=block.type==='toolCall';const value=tool?JSON.stringify(block.arguments):block.text;
 yield {type:'headers',payload:{httpStatus:200}};
 yield {type:'block_start',payload:{index:0,blockType:tool?'tool_call':'text',...(tool?{id:block.id,name:block.name}:{})}};
 yield {type:tool?'tool_call_delta':'text_delta',payload:{index:0,delta:value}};
 yield {type:'block_end',payload:{index:0,value}};
 yield {type:'terminal',outcome:'succeeded_terminal',payload:{finishReason:tool?'tool_use':'stop',usage:{input:5,output:2}}};
}
