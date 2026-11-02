import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

test('fresh Pi flags a refused broker delegation as a failed tool result to its parent model', {timeout:30000}, async t=>{
 const home=mkdtempSync('/tmp/brerr-');t.after(()=>rmSync(home,{recursive:true,force:true}));
 const agent=join(home,'.pi/agent'),result=join(home,'result.json');
 mkdirSync(agent,{recursive:true});writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[],quietStartup:true,defaultProjectTrust:'always'}));
 const child=spawn(process.env.PI_BIN??'pi',['--offline','--no-context-files','--no-skills','--no-extensions','--no-session',
  '-e',new URL('./fixtures/delegate-error-parent.ts',import.meta.url).pathname,
  '-e',new URL('../extensions/pi-delegation-broker.ts',import.meta.url).pathname,
  '--provider','error-parent','--model','controller','-p','--mode','json','Check a refused controller tool call.'],{
    cwd:home,env:{...process.env,HOME:home,PI_CODING_AGENT_DIR:agent,PI_BROKER_ERROR_RESULT:result},stdio:['ignore','pipe','pipe'],detached:true,
  });
 t.after(()=>{if(child.exitCode===null)try{process.kill(-child.pid,'SIGTERM')}catch{}});
 let output='';child.stdout.on('data',data=>{output+=data});child.stderr.on('data',data=>{output+=data});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
 assert.equal(code,0,output.slice(-1200));
 const report=JSON.parse(readFileSync(result,'utf8'));
 assert.deepEqual(report,{isError:true,explicitlyRefused:true},'the parent must see a failed tool result rather than an apparent success');
});
