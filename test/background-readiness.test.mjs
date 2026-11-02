import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundReadiness } from '../src/background-readiness.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function idle(preparation){for(let i=0;i<50&&preparation.pending;i++)await tick();assert.equal(preparation.pending,false);}

test('automatic preparation is deferred, single-flight and does not make visible input wait',async()=>{
  let calls=0,finish;
  const prep=new BackgroundReadiness({prepare:()=>{calls++;return new Promise(resolve=>{finish=resolve;});},minIntervalMs:0});
  assert.equal(prep.schedule(),true);assert.equal(calls,0);
  assert.equal(prep.schedule(),false);
  await tick();assert.equal(calls,1);
  assert.equal(prep.schedule(),false,'owner turns cannot multiply an in-flight probe sweep');
  finish();await idle(prep);assert.equal(calls,1);
  await prep.close();
});

test('later ordinary input automatically refreshes readiness after the bounded cooldown',async()=>{
  let now=0,calls=0;
  const prep=new BackgroundReadiness({prepare:async()=>{calls++;},now:()=>now,minIntervalMs:30_000});
  prep.schedule();await idle(prep);assert.equal(calls,1);
  now=29_999;assert.equal(prep.schedule(),false);
  now=60_001;assert.equal(prep.schedule(),true);await idle(prep);assert.equal(calls,2);
  await prep.close();assert.equal(prep.schedule(),false);
});

test('background preparation failure settles and is not an endless idle retry loop',async()=>{
  let calls=0;
  const prep=new BackgroundReadiness({prepare:async()=>{calls++;throw new Error('controller unavailable');},minIntervalMs:0});
  prep.schedule();await idle(prep);await tick();assert.equal(calls,1);
  assert.equal(prep.schedule(),true);await idle(prep);assert.equal(calls,2);
  await prep.close();
});

test('deadline and shutdown abort only owned preparation and leave no scheduled work',async()=>{
  for(const shutdown of [false,true]){
    let signal,aborted=0;
    const prep=new BackgroundReadiness({prepare:input=>{signal=input.signal;return new Promise(resolve=>signal.addEventListener('abort',()=>{aborted++;resolve();},{once:true}));},deadlineMs:20});
    prep.schedule();await tick();assert.ok(signal);
    if(shutdown)await prep.close();else await idle(prep);
    assert.equal(signal.aborted,true);assert.equal(aborted,1);assert.equal(prep.pending,false);
    await prep.close();assert.equal(prep.schedule(),false);
  }
  let calls=0;
  const prep=new BackgroundReadiness({prepare:()=>{calls++;}});
  prep.schedule();await prep.close();await tick();assert.equal(calls,0,'shutdown before dispatch spends no provider inference');
});
