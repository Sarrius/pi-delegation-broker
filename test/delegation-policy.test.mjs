import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWork, activeAssignments, assignmentNotice, parentWriteConflict, overlappingAssignment } from '../src/delegation-policy.mjs';
import { normalizeContract, assertStoredContract } from '../src/child-contract.mjs';
const work={taskClass:'diagnosis',deliverable:'Find race',benefit:'Independent evidence',parentWork:'Inspect another subsystem',ownedPaths:['/repo/src']};
test('ownership persists in child contracts and blocks parent writes until terminal, including cancellation pending',()=>{
 const contract=assertStoredContract(normalizeContract({work}));assert.equal(contract.work.taskClass,'diagnosis');
 for(const status of ['queued','running','cancellation_requested']) {const assignments=activeAssignments([{jobId:'job',kind:'task',ownerSessionId:'owner',status,contract}],'owner');assert.ok(parentWriteConflict('src/a.ts','/repo',assignments));assert.ok(overlappingAssignment(normalizeWork(work),assignments));assert.match(assignmentNotice(assignments),/Inspect another subsystem/);}
 assert.equal(parentWriteConflict('src/a.ts','/repo',activeAssignments([{jobId:'job',kind:'task',ownerSessionId:'owner',status:'cancelled',contract}],'owner')),undefined);
 assert.equal(parentWriteConflict('src-other/a.ts','/repo',activeAssignments([{jobId:'job',kind:'task',ownerSessionId:'owner',status:'running',contract}],'owner')),undefined);
 assert.equal(activeAssignments([{jobId:'job',ownerSessionId:'foreign',status:'running'}],'owner').length,0);
});
test('independent review is deliberate and does not own production paths; malformed plans fail early',()=>{
 const review=normalizeWork({...work,purpose:'review'});assert.equal(parentWriteConflict('/repo/src/a.ts','/repo',[{work:review}]),undefined);
 assert.throws(()=>normalizeWork({...work,parentWork:''}));assert.throws(()=>normalizeWork({...work,ownedPaths:['relative']}));
});

test('parallel producers need disjoint scopes; dependency order permits sequential ownership',async()=>{
 const {assertIndependentNodeScopes}=await import('../src/delegation-policy.mjs');
 const a={id:'a',dependsOn:[],contract:normalizeContract({work})};
 const b={id:'b',dependsOn:[],contract:normalizeContract({work})};
 assert.throws(()=>assertIndependentNodeScopes([a,b]),/ownership overlap/);
 assert.doesNotThrow(()=>assertIndependentNodeScopes([a,{...b,dependsOn:['a']}]));
});

test('owning the filesystem root also protects descendant paths',()=>{
 assert.equal(parentWriteConflict('/tmp/example','/tmp',[{id:'root-job',work:{purpose:'produce',ownedPaths:['/']}}])?.id,'root-job');
});
