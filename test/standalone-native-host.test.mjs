import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
test('standalone broker delegates through public Pi provider APIs without sibling extension injection',{timeout:30000},async t=>{
 const home=mkdtempSync('/tmp/pibs-');t.after(()=>rmSync(home,{recursive:true,force:true}));
 const agent=join(home,'.pi/agent'),result=join(home,'result.json');mkdirSync(agent,{recursive:true,mode:0o700});
 writeFileSync(join(agent,'auth.json'),JSON.stringify({anthropic:{type:'api_key',key:'fixture-native'}}));
 writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[],quietStartup:true,defaultProjectTrust:'always',defaultProvider:'standalone-parent',defaultModel:'parent'}));
 const child=spawn(process.env.PI_BIN??'pi',['--offline','--no-context-files','--no-skills','--no-extensions','--no-session',
  '-e',new URL('./fixtures/standalone-native-host.ts',import.meta.url).pathname,
  '-e',new URL('../extensions/pi-delegation-broker.ts',import.meta.url).pathname,'-p','--mode','json','Run the standalone canary'],{
  stdio:['ignore','pipe','pipe'],cwd:home,env:{...process.env,HOME:home,PI_CODING_AGENT_DIR:agent,STANDALONE_RESULT:result},detached:true,
 });
 t.after(()=>{if(child.exitCode===null)try{process.kill(-child.pid,'SIGTERM')}catch{}});
 let output='';const capture=d=>{output+=d};child.stdout.on('data',capture);child.stderr.on('data',capture);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
 assert.equal(code,0,output);assert.match(output,/STANDALONE_PARENT_OK/);
 const evidence=JSON.parse(readFileSync(result,'utf8'));assert.equal(evidence.childRequests,1);
 assert.equal(evidence.result.isError,false,JSON.stringify(evidence));
 assert.doesNotMatch(output,/"type":"extension_error"/);
});
