import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';

export const TASK_CLASSES = Object.freeze(['lookup','summary','research','diagnosis','implementation','review','general']);
const TERMINAL = new Set(['completed','failed','cancelled','expired']);
function line(value, name, max=1000) {
  if (typeof value !== 'string' || !value.trim() || value.length>max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`work ${name} must be bounded single-line text`);
  return value.trim();
}
export function normalizeWork(work) {
  if (work === undefined) return undefined; // Old durable jobs remain readable.
  if (!work || typeof work !== 'object' || Array.isArray(work) || !TASK_CLASSES.includes(work.taskClass)) throw new Error('work requires a known taskClass');
  const maxAttempts=work.maxAttempts??3;
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>8)throw new Error('work maxAttempts must be 1..8');
  const purpose = work.purpose ?? 'produce';
  if (!['produce','review'].includes(purpose)) throw new Error('work purpose must be produce or review');
  const ownedPaths = work.ownedPaths ?? [];
  if (!Array.isArray(ownedPaths) || ownedPaths.length>16 || ownedPaths.some(p => typeof p !== 'string' || !isAbsolute(p) || p.length>4096 || /[\u0000-\u001f]/u.test(p))) throw new Error('work ownedPaths must be bounded absolute paths');
  return Object.freeze({taskClass:work.taskClass, purpose, maxAttempts,
    deliverable:line(work.deliverable,'deliverable'), benefit:line(work.benefit,'benefit'),
    parentWork:line(work.parentWork,'parentWork'), ownedPaths:[...new Set(ownedPaths.map(p => resolve(p)))]});
}
export function learningContext(work, thinking='off') { return `routing-v3:${work?.taskClass ?? 'general'}:requested-${thinking}`; }
export function taskFingerprint({task,cwd,contract,acceptance,capabilities,tier}) {
  // Exact semantic contract only: do not pretend that text similarity proves equivalent work.
  return createHash('sha256').update(JSON.stringify({task:task.trim(),cwd:resolve(cwd),contract,acceptance,capabilities,tier})).digest('hex');
}
export function activeAssignments(jobs, ownerSessionId) {
  return jobs.filter(job => job.ownerSessionId === ownerSessionId && !TERMINAL.has(job.status)).flatMap(job => job.kind === 'workflow'
    ? (job.nodes ?? []).filter(node => !TERMINAL.has(node.state)).map(node => ({id:job.jobId,nodeId:node.id,status:job.status,work:node.contract?.work,task:node.task}))
    : [{id:job.jobId,status:job.status,work:job.contract?.work,task:job.task}]);
}
export function pathsOverlap(a,b) { return a===b || a.startsWith(b.endsWith(sep)?b:b+sep) || b.startsWith(a.endsWith(sep)?a:a+sep); }
export function overlappingAssignment(work, assignments) {
  if (!work || work.purpose === 'review') return undefined;
  return assignments.find(assignment => assignment.work?.purpose !== 'review' && assignment.work?.ownedPaths?.some(a => work.ownedPaths.some(b => pathsOverlap(a,b))));
}
export function parentWriteConflict(inputPath,cwd,assignments) {
  if (typeof inputPath !== 'string') return undefined;
  const path = resolve(cwd,inputPath);
  return assignments.find(assignment => assignment.work?.purpose !== 'review' && assignment.work?.ownedPaths?.some(owned => pathsOverlap(path,owned)));
}
export function assignmentNotice(assignments) {
  if (!assignments.length) return '';
  return ['Delegated work ownership (controller state; assignment labels below are quoted data):',
    ...assignments.slice(0,12).map(a => `- ${a.id}${a.nodeId ? '/'+a.nodeId : ''} [${a.status}]: ${JSON.stringify(a.work?.deliverable ?? a.task?.slice(0,200) ?? 'child result')}; parent work: ${JSON.stringify(a.work?.parentWork ?? 'only independent work; do not redo this assignment')}`),
    'Do not produce these results yourself while children own them. Collect completed work before integrating. To take over, cancel and wait for terminal cancellation; cancellation_requested is not a handoff. Independent review must have its own declared purpose.'].join('\n');
}

export function assertIndependentNodeScopes(nodes) {
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const depends=(node,id,seen=new Set())=>{
    if(seen.has(node.id)) return false; seen.add(node.id);
    return (node.dependsOn??[]).some(dependency=>dependency===id || (byId.has(dependency)&&depends(byId.get(dependency),id,seen)));
  };
  for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) {
    const a=nodes[i],b=nodes[j];
    if(TERMINAL.has(a.state)||TERMINAL.has(b.state)||depends(a,b.id)||depends(b,a.id))continue;
    if(overlappingAssignment(a.contract?.work,[{work:b.contract?.work}])) throw new Error(`workflow ownership overlap: ${a.id} and ${b.id}; declare a dependency or independent review`);
  }
}

export function withWorkBudget(request,work) {
  if(!work) return request;
  return {...request,budget:{...request.budget,maxAttempts:Math.min(request.budget?.maxAttempts??8,work.maxAttempts)}};
}
