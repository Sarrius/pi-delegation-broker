import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {visualFixture} from './fixtures/jev-visual-image.mjs';

test('fresh Pi imports experimental visual tool and completes real tool dispatch with isolated fake API',{timeout:30000},async t=>{
 const root=mkdtempSync('/tmp/pivis-');t.after(()=>rmSync(root,{recursive:true,force:true}));
 const agent=join(root,'agent'),state=join(root,'state'),image=join(root,'image.png');mkdirSync(agent);mkdirSync(state);
 writeFileSync(image,visualFixture());
 writeFileSync(join(state,'jev-engine.json'),JSON.stringify({schemaVersion:1,decisions:true,routing:false,consentToSendTaskText:true,scope:'all_cwds',autoThinkingMax:'low'}));
 // The new activation overlay leaves the legacy strict engine file readable by old owners.
 writeFileSync(join(state,'jev-visual.json'),JSON.stringify({schemaVersion:1,enabled:true,consentToSendImages:true}));
 writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[],quietStartup:true,defaultProjectTrust:'always',defaultProvider:'visual-fixture',defaultModel:'parent'}));
 const child=spawn(process.env.PI_BIN??'pi',['--offline','--no-context-files','--no-skills','--no-extensions','--no-session',
  '-e',new URL('./fixtures/jev-visual-host.ts',import.meta.url).pathname,'-p','--mode','json','Locate the rectangle'],
  {cwd:root,env:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agent,JEV_VISUAL_STATE:state,JEV_VISUAL_IMAGE:image},stdio:['ignore','pipe','pipe'],detached:true});
 t.after(()=>{if(child.exitCode===null)try{process.kill(-child.pid,'SIGTERM');}catch{}});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 assert.equal(code,0,output);assert.match(output,/VISUAL_NATIVE_OK/);assert.doesNotMatch(output,/"type":"extension_error"|synthetic-key|data_base64/);
});
