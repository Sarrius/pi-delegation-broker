import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainedWork } from '../src/retained-work.mjs';

test('retained work exposes raw journal pointers without promoting private contents to a result', t => {
  const root = mkdtempSync(join(tmpdir(), 'retained-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'task', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'attempt.jsonl'), 'private captured tool output\n');
  const result = retainedWork(root, 'task');
  assert.equal(result.status, 'available');
  assert.equal(result.artifacts[0].verificationStatus, 'unverified');
  assert.equal(result.artifacts[0].path, join(dir, 'attempt.jsonl'));
  assert.equal(JSON.stringify(result).includes('private captured tool output'), false);
  assert.equal(retainedWork(root, 'absent').status, 'not_found');
  assert.throws(() => retainedWork(root, '../task'), /invalid task/);
});

test('retained work does not follow symlink evidence outside task', t => {
  const root = mkdtempSync(join(tmpdir(), 'retained-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'task'));
  mkdirSync(join(root, 'foreign'));
  writeFileSync(join(root, 'foreign', 'secret.jsonl'), 'not this task');
  symlinkSync(join(root, 'foreign'), join(root, 'task', 'sessions'));
  assert.deepEqual(retainedWork(root, 'task').artifacts, []);
});
