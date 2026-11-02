import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseRouteProvider } from './model-provenance-policy.mjs';
import { effectiveQualityEvents } from './routing-history-store.mjs';
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
  const resourceId=result.resource?.id;
  const leasedProvider=typeof resourceId==='string' && resourceId.includes('/') ? resourceId.split('/')[0] : undefined;
  return {taskId,owner:ownerKey(ownerSessionId),context,status:result.status,
    resourceId:resourceId??null,provider:leasedProvider??result.resolved?.provider??null,modelId:result.resolved?.modelId??null,
    effectiveThinking:result.resolved?.thinkingLevel??null,
    modelTier:['cheap','standard','frontier'].includes(result.selection?.modelTier)?result.selection.modelTier:null,
    preferenceSource:['auto','user','auto_user_tier_unavailable','legacy_emergency'].includes(result.selection?.preferenceSource)
      ?result.selection.preferenceSource:null,
    verification:['accepted','rejected'].includes(result.verification?.verification?.status)
      ? result.verification.verification.status
      : ['accepted','rejected'].includes(result.verification?.outcome?.status)
      ? result.verification.outcome.status : 'unverified',
    attempts:(result.route??[]).length,childHandoffs:count(result.childHandoffs),
    latencyMs:Math.max(0,completedAt-startedAt),
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

const SCORECARD_WINDOW = 2000;
const THINKING = new Set(['off','minimal','low','medium','high','xhigh','max']);
const TASK_CLASS = new Set(['lookup','summary','research','diagnosis','implementation','review','general']);
const UTILITY = new Set(['used','reworked','redundant','unused']);
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function routeDimensions(row) {
  const match = /^routing-v3:([a-z]+):requested-([a-z]+)$/.exec(row.context ?? '');
  const taskClass = match && TASK_CLASS.has(match[1]) ? match[1] : 'unknown';
  const requestedThinking = match && THINKING.has(match[2]) ? match[2] : 'unknown';
  return {
    provider: typeof row.provider === 'string' && row.provider.length <= 200 ? baseRouteProvider(row.provider) : 'unknown',
    modelId: typeof row.modelId === 'string' && row.modelId.length <= 200 ? row.modelId : 'unknown',
    taskClass, requestedThinking,
    effectiveThinking: THINKING.has(row.effectiveThinking) ? row.effectiveThinking : 'unknown',
    modelTier: ['cheap','standard','frontier'].includes(row.modelTier) ? row.modelTier : 'unknown',
    preferenceSource: ['auto','user','auto_user_tier_unavailable','legacy_emergency'].includes(row.preferenceSource)
      ? row.preferenceSource : 'unknown',
  };
}

/**
 * Parent-session execution scorecard, not an estimator of model quality or actual billing.
 * Input rows are the controller's route observations joined with attributed parent feedback;
 * only the separate receipt-backed quality events may train routing affinity. This projection
 * has no task text/ids and cannot change the selector or any acceptance/terminal state.
 */
export function executionScorecard(rows,{owner,maxCohorts=32}={}) {
  if (!Array.isArray(rows) || typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner)
    || !Number.isSafeInteger(maxCohorts) || maxCohorts < 1 || maxCohorts > 100) throw new Error('scorecard requires bounded rows, owner and cohort limit');
  const scoped = rows.filter(row => row && row.owner === owner && !row.legacy);
  const recent = scoped.slice(-SCORECARD_WINDOW);
  const groups = new Map();
  const evidence = {verifiedAccepted:0,verifiedRejected:0,unverified:0,parentFeedback:0};
  for (const row of recent) {
    const route = routeDimensions(row);
    const key = JSON.stringify(route);
    let cohort = groups.get(key);
    if (!cohort) {
      cohort = {route,results:{routeEvents:0,completed:0,failed:0,cancelled:0,expired:0,other:0,
          verifiedAcceptedWithSingleRouteHop:0,verifiedAcceptedWithOneChildHandoff:0,
          verifiedAccepted:0,verifiedRejected:0,unverified:0},
        routeHops:{known:0,total:0,unknown:0},childHandoffs:{known:0,total:0,unknown:0},
        usage:{known:0,totalTokens:0,unknown:0},
        childRouteLatency:{known:0,totalMs:0,unknown:0},
        parentUtility:{used:0,reworked:0,redundant:0,unused:0,unreported:0},
        parentIntegration:{known:0,totalMs:0}};
      groups.set(key,cohort);
    }
    const result = cohort.results;
    result.routeEvents++;
    if (['completed','failed','cancelled','expired'].includes(row.status)) result[row.status]++;
    else result.other++;
    if (row.verification === 'accepted') {
      evidence.verifiedAccepted++;result.verifiedAccepted++;
      if (row.status === 'completed' && row.attempts === 1) result.verifiedAcceptedWithSingleRouteHop++;
      if (row.status === 'completed' && row.childHandoffs === 1) result.verifiedAcceptedWithOneChildHandoff++;
    } else if (row.verification === 'rejected') {
      evidence.verifiedRejected++;result.verifiedRejected++;
    } else {evidence.unverified++;result.unverified++;}
    const attempts = safeCount(row.attempts);
    if (attempts !== undefined && attempts > 0) {cohort.routeHops.known++;cohort.routeHops.total += attempts;}
    else cohort.routeHops.unknown++;
    const handoffs = safeCount(row.childHandoffs);
    if (handoffs !== undefined) {cohort.childHandoffs.known++;cohort.childHandoffs.total += handoffs;}
    else cohort.childHandoffs.unknown++;
    const input = safeCount(row.tokens?.input),output = safeCount(row.tokens?.output);
    if (input !== undefined && output !== undefined) {cohort.usage.known++;cohort.usage.totalTokens += input+output;}
    else cohort.usage.unknown++;
    const latency = safeCount(row.latencyMs);
    if (latency !== undefined) {cohort.childRouteLatency.known++;cohort.childRouteLatency.totalMs += latency;}
    else cohort.childRouteLatency.unknown++;
    const utility = row.utility;
    if (utility?.source === 'parent_report' && UTILITY.has(utility.utility)) {
      evidence.parentFeedback++;cohort.parentUtility[utility.utility]++;
      const integration = safeCount(utility.parentIntegrationMs);
      if (integration !== undefined) {cohort.parentIntegration.known++;cohort.parentIntegration.totalMs += integration;}
    } else cohort.parentUtility.unreported++;
  }
  const ordered = [...groups.values()].sort((a,b) => b.results.routeEvents-a.results.routeEvents
    || JSON.stringify(a.route).localeCompare(JSON.stringify(b.route)));
  const shown = ordered.slice(0,maxCohorts);
  return {
    version:'delegation-execution-scorecard-v1',scope:'owner_session_recent',
    routeEvents:recent.length,windowPossiblyTruncated:scoped.length >= SCORECARD_WINDOW,
    evidence,cohorts:shown,omittedCohorts:ordered.length-shown.length,
    omittedRouteEvents:ordered.slice(maxCohorts).reduce((total,row)=>total+row.results.routeEvents,0),
    physicalAttempts:{status:'not_observed',actual:null},money:{status:'unavailable',actual:null},
    note:'Route-hop counts can include pre-dispatch denials; child handoffs count Pi sessions opened after durable admission, NOT paid provider requests. Usage and parent utility are not independently verified quality. Only separate controller-accepted quality receipts train model affinity. This window does not measure original parent-task completion, counterfactual routes or subscription money.',
  };
}

export function qualitySummary(store,now=Date.now()) {
  const groups=new Map();
  for(const {data,timestamp} of effectiveQualityEvents(store)) {
    if(timestamp<now-30*86400000)continue;
    const capabilities=[...(data.capabilities??[])].sort();
    const effectiveThinking=THINKING.has(data.effectiveThinking)?data.effectiveThinking:'unknown';
    const key=JSON.stringify([data.context,data.resourceId,capabilities,effectiveThinking]);
    const entry=groups.get(key)??{model:data.resourceId,context:data.context,capabilities,
      requestedThinking:routeDimensions({context:data.context}).requestedThinking,effectiveThinking,
      accepted:0,rejected:0,latencyTotalMs:0,tokensTotal:0,tokenSamples:0,attemptsTotal:0,lastObservedAt:0};
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
