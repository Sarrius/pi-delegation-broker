import { qualityForModel } from './model-quality-catalog.mjs';
import { evaluateRouteEligibility, baseRouteProvider } from './model-provenance-policy.mjs';
import { preferenceMatches } from './model-preferences.mjs';
import { poolBlocksWork } from './model-selector.mjs';

export function modelLearningIdentity(resourceId, registry) {
  const model = registry?.resources?.[resourceId]?.model;
  return model ? `${baseRouteProvider(model.provider)}/${model.modelId}` : resourceId;
}
/** No credentials, probes or model requests. Snapshot is advisory; leasing remains authoritative. */
export function delegationInventory({registry, inventory=[], currency={}, pools={}, preferences, now=Date.now(), enabled=true}={}) {
  const live = new Map(inventory.map(row => [row.resourceId,row]));
  const rows = Object.entries(registry?.resources ?? {}).map(([id,resource]) => {
    const model=resource.model ?? {}; const health=live.get(id);
    const tier=qualityForModel({...model,generation:currency[id]?.generation}) ?? 'unrated';
    const explicitlyAllowed=Object.values(preferences?.tiers ?? {}).some(entries => preferenceMatches(entries,model));
    const policy=evaluateRouteEligibility({identity:model,resource,currencyFact:currency[id],explicitlyAllowed,requestedTier:tier,meetsQuality:tier!=='unrated'});
    const poolFact=resource.pool ? pools[resource.pool] : undefined;
    let state='unknown'; const reasons=[...policy.reasons];
    if (!enabled) {state='stopped'; reasons.push('broker_stopped');}
    else if (!policy.eligible || tier==='apex') {state='excluded'; if(tier==='apex') reasons.push('requires_explicit_controller_admission');}
    else if (resource.pool && poolBlocksWork(poolFact,now)) {state='excluded';reasons.push('pool_near_exhausted');}
    else if (health?.retiring || (health?.state && !['healthy','unknown'].includes(health.state))) state='unavailable';
    else if (health && Math.max(health.cooldownUntil??0,health.groupCooldownUntil??0)>now) state='cooling_down';
    else if (health?.probeLeaseId) state='probe_in_flight';
    else if (health && health.activeLeases>=Math.max(0,health.maxConcurrent-(health.controlReserve??1)-(health.verifyReserve??0))) state='busy';
    else if (health?.breakerState==='cooling_down') state='probe_eligible';
    else if (health?.state==='healthy') state='available';
    else if (health) state='probe_eligible';
    // Explain observed health independently of policy eligibility. These labels describe gates,
    // not the underlying provider fault: absent response headers do not prove a dead endpoint.
    if (!health) reasons.push('no_health_observation');
    else {
      if (health.retiring) reasons.push('resource_retiring');
      if (health.state === 'unknown') reasons.push('resource_health_unknown');
      if (health.state && !['healthy','unknown'].includes(health.state)) reasons.push('resource_unavailable');
      if ((health.cooldownUntil ?? 0) > now) reasons.push('resource_cooldown');
      if ((health.groupCooldownUntil ?? 0) > now) reasons.push('capacity_group_cooldown');
      if (health.probeLeaseId) reasons.push('capacity_group_probe_in_flight');
      if (state === 'busy') reasons.push('child_slots_busy');
      if (state === 'probe_eligible') reasons.push('recovery_probe_required');
    }
    return {resourceId:id,provider:model.provider,modelId:model.modelId,tier,state,reasons,
      capabilities:registry.profiles?.[resource.profile]?.supports??[],enforcement:health?.enforcement??null,
      confidence:health?.confidence??'unknown',capacityGroup:health?.capacityGroup??null,
      freeChildSlots:health ? Math.max(0,health.maxConcurrent-(health.controlReserve??1)-(health.verifyReserve??0)-health.activeLeases) : null,
      retryAt:health ? Math.max(health.cooldownUntil??0,health.groupCooldownUntil??0) || null : null,
      freshnessEvaluatedAt:currency[id]?.evaluatedAt??null,
      ...(resource.pool ? {pool:resource.pool,poolUsedPercent:poolFact?.usedPercent??null,poolResetAt:poolFact?.resetAt??null} : {}),
      cost:{status:['native_subscription','included_subscription'].includes(policy.provenance.billingPool)?'subscription_no_request_price':'unavailable',actualMoney:null}};
  });
  return {observedAt:now,enabled,availabilityGuarantee:false,parentQuotaReserve:'not_measurable',rows};
}
export function prioritizeInventoryRows(rows,{provider,limit=100}={}) {
  if(!Array.isArray(rows)||!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error('invalid inventory view');
  const order={available:0,probe_eligible:1,busy:2,cooling_down:3,unavailable:4,unknown:5,excluded:6,stopped:7};
  return rows.filter(row=>!provider||row.provider===provider)
    .map((row,index)=>({row,index}))
    .sort((a,b)=>(order[a.row.state]??8)-(order[b.row.state]??8)||a.index-b.index)
    .slice(0,limit).map(entry=>entry.row);
}
export function inventorySummary(snapshot) {
  const summary = new Map();
  for (const row of snapshot.rows) {
    const key=`${row.provider}/${row.tier}`; const counts=summary.get(key)??{};
    counts[row.state]=(counts[row.state]??0)+1; summary.set(key,counts);
  }
  return `Delegation catalog/health snapshot ${new Date(snapshot.observedAt).toISOString()} (NOT live inference evidence; launch rechecks and reserves capacity).\n`
    + [...summary].slice(0,24).map(([key,counts])=>`${key}: ${Object.entries(counts).map(([state,n])=>`${n} ${state}`).join(', ')}`).join('\n')
    + '\nBefore deciding to delegate, call delegate_inventory for bounded real native inference evidence; unchecked rows remain unknown. A short successful probe cannot guarantee future quota or child startup. No monetary price is inferred from tokens.';
}

/** Preserve the selector's vetted preference at actual atomic lease admission. */
export function rankAdmittedResources({contract,resourceIds}) {
  const order=new Map((contract?.capability?.allowedResources??[]).map((id,index)=>[id,index]));
  return [...resourceIds].sort((a,b)=>(order.get(a)??Infinity)-(order.get(b)??Infinity));
}
