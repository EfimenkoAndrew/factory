import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupArguments, launchFromGroup, claimIdentity, validCheckpoint, observeChild, watchLane, stopChild, schedulerSuggestions } from './lifecycle.mjs';

const cfg = { maxItemsPerLane: 2, modelConcurrency: 6, buildCapacity: 1, backend: 'interactive' };
const item = { id: 'A', worktree: { path: resolve('fixture/worktrees/A'), branch: 'factory/A' } };
const result = { id: 'A', resultId: 'A#4', worktree: item.worktree.path, branch: item.worktree.branch, toState: 'CLOSED', transitions: ['CLAIMED', 'CLOSED'] };
const identity = { mtimeMs: 20, sinceMs: 10, claim: 'claim-a', currentClaim: 'claim-a' };

test('launch envelope is machine authority, including paths with spaces', () => {
  const output = 'group [label=x]: 1 item(s) claimed + per-item worktrees -> mount with spaces/state/run-args-x.json (12 bytes)\n  launcher: Workflow({scriptPath: "C:/repo with spaces/run-script-x.js"})';
  let requested;
  const launch = launchFromGroup(output, (path) => { requested = path; return { cycle: 4, items: [item], buildCapacity: 2 }; }, resolve('.'));
  assert.equal(requested, resolve('mount with spaces/state/run-args-x.json'));
  assert.deepEqual(launch.ids, ['A']);
  assert.equal(launch.batch.buildCapacity, 2);
  assert.throws(() => launchFromGroup(output, () => ({ cycle: 4, items: [item, item] }), '.'), /identities/);
  for (const buildCapacity of [undefined, null, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => launchFromGroup(output, () => ({ cycle: 4, items: [item], buildCapacity }), '.'), /invalid launch buildCapacity/);
  }
  assert.equal(launchFromGroup('nothing schedulable', () => assert.fail(), '.'), null);
  const args = groupArguments(cfg, { token: 't', ids: 'A,B' });
  assert.equal(args[args.indexOf('--conc') + 1], '6');
  for (const backend of ['interactive', 'claude-headless', 'opencode']) {
    const args = groupArguments({ ...cfg, backend, buildCapacity: 5 });
    assert.equal(args[args.indexOf('--build-capacity') + 1], '5');
  }
  assert.throws(() => groupArguments({ ...cfg, backend: 'dry' }), /must not call/);
});

test('checkpoint needs terminal state, cycle, worktree, branch and current claim identity', () => {
  assert.equal(validCheckpoint(result, item, 4, identity), true);
  for (const patch of [{ id: 'B' }, { resultId: 'A#3' }, { cycle: 3 }, { worktree: item.worktree.path + '-other' }, { branch: 'factory/B' }, { toState: 'GATED' }, { transitions: ['FAILED'] }]) assert.equal(validCheckpoint({ ...result, ...patch }, item, 4, identity), false);
  assert.equal(validCheckpoint(result, item, 4, { ...identity, currentClaim: 'new' }), false);
  assert.equal(validCheckpoint(result, item, 4, { ...identity, mtimeMs: 9 }), false);
  assert.equal(validCheckpoint(result, { ...item, attemptId: 'attempt-a' }, 4, identity), false);
  const row = { worktree: 'wt', history: [{ to: 'CLAIMED', at: 'one' }] };
  assert.notEqual(claimIdentity(row), claimIdentity({ ...row, history: [...row.history, { to: 'CLAIMED', at: 'two' }] }));
});

