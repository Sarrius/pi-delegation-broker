import { qualityForModel } from './model-quality-catalog.mjs';
import { evaluateRouteEligibility, baseRouteProvider } from './model-provenance-policy.mjs';
import { preferenceMatches } from './model-preferences.mjs';

export function modelLearningIdentity(resourceId, registry) {
  const model = registry?.resources?.[resourceId]?.model;
  return model ? `${baseRouteProvider(model.provider)}/${model.modelId}` : resourceId;
}
/** No credentials, probes or model requests. Snapshot is advisory; leasing remains authoritative. */
export function delegationInventory({registry, inventory=[], currency={}, preferences, now=Date.now(), enabled=true}={}) {
  const live = new Map(inventory.map(row => [row.resourceId,row]));
  const rows = Object.entries(registry?.resources ?? {}).map(([id,resource]) => {
    const model=resource.model ?? {}; const health=live.get(id);
    const tier=qualityForModel({...model,generation:currency[id]?.generation}) ?? 'unrated';
    const explicitlyAllowed=Object.values(preferences?.tiers ?? {}).some(entries => preferenceMatches(entries,model));
    const policy=evaluateRouteEligibility({identity:model,resource,currencyFact:currency[id],explicitlyAllowed,meetsQuality:tier!=='unrated'});
    let state='unknown'; const reasons=[...policy.reasons];
    if (!enabled) {state='stopped'; reasons.push('broker_stopped');}
    else if (!policy.eligible || tier==='apex') {state='excluded'; if(tier==='apex') reasons.push('requires_explicit_controller_admission');}
    else if (health?.retiring || (health?.state && !['healthy','unknown'].includes(health.state))) state='unavailable';
    else if (health && Math.max(health.cooldownUntil??0,health.groupCooldownUntil??0)>now) state='cooling_down';
    else if (health?.probeLeaseId) state='probe_in_flight';
    else if (health && health.activeLeases>=Math.max(0,health.maxConcurrent-(health.controlReserve??1)-(health.verifyReserve??0))) state='busy';
    else if (health?.state==='healthy') state='available';
    else if (health) state='probe_eligible';
    return {resourceId:id,provider:model.provider,modelId:model.modelId,tier,state,reasons,
      capabilities:registry.profiles?.[resource.profile]?.supports??[],enforcement:health?.enforcement??null,
      confidence:health?.confidence??'unknown',capacityGroup:health?.capacityGroup??null,
      freeChildSlots:health ? Math.max(0,health.maxConcurrent-(health.controlReserve??1)-(health.verifyReserve??0)-health.activeLeases) : null,
      retryAt:health ? Math.max(health.cooldownUntil??0,health.groupCooldownUntil??0) || null : null,
      freshnessEvaluatedAt:currency[id]?.evaluatedAt??null,
      cost:{status:policy.provenance.billingPool==='native_subscription'?'subscription_no_request_price':'unavailable',actualMoney:null}};
  });
  return {observedAt:now,enabled,availabilityGuarantee:false,parentQuotaReserve:'not_measurable',rows};
}
export function inventorySummary(snapshot) {
  const summary = new Map();
  for (const row of snapshot.rows) {
    const key=`${row.provider}/${row.tier}`; const counts=summary.get(key)??{};
    counts[row.state]=(counts[row.state]??0)+1; summary.set(key,counts);
  }
  return `Delegation availability snapshot ${new Date(snapshot.observedAt).toISOString()} (advisory; launch rechecks and reserves capacity).\n`
    + [...summary].slice(0,24).map(([key,counts])=>`${key}: ${Object.entries(counts).map(([state,n])=>`${n} ${state}`).join(', ')}`).join('\n')
    + '\nUse delegate_inventory for model details. Subscription quota headroom is unknown; no monetary price is inferred from tokens.';
}

/** Preserve the selector's vetted preference at actual atomic lease admission. */
export function rankAdmittedResources({contract,resourceIds}) {
  const order=new Map((contract?.capability?.allowedResources??[]).map((id,index)=>[id,index]));
  return [...resourceIds].sort((a,b)=>(order.get(a)??Infinity)-(order.get(b)??Infinity));
}
