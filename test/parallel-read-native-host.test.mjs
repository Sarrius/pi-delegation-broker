import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('fresh Pi: one child response with three duplicate reads can return a useful final report', { timeout: 30000 }, async (t) => {
  const home = mkdtempSync('/tmp/pibr-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = join(home, '.pi/agent'), result = join(home, 'result.json'), file = join(home, 'probe.txt');
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  writeFileSync(file, 'BATCH_READ_DATA\n');
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'fixture-native' } }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], quietStartup: true,
    defaultProjectTrust: 'always', defaultProvider: 'standalone-parent', defaultModel: 'parent' }));
  const child = spawn(process.env.PI_BIN ?? 'pi', [
    '--offline', '--no-context-files', '--no-skills', '--no-extensions', '--no-session',
    '-e', new URL('./fixtures/parallel-read-native-host.ts', import.meta.url).pathname,
    '-e', new URL('../extensions/pi-delegation-broker.ts', import.meta.url).pathname,
    '-p', '--mode', 'json', 'Run the parallel-read canary',
  ], { stdio: ['ignore', 'pipe', 'pipe'], cwd: home,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, BATCH_READ_FILE: file,
      BATCH_READ_RESULT: result, PI_JEV_API_KEY: '' }, detached: true });
  t.after(() => { if (child.exitCode === null) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, output);
  assert.match(output, /BATCH_PARENT_OK/);
  const evidence = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(evidence.childRequests, 2, 'one provider tool turn and one final answer');
  assert.equal(evidence.readResults, 3, 'Pi delivered all three identical results to the model once');
  assert.equal(evidence.result.isError, false, 'broker must deliver a successful child report');
  assert.doesNotMatch(output, /"type":"extension_error"/);
});
