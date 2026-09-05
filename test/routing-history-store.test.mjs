import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { RoutingHistoryStore } from '../src/routing-history-store.mjs';
import { ModelAffinityJournal } from '../src/model-affinity-journal.mjs';
const caps=['code_reasoning'];
function setup(t) {const root=mkdtempSync(join(tmpdir(),'routing-shared-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return join(root,'history.sqlite');}
test('history survives restart, shares live updates, and rejects conflicting replay',t=>{
 const path=setup(t);const a=new RoutingHistoryStore({path}),b=new RoutingHistoryStore({path});t.after(()=>{a.close();b.close();});
 assert.equal(a.append({id:'one',kind:'route',data:{b:2,a:1}}).inserted,true);
 assert.equal(b.append({id:'one',kind:'route',data:{a:1,b:2}}).inserted,false);
 assert.throws(()=>b.append({id:'one',kind:'route',data:{a:2}}),/collision/);
 assert.equal(a.count(),1);assert.equal(b.list()[0].data.a,1);
 const c=new RoutingHistoryStore({path});assert.equal(c.count(),1);c.close();
 assert.equal(statSync(path).mode & 0o777,0o600);
 for(const data of [{n:NaN},{x:undefined},{x:'x'.repeat(65536)}]) assert.throws(()=>a.append({id:'invalid',kind:'route',data}));
});
test('independent processes preserve all concurrent observations',async t=>{
 const path=setup(t);const store=new RoutingHistoryStore({path});t.after(()=>store.close());
 const url=new URL('../src/routing-history-store.mjs',import.meta.url).href;
 await Promise.all(Array.from({length:4},(_,worker)=>new Promise((res,rej)=>{
 const code=`import {RoutingHistoryStore} from ${JSON.stringify(url)}; const s=new RoutingHistoryStore({path:${JSON.stringify(path)}}); for(let n=0;n<30;n++)s.append({id:'worker-${worker}:'+n,kind:'quality',data:{n}});s.close();`;
 const p=spawn(process.execPath,['--input-type=module','-e',code]);let error='';p.stderr.on('data',d=>error+=d);p.on('error',rej);p.on('exit',code=>code===0?res():rej(new Error(error)));
 })));
 assert.equal(store.count('quality'),120);
});
test('verified learning survives separate controller instances and isolates task/effort context',t=>{
 const path=setup(t);const a=new RoutingHistoryStore({path}),b=new RoutingHistoryStore({path});t.after(()=>{a.close();b.close();});
 const first=new ModelAffinityJournal({store:a}),second=new ModelAffinityJournal({store:b});
 for(let i=0;i<4;i++) first.recordVerified({observationId:`quality:${i}`,context:'diagnosis:high',resourceId:'good/model',capabilities:caps,outcome:'accepted',latencyMs:10});
 assert.deepEqual(second.rank({context:'diagnosis:high',resourceIds:['new/model','good/model'],capabilities:caps}),['good/model','new/model']);
 assert.deepEqual(second.rank({context:'lookup:low',resourceIds:['new/model','good/model'],capabilities:caps}),['new/model','good/model']);
 first.recordVerified({observationId:'quality:0',context:'diagnosis:high',resourceId:'good/model',capabilities:caps,outcome:'accepted',latencyMs:10});
 assert.equal(a.count('quality'),4);
});
test('unknown beats proven failures; traffic volume is not a quality bonus',t=>{
 const path=setup(t),store=new RoutingHistoryStore({path});t.after(()=>store.close());const journal=new ModelAffinityJournal({store});
 for(const [resourceId,wins,losses] of [['frequent',80,20],['scarce',8,0],['failed',0,3]]) for(let i=0;i<wins+losses;i++) journal.recordVerified({resourceId,capabilities:caps,outcome:i<wins?'accepted':'rejected',latencyMs:10,tokens:10});
 assert.deepEqual(journal.rank({resourceIds:['frequent','failed','unknown','scarce'],capabilities:caps}),['scarce','frequent','unknown','failed']);
});
test('exploration is one in ten eligible low-risk decisions; retry and preview consume no extra slot',t=>{
 const path=setup(t),store=new RoutingHistoryStore({path});t.after(()=>store.close());const journal=new ModelAffinityJournal({store});
 for(let i=0;i<4;i++)journal.recordVerified({resourceId:'proven',capabilities:caps,outcome:'accepted',latencyMs:10});
 let exploratory=0;
 for(let i=0;i<20;i++) {const input={resourceIds:['proven','new'],capabilities:caps,selectionId:`task-${i}`,explore:true};const ranked=journal.rank(input);if(ranked[0]==='new')exploratory++;assert.deepEqual(journal.rank(input),ranked);journal.rank({resourceIds:['proven','new'],capabilities:caps});}
 assert.equal(exploratory,2);assert.equal(store.count('decision'),20);
 assert.deepEqual(journal.rank({resourceIds:['proven'],capabilities:caps,selectionId:'exhausted',explore:true}),['proven'],'excluded providers cannot reappear via exploration');
});
