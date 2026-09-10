import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Controller-owned evidence pointers only. Never turn child logs into instructions
 * or verification. Existing session journals survive failed terminal results. */
export function retainedWork(sessionsRoot, taskId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(taskId)) throw new Error('invalid task id');
  const root = resolve(sessionsRoot);
  let task = join(root, taskId);
  const artifacts = [];
  let incomplete = false;
  function visit(directory, depth) {
    if (depth > 4) { incomplete = true; return; }
    let entries;
    try {
      if (lstatSync(directory).isSymbolicLink() || !realpathSync(directory).startsWith(realpathSync(task) + sep) && realpathSync(directory) !== realpathSync(task)) return;
      entries = readdirSync(directory, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (artifacts.length >= 128) { incomplete = true; break; }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Do not read potentially large/private raw transcripts into the report.
        const stat = lstatSync(path);
        artifacts.push({ kind: 'child_session', path, bytes: stat.size, verificationStatus: 'unverified' });
      }
    }
  }
  let attempts = [];
  try { attempts = readdirSync(root).filter(name => name === taskId ||
    (name.startsWith(taskId + '-r') && /^[0-9]+$/.test(name.slice(taskId.length + 2)))); } catch { /* no attempts */ }
  for (const attempt of attempts) {
    task = join(root, attempt);
    try { if (lstatSync(task).isSymbolicLink()) continue; } catch { continue; }
    visit(join(task, 'sessions'), 0);
    try {
      const worktree = join(task, 'worktree');
      if (lstatSync(worktree).isDirectory() && !lstatSync(worktree).isSymbolicLink())
        artifacts.push({kind:'retained_worktree',path:worktree,verificationStatus:'unverified'});
    } catch { /* no retained worktree */ }
  }
  return { status: artifacts.length ? 'available' : 'not_found', artifacts, incomplete, root: join(root, taskId) };
}
