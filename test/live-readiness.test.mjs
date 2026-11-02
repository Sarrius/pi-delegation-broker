import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveReadiness } from '../src/live-readiness.mjs';

const route = (id, {state='available',billing='subscription_no_request_price'}={}) => ({
  resourceId:id,provider:id.split('/')[0],state,cost:{status:billing},
});

test('a checked route gets short-lived native inference evidence; another call reuses it but not forever', async () => {
  let time=1000, calls=0;
  const readiness=new LiveReadiness({now:()=>time,probe:async()=>{calls++;return {status:'verified',checkedAt:time,evidence:'native_inference'};}});
  const rows=[route('cursor/composer-2.5'),route('metered/flash',{billing:'unavailable'}),route('slot/cool',{state:'cooling_down'})];
  const first=await readiness.verifyRows(rows,{maxChecks:2});
  assert.equal(calls,1);
  assert.equal(first[0].readiness.status,'verified');
  assert.equal(first[0].readiness.checkedAt,time);
  assert.equal(first[1].readiness.status,'not_checked');
  assert.equal(first[2].readiness.status,'not_checked');
  time+=1000;
  await readiness.verifyRows(rows,{maxChecks:2});
  assert.equal(calls,1);
  time+=16_000;
  await readiness.verifyRows(rows,{maxChecks:2});
  assert.equal(calls,2);
});

test('concurrent readiness requests single-flight, 429 updates the exact capacity group, and failures are never verified', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let calls=0,rateLimits=[];
  const readiness=new LiveReadiness({probe:async()=>{calls++;await gate;return {status:'failed',reason:'rate_limited',scope:'capacity_group',retryAfterMs:3000};},
    onRateLimited:async(id,delay)=>rateLimits.push([id,delay])});
  const rows=[route('slot/a')];
  const a=readiness.verifyRows(rows,{maxChecks:1});
  const b=readiness.verifyRows(rows,{maxChecks:1});
  release();
  const [one,two]=await Promise.all([a,b]);
  assert.equal(calls,1);
  assert.equal(one[0].readiness.status,'failed');
  assert.equal(two[0].readiness.status,'failed');
  assert.deepEqual(rateLimits,[['slot/a',3000]]);
});

test('an early proof that expires during a slow multi-route sweep is not presented as current', async () => {
  let time=1000;
  const readiness=new LiveReadiness({now:()=>time,probe:async()=>{
    const checkedAt=time;
    time+=16_000;
    return {status:'verified',checkedAt,evidence:'native_inference'};
  }});
  const rows=await readiness.verifyRows([route('slot/a'),route('other/a')],{maxChecks:2});
  assert.notEqual(rows[0].readiness.status,'verified');
  assert.equal(rows[1].readiness.status,'verified');
});

test('a proven group 429 never floods its sibling models during a sweep', async () => {
  const seen=[];
  const readiness=new LiveReadiness({probe:async({resourceId})=>{
    seen.push(resourceId);
    return resourceId.startsWith('slot/')
      ? {status:'failed',reason:'rate_limited',scope:'capacity_group'}
      : {status:'verified',checkedAt:Date.now()};
  }});
  const rows=[{...route('slot/model-a'),capacityGroup:'slot-quota'},
    {...route('slot/model-b'),capacityGroup:'slot-quota'},
    {...route('other/model'),capacityGroup:'other-quota'}];
  const result=await readiness.verifyRows(rows,{maxChecks:3});
  assert.deepEqual(seen,['slot/model-a','other/model']);
  assert.equal(result[1].readiness.status,'not_checked');
  assert.equal(result[1].readiness.reason,'capacity_group_probe_failed');
});

test('cancellation and bounded checks leave unexamined routes unknown, not falsely available', async () => {
  const seen=[];
  const readiness=new LiveReadiness({probe:async({resourceId})=>{seen.push(resourceId);return {status:'verified',checkedAt:Date.now(),evidence:'native_inference'};}});
  const rows=[route('one/a'),route('two/a'),route('three/a')];
  const observed=await readiness.verifyRows(rows,{maxChecks:1});
  assert.equal(seen.length,1);
  assert.equal(observed.filter(row=>row.readiness.status==='not_checked').length,2);
  const cancelled=await readiness.verifyRows([route('four/a')],{signal:AbortSignal.abort()});
  assert.equal(cancelled[0].readiness.status,'not_checked');
  assert.equal(seen.length,1);
});