test('scheduler refills after file collisions and excludes unready/blocked items without mutation', () => {
  const wi = (id, file, extra = {}) => ({ id, files: [file], severity: 'HIGH', acceptance: 'The output must match the requested value.', regressionTest: 'Assert incorrect values are rejected.', autonomyTier: 'auto', ...extra });
  const graph = { items: [wi('A', 'same'), wi('B', 'same'), wi('C', 'other'), wi('D', 'third', { acceptance: '' }), wi('E', 'fourth', { autonomyTier: 'blocked' })] };
  const ledger = { cycle: 1, items: Object.fromEntries(graph.items.map((i) => [i.id, { state: 'READY', attempts: 0 }])) };
  const before = JSON.stringify({ graph, ledger });
  const plan = schedulerSuggestions(graph, ledger, cfg, { maxItemRetries: 2 });
  assert.deepEqual(plan.ids, ['A', 'C']);
  assert.equal(plan.deferred.find((i) => i.id === 'B').reason, 'file-overlap');
  assert.equal(plan.deferred.find((i) => i.id === 'D').reason, 'input-not-ready');
  assert.equal(plan.buildCapacityEnforced, false);
  assert.equal(plan.advisory, true);
  assert.equal(JSON.stringify({ graph, ledger }), before);
});

test('fake child exit/error wakes watch immediately and usage survives fragmented JSON', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough();
  const state = observeChild(child);
  child.stdout.write('{"type":"system","session_');
  child.stdout.write('id":"session-a"}\n{"type":"result","usage":{"output_tokens":42},"total_cost_usd":0.2}\n');
  const pending = watchLane({ poll: () => ({ done: [], complete: false }), heartbeat: () => true, childState: state, intervalMs: 60000, timeoutMs: 60000 });
  child.emit('exit', 1, null); child.emit('close');
  const watched = await pending;
  assert.equal(watched.childFailed, true);
  assert.equal(state.sessionId, 'session-a');
  assert.equal(state.usage.output_tokens, 42);
  assert.equal(state.totalCostUsd, 0.2);
  const missing = new EventEmitter(); missing.stdout = new PassThrough();
  const failed = observeChild(missing); missing.emit('error', new Error('ENOENT'));
  assert.equal((await watchLane({ poll: () => ({ done: [], complete: false }), heartbeat: () => true, childState: failed, intervalMs: 60000, timeoutMs: 60000 })).childFailed, true);
});

test('completion waits for child close; lease loss and timeout retain partial results', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough();
  const state = observeChild(child);
  const pending = watchLane({ poll: () => ({ done: ['A'], complete: true }), heartbeat: () => true, childState: state, intervalMs: 60000, timeoutMs: 60000 });
  child.stdout.write('{"type":"result","is_error":true}');
  child.emit('exit', 0, null); child.emit('close');
  assert.equal((await pending).childFailed, true);
  assert.equal((await watchLane({ poll: () => assert.fail(), heartbeat: () => false, intervalMs: 1, timeoutMs: 1 })).leaseLost, true);
  let time = 0;
  const timed = await watchLane({ poll: () => ({ done: ['A'], complete: false }), heartbeat: () => true, intervalMs: 10, timeoutMs: 20, now: () => time, sleep: async (ms) => { time += ms; } });
  assert.equal(timed.timedOut, true); assert.deepEqual(timed.done, ['A']);
});

test('oversized log line cannot hide later usage; missing usage remains unknown', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough();
  const state = observeChild(child, () => {}, 100);
  assert.equal(state.usage, null);
  child.stdout.write('x'.repeat(150));
  child.stdout.write('tail\n{"type":"result","usage":{"output_tokens":7}}\n');
  assert.equal(state.outputTruncated, true);
  assert.equal(state.usage.output_tokens, 7);
});

test('termination escalates a fake resistant child and confirms close', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough();
  const state = observeChild(child), signals = [];
  child.kill = (signal) => { signals.push(signal); if (signal === 'SIGKILL') { child.emit('exit', null, signal); child.emit('close'); } };
  assert.equal(await stopChild(child, state, 1), true);
  assert.deepEqual(signals, [undefined, 'SIGKILL']);
});

