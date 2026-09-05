import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
test('parent-facing tools enforce declared ownership and expose honest persistent evidence',async t=>{
 const home=mkdtempSync(join(tmpdir(),'broker-product-host-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const child=spawn(process.execPath,['--experimental-strip-types',new URL('./fixtures/extension-product-probe.mjs',import.meta.url).pathname],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HOME:home,BROKER_EXTENSION_PATH:new URL('../extensions/pi-delegation-broker.ts',import.meta.url).pathname}});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(output)))});
});
