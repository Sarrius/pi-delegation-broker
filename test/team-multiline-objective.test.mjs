import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTaskAdmission,admitTeamNodes} from '../src/team.mjs';

test('optional objective inherits the complete multiline task without flattening',()=>{
 const task='Read the diff.\n\nTrace the callers and return findings.';
 const admission=normalizeTaskAdmission({id:'review',task,purpose:'reviewer'});
 assert.equal(admission.objective,task);
 assert.notEqual(admission.objectiveFingerprint,
  normalizeTaskAdmission({id:'review',task:task.replaceAll('\n',' '),purpose:'reviewer'}).objectiveFingerprint);
});

test('explicit nested or top-level multiline objectives retain their meaning',()=>{
 for(const field of ['objective','admission']){
  const objective='Inspect code:\n  preserve this indentation\r\nand report evidence.';
  const node={id:'review',task:'Read the source',...(field==='admission'?{admission:{objective}}:{objective})};
  assert.equal(normalizeTaskAdmission(node).objective,objective);
 }
});

test('multiline objective support keeps bounds, identifiers and duplicate guards',()=>{
 for(const objective of ['', ' \n ', '\0bad', 'x'.repeat(256*1024+1)]){
  assert.throws(()=>normalizeTaskAdmission({task:'valid',objective}));
 }
 assert.throws(()=>normalizeTaskAdmission({task:'valid',scope:'a\nb'}));
 const node={id:'first',task:'Inspect code.\nReport evidence.'};
 const first=admitTeamNodes([], [node], {concurrency:1});
 assert.equal(first.added.length,1);
 const repeat=admitTeamNodes(first.added,[{...node,id:'second'}],{concurrency:1});
 assert.equal(repeat.added.length,0);
});
