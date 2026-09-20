import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatchConfig, runWorker } from './opencode-worker.mjs';

test('OpenCode backend maps independent capacities and preserves host routes and evidence inputs', () => {
  const host = { url: 'http://localhost:4096', roles: { 'gate-qa': { agent: 'factory-reviewer-strong' } }, items: { A: { target: 'A.sln', filter: 'Tests' } }, buildConcurrency: 9, headers: { authorization: 'fixture' } };
  const merged = dispatchConfig(host, { modelConcurrency: 6, buildCapacity: 2, opencode: { version: 'v2' } });
  assert.equal(merged.agentConcurrency, 6); assert.equal(merged.buildConcurrency, 2);
  assert.deepEqual(merged.items, host.items); assert.deepEqual(merged.roles, host.roles);
  assert.deepEqual(merged.headers, host.headers); assert.equal(host.buildConcurrency, 9);
  assert.throws(() => dispatchConfig({}, { modelConcurrency: 1, buildCapacity: 1 }), /URL/);
  assert.throws(() => dispatchConfig(host, { modelConcurrency: 1, buildCapacity: 0 }), /capacity/);
});

test('OpenCode orchestrator CLI folds only finalized complete fake batches and records effective capacities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-oc-backend-'));
  try {
    const factory = join(root, 'mount'), source = fileURLToPath(new URL('../', import.meta.url));
    mkdirSync(join(factory, 'config'), { recursive: true });
    mkdirSync(join(factory, 'state'), { recursive: true });
    mkdirSync(join(factory, '_workflow', 'opencode'), { recursive: true });
    writeFileSync(join(root, '.git'), 'fixture only');
    cpSync(join(source, 'orchestrator'), join(factory, 'orchestrator'), { recursive: true });
    cpSync(join(source, '_workflow', 'lib'), join(factory, '_workflow', 'lib'), { recursive: true });
    writeFileSync(join(factory, 'config', 'orchestrator.config.json'), JSON.stringify({ backend: 'opencode', modelConcurrency: 7, buildCapacity: 5, watchIntervalMs: 10, laneTimeoutMinutes: 1, maxCyclesPerRun: 1 }));
    writeFileSync(join(factory, 'config', 'factory.config.json'), JSON.stringify({ concurrency: { builds: 2 } }));
    writeFileSync(join(factory, 'config', 'opencode-dispatch.local.json'), JSON.stringify({ url: 'http://fixture.invalid', version: 'v2', items: { A: { target: 'App.sln', filter: 'Tests' } } }));
    const item = { id: 'A', worktree: { path: join(root, 'worktree-A'), branch: 'factory/A' } };
    const ledger = { cycle: 3, items: { A: { state: 'CLAIMED', worktree: item.worktree.path, branch: item.worktree.branch, history: [{ to: 'CLAIMED', at: '2026-09-19T00:00:00.000Z' }] } } };
    writeFileSync(join(factory, 'state', 'ledger.json'), JSON.stringify(ledger));
    writeFileSync(join(factory, 'state', 'run-args.json'), JSON.stringify({ cycle: 4, items: [item], buildCapacity: 3 }));
    writeFileSync(join(factory, '_workflow', 'driver.mjs'), `
      import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
      import {fileURLToPath} from 'node:url';
      import {resolve} from 'node:path';
      const root=fileURLToPath(new URL('../',import.meta.url));
      const args=process.argv.slice(2); appendFileSync(resolve(root,'calls.jsonl'),JSON.stringify(args)+'\\n');
      if(args[0]==='group') {
        if(args[args.indexOf('--build-capacity')+1]!=='5'||args[args.indexOf('--conc')+1]!=='7') throw new Error('wrong group capacities');
        writeFileSync(resolve(root,'state/build-capacity.json'),JSON.stringify({limit:3}));
      }
      if(args[0]==='controller'&&args[1]==='claim') console.log('token abc123');
      if(args[0]==='group') console.log('group: 1 item(s) claimed + per-item worktrees -> '+resolve(root,'state/run-args.json')+' (12 bytes)\\nWorkflow({scriptPath: "'+resolve(root,'state/run-script.js').replaceAll('\\\\','/')+'"})');
      if(args[0]==='fold') { const r=JSON.parse(readFileSync(args[1])); if(r.results.length!==1||r.results[0].id!=='A') throw new Error('wrong fold'); }
    `);
    writeFileSync(join(factory, '_workflow', 'opencode', 'runtime.mjs'), `
      if(process.argv[2]!=='init'||process.argv[4]!=='--launch') throw new Error('wrong runtime args');
    `);
    writeFileSync(join(factory, '_workflow', 'opencode', 'dispatch.mjs'), `
      import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
      import {fileURLToPath} from 'node:url';
      import {resolve} from 'node:path';
      const root=fileURLToPath(new URL('../../',import.meta.url));
      const args=process.argv.slice(2), cfg=JSON.parse(readFileSync(args[1]));
      if(args[0]!=='--config'||args[2]!=='--ids'||args[3]!=='A'||cfg.buildConcurrency!==2||cfg.agentConcurrency!==7) throw new Error('wrong dispatch contract');
      const item=JSON.parse(readFileSync(resolve(root,'state/run-args.json'))).items[0];
      const result={id:'A',resultId:'A#4',worktree:item.worktree.path,branch:item.worktree.branch,toState:'CLOSED',transitions:['CLOSED']};
      mkdirSync(resolve(root,'state/items/A'),{recursive:true});
      writeFileSync(resolve(root,'state/items/A/result.json'),JSON.stringify(result));
      writeFileSync(resolve(root,'state/results-cycle-4-A.json'),JSON.stringify({mode:'opencode-adapter',cycle:4,results:[process.env.FIXTURE_BAD_FINAL ? {...result,resultId:'A#3'} : result]}));
      console.log(JSON.stringify([process.env.FIXTURE_UNAVAILABLE ? {id:'A',unavailable:true} : {id:'A',done:true}]));
    `);
    const run = async (extra = {}) => {
      try { return { code: 0, ...await promisify(execFile)(process.execPath, [join(factory, 'orchestrator', 'orchestrate.mjs'), 'run'], { env: { ...process.env, REPO_ROOT: root, FACTORY_TELEMETRY: '0', ...extra }, timeout: 15000 }) }; }
      catch (e) { return { code: e.code, stderr: e.stderr }; }
    };
    const good = await run(); assert.equal(good.code, 0, good.stderr);
    const calls = () => readFileSync(join(factory, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls().filter((c) => c[0] === 'fold').length, 1);
    const lane = readdirSync(join(factory, 'state/orchestrator'))[0];
    const meta = JSON.parse(readFileSync(join(factory, 'state/orchestrator', lane, 'launch.json')));
    assert.equal(meta.buildCapacityEnforced, true); assert.equal(meta.buildCapacity, 2);
    assert.equal(meta.buildCapacityScope, 'mechanics-and-contract-compliant-worker-builds');
    assert.equal(meta.modelConcurrency, 7); assert.match(meta.resumeCommand.join(' '), /dispatch.mjs.*--config.*--ids A/);
    for (const extra of [{ FIXTURE_UNAVAILABLE: '1' }, { FIXTURE_BAD_FINAL: '1' }]) {
      const failed = await run(extra); assert.notEqual(failed.code, 0);
      assert.equal(calls().filter((c) => c[0] === 'fold').length, 1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('worker initializes enriched claims then dispatches complete batch; unavailable exit-zero output fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-oc-worker-'));
  try {
    const launch = join(dir, 'args with spaces.json'), config = join(dir, 'config.json');
    writeFileSync(launch, JSON.stringify({ items: [{ id: 'A' }, { id: 'B' }] }));
    const calls = [];
    const invoke = async (file, args) => { calls.push({ file, args }); return file.endsWith('dispatch.mjs') ? JSON.stringify([{ id: 'A', done: true }, { id: 'B', done: true }]) : ''; };
    const result = await runWorker(dir, launch, config, invoke);
    assert.deepEqual(calls.map((c) => c.args), [['init', 'A', '--launch', launch], ['init', 'B', '--launch', launch], ['--config', config, '--ids', 'A,B']]);
    assert.equal(result.is_error, false);
    for (const output of [[{ id: 'A', done: true }, { id: 'B', unavailable: true }], [{ id: 'A', done: true }], [{ id: 'A', done: true }, { id: 'A', done: true }]]) {
      await assert.rejects(runWorker(dir, launch, config, async (file) => file.endsWith('dispatch.mjs') ? JSON.stringify(output) : ''), /incomplete batch/);
    }
    await assert.rejects(runWorker(dir, launch, config, async () => { throw new Error('init refused'); }), /init refused/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
