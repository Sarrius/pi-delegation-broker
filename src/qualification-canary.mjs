import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {writeReport,readReport,markReportRead} from './report-store.mjs';
import {classifyChildFailure} from './brokered-runner.mjs';
import {parseResourceModel} from './model-selector.mjs';

function observedRead(sessionsRoot,id,path) {
  const calls=new Set();
  try {for(const file of readdirSync(join(sessionsRoot,id,'sessions')).filter(name=>name.endsWith('.jsonl'))) {
    const full=join(sessionsRoot,id,'sessions',file);if(statSync(full).size>2*1024*1024)continue;
    for(const line of readFileSync(full,'utf8').split('\n')) {
      let message;try{message=JSON.parse(line).message;}catch{continue;}
      if(message?.role==='assistant')for(const c of message.content??[]) {
        if(c.type==='toolCall'&&c.name==='read'&&c.arguments?.path===path)calls.add(c.id);
      }
      if(message?.role==='toolResult'&&message.toolName==='read'&&!message.isError&&calls.has(message.toolCallId))return true;
    }
  }}catch{/* Missing journals cannot certify a read. */}
  return false;
}

/** Same signed child runtime, proxy, monitor, lease and report store as user work.
 * A separate resolver (without the qualification gate) prevents recursion. No task brief,
 * owner repo, ambient instructions or credentials are copied to this challenge directory.
 */
export function createQualificationCanary({runner,root,sessionsRoot,now=Date.now}) {
  return async ({resourceId,thinking='off',signal})=>{
    if(signal?.aborted)return {status:'unknown',reason:'cancelled'};
    const model=parseResourceModel(resourceId);if(!model)return {status:'failed',reason:'invalid_route'};
    const childId=`qualification-${randomUUID()}`;
    const cwd=join(root,childId);mkdirSync(cwd,{recursive:true,mode:0o700});
    const path=join(cwd,'challenge.txt');const expected=randomBytes(24).toString('hex');
    writeFileSync(path,expected+'\n',{mode:0o600});
    const prompt=`Use the read tool once to read ${path}. Reply with ONLY the literal text inside the file, not JSON, quotes, formatting or explanation. A tool response may wrap the file text in an output field: extract that field's text; do not echo the wrapper. Do not read anything else.`;
    const startedAt=now();
    const abort=()=>{void runner.abort(childId).catch(()=>{});};
    signal?.addEventListener('abort',abort,{once:true});
    try {
      const result=await runner.run({childId,cwd,prompt,model,thinkingLevel:thinking,maxAttempts:1,
        promptDigest:createHash('sha256').update(prompt).digest('hex'),
        capabilityRequest:{taskId:childId,taskDescription:'Read-only route compatibility check',operationClass:'observe',
          requiredCapabilities:['text_generation'],requireModelIdentity:model,allowSiblingAccounts:false,
          modelTier:'cheap',routingRequestedThinking:thinking,budget:{maxAttempts:1}},
      });
      const route=result.route?.at(-1);
      const valid=!signal?.aborted&&result.status==='completed'&&route?.resourceId===resourceId
        &&result.text?.trim()===expected&&observedRead(sessionsRoot,childId,path);
      const reason=signal?.aborted?'cancelled':result.status==='completed'?'canary_answer_or_tool_mismatch':classifyChildFailure(result.error,{readOnly:true});
      const original=typeof result.error==='string'?result.error.replace(/\s+/g,' ').trim().slice(0,500):'';
      // This is technical readiness evidence, NOT task acceptance or learned model quality.
      const reports=join(root,'reports');
      writeReport(reports,{taskId:childId,status:valid?'completed':'failed',task:'Synthetic isolated read/tool/result readiness check',
        text:valid?expected:'',...(valid?{}:{error:reason,...(original&&original!==reason?{routeExplanation:original}:{})}),resourceId,startedAt,completedAt:now(),wakeAt:null});
      const report=readReport(reports,childId);
      if(!report||report.status!==(valid?'completed':'failed')||(valid&&report.text!==expected))return {status:'failed',reason:'canary_report_unreadable'};
      markReportRead(reports,childId);
      return valid?{status:'verified',evidence:'isolated_tool_roundtrip',canaryId:childId}
        :{status:'failed',reason};
    } finally {
      signal?.removeEventListener('abort',abort);
      rmSync(cwd,{recursive:true,force:true});
    }
  };
}
