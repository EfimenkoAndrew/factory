import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareLifecycle, lifecycleConfig, missingModelThenFallback, lifecycleReport, appendCleanupReceipt, runLifecycle } from './live-opencode-lifecycle.mjs';

test('live doc configuration enforces read-only source and exact shell commands', () => {
  const cfg = lifecycleConfig('github-copilot/gpt-5-mini', '/fixture', '/mount');
  const worker = cfg.agent['factory-live-doc'];
  assert.equal(worker.permission.edit, 'deny');
  assert.equal(worker.permission.external_directory, 'deny');
  assert.equal(worker.permission.bash['*'], 'deny');
  assert.equal(worker.permission.bash['node check-doc.mjs'], 'allow');
  assert.equal(cfg.snapshot, false);
  assert.equal(worker.steps, 8);
});

test('replay preserves finalized report and nine immutable session deletion receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-report-replay-'));
  try {
    const first = lifecycleReport(root);
    first.report.finalized = { state: 'CLOSED' }; first.report.result = 'PASS';
    first.report.cleanup.sessions = [];
    for (let n = 0; n < 9; n++) {
      const evidence = { id: 'ses_' + n, stopped: true, deleted: true };
      appendCleanupReceipt(root, first.report, 'session', evidence);
      first.report.cleanup.sessions.push(evidence);
    }
    first.save();
    const original = readFileSync(join(root, 'report.json'), 'utf8');
    const receipts = readFileSync(join(root, 'cleanup-receipts.jsonl'), 'utf8');
    const replay = lifecycleReport(root);
    replay.report.result = 'FAIL'; replay.report.endpoint = 'http://new-server'; replay.save();
    appendCleanupReceipt(root, replay.report, 'server', { pid: 123, stopped: true }); replay.save();
    assert.equal(readFileSync(join(root, 'report.json'), 'utf8'), original);
    assert.ok(readFileSync(join(root, 'cleanup-receipts.jsonl'), 'utf8').startsWith(receipts));
    const persisted = JSON.parse(readFileSync(replay.report.reportPath, 'utf8'));
    assert.equal(persisted.cleanup.sessions.filter(s => s.stopped && s.deleted).length, 9);
    assert.equal(persisted.cleanup.receipts.filter(r => r.kind === 'session' && r.deleted).length, 9);
    const next = lifecycleReport(root);
    assert.equal(next.report.cleanup.receipts.length, 10, 'next replay starts from latest receipts, not obsolete initial report');
    assert.equal(next.report.priorReport, replay.report.reportPath);
    const dir = join(root, 'item'); mkdirSync(dir);
    writeFileSync(join(dir, 'opencode-progress.json'), '{}');
    writeFileSync(join(root, 'fixture-context.json'), JSON.stringify({ workspace: root, mount: root, dir }));
    const resumed = await runLifecycle({ resumeRoot: root, prepareOnly: true });
    assert.equal(resumed.result, 'PREPARED');
    assert.equal(resumed.cleanup.sessions.filter(s => s.stopped && s.deleted).length, 9, 'actual lifecycle finally preserves prior deletions');
    assert.equal(resumed.cleanup.receipts.filter(r => r.kind === 'session').length, 9);
    assert.equal(readFileSync(join(root, 'report.json'), 'utf8'), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('replay recovers cleanup receipts appended before an interrupted report save', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-cleanup-journal-'));
  try {
    const first = lifecycleReport(root); first.save();
    const receipt = appendCleanupReceipt(root, first.report, 'session', { id: 'ses_removed', stopped: true, deleted: true });
    const journal = readFileSync(join(root, 'cleanup-receipts.jsonl'), 'utf8');
    const resumed = lifecycleReport(root);
    assert.deepEqual(resumed.report.cleanup.receipts, [receipt]);
    assert.deepEqual(resumed.report.cleanup.sessions, [{ id: 'ses_removed', stopped: true, deleted: true }]);
    resumed.save();
    const again = lifecycleReport(root);
    assert.deepEqual(again.report.cleanup.receipts, [receipt]);
    assert.equal(again.report.cleanup.sessions.length, 1);
    assert.equal(readFileSync(join(root, 'cleanup-receipts.jsonl'), 'utf8'), journal);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 profile uses current dialect, bounded steps and ordered shell-only exception', () => {
  const config = lifecycleConfig('github-copilot/gpt-5-mini', '/fixture', '/mount', 'v2');
  assert.equal(config.agent, undefined);
  assert.equal(config.permission, undefined);
  assert.equal(config.snapshots, false);
  assert.equal(config.agents['factory-live-doc'].steps, 8);
  const rules = config.agents['factory-live-doc'].permissions;
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
  assert.ok(rules.some(r => r.action === 'shell' && r.resource === 'node check-doc.mjs' && r.effect === 'allow'));
  assert.ok(rules.some(r => r.action === 'edit' && r.effect === 'deny'));
  assert.throws(() => lifecycleConfig('x/y', '', '', 'v3'), /unsupported/);
});

test('bounded model failure keeps failed mapping immutable and uses fresh explicit fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-model-fallback-test-'));
  const routes = [], sent = [], sessions = [];
  const api = { version: 'v2', url: 'http://127.0.0.1:1',
    request: async () => ({ data: [{ providerID: 'provider', id: 'valid' }] }),
    route: async (d, c) => c.roles[d.role],
    create: async (d, dir, route) => { routes.push(route); return 'ses_' + routes.length; },
    messages: async () => [], verifySession: async () => {},
    send: async m => { sent.push(m.sessionId); },
    outcome: async m => m.requestedModel.modelID.startsWith('factory-live-deliberately-unavailable-')
      ? { failed: true, settled: true, error: 'model unavailable' }
      : { settled: true, text: '{"markerFound":true}', actualModel: 'provider/valid', cost: 0.001 },
  };
  try {
    const result = await missingModelThenFallback({ api, root, model: 'provider/valid', sessions });
    assert.equal(result.result, 'PASS');
    assert.equal(result.failed.status, 'failed');
    assert.equal(result.failed.actualModel, null);
    assert.equal(result.failedMappingUnchanged, true);
    assert.equal(result.fallback.actualModel, 'provider/valid');
    assert.deepEqual(sent, ['ses_1', 'ses_2']);
    assert.equal(routes[1].modelID, 'valid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uncertain model failure never admits valid fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-model-fence-test-'));
  let creates = 0;
  const api = { version: 'v2', url: 'http://127.0.0.1:1',
    request: async () => ({ data: [{ providerID: 'provider', id: 'valid' }] }),
    route: async (d, c) => c.roles[d.role], create: async () => { creates++; return 'ses_unknown'; },
    messages: async () => [], verifySession: async () => {}, send: async () => {},
    outcome: async () => { throw new Error('model unavailable'); },
    stop: async () => { throw new Error('stop not confirmed'); },
  };
  try {
    await assert.rejects(missingModelThenFallback({ api, root, model: 'provider/valid', sessions: [] }), /did-not-fail-closed/);
    assert.equal(creates, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual doc verification CLI refresh does not duplicate forward transitions', { timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-live-lifecycle-test-'));
  try {
    const fx = prepareLifecycle(root);
    const id = fx.item.id;
    const cli = args => execFileSync(process.execPath, [join(fx.mount, '_workflow/opencode/runtime.mjs'), ...args],
      { cwd: root, env: fx.env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const next = () => { const text = cli(['next', id]); return JSON.parse(text.slice(text.indexOf('{'))); };
    const submit = (call, result) => {
      const path = join(root, 'response.json'); writeFileSync(path, JSON.stringify(result));
      cli(['submit', id, '--role', call.key, '--dispatch', call.dispatchId, '--json', path]);
    };
    cli(['init', id, '--fixture', join(root, 'fixture.json')]);
    const raw = execFileSync(process.execPath, [join(fx.workspace, 'check-doc.mjs')], { encoding: 'utf8' });
    assert.match(raw, /FACTORY::RED::0/);
    writeFileSync(join(fx.dir, 'verify-red-raw.txt'), raw);
    submit(next().agents[0], { red: false, verificationOnly: true, testFiles: [], note: 'real doc assertion succeeded' });
    assert.equal(next().mechanical, 'verify');
    cli(['mech', id, 'verify']);
    for (let i = 0; i < 2; i++) submit(next().agents[0], { gate: 'editorial', verdict: 'APPROVED', headline: 'read-only fixture' });
    assert.equal(next().mechanical, 'verify');
    cli(['mech', id, 'verify']);
    const progress = JSON.parse(readFileSync(join(fx.dir, 'opencode-progress.json'), 'utf8'));
    assert.deepEqual(progress.res.transitions, ['RED', 'GREEN', 'BUILT', 'TESTED']);
    assert.equal(progress.res.codeChange, false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
