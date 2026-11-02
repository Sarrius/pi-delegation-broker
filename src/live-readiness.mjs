const VERIFIED_TTL_MS = 15_000;
const FAILED_TTL_MS = 5_000;
const REASON = /^[a-z_]{1,64}$/;
const notChecked = Object.freeze({status:'not_checked',reason:'no_recent_inference_evidence'});

/** Controller-local, short-lived inference observations; never an authorization or quota promise. */
export class LiveReadiness {
  #probe; #onRateLimited; #onUnavailable; #now; #cache=new Map(); #inFlight=new Map();
  constructor({probe,onRateLimited, onUnavailable,now=Date.now}={}) {
    if(typeof probe!=='function'||typeof now!=='function') throw new Error('live readiness needs controller native probe and clock');
    this.#probe=probe;this.#onRateLimited=onRateLimited;this.#onUnavailable=onUnavailable;this.#now=now;
  }
  cached(resourceId) {
    const entry=this.#cache.get(resourceId);
    if(!entry) return notChecked;
    if(entry.expiresAt<=this.#now()) {this.#cache.delete(resourceId);return notChecked;}
    return entry;
  }
  async check(resourceId,{signal,fresh=false}={}) {
    if(typeof resourceId!=='string'||!resourceId||signal?.aborted) return notChecked;
    const cached=this.cached(resourceId);
    if(!fresh && cached.status!=='not_checked') return cached;
    const pending=this.#inFlight.get(resourceId);
    if(pending) return pending;
    const work=(async()=>{
      let value;
      try {value=await this.#probe({resourceId,signal});}
      catch {value={status:'unknown',reason:'probe_failed'};}
      if(signal?.aborted) return {status:'unknown',reason:'cancelled'};
      const status=['verified','failed','unknown'].includes(value?.status)?value.status:'unknown';
      const reason=typeof value?.reason==='string'&&REASON.test(value.reason)?value.reason:'probe_unconfirmed';
      if(status==='failed') {
        try {
          if(reason==='rate_limited') await this.#onRateLimited?.(resourceId,value.retryAfterMs);
          else if(['auth_failed','quota_exhausted','model_request_rejected','route_endpoint_unreachable','transport_before_headers'].includes(reason))
            await this.#onUnavailable?.(resourceId,reason,value.scope==='capacity_group'?'capacity_group':'resource');
        } catch { /* a failed observation never becomes a verified success */ }
      }
      const checkedAt=this.#now();
      const result=Object.freeze({status,checkedAt,
        ...(status==='verified'?{evidence:'native_inference'}:{reason,
          ...(value?.scope==='capacity_group'?{scope:'capacity_group'}:{})}),
        expiresAt:checkedAt+(status==='verified'?VERIFIED_TTL_MS:FAILED_TTL_MS)});
      if(!signal?.aborted && reason!=='cancelled') this.#cache.set(resourceId,result);
      return result;
    })();
    this.#inFlight.set(resourceId,work);
    try {return await work;}finally{if(this.#inFlight.get(resourceId)===work)this.#inFlight.delete(resourceId);}
  }
  /** A partial sweep NEVER calls a non-checked route verified. Only native eligible, healthy routes. */
  async verifyRows(rows,{maxChecks=4,signal}={}) {
    if(!Number.isSafeInteger(maxChecks)||maxChecks<1||maxChecks>16||!Array.isArray(rows)) throw new Error('invalid readiness sweep bounds');
    const observations=new Map();
    const failedGroups=new Set();
    let checks=0;
    for(const row of rows) {
      const eligible=row?.state==='available'&&row?.cost?.status==='subscription_no_request_price';
      if(!eligible||typeof row.resourceId!=='string') continue;
      if(row.capacityGroup && failedGroups.has(row.capacityGroup)) {
        observations.set(row.resourceId,{status:'not_checked',reason:'capacity_group_probe_failed'});
        continue;
      }
      let current=this.cached(row.resourceId);
      if(current.status==='not_checked'&&!signal?.aborted&&checks<maxChecks) {
        checks++;
        current=await this.check(row.resourceId,{signal});
      }
      observations.set(row.resourceId,current);
      if(current.status==='failed' && current.scope==='capacity_group' && row.capacityGroup) failedGroups.add(row.capacityGroup);
    }
    return rows.map(row=>{
      const observed=observations.get(row.resourceId)??notChecked;
      const readiness=observed.expiresAt!==undefined && observed.expiresAt<=this.#now()
        ? {status:'not_checked',reason:'expired_during_sweep'} : observed;
      return {...row,readiness};
    });
  }
}
