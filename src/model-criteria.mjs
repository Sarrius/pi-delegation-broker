import {readFileSync} from 'node:fs';
import {baseRouteProvider} from './model-provenance-policy.mjs';
import {effectiveQualityEvents} from './routing-history-store.mjs';

const DATA=Object.freeze(JSON.parse(readFileSync(new URL('./model-criteria-v1.json',import.meta.url),'utf8')));
if(DATA.schemaVersion!==1 || !Array.isArray(DATA.models)
 ||DATA.models.some(card=>(card.sources??[]).some(id=>!DATA.sourceRegistry?.[id]?.url?.startsWith('https://'))))
 throw Error('model criteria schema or public source provenance is unsupported');
const index=new Map(DATA.models.map(card=>[card.identity,card]));
const aliases=new Map(DATA.models.flatMap(card=>(card.routeAliases??[])
 .filter(alias=>!alias.includes('*') && alias!==card.identity)
 .map(alias=>[alias,card.identity])));
const MAX_CARD_BYTES=1800;

/** An account number is a capacity identity, not a new model or a quality observation. */
export function criteriaIdentity(resourceId){
 if(typeof resourceId!=='string'||!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]{1,160}$/.test(resourceId))return undefined;
 const [provider,...parts]=resourceId.split('/');
 const canonical=`${baseRouteProvider(provider)}/${parts.join('/')}`;
 return aliases.get(canonical)??canonical;
}

/** Only controller-authenticated finalized observations; never parent feedback or public scores. */
export function checkedModelOutcomes(history,identity,{now=Date.now()}={}){
 if(!history||typeof history.list!=='function')return [];
 const groups=new Map();
 for(const row of effectiveQualityEvents(history)){
  const d=row.data??{};
  if(d.resourceId!==identity||row.timestamp<now-30*24*3600*1000||!['accepted','rejected'].includes(d.outcome))continue;
  const context=typeof d.context==='string'?d.context:'unknown';
  const effort=typeof d.effectiveThinking==='string'?d.effectiveThinking:'unknown';
  const key=JSON.stringify([context,effort]);
  const item=groups.get(key)??{context,effort,accepted:0,rejected:0,lastObservedAt:0};
  item[d.outcome]++;item.lastObservedAt=Math.max(item.lastObservedAt,row.timestamp);groups.set(key,item);
 }
 return [...groups.values()].sort((a,b)=>b.lastObservedAt-a.lastObservedAt).slice(0,16);
}

export function modelCriteria(resourceId,{history,now=Date.now()}={}){
 const identity=criteriaIdentity(resourceId);
 if(!identity)return undefined;
 const card=index.get(identity);
 const record=card?{
  identity,sourceVersion:DATA.schemaVersion,researchedAt:DATA.capturedAtUTC,
  manufacturer:card.manufacturer,vendorUses:card.vendorUses,
  efforts:card.effort,benchmark:card.independentBenchmark,
  unknowns:card.unknowns,sources:card.sources.map(id=>({id,...DATA.sourceRegistry?.[id]})),
 }:{identity,sourceVersion:DATA.schemaVersion,researchedAt:DATA.capturedAtUTC,
  manufacturer:'unknown',vendorUses:[],efforts:{},benchmark:null,
  unknowns:[DATA.unknownIdentity.taskSuitability,DATA.unknownIdentity.benchmark],sources:[]};
 return Object.freeze({...record,localCheckedOutcomes:checkedModelOutcomes(history,identity,{now}),
  stale:!Number.isFinite(Date.parse(DATA.capturedAtUTC))||now>Date.parse(DATA.capturedAtUTC)+90*86400000,
  caveat:'Vendor use cases are claims; public benchmark index is NOT Pi pass probability. Benchmarked provider none is NOT Pi off. Admission, explicit effort and availability are checked by controller at launch.'});
}

/** Small externally sent projection, with source strengths and no task, account, receipt or secret. */
export function compactModelCriteria(resourceId,options){
 const card=modelCriteria(resourceId,options);if(!card)return undefined;
 const summary={identity:card.identity,stale:card.stale,
  vendorSuitability:card.stale?[]:card.vendorUses.map(v=>({task:v.task,source:v.sourceId,kind:v.kind})),
  effortSupport:Object.fromEntries(Object.entries(card.efforts).map(([name,item])=>[name,item.wire])),
  localCheckedOutcomes:card.localCheckedOutcomes,
  externalBenchmark:!card.stale&&card.benchmark?{source:card.benchmark.sourceId,methodology:card.benchmark.methodologySourceId,
    version:card.benchmark.indexVersion,indexPoints:card.benchmark.effortIndices,notSuccessProbability:true}:null,
  unknowns:card.stale?['Static model claims/benchmarks expired; refresh sources before comparative use.']:
    card.unknowns.slice(0,3),sourceVersion:card.sourceVersion};
 // Trim only sparse local cohort rows if needed. Never silently drop the vendor claim
 // or methodology to make room for growing local observations.
 while(summary.localCheckedOutcomes.length && Buffer.byteLength(JSON.stringify(summary),'utf8')>MAX_CARD_BYTES)
   summary.localCheckedOutcomes.pop();
 return Buffer.byteLength(JSON.stringify(summary),'utf8')<=MAX_CARD_BYTES?summary:
  {identity:card.identity,sourceVersion:card.sourceVersion,stale:card.stale,
   vendorSuitability:[],effortSupport:{},localCheckedOutcomes:[],externalBenchmark:null,
   unknowns:['Even static card too large for bounded Jev state; preserve baseline.']};
}

export function modelCriteriaSummary(resourceId,options){
 const card=compactModelCriteria(resourceId,options);return card?JSON.stringify(card):'No research card: keep controller baseline.';
}

export const MODEL_CRITERIA_VERSION=DATA.capturedAtUTC;
