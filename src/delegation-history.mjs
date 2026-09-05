import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const hash = value => createHash('sha256').update(value).digest('hex');
/** Preserve pre-upgrade aggregates for inspection; missing task class/effort cannot train new routing. */
export function importLegacyAffinity(store,stateDir) {
  const controllers=join(stateDir,'controllers');
  const paths=[join(stateDir,'model-affinity.json')];
  if (existsSync(controllers)) for (const entry of readdirSync(controllers,{withFileTypes:true})) if (entry.isDirectory() && /^[a-f0-9]{16}$/.test(entry.name)) paths.push(join(controllers,entry.name,'model-affinity.json'));
  let imported=0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let value; try {value=JSON.parse(readFileSync(path,'utf8'));} catch {continue;}
    if (![1,2].includes(value?.schemaVersion) || !value.observations || typeof value.observations!=='object') continue;
    for (const [key,entry] of Object.entries(value.observations)) {
      if (typeof entry?.resourceId!=='string' || !/^[A-Za-z0-9~][A-Za-z0-9._/:~-]{0,191}$/.test(entry.resourceId)
        || ![entry.accepted,entry.rejected].every(n=>Number.isSafeInteger(n)&&n>=0)) continue;
      const data={legacy:true,source:hash(path),taskClass:typeof entry.taskClass === "string" && /^[A-Za-z0-9+_./-]{1,1000}$/.test(entry.taskClass) ? entry.taskClass : "unknown",resourceId:entry.resourceId,accepted:entry.accepted,rejected:entry.rejected,comparable:false};
      // Version each changing snapshot; consumers display latest source/resource, never sum versions.
      if(store.append({id:`legacy:${hash(path+key+JSON.stringify(data))}`,kind:'route',data}).inserted) imported++;
    }
  }
  return imported;
}
export function ownerKey(sessionId) { return hash(String(sessionId)); }
export function routeFact({taskId,ownerSessionId,context,result,startedAt,completedAt=Date.now()}) {
  const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
  return {taskId,owner:ownerKey(ownerSessionId),context,status:result.status,
    resourceId:result.resource?.id??null,provider:result.resolved?.provider??null,modelId:result.resolved?.modelId??null,
    effectiveThinking:result.resolved?.thinkingLevel??null,verification:result.verification?.outcome?.status??'unverified',
    attempts:(result.route??[]).length,latencyMs:Math.max(0,completedAt-startedAt),
    tokens:result.usage ? {input:count(result.usage.input),output:count(result.usage.output),cacheRead:count(result.usage.cacheRead),cacheWrite:count(result.usage.cacheWrite)} : null,
    money:{status:'unavailable',actual:null},
    // Bounded machine labels only. Provider raw error strings may contain sensitive request data.
    hops:(result.route??[]).slice(0,64).map(h=>({resourceId:h.resourceId??null,outcome:String(h.outcome??'unknown').replace(/[^A-Za-z_:-]/g,'').slice(0,64)}))};
}
export function historySummary(store,{limit=100,owner}={}) {
  const feedback=store.list({kind:'feedback',limit:100000});
  const latest=new Map(feedback.map(row=>[row.data.taskId,row.data]));
  return store.list({kind:'route',limit:100000}).filter(row=>!row.data.legacy && (!owner || row.data.owner===owner)).slice(-limit).map(row=>({...row.data,at:row.timestamp,utility:latest.get(row.data.taskId)??null}));
}

export function qualitySummary(store,now=Date.now()) {
  const groups=new Map();
  for(const {data,timestamp} of store.list({kind:'quality',limit:100000})) {
    if(timestamp<now-30*86400000)continue;
    const capabilities=[...(data.capabilities??[])].sort();
    const key=JSON.stringify([data.context,data.resourceId,capabilities]);
    const entry=groups.get(key)??{model:data.resourceId,context:data.context,capabilities,accepted:0,rejected:0,latencyTotalMs:0,tokensTotal:0,tokenSamples:0,attemptsTotal:0,lastObservedAt:0};
    if(!['accepted','rejected'].includes(data.outcome))continue;
    entry[data.outcome]++; entry.latencyTotalMs+=data.latencyMs;
    if(data.tokens!==undefined){entry.tokensTotal+=data.tokens;entry.tokenSamples++;}
    entry.attemptsTotal+=data.attempts??1; entry.lastObservedAt=Math.max(entry.lastObservedAt,timestamp);
    groups.set(key,entry);
  }
  return [...groups.values()].map(entry=>{
    const n=entry.accepted+entry.rejected,p=entry.accepted/n,z2=1.96**2;
    const center=p+z2/(2*n),margin=1.96*Math.sqrt((p*(1-p)+z2/(4*n))/n),denominator=1+z2/n;
    return {...entry,samples:n,acceptedRate:p,confidence95:[Math.max(0,(center-margin)/denominator),Math.min(1,(center+margin)/denominator)],
      evidence:n<3?'insufficient':'observed',averageLatencyMs:entry.latencyTotalMs/n,
      tokensPerAcceptedResult:entry.accepted && entry.tokenSamples===n ? entry.tokensTotal/entry.accepted : null,
      actualMoney:null};
  }).sort((a,b)=>b.lastObservedAt-a.lastObservedAt).slice(0,200);
}

export function legacyQualitySummary(store) {
  const latest=new Map();
  for(const row of store.list({kind:'route',limit:100000})) if(row.data.legacy) latest.set(JSON.stringify([row.data.source,row.data.resourceId,row.data.taskClass]),row.data);
  return [...latest.values()].slice(-200);
}
