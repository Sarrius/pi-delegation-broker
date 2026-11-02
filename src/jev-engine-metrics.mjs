import {constants,readFileSync,statSync,openSync,readSync,writeSync,closeSync,fstatSync} from 'node:fs';
import {effectiveQualityEvents} from './routing-history-store.mjs';
import {randomUUID} from 'node:crypto';

const FUNCTIONS=new Set(['routing','decision']);
const STATES=new Set(['opportunity','invoked','answered','applied','skipped','baseline']);
/** No task text, keys, raw response, child report or unverifiable success label. */
export class JevEngineMetrics {
 constructor(path,{now=Date.now}={}){this.path=path;this.now=now;}
 record({functionName,state,reason,taskId,taskDigest,modelIdentity,effort,latencyMs,inputTokens,outputTokens,answer,baselineModelIdentity}={}){
  if(!FUNCTIONS.has(functionName)||!STATES.has(state))throw Error('invalid Jev metric');
  const bounded=(v,n)=>typeof v==='string'&&v.length<=n&&!/[\r\n\0]/.test(v)?v:undefined;
  const event={v:1,id:randomUUID(),at:this.now(),functionName,state,
   ...(bounded(reason,80)&&/^[a-z][a-z0-9_:-]*$/.test(reason)?{reason}:{}),
   ...(bounded(taskId,160)&&/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(taskId)?{taskId}:{}),
   ...(typeof taskDigest==='string'&&/^[a-f0-9]{64}$/.test(taskDigest)?{taskDigest}:{}),
   ...(bounded(modelIdentity,180)&&/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(modelIdentity)?{modelIdentity}:{}),
   ...(bounded(baselineModelIdentity,180)&&/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(baselineModelIdentity)?{baselineModelIdentity}:{}),
   ...(['off','minimal','low','medium','high','xhigh','max'].includes(effort)?{effort}:{}),
   ...(bounded(answer,80)&&/^[a-z][a-z0-9_:-]*$/.test(answer)?{answer}:{}),
   ...(Number.isFinite(latencyMs)&&latencyMs>=0?{latencyMs:Math.round(latencyMs)}:{}),
   ...(Number.isSafeInteger(inputTokens)&&inputTokens>=0?{inputTokens}:{}),
   ...(Number.isSafeInteger(outputTokens)&&outputTokens>=0?{outputTokens}:{})};
  const fd=openSync(this.path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600);
  try{const info=fstatSync(fd);if(!info.isFile()||(info.mode&0o077)!==0)throw Error('Jev metrics file is not private');
    const line=Buffer.from(JSON.stringify(event)+'\n','utf8');
    if(writeSync(fd,line)!==line.length)throw Error('Jev metrics append incomplete');
  }finally{closeSync(fd);}
  return event.id;
 }
 summary({days=30,routingHistory}={}){
  let contents,fullCoverage=true;
  try {const size=statSync(this.path).size;
   // An explicit bounded status view never presents a tail as complete history.
   if(size>16*1024*1024)fullCoverage=false;
   if(!fullCoverage){const fd=openSync(this.path,'r');try{const buf=Buffer.allocUnsafe(16*1024*1024);
     const bytes=readSync(fd,buf,0,buf.length,size-buf.length);
     contents=buf.subarray(0,bytes).toString('utf8').replace(/^[^\n]*\n/,'');
   }finally{closeSync(fd);}}
   else contents=readFileSync(this.path,'utf8');
  }catch{contents='';}
  const lower=this.now()-days*86400000;
  const buckets=Object.fromEntries([...FUNCTIONS].map(name=>[name,{opportunity:0,invoked:0,answered:0,applied:0,skipped:0,baseline:0,
   inputTokens:0,outputTokens:0,latencyMs:0,reasons:{},answers:{},verifiedAccepted:0,verifiedRejected:0,
   parentFeedback:0,withoutControllerOutcome:0}]));
  const quality=new Map(),parent=new Map();
  let historyCoverage=routingHistory&&typeof routingHistory.list==='function'?'available':'not_loaded';
  if(historyCoverage==='available'){
   try {for(const row of effectiveQualityEvents(routingHistory)){
      if(row.timestamp<lower||!['accepted','rejected'].includes(row.data?.outcome))continue;
      quality.set(row.data.taskId,row.data.outcome);
    }
    for(const row of routingHistory.list({kind:'feedback',limit:100000}))if(row.timestamp>=lower)parent.set(row.data.taskId,row.data.utility);
   }catch{historyCoverage='unavailable';/* unknown, not verified success */}
  }
  const seenApplied=new Set(),seenOpportunities=new Set();
  for(const line of contents.split('\n')){
   let e;try{e=JSON.parse(line);}catch{continue;}
   if(e?.v!==1||!FUNCTIONS.has(e.functionName)||!STATES.has(e.state)||e.at<lower||e.at>this.now()+60000)continue;
   const b=buckets[e.functionName];
   if(e.state==='opportunity'&&e.taskId){const key=`${e.functionName}:${e.taskId}`;
     if(seenOpportunities.has(key))continue;seenOpportunities.add(key);}
   b[e.state]++;
   if(e.state==='invoked'){b.inputTokens+=e.inputTokens??0;b.outputTokens+=e.outputTokens??0;b.latencyMs+=e.latencyMs??0;}
   if(e.state==='skipped'&&e.reason)b.reasons[e.reason]=(b.reasons[e.reason]??0)+1;
   if(e.answer)b.answers[e.answer]=(b.answers[e.answer]??0)+1;
   if(e.state==='applied'&&e.taskId&&!seenApplied.has(e.taskId)){
    seenApplied.add(e.taskId);
    if(historyCoverage!=='available')continue;
    if(quality.get(e.taskId)==='accepted')b.verifiedAccepted++;
    else if(quality.get(e.taskId)==='rejected')b.verifiedRejected++;
    else b.withoutControllerOutcome++;
    if(parent.has(e.taskId))b.parentFeedback++;
   }
  }
  if(historyCoverage!=='available')for(const bucket of Object.values(buckets)){
    bucket.verifiedAccepted=null;bucket.verifiedRejected=null;
    bucket.withoutControllerOutcome=null;bucket.parentFeedback=null;
  }
  return {windowDays:days,coverage:fullCoverage?'complete_within_retention':'last_16mb_only',
   controllerHistoryCoverage:historyCoverage,
   evidenceLevels:'Jev selection/application, parent feedback and controller verification are separate; no causal model comparison.',byFunction:buckets};
 }
}
