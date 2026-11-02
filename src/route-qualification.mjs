import { Semaphore } from './semaphore.mjs';

const unknown = (reason='not_qualified') => Object.freeze({status:'not_checked',reason});
const safeReason = value => typeof value==='string' && /^[a-z_]{1,64}$/.test(value) ? value : 'qualification_failed';

/** Controller-owned evidence, never task acceptance. No user brief enters a probe.
 * Cold routes require an isolated tool-loop canary. A text ping cannot create conformance.
 * State is incarnation-local; restarts and binding changes deliberately require qualification.
 */
export class RouteQualification {
  #preflight; #canary; #probe; #health; #now; #slots; #cache=new Map(); #pending=new Map(); #stop=new AbortController();
  constructor({preflight,canary,probe,health=()=>true,now=Date.now,parallel=2}={}) {
    if([preflight,canary,probe,health,now].some(fn=>typeof fn!=='function')) throw new Error('qualification requires controller callbacks');
    this.#preflight=preflight;this.#canary=canary;this.#probe=probe;this.#health=health;this.#now=now;this.#slots=new Semaphore(parallel);
  }
  #key(id,thinking='off'){return JSON.stringify([id,thinking]);}
  cached(id,{thinking='off'}={}) {
    const entry=this.#cache.get(this.#key(id,thinking));
    if(!entry || entry.expiresAt<=this.#now() || (entry.status==='verified' && !this.#health(id))) return unknown();
    const {fingerprint,compatibleUntil,...publicEntry}=entry;
    return Object.freeze(publicEntry);
  }
  async check(id,{signal,thinking='off',fresh=false}={}) {
    if(this.#stop.signal.aborted || signal?.aborted) return unknown('cancelled');
    // An admission requiring fresh availability must never join a cache-eligible
    // inventory request. Coalesce only checks with the same freshness contract.
    const key=JSON.stringify([id,thinking,fresh]);
    // Joined callers cannot cancel another owner's check. They may stop waiting independently.
    let pending=this.#pending.get(key);
    if(!pending) {
      const controller=new AbortController();
      pending={controller,waiters:0,promise:this.#check(id,thinking,fresh,controller.signal)};
      this.#pending.set(key,pending);
      const owned=pending;
      void pending.promise.finally(()=>{if(this.#pending.get(key)===owned)this.#pending.delete(key);}).catch(()=>{});
    }
    pending.waiters++;
    let abort;
    try {
      if(!signal)return await pending.promise;
      return await Promise.race([pending.promise,new Promise(resolve=>{
        abort=()=>resolve(unknown('cancelled'));signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)abort();
      })]);
    } finally {
      if(abort)signal?.removeEventListener('abort',abort);
      if(--pending.waiters===0)pending.controller.abort();
    }
  }
  async #check(id,thinking,fresh,callerSignal) {
    const signal=AbortSignal.any([this.#stop.signal,callerSignal,AbortSignal.timeout(120_000)]);
    let release;
    const key=this.#key(id,thinking);
    try {
      release=await this.#slots.acquire(signal);
      if(!this.#health(id)) return unknown('route_not_admissible');
      const preflight=await this.#bounded(this.#preflight({resourceId:id,requestedThinking:thinking,signal}),signal);
      if(preflight?.status!=='ready') return this.#record(key,{status:'failed',reason:safeReason(preflight?.reason)},undefined,0);
      const fingerprint=preflight.routeFingerprint;
      const minimum=preflight.minimumReadinessThinking;
      if(minimum!==undefined && minimum!=='low') return this.#record(key,
        {status:'failed',reason:'readiness_effort_unattested'},fingerprint,0);
      // This raises only the internal off check to its positively attested minimum.
      // Explicit high/xhigh work conformance is never lowered or silently substituted.
      const effectiveThinking=thinking==='off' && minimum==='low'?'low':thinking;
      const previous=this.#cache.get(key);
      if(previous && previous.fingerprint===fingerprint && previous.status==='failed' && previous.expiresAt>this.#now()) return this.cached(id,{thinking});
      const compatible=typeof fingerprint==='string' && previous?.fingerprint===fingerprint && previous.compatibleUntil>this.#now();
      if(compatible && !fresh && previous.status==='verified' && previous.expiresAt>this.#now()) return this.cached(id,{thinking});
      let evidence;
      if(compatible) evidence=await this.#bounded(this.#probe({resourceId:id,signal}),signal);
      // A short ping may be inconclusive on a reasoning-only route. Only the complete
      // canary can upgrade that uncertainty; no normal task is used as the probe.
      if(!compatible || evidence?.status==='unknown') {
        evidence=await this.#bounded(this.#canary({resourceId:id,thinking:effectiveThinking,signal}),signal);
        if(evidence?.status==='verified' && evidence.evidence!=='isolated_tool_roundtrip') evidence={status:'failed',reason:'canary_evidence_missing'};
      }
      if(signal.aborted) return unknown('cancelled');
      if(evidence?.status!=='verified') return this.#record(key,
        {status:evidence?.status==='failed'?'failed':'unknown',reason:safeReason(evidence?.reason)},fingerprint,0);
      if(!this.#health(id)) return unknown('route_state_changed');
      const after=await this.#bounded(this.#preflight({resourceId:id,requestedThinking:thinking,signal}),signal);
      if(after?.status!=='ready' || after.routeFingerprint!==fingerprint) return unknown('route_changed_during_check');
      const verified=evidence?.status==='verified';
      return this.#record(key,verified?{status:'verified',evidence:'isolated_tool_roundtrip',
        ...(evidence.canaryId?{canaryId:evidence.canaryId}:previous?.canaryId?{canaryId:previous.canaryId}:{}),
        effectiveQualificationThinking:effectiveThinking,
        compatibilityCheckedAt:compatible?previous.compatibilityCheckedAt:this.#now()}
        :{status:evidence?.status==='failed'?'failed':'unknown',reason:safeReason(evidence?.reason)},
        fingerprint,verified?(compatible?previous.compatibleUntil:this.#now()+600_000):0);
    } catch {return this.#record(key,{status:'unknown',reason:signal.aborted?'check_cancelled_or_timed_out':'qualification_failed'},undefined,0);}
    finally {release?.();}
  }
  #record(key,value,fingerprint,compatibleUntil) {
    const checkedAt=this.#now();
    const result={...value,checkedAt,expiresAt:checkedAt+(value.status==='verified'?60_000:5_000)};
    this.#cache.set(key,{...result,fingerprint,compatibleUntil});
    return Object.freeze(result);
  }
  async #bounded(promise,signal) {
    let abort;
    try {return await Promise.race([promise,new Promise((_,reject)=>{
      abort=()=>reject(new Error('qualification cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    })]);} finally {signal.removeEventListener('abort',abort);}
  }
  async verifyRows(rows,{maxChecks=1000,signal}={}) {
    if(!Array.isArray(rows)||!Number.isSafeInteger(maxChecks)||maxChecks<1||maxChecks>1000)throw new Error('invalid qualification sweep');
    let selected=0;
    await Promise.all(rows.map(async row=>{
      if(!['available','probe_eligible'].includes(row.state)||selected++>=maxChecks||signal?.aborted)return;
      await this.check(row.resourceId,{signal});
    }));
    return rows.map(row=>({...row,readiness:this.cached(row.resourceId)}));
  }
  async close(){this.#stop.abort();await Promise.allSettled([...this.#pending.values()].map(entry=>entry.promise));this.#cache.clear();}
}

/** Connected/healthy catalog rows are diagnostic data, never a ready child roster. */
export function qualifiedInventory(snapshot,qualification,{now=Date.now()}={}) {
  const rows=snapshot.rows.map(row=>{
    const readiness=qualification?.cached(row.resourceId)??unknown();
    const ready=['available','probe_eligible'].includes(row.state)&&readiness.status==='verified'&&readiness.expiresAt>now;
    return {...row,catalogState:row.state,state:ready?'ready':row.state==='available'?'unverified':row.state,readiness};
  });
  return {...snapshot,rows:rows.filter(row=>row.state==='ready'),diagnostics:rows.filter(row=>row.state!=='ready')};
}
