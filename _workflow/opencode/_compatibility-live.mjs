import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { OpenCodeServer } from './server-api.mjs';
import { digest } from './identity.mjs';
import { opencodeFragment } from '../lib/hostinstall.mjs';
import { detectOpenCodeApi, parseOpenCodeVersion, waitForOpenCodeAgents } from './compatibility.mjs';
import { prepareDispatchConfig } from './dispatcher.mjs';

const binary = process.argv[2];
if (!binary) throw new Error('usage: node _compatibility-live.mjs <official-v2-binary> [temporary-parent]');
const root = realpathSync(mkdtempSync(join(resolve(process.argv[3] || tmpdir()), 'factory-v2-compat-')));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT)$/i.test(k)));
for (const name of ['home', 'data', 'config', 'cache', 'state', 'tmp', 'project']) mkdirSync(join(root, name));
Object.assign(env, {
  HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), OPENCODE_TEST_HOME: join(root, 'home'),
  XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
  OPENCODE_CONFIG_DIR: join(root, 'config'), OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_FILEWATCHER: '1',
  OPENCODE_PASSWORD: randomBytes(24).toString('hex'),
});
const base = JSON.parse(readFileSync(new URL('../../opencode-assets/opencode.config.json', import.meta.url)));
const profiles = JSON.parse(readFileSync(new URL('../../opencode-assets/worker-profiles.json', import.meta.url)));
const config = { ...opencodeFragment(base, profiles, 2), snapshots: false, update: 'disable' };
writeFileSync(join(root, 'config', 'opencode.json'), JSON.stringify(config));
const version = execFileSync(binary, ['--version'], { env, cwd: root, encoding: 'utf8' }).trim();
assert.equal(parseOpenCodeVersion(version)?.apiVersion, 'v2');
const child = spawn(binary, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], { env, cwd: join(root, 'project'), stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', stderr = '';
child.stderr.on('data', b => { stderr += b; });
const results = { version, root, checks: [], noModelExecution: true };
try {
  const url = await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('startup timeout: ' + stderr)), 60000);
    const finish = (fn, value) => { clearTimeout(timer); fn(value); };
    child.once('error', e => finish(no, e));
    child.once('exit', code => finish(no, new Error('server exit ' + code + ': ' + stderr)));
    child.stdout.on('data', b => {
      output += b;
      for (const line of output.split(/\r?\n/)) {
        try { const record = JSON.parse(line); if (record.url) finish(yes, record.url); } catch {}
      }
    });
  });
  const prepared = await prepareDispatchConfig({ url }, { env });
  results.detected = await detectOpenCodeApi(prepared);
  assert.equal(results.detected.apiVersion, 'v2');
  results.checks.push('auto-detection against real v2 and absent v1 endpoint');
  const wire = [];
  const api = new OpenCodeServer({ ...prepared, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === 'POST' && path.endsWith('/prompt')) init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), resume: false }) };
    const response = await fetch(url, init);
    wire.push({ method: init.method, path, status: response.status, body: await response.clone().text() });
    return response;
  } });
  try {
    const info = await api.check();
    results.info = info;
    results.checks.push('adapter.check');
    const directory = join(root, 'project');
    writeFileSync(join(root, 'effective-config.json'), JSON.stringify(await api.request('GET', '/api/config?location[directory]=' + encodeURIComponent(directory)), null, 2));
    const definitions = await waitForOpenCodeAgents(api, directory, Object.keys(config.agents));
    results.plugins = await api.request('GET', '/api/plugin?location[directory]=' + encodeURIComponent(directory));
    results.agents = definitions.filter(a => a.id?.startsWith('factory-'));
    assert.equal(results.agents.length, Object.keys(profiles.models).length * 3);
    results.checks.push('generated v2 worker profiles load');
    const descriptor = { dispatchId: 'compat-' + randomBytes(8).toString('hex'), role: 'fixer', route: { model: 'claude-sonnet-5', effort: 'medium' } };
    const route = await api.route(descriptor, {}, directory);
    assert.equal(route.agent, 'factory-writer-standard');
    assert.equal(route.providerID, 'anthropic');
    assert.equal(route.modelID, 'claude-sonnet-5');
    results.checks.push('effective worker route');
    const sessionId = await api.create(descriptor, directory, route);
    assert.equal(await api.create(descriptor, directory, route), sessionId);
    const text = 'No-model compatibility probe: queued with resume false.';
    const mapping = { dispatchId: descriptor.dispatchId, sessionId, requestedModel: route, messageId: 'msg_' + digest(descriptor.dispatchId).slice(0, 32), promptHash: digest(text) };
    await api.verifySession(mapping, directory);
    results.checks.push('create, idempotent lookup, identity and route verification');
    assert.deepEqual(await api.messages(mapping, directory), []);
    assert.equal(await api.executionIdle(mapping, directory), true);
    await api.send(mapping, text, route, directory);
    assert.equal(await api.admissionKnown(mapping, directory), true);
    assert.equal((await api.inbox(mapping)).length, 1);
    assert.deepEqual(await api.outcome(mapping, directory), { pending: true });
    results.checks.push('resume:false durable admission, inbox and pending outcome');
    assert.deepEqual(await api.stop(mapping, directory), { stopped: true });
    assert.deepEqual(await api.inbox(mapping), []);
    assert.deepEqual(await api.messages(mapping, directory), []);
    results.checks.push('cancel queued input, interrupt, empty messages and idle reconciliation');
    await api.request('DELETE', '/api/session/' + sessionId);
    results.checks.push('delete isolated session');
  } finally {
    writeFileSync(join(root, 'wire.json'), JSON.stringify(wire, null, 2));
  }
} catch (e) {
  results.error = e.message;
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const stopped = once(child, 'exit');
  const timer = setTimeout(() => child.kill(), 10000);
  if (child.exitCode === null && child.signalCode === null) await stopped;
  clearTimeout(timer);
  writeFileSync(join(root, 'server-stderr.txt'), stderr);
  writeFileSync(join(root, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ ...results, plugins: results.plugins?.data?.length, agents: results.agents?.length }, null, 2));
}