test('real Node fake worker produces structured session/result metadata through process pipes', async () => {
  const child = spawn(process.execPath, ['-e', 'console.log(JSON.stringify({type:"system",session_id:"fixture-session"})); console.log(JSON.stringify({type:"result",usage:{input_tokens:3,output_tokens:2},modelUsage:{fixture:{costUSD:0}},total_cost_usd:0}));'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = observeChild(child);
  const result = await watchLane({ poll: () => ({ done: ['A'], complete: true }), heartbeat: () => true, childState: state, intervalMs: 60000, timeoutMs: 10000 });
  assert.equal(result.complete, true);
  assert.equal(state.closed, true);
  assert.equal(state.sessionId, 'fixture-session');
  assert.deepEqual(state.usage, { input_tokens: 3, output_tokens: 2 });
  assert.equal(state.modelUsage.fixture.costUSD, 0);
});

test('dry CLI uses only fixture filesystem, never invokes fake driver or claims lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-orchestrator-'));
  try {
    const factory = join(root, 'mount'), source = fileURLToPath(new URL('../', import.meta.url));
    mkdirSync(join(factory, '_workflow', 'lib'), { recursive: true });
    mkdirSync(join(factory, 'config'), { recursive: true });
    mkdirSync(join(factory, 'state'), { recursive: true });
    cpSync(join(source, 'orchestrator'), join(factory, 'orchestrator'), { recursive: true });
    cpSync(join(source, '_workflow', 'lib'), join(factory, '_workflow', 'lib'), { recursive: true });
    writeFileSync(join(factory, '_workflow', 'driver.mjs'), 'throw new Error("DRIVER MUST NOT RUN");');
    writeFileSync(join(factory, 'config', 'orchestrator.config.json'), JSON.stringify({ ...cfg, backend: 'dry' }));
    writeFileSync(join(factory, 'config', 'factory.config.json'), JSON.stringify({ maxItemRetries: 2, paths: { graph: 'mount/state/findings-graph.json', ledger: 'mount/state/ledger.json' } }));
    writeFileSync(join(factory, 'state', 'findings-graph.json'), JSON.stringify({ items: [] }));
    const ledger = JSON.stringify({ cycle: 2, items: {} });
    writeFileSync(join(factory, 'state', 'ledger.json'), ledger);
    const child = spawn(process.execPath, [join(factory, 'orchestrator', 'orchestrate.mjs'), 'run', '--backend', 'dry'], { env: { ...process.env, REPO_ROOT: root, FACTORY_TELEMETRY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((r, reject) => { child.on('error', reject); child.on('close', r); });
    assert.equal(code, 0, err);
    assert.equal(JSON.parse(out).dry, true);
    assert.equal(JSON.parse(out).advisory, true);
    assert.equal(JSON.parse(out).buildCapacityEnforced, false);
    assert.equal(readFileSync(join(factory, 'state', 'ledger.json'), 'utf8'), ledger);
    assert.deepEqual(readdirSync(join(factory, 'state')).sort(), ['findings-graph.json', 'ledger.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const backend of ['interactive', 'claude-headless']) test(`${backend} CLI forwards requested capacity and reports launch-envelope/shared effective capacity`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-native-capacity-'));
  try {
    const factory = join(root, 'mount'), source = fileURLToPath(new URL('../', import.meta.url));
    mkdirSync(join(factory, 'config'), { recursive: true });
    mkdirSync(join(factory, 'state'), { recursive: true });
    writeFileSync(join(root, '.git'), 'fixture only');
    cpSync(join(source, 'orchestrator'), join(factory, 'orchestrator'), { recursive: true });
    cpSync(join(source, '_workflow', 'lib'), join(factory, '_workflow', 'lib'), { recursive: true });
    const config = { ...cfg, backend, buildCapacity: 5, watchIntervalMs: 10, laneTimeoutMinutes: 1, claudeHeadless: { bin: process.execPath, promptTemplate: '0' } };
    writeFileSync(join(factory, 'config', 'orchestrator.config.json'), JSON.stringify(config));
    writeFileSync(join(factory, 'state', 'ledger.json'), JSON.stringify({ cycle: 3, items: { A: { worktree: item.worktree.path, branch: item.worktree.branch, history: [{ to: 'CLAIMED', at: 'fixture' }] } } }));
    writeFileSync(join(factory, 'state', 'run-args.json'), JSON.stringify({ cycle: 4, items: [item], buildCapacity: 2 }));
    writeFileSync(join(factory, '_workflow', 'driver.mjs'), `
      import assert from 'node:assert/strict';
      import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      import { resolve } from 'node:path';
      const root = fileURLToPath(new URL('../', import.meta.url));
      const args = process.argv.slice(2);
      appendFileSync(resolve(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
      if (args[0] === 'controller' && args[1] === 'claim') console.log('token abc123');
      if (args[0] === 'group') {
        assert.equal(args[args.indexOf('--build-capacity') + 1], '5');
        assert.equal(args[args.indexOf('--conc') + 1], '6');
        writeFileSync(resolve(root, 'state/build-capacity.json'), JSON.stringify({ limit: 5 }));
        console.log('group: 1 item(s) claimed + per-item worktrees -> ' + resolve(root, 'state/run-args.json') + ' (12 bytes)\\nWorkflow({scriptPath: "' + resolve(root, 'state/run-script.js').replaceAll('\\\\', '/') + '"})');
      }
      if (args[0] === 'controller' && args[1] === 'heartbeat') {
        mkdirSync(resolve(root, 'state/items/A'), { recursive: true });
        writeFileSync(resolve(root, 'state/items/A/result.json'), ${JSON.stringify(JSON.stringify(result))});
      }
      if (args[0] === 'fold') assert.equal(JSON.parse(readFileSync(args[1])).results[0].resultId, 'A#4');
    `);
    const run = () => promisify(execFile)(process.execPath, [join(factory, 'orchestrator', 'orchestrate.mjs'), 'run'], { env: { ...process.env, REPO_ROOT: root, FACTORY_TELEMETRY: '0' }, timeout: 15000 });
    for (const [configured, expected] of [[8, 2], [1, 1]]) {
      writeFileSync(join(factory, 'config', 'factory.config.json'), JSON.stringify({ concurrency: { builds: configured } }));
      const before = new Set(readdirSync(join(factory, 'state')).includes('orchestrator') ? readdirSync(join(factory, 'state/orchestrator')) : []);
      await run();
      const lane = readdirSync(join(factory, 'state/orchestrator')).find((name) => !before.has(name));
      const meta = JSON.parse(readFileSync(join(factory, 'state/orchestrator', lane, 'launch.json')));
      assert.equal(meta.buildCapacity, expected);
      assert.equal(meta.buildCapacityEnforced, true);
      assert.equal(meta.buildCapacityScope, 'mechanics-and-contract-compliant-worker-builds');
      assert.equal(meta.watch.complete, true);
    }
    const calls = readFileSync(join(factory, 'calls.jsonl'), 'utf8');
    assert.equal(calls.trim().split('\n').map(JSON.parse).filter((c) => c[0] === 'fold').length, 2);
    for (const invalid of [0, -1, 1.5, '2']) {
      writeFileSync(join(factory, 'config', 'factory.config.json'), JSON.stringify({ concurrency: { builds: invalid } }));
      await assert.rejects(run(), (e) => { assert.match(e.stdout, /invalid global build capacity/); return true; });
      assert.equal(readFileSync(join(factory, 'calls.jsonl'), 'utf8'), calls);
    }
    writeFileSync(join(factory, 'config', 'factory.config.json'), '{}');
    for (const invalid of [0, -1, 1.5, '2', null]) {
      writeFileSync(join(factory, 'config', 'orchestrator.config.json'), JSON.stringify({ ...config, buildCapacity: invalid }));
      await assert.rejects(run(), (e) => { assert.match(e.stderr, /(?:invalid config|config must be an integer).*buildCapacity/); return true; });
      assert.equal(readFileSync(join(factory, 'calls.jsonl'), 'utf8'), calls);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
