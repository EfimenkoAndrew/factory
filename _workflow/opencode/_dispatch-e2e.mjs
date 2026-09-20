import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateObservation, aggregateObservations } from '../lib/observations.mjs';
import { evidenceIdentity } from '../lib/evidence-identity.mjs';
import { snapshotTree, digest } from './identity.mjs';
import { resolveRoute } from './server-api.mjs';
import { driveItems, parseDispatchArgs } from './dispatcher.mjs';
import { withBuildSlot } from './build-lease.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'factory-dispatch-e2e-'));
const runtime = join(root, '_workflow/opencode/runtime.mjs');
const sessions = new Map();
let version, faulty = false, admissions = 0, active = 0, maxActive = 0;
const models = { planning: 'claude-fable-5', strong: 'claude-opus-4-8', standard: 'claude-sonnet-5' };
const definitions = () => Object.entries(models).map(([tier, model]) => version === 'v1'
  ? { name: 'factory-reviewer-' + tier, mode: 'subagent', model: { providerID: 'host', modelID: model + '-override' } }
  : { id: 'factory-reviewer-' + tier, name: 'factory-reviewer-' + tier, mode: 'subagent', model: { providerID: 'host', id: model + '-override' } });
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null, url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  const reply = value => res.end(JSON.stringify(value));
  if (url.pathname === '/global/health') return reply({ healthy: true, version: '1.99.0' });
  if (url.pathname === '/api/info') return reply({ version: '2.99.0' });
  if (url.pathname === '/session/status') return reply(Object.fromEntries([...sessions].filter(([, s]) => s.input && !s.ended).map(([id]) => [id, { type: 'busy' }])));
  if (url.pathname === '/api/session/active') return reply({ data: Object.fromEntries([...sessions].filter(([, s]) => s.input && !s.ended).map(([id]) => [id, {}])) });
  if (url.pathname === '/agent' || url.pathname === '/api/agent') return reply(version === 'v1' ? definitions() : { location: { directory: url.searchParams.get('location[directory]') }, data: definitions() });
  if (url.pathname === '/session' && req.method === 'GET') return reply([...sessions.values()].map(s => s.info));
  if (['/session', '/api/session'].includes(url.pathname) && req.method === 'POST') {
    const id = body.id || 'ses_' + sessions.size;
    const info = { ...body, id, directory: url.searchParams.get('directory') };
    sessions.set(id, { info, polls: 0 }); return reply(version === 'v1' ? info : { data: info });
  }
  const match = /^\/(?:api\/)?session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  const session = match && sessions.get(match[1]);
  if (!session) { res.statusCode = 404; return reply({}); }
  if (!match[2]) return reply(version === 'v1' ? session.info : { data: session.info });
  if (match[2] === 'inbox') return reply({ data: [] });
  if (match[2].startsWith('inbox/') && req.method === 'DELETE') { res.statusCode = 204; return res.end(); }
  if (['prompt_async', 'prompt'].includes(match[2])) {
    const agent = version === 'v1' ? body.agent : session.info.agent;
    assert.ok(agent.startsWith('factory-reviewer-'));
    const model = version === 'v1' ? body.model.modelID : session.info.model.id;
    assert.ok(model.endsWith('-override'), 'effective host profile override reaches API');
    session.input = body; admissions++; maxActive = Math.max(maxActive, ++active);
    if (version === 'v1') { res.statusCode = 204; return res.end(); }
    return reply({ data: { id: body.id, sessionID: session.info.id, type: 'user' } });
  }
  if (['abort', 'interrupt'].includes(match[2])) { if (!session.ended) active--; session.ended = true; return reply(version === 'v1' ? true : { interrupted: true }); }
  if (match[2] === 'message') {
    if (!session.input) return reply(version === 'v1' ? [] : { data: [], cursor: { next: null, previous: null } });
    const input = session.input;
    const prompt = version === 'v1' ? input.parts[0].text : input.text;
    const value = prompt.includes('"globalGreen"') ? { globalGreen: true, regressionDelta: 0, handoff: 'ready for owner' }
      : prompt.includes('"recommendScopeStop"') ? { rootCause: 'owner ruling required', approach: 'halt', recommendScopeStop: true, recommendEscalate: false }
      : { decision: 'Stop?', recommendation: 'Stop', headline: 'Owner decision required' };
    ++session.polls;
    if (session.polls >= 3 && !session.ended) { active--; session.ended = true; }
    const text = faulty ? '{"missing":"required fields"}' : JSON.stringify(value);
    const tokens = { input: 10, output: 5, cache: { read: 3, write: 1 } };
    return reply(version === 'v1' ? [
      { info: { id: input.messageID, role: 'user', sessionID: session.info.id }, parts: input.parts },
      { info: { id: 'msg_a', role: 'assistant', sessionID: session.info.id, parentID: input.messageID, time: { completed: 1 }, finish: 'stop', providerID: 'host', modelID: input.model.modelID, tokens, cost: 0.01 }, parts: [{ type: 'text', text }, { type: 'tool', state: { status: session.polls < 2 ? 'running' : 'completed' } }] },
    ] : { data: [ { id: input.id, type: 'user', text: input.text }, { id: 'msg_a', type: 'assistant', agent: session.info.agent, model: session.info.model, time: { completed: 1 }, finish: 'stop', content: [{ type: 'text', text }, { type: 'tool', state: { status: session.polls < 2 ? 'running' : 'completed' } }], tokens, cost: 0.01 } ], cursor: { next: null, previous: null } });
  }
  res.statusCode = 404; reply({});
});
const owned = [];
const run = args => exec(process.execPath, [runtime, ...args], { env: { ...process.env, FACTORY_TELEMETRY: '0' } });
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.deepEqual(parseDispatchArgs(['--url', url, '--ids', 'A,B', '--version', '2']), { config: { url, version: 'v2' }, ids: ['A', 'B'] });
  for (version of ['v1', 'v2']) {
    sessions.clear(); admissions = 0; maxActive = 0; active = 0;
    const ids = [0, 1].map(n => 'DISPATCH-E2E-' + version + '-' + process.pid + '-' + n);
    for (const id of ids) {
      const itemDir = join(root, 'state/items', id); owned.push(itemDir, join(root, 'state', 'results-cycle-1-' + id + '.json'));
      const fixture = join(temp, id + '.json');
      writeFileSync(fixture, JSON.stringify({ item: { id, target: 'Fake', severity: 'HIGH', fixType: 'non-trivial', files: ['README.md'], acceptance: 'one clause' }, worktreePath: temp, cycle: 1 }));
      await run(['init', id, '--fixture', fixture]);
      const progress = JSON.parse(readFileSync(join(itemDir, 'opencode-progress.json')));
      assert.ok(!Object.hasOwn(progress.ctx.briefs, 'reporter'), 'unused reporter is not composed at init');
    }
    const results = await driveItems(ids, { url, version, agentConcurrency: 1, buildConcurrency: 1, pollMs: 1, agentTimeoutMs: 5000 });
    assert.ok(results.every(r => r.done && r.toState === 'BLOCKED'), JSON.stringify(results));
    assert.equal(admissions, 4); assert.equal(maxActive, 1);
    const observations = [];
    for (const id of ids) {
      const envelope = JSON.parse(readFileSync(join(root, 'state', 'results-cycle-1-' + id + '.json')));
      assert.equal(envelope.results[0].admission.attempted, true);
      assert.equal(envelope.results[0].attemptObservations.length, 2);
      assert.equal(envelope.runId, envelope.results[0].admission.runId);
      const dir = join(root, 'state/items', id, 'dispatch');
      for (const name of readdirSync(dir).filter(n => n.endsWith('-session.json'))) {
        const state = JSON.parse(readFileSync(join(dir, name)));
        assert.deepEqual(validateObservation(state.observation), []);
        assert.notEqual(state.observation.dispatchId, state.observation.attemptId);
        assert.equal(state.observation.inputTokens, 10);
        observations.push(state.observation);
      }
    }
    assert.equal(aggregateObservations([...observations, ...observations]).calls.physical, 4);
    await driveItems(ids, { url, version, agentConcurrency: 1 });
    assert.equal(admissions, 4, 'completed runtime resume dispatches no duplicate workers');
    faulty = true;
    const bad = ids[0] + '-BAD'; const itemDir = join(root, 'state/items', bad); owned.push(itemDir, join(root, 'state', 'results-cycle-1-' + bad + '.json'));
    const fx = join(temp, 'bad.json'); writeFileSync(fx, JSON.stringify({ item: { id: bad, target: 'Fake', fixType: 'non-trivial', files: [] }, worktreePath: temp, cycle: 1 }));
    await run(['init', bad, '--fixture', fx]);
    const badResult = await driveItems([bad], { url, version, pollMs: 1, agentTimeoutMs: 5000 });
    assert.equal(badResult[0].toState, 'FAILED'); assert.ok(badResult[0].done); faulty = false;
    const close = ids[0] + '-CLOSE'; const closeDir = join(root, 'state/items', close);
    owned.push(closeDir, join(root, 'state', 'results-cycle-1-' + close + '.json'));
    const closeFx = join(temp, 'close.json'); writeFileSync(closeFx, JSON.stringify({ item: { id: close, target: 'Fake', fixType: 'mechanical', files: [] }, worktreePath: temp, cycle: 1 }));
    await run(['init', close, '--fixture', closeFx]);
    const closePath = join(closeDir, 'opencode-progress.json');
    const cp = JSON.parse(readFileSync(closePath));
    cp.phase = 'integrate_judge'; cp.res.transitions = ['RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED'];
    cp.evidence = { ...cp.content, complete: true, rawHash: digest('verification') };
    cp.integrationEvidence = { ...cp.content, complete: true, rawHash: digest('integration') };
    writeFileSync(join(closeDir, 'verify-raw.txt'), 'verification'); writeFileSync(join(closeDir, 'integrate-raw.txt'), 'integration');
    writeFileSync(closePath, JSON.stringify(cp));
    const closed = await driveItems([close], { url, version, pollMs: 1, agentTimeoutMs: 5000 });
    assert.equal(closed[0].toState, 'CLOSED', JSON.stringify(closed));
    assert.ok(closed[0].done);
    const dispatchFiles = readdirSync(join(closeDir, 'dispatch')).filter(n => n.endsWith('.json') && !/-(?:result|session)\.json$/.test(n));
    const handoff = JSON.parse(readFileSync(join(closeDir, 'dispatch', dispatchFiles[0]))).prompt;
    assert.ok(handoff.includes('HANDOFF-ONLY') && handoff.includes('READ-ONLY WORKER MODE'));
  }
  const p = { role: 'fixer', route: { model: 'claude-sonnet-4-6' } };
  assert.equal(resolveRoute(p, {}, [{ name: 'factory-writer-mechanical', model: { providerID: 'host', modelID: 'custom' } }], 'v1').agent, 'factory-writer-mechanical');
  assert.throws(() => resolveRoute(p, {}, [], 'v1'), /profile missing/);
  const tree = join(temp, 'identity'); mkdirSync(tree); writeFileSync(join(tree, 'a.rst'), 'doc'); writeFileSync(join(tree, 'a.cs'), 'code');
  const git = args => args[0] === 'rev-parse' ? 'HEAD' : 'a.rst\0a.cs\0';
  const contract = { policy: true };
  const shared = evidenceIdentity({ baseRevision: 'HEAD', reviewerContract: contract, context: { runtime: 'opencode' }, entries: [{ path: 'a.rst', content: 'doc', mode: 'file' }, { path: 'a.cs', content: 'code', mode: 'file' }] });
  const adapted = snapshotTree(tree, contract, git);
  assert.equal(adapted.hash, shared.hash);
  assert.equal(adapted.codeHash, digest({ code: shared.codeHash, contract }));
  assert.notEqual(snapshotTree(tree, { policy: false }, git).codeHash, adapted.codeHash, 'runtime contract changes also invalidate build reuse');
  mkdirSync(join(tree, 'submodule'));
  assert.throws(() => snapshotTree(tree, contract, args => args[0] === 'rev-parse' ? 'HEAD' : 'submodule\0'), /cannot prove/);
  const leaseRoot = join(temp, 'leases'); mkdirSync(join(leaseRoot, 'state'), { recursive: true });
  writeFileSync(join(leaseRoot, 'state/opencode-build-capacity.json'), '{"limit":1}');
  const leaseModule = new URL('./build-lease.mjs', import.meta.url).href;
  const childSource = `import {withBuildSlot} from ${JSON.stringify(leaseModule)}; const times=withBuildSlot(process.argv[1],()=>{const start=Date.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);return [start,Date.now()]});console.log(JSON.stringify(times));`;
  const windows = await Promise.all([0, 1, 2].map(() => exec(process.execPath, ['--input-type=module', '-e', childSource, leaseRoot]).then(r => JSON.parse(r.stdout))));
  windows.sort((a, b) => a[0] - b[0]);
  assert.ok(windows.slice(1).every((w, i) => w[0] >= windows[i][1]), 'global build lease serializes actual worker processes');
  const cli = fileURLToPath(new URL('./build-lease.mjs', import.meta.url));
  const generic = await exec(process.execPath, [cli, leaseRoot, '--', process.execPath, '-e', 'console.log("generic-lease-ok")']);
  assert.equal(generic.stdout.trim(), 'generic-lease-ok');
  await assert.rejects(exec(process.execPath, [cli, leaseRoot, '--', process.execPath, '-e', 'process.exit(7)']), e => e.code === 7);
  const { buildCapacity } = await import('./build-lease.mjs');
  mkdirSync(join(leaseRoot, 'config'));
  writeFileSync(join(leaseRoot, 'config/factory.config.json'), '{"concurrency":{"builds":2}}');
  assert.equal(buildCapacity(leaseRoot), 1, 'legacy lower capacity cannot be bypassed by factory config');
  writeFileSync(join(leaseRoot, 'config/factory.config.local.json'), '{"buildConcurrency":3}');
  assert.equal(buildCapacity(leaseRoot), 1, 'local generic capacity cannot bypass an existing lower runtime limit');
  writeFileSync(join(leaseRoot, 'state/build-capacity.json'), '{"limit":1}');
  assert.equal(buildCapacity(leaseRoot), 1, 'explicit shared runtime capacity wins');
  assert.throws(() => withBuildSlot(leaseRoot, () => { const e = new Error('timeout'); e.unsettled = true; throw e; }), /timeout/);
  assert.throws(() => withBuildSlot(leaseRoot, () => {}, 2), /slot timeout/, 'unsettled build retains capacity');
  const retained = join(leaseRoot, 'state/opencode-build-slots/0');
  const dead = await exec(process.execPath, ['-e', 'console.log(process.pid)']);
  writeFileSync(join(retained, 'owner.json'), JSON.stringify({ pid: Number(dead.stdout.trim()) }));
  assert.throws(() => withBuildSlot(leaseRoot, () => {}, 100), /process-tree inspection/, 'dead controller does not prove child build stopped');
  console.log('Dispatch end-to-end: v1/v2 real runtime, profiles, multi-item bounds, terminal failure/resume, observations and shared identity passed');
} finally {
  await new Promise(r => server.close(r));
  for (const path of owned) rmSync(path, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
}
