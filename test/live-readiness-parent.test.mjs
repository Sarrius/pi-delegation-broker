import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';

for(const {result,settlement} of [
  ...['ok','429','transport'].map(result=>({result})),
  {result:'ok',settlement:'startup'},
  {result:'ok',settlement:'running'},
  {result:'ok',settlement:'shutdown'},
]) test(`fresh extension checked-inference inventory and task preview: ${result}${settlement?` during parent ${settlement} settlement`:''}`,async t=>{
  const home=mkdtempSync('/tmp/brl-');t.after(()=>rmSync(home,{recursive:true,force:true}));
  const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/live-readiness-parent.mjs',import.meta.url).pathname],{
    cwd:new URL('..',import.meta.url).pathname,
    env:{...process.env,HOME:home,BROKER_EXTENSION_PATH:new URL('../extensions/pi-delegation-broker.ts',import.meta.url).pathname,PROBE_RESULT:result,...(settlement?{PROBE_SETTLEMENT:settlement}:{})},
  });
  let text='';child.stdout.on('data',data=>text+=data);child.stderr.on('data',data=>text+=data);
  const timer=setTimeout(()=>child.kill('SIGKILL'),25_000);
  try {await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(text)))});
    assert.match(text,/verified inventory integration/);
    if(settlement==='shutdown')assert.match(text,/qualification aborted and child exited on shutdown/);
    else if(settlement)assert.match(text,/qualification survived; orphan cleanup retained/);
  }finally{clearTimeout(timer)}
});
