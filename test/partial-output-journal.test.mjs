import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openPartialOutputJournal } from '../src/partial-output-journal.mjs';

test('streamed public text survives abrupt process death without a final answer', t => {
  const root = mkdtempSync(join(tmpdir(), 'partial-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'attempt.jsonl');
  const module = new URL('../src/partial-output-journal.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {openPartialOutputJournal} from ${JSON.stringify(module)};
    const j=openPartialOutputJournal(${JSON.stringify(path)});
    j.record({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'partial answer'}});
    process.kill(process.pid,'SIGKILL');
  `]);
  assert.equal(child.signal, 'SIGKILL');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { type: 'text_delta', text: 'partial answer' });
});

test('reasoning and arbitrary event metadata never enter public output journal', t => {
  const root = mkdtempSync(join(tmpdir(), 'partial-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'attempt.jsonl');
  const j = openPartialOutputJournal(path);
  j.record({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'hidden'}});
  j.record({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'visible',secret:'private'}});
  j.close(); j.close();
  assert.equal(readFileSync(path,'utf8'), '{"type":"text_delta","text":"visible"}\n');
});
