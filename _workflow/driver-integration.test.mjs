import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { containedMountRelative, resolveRepoRoot } from './lib/rootfind.mjs';
import { unclaimedMainDrift } from './lib/mainguard.mjs';
import vm from 'node:vm';
import { emptyLedger, syncFromGraph, writeJsonAtomic } from './lib/ledger.mjs';
import { verifyFinalTranscript, verifyTranscript, verificationExpectations, verifyRecoveryTranscript, affectedVerificationTargets, admitAttempt, observePhysical } from './lib/driver-integration.mjs';
import { aggregateObservations, makeObservation } from './lib/observations.mjs';
import { EVIDENCE_IDENTITY_VERSION, collectEvidenceIdentity } from './lib/evidence-identity.mjs';
import { verifyNativeReceipt } from './lib/driver-integration.mjs';
import { nativeEvidenceRequest } from './lib/native-evidence-request.mjs';
import { eligibleItems, disjointItems, resolvedBuildCapacity } from './lib/driver-integration.mjs';
import { computeReady } from './lib/graph.mjs';

const driverUrl = new URL('./driver.mjs', import.meta.url);
const source = fs.readFileSync(driverUrl, 'utf8');
const imports = {};
for (const match of source.matchAll(/^import\s+\{([\s\S]*?)\}\s+from\s+'([^']+)';/gm)) {
  const module = await import(match[2].startsWith('.') ? new URL(match[2], driverUrl) : match[2]);
  for (const binding of match[1].split(',')) {
    const [name, alias] = binding.trim().split(/\s+as\s+/);
    if (name) imports[alias || name] = module[name];
  }
}
const executable = source.replace(/^#![^\n]*\n/, '').replace(/^import\s+\{[\s\S]*?\}\s+from\s+'[^']+';[^\n]*/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(driverUrl.href)).replace(/await main\(\);\s*$/, '');

function item(id, extra = {}) {
  return { id, title: 'Correct the documented configuration', target: id, severity: 'HIGH', theme: 'doc-drift',
    layer: 'service', autonomyTier: 'auto', fixType: 'mechanical', files: [id + '.md'],
    acceptance: 'The documented configuration matches the actual configured value.',
    regressionTest: 'Assert the documented value agrees with configuration.', ...extra };
}

function fixture(t, items = [item('A')]) {
  const root = fs.mkdtempSync(join(tmpdir(), 'driver-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['ledger', 'graph', 'runArgs'].map(k => [k, join(root, 'state', k + '.json')]));
  paths.runArgs = join(root, 'state/run-args.json');
  Object.assign(paths, { items: join(root, 'state/items'), worktreesState: join(root, 'state/worktrees'), reports: join(root, 'reports'),
    progress: join(root, 'state/PROGRESS.md'), burndown: join(root, 'reports/burndown.md'), runScript: join(root, 'state/run-script.js'),
    agents: resolve(dirname(fileURLToPath(driverUrl)), '../agents') });
  fs.mkdirSync(paths.items, { recursive: true }); fs.mkdirSync(paths.reports, { recursive: true });
  if (items.some(it => it.files.some(f => /\.cs$/i.test(f)))) fs.writeFileSync(join(root, 'app.sln'), 'solution');
  const cfg = { root, paths, maxItemRetries: 2, maxBudgetDeferrals: 2, concurrency: { default: 7 } };
  const graph = { items }, ledger = emptyLedger(paths.graph);
  syncFromGraph(ledger, graph); writeJsonAtomic(paths.graph, graph); writeJsonAtomic(paths.ledger, ledger);
  const events = [], logs = [], worktrees = [];
  const context = vm.createContext({ ...imports, console: { log: (...v) => logs.push(v.join(' ')), warn: (...v) => logs.push(v.join(' ')), error: (...v) => logs.push(v.join(' ')) },
    process: { env: {}, argv: [], exitCode: 0, exit: n => { throw new Error('exit ' + n); } }, Buffer, AbortSignal, fetch, structuredClone,
    resolveRepoRoot: () => root, temit: event => events.push(structuredClone(event)),
    addWorktree: path => { worktrees.push(path); fs.mkdirSync(path, { recursive: true }); },
    dirtyMainPaths: () => ({ paths: [], dirs: [] }), dockerAvailable: () => true,
    snapshotMainFiles: () => ({}), driftAgainstSnapshot: () => [], splitDriftByStatus: () => ({ dirty: [], committed: [] }),
    driverEngineMount: () => null, preflightProductGitlinks: () => {},
    execFileSync: (_cmd, args) => { assert.ok(!args.some(x => ['add', 'checkout', 'commit', 'reset', 'restore', 'clean'].includes(x))); return ''; },
    changedFiles: () => [], repairDirtyDrift: () => { throw new Error('forbidden git mutation'); },
    loadPolicies: () => ({}), readRoleBriefs: () => ({}), readRepoProfiles: () => ({}), buildDocMap: () => null,
    lintWorktreeDocClaims: () => [], findLeftovers: () => [], findComments: () => [],
    cfg, testRoot: root });
  vm.runInContext(executable + '\nloadConfig = () => cfg; writeReports = () => {}; recordCostSnapshot = () => {}; cmdEscalationsSync = () => {}; emitLauncherScript = () => null; solutionFor = () => "app.sln"; injectedRouting = () => undefined;', context);
  const call = (name, ...args) => context[name](...args);
  const readLedger = () => JSON.parse(fs.readFileSync(paths.ledger, 'utf8'));
  const writeResult = value => { const path = join(root, 'result.json'); writeJsonAtomic(path, value); return path; };
  return { root, cfg, graph, ledger, context, call, readLedger, writeResult, events, logs, worktrees };
}

function sweepSetup(f, extra = {}) {
  const dir = join(f.cfg.paths.items, '../sweeps'); fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'sweep-0.json'), { label: 'fixture', theme: 'doc-drift', sites: f.graph.items.map(w => ({ findingId: w.id, files: ['untrusted-spec.md'] })) });
  f.call('cmdSweep', extra, ['0']);
  const launch = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  for (const s of launch.sweep.sites) for (const file of s.files) {
    const path = join(launch.worktree.path, file); fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, 'Actual configuration value is now documented.\n');
  }
  const review = () => ({ verdict: 'APPROVED', findings: [] });
  const result = { mode: 'sweep', cycle: launch.cycle, runId: launch.runId, usage: { outputTokens: 100 },
    sweep: { index: '0', worktree: launch.worktree.path, gates: { architect: 'APPROVED', security: 'APPROVED' },
      execution: { version: 1, verificationRequired: false, verificationCompleted: true, verificationPassed: true, reviewsCompleted: true },
      reviews: { architect: review(), security: review() }, cost: { model: 4 }, sites: launch.sweep.sites.map(s => ({ findingId: s.findingId, applied: true, admission: { version: 1, attempted: true } })) } };
  return { launch, result };
}

test('actual sweep command shares readiness/dependency/owner/retry/lock eligibility and graph files', t => {
  const f = fixture(t, [item('A'), item('B', { autonomyTier: 'blocked' }), item('C', { dependsOn: ['B'] }),
    item('D', { acceptance: '' }), item('E'), item('F', { files: ['A.md'] }), item('G')]);
  f.ledger.items.E.attempts = 4; f.ledger.items.G.state = 'CLAIMED';
  writeJsonAtomic(f.cfg.paths.ledger, f.ledger);
  const { launch } = sweepSetup(f);
  assert.deepEqual(launch.sweep.sites.map(s => s.findingId), ['A']);
  assert.deepEqual(launch.sweep.sites[0].files, ['A.md']);
  assert.match(launch.runId, /^[a-f0-9-]{36}$/);
  assert.match(launch.sweep.sites[0].claimId, /^[a-f0-9-]{36}$/);
  assert.equal(f.readLedger().items.A.attemptNumber, 1);
  assert.equal(f.events.filter(e => e.attrs?.observation?.phase === 'started').length, 0);
  assert.equal(f.events.filter(e => e.event === 'claim_reserved').length, 1);
});

test('physical hardlink and junction aliases serialize eligibility, batches, group, claim, suggest and sweep', t => {
  const items = [item('A', { files: ['real/file.md'] }), item('B', { files: ['hard.md'] }),
    item('C', { files: ['alias/file.md'] }), item('D', { files: ['independent.md'] })];
  const f = fixture(t, items);
  fs.mkdirSync(join(f.root, 'real'));
  fs.writeFileSync(join(f.root, 'real/file.md'), 'shared');
  fs.linkSync(join(f.root, 'real/file.md'), join(f.root, 'hard.md'));
  fs.symlinkSync(join(f.root, 'real'), join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const options = { repoRoot: f.root };
  assert.deepEqual(disjointItems(items, Infinity, options).map(w => w.id), ['A', 'D']);
  assert.deepEqual(eligibleItems(f.graph, f.ledger, f.cfg, {}, { ...options, dirty: { paths: ['hard.md'], dirs: [] } }).map(w => w.id), ['D']);
  f.ledger.items.A.state = 'CLAIMED';
  assert.deepEqual(computeReady(f.graph, f.ledger, options).map(w => w.id), ['D']);
  f.ledger.items.A.state = 'READY';
  f.call('cmdSuggest', { min: '1' });
  const suggestion = f.logs.find(line => line.includes('driver.mjs group --ids'));
  assert.ok(suggestion && !/--ids [^ ]*(?:B|C)/.test(suggestion));
  f.call('cmdGroup', { ids: 'A,B,C,D', dry: true });
  const launch = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  assert.deepEqual(launch.items.map(w => w.id), ['A', 'D']);
  f.call('cmdClaim', ['A', 'B', 'C', 'D']);
  assert.deepEqual(Object.entries(f.readLedger().items).filter(([, row]) => row.state === 'CLAIMED').map(([id]) => id), ['A', 'D']);
  const claimedLaunch = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  assert.equal(claimedLaunch.items[0].claimAt, f.readLedger().items.A.attemptIdentity.reservedAt);
  writeJsonAtomic(f.cfg.paths.ledger, f.ledger);
  f.cfg.evidenceInputs = { includeGlobs: ['eng/*.settings'] };
  f.cfg.concurrency.builds = 2;
  const { launch: sweep } = sweepSetup(f);
  assert.deepEqual(sweep.sweep.sites.map(s => s.findingId), ['A', 'D']);
  assert.deepEqual(sweep.evidenceInputs, f.cfg.evidenceInputs);
  assert.equal(sweep.buildCapacity, 2);
  assert.equal(sweep.sweep.sites[0].claimAt, f.readLedger().items.A.attemptIdentity.reservedAt);
});

test('launch carries host input contract, resolved capacity and reservation claimAt', t => {
  const f = fixture(t);
  f.cfg.evidenceInputs = { includePaths: ['eng/custom.settings'], discoverDefaults: false };
  f.cfg.concurrency.builds = 3;
  const engineMount = { path: 'tools/factory', sourceRoot: join(f.root, 'tools/factory') };
  f.context.driverEngineMount = () => engineMount;
  f.call('cmdGroup', { ids: 'A', 'build-capacity': '2' });
  const launch = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  assert.equal(launch.buildCapacity, 2);
  assert.deepEqual(launch.evidenceInputs, f.cfg.evidenceInputs);
  assert.deepEqual(launch.engineMount, engineMount);
  assert.equal(launch.items[0].claimAt, f.readLedger().items.A.attemptIdentity.reservedAt);
  assert.equal(resolvedBuildCapacity(f.cfg), 3);
  assert.throws(() => resolvedBuildCapacity(f.cfg, { 'build-capacity': '2garbage' }), /capacity/);
  assert.throws(() => resolvedBuildCapacity({ buildCapacity: 0 }), /capacity/);
});

test('product submodule preflight refuses before claims, and checks new worktrees before admission', t => {
  const f = fixture(t);
  f.context.preflightProductGitlinks = () => { throw new Error('initialize product submodule'); };
  assert.throws(() => f.call('cmdGroup', { ids: 'A' }), /initialize product/);
  assert.equal(f.worktrees.length, 0);
  assert.equal(f.readLedger().items.A.state, 'READY');
  assert.throws(() => f.call('cmdClaim', ['A']), /initialize product/);
  assert.equal(f.readLedger().items.A.state, 'READY');
  const checked = [];
  f.context.preflightProductGitlinks = root => {
    checked.push(root);
    if (root !== f.root) throw new Error('initialize product in new worktree');
  };
  assert.throws(() => f.call('cmdGroup', { ids: 'A' }), /new worktree/);
  assert.equal(checked.length, 2);
  assert.equal(f.readLedger().items.A.state, 'READY');
});

test('driver publishes backend-neutral build capacity atomically inside lock and controller guards', async t => {
  const f = fixture(t), events = [];
  f.context.process.argv = ['node', 'driver.mjs', 'group', '--build-capacity', '2'];
  f.context.acquireLock = () => { events.push('lock'); return { ok: true }; };
  f.context.releaseLock = () => events.push('unlock');
  f.context.requireController = () => { events.push('controller'); return true; };
  f.context.writeJsonAtomic = (path, value) => {
    assert.match(path.replace(/\\/g, '/'), /\/state\/build-capacity\.json$/);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), { version: 1, limit: 2 });
    events.push('capacity');
  };
  f.context.dispatch = () => events.push('dispatch');
  await f.call('main');
  assert.deepEqual(events, ['lock', 'controller', 'capacity', 'dispatch', 'unlock']);
  events.length = 0;
  f.context.process.argv.push('--dry');
  await f.call('main');
  assert.deepEqual(events, ['lock', 'controller', 'dispatch', 'unlock']);
});

test('actual sweep fold is legal and idempotent, and completes lifecycle with final state', t => {
  const f = fixture(t); const { result } = sweepSetup(f);
  const path = f.writeResult(result); f.call('cmdSweepFold', path);
  const first = f.readLedger();
  assert.equal(first.items.A.state, 'CLOSED'); assert.equal(first.items.A.attempts, 1);
  assert.deepEqual(first.items.A.history.slice(-9).map(h => h.to), ['RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED', 'INTEGRATED', 'CLOSED']);
  f.call('cmdSweepFold', path);
  assert.deepEqual(f.readLedger().items.A, first.items.A);
  assert.equal(f.events.filter(e => e.event === 'usage').length, 1);
  assert.equal(f.events.filter(e => e.event === 'item_folded').length, 1);
  assert.equal(f.events.find(e => e.attrs?.observation?.phase === 'completed').attrs.observation.outcome, 'CLOSED');
});

test('sweep admission honors drain and dry planning without claiming or creating worktrees', t => {
  const f = fixture(t);
  const dir = join(f.cfg.paths.items, '../sweeps');
  writeJsonAtomic(join(dir, 'sweep-0.json'), { sites: [{ findingId: 'A' }] });
  f.call('cmdSweep', { dry: true }, ['0']);
  assert.equal(f.readLedger().items.A.state, 'READY'); assert.equal(f.worktrees.length, 0);
  fs.writeFileSync(join(f.root, 'state/STOP_REQUESTED.md'), 'drain');
  f.call('cmdSweep', {}, ['0']);
  assert.equal(f.readLedger().items.A.state, 'READY'); assert.equal(f.worktrees.length, 0);
});

test('sweep opt-in to escalate tier never grants automatic close', t => {
  const f = fixture(t, [item('A', { autonomyTier: 'escalate' })]);
  const { result } = sweepSetup(f, { 'include-escalate': true });
  f.call('cmdSweepFold', f.writeResult(result));
  assert.equal(f.readLedger().items.A.state, 'ESCALATED');
});

for (const defect of ['execution', 'review', 'file', 'worktree', 'scope', 'claim']) {
  test('actual sweep fold rejects ' + defect + ' without false closure', t => {
    const f = fixture(t); const { launch, result } = sweepSetup(f);
    if (defect === 'execution') result.sweep.execution.verificationPassed = false;
    if (defect === 'review') result.sweep.reviews.architect = null;
    if (defect === 'file') fs.unlinkSync(join(launch.worktree.path, 'A.md'));
    if (defect === 'worktree') fs.rmSync(launch.worktree.path, { recursive: true });
    if (defect === 'scope') result.sweep.reviews.security.scopeViolation = true;
    if (defect === 'claim') { const l = f.readLedger(); l.items.A.state = 'BLOCKED'; writeJsonAtomic(f.cfg.paths.ledger, l); }
    f.call('cmdSweepFold', f.writeResult(result));
    assert.equal(f.readLedger().items.A.state, ['scope', 'claim'].includes(defect) ? 'BLOCKED' : 'FAILED');
  });
}

test('completed isolated dissent closes only unaffected sites', t => {
  const f = fixture(t, [item('A'), item('B')]); const { result } = sweepSetup(f);
  result.sweep.reviews.architect = { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH', file: 'A.md', title: 'Wrong value' }] };
  f.call('cmdSweepFold', f.writeResult(result));
  assert.equal(f.readLedger().items.A.state, 'FAILED'); assert.equal(f.readLedger().items.B.state, 'CLOSED');
});

test('one mapped blocker cannot hide a second unmapped blocker', t => {
  const f = fixture(t, [item('A'), item('B')]); const { result } = sweepSetup(f);
  result.sweep.reviews.architect = { verdict: 'CHANGES_REQUIRED', findings: [
    { severity: 'HIGH', file: 'A.md', title: 'Wrong value' }, { severity: 'HIGH', file: 'shared.md', title: 'Shared failure' }] };
  f.call('cmdSweepFold', f.writeResult(result));
  assert.equal(f.readLedger().items.A.state, 'FAILED'); assert.equal(f.readLedger().items.B.state, 'FAILED');
});

test('group refills after exclusions and persists distinct run/claim UUIDs', t => {
  const f = fixture(t, [item('A'), item('B', { files: ['A.md'] }), item('C', { acceptance: '' }), item('D')]);
  f.call('cmdGroup', { max: '2' });
  const launch = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  assert.deepEqual(launch.items.map(w => w.id), ['A', 'D']);
  assert.equal(launch.concurrency, 7);
  assert.notEqual(launch.items[0].claimId, launch.items[1].claimId);
  assert.equal(launch.items[0].runId, launch.runId);
});

test('precedent lookup falls back to an older live artifact using configured paths', t => {
  const f = fixture(t, [item('A'), item('OLDER'), item('NEWER')]);
  for (const [id, at] of [['OLDER', '2026-01-01'], ['NEWER', '2026-02-01']]) {
    f.ledger.items[id].state = 'CLOSED'; f.ledger.items[id].updatedAt = at;
  }
  writeJsonAtomic(f.cfg.paths.ledger, f.ledger);
  writeJsonAtomic(join(f.cfg.paths.items, 'OLDER/fix.json'), { applied: true });
  f.call('cmdGroup', { ids: 'A' });
  const launch = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  assert.equal(launch.items[0].precedent.id, 'OLDER');
  assert.equal(launch.items[0].precedent.fixJson, join(f.cfg.paths.items, 'OLDER/fix.json'));
});

test('recovery persists fresh identities and structured classification, and recognizes unavailable integrator', t => {
  const f = fixture(t); f.ledger.items.A.state = 'FAILED'; writeJsonAtomic(f.cfg.paths.ledger, f.ledger);
  const key = 'adjudicator:realinfra-override';
  const ruling = { verdict: 'OVERRULED', headline: 'Pure logic', reasons: ['No provider semantics involved'] };
  writeJsonAtomic(join(f.cfg.paths.items, 'A/result.json'), { id: 'A', resultId: 'A#1', codeChange: false,
    gates: { [key]: 'OVERRULED' }, realInfraClassification: { original: true, effective: false, reason: 'Pure logic', adjudication: ruling } });
  writeJsonAtomic(join(f.cfg.paths.items, 'A/last-failure.json'), { transitions: ['REAUDITED', 'FAILED'], gates: {}, failure: { kind: 'unavailable', stage: 'integrator' } });
  f.call('cmdRecover', {}, ['A']);
  const path = join(f.cfg.paths.items, 'A/recovery/recovery-fold.json');
  const first = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.ok(fs.existsSync(join(f.cfg.paths.items, 'A/recovery/recover-stage-integrator.md')));
  assert.equal(first.results[0].realInfraClassification.adjudication.headline, 'Pure logic');
  f.call('cmdRecover', {}, ['A']);
  const second = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.notEqual(first.runId, second.runId); assert.notEqual(first.results[0].claimId, second.results[0].claimId);
  assert.notEqual(first.results[0].resultId, second.results[0].resultId);
  assert.equal(f.readLedger().items.A.attempts, 0);
});

test('fold infra floor comes from graph and accepts only corroborated structured override in both bindings', t => {
  const f = fixture(t, [item('A', { files: ['A.cs'], title: 'Race condition loses updates', realInfra: true })]);
  const dir = join(f.cfg.paths.items, 'A'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'verify-raw.txt'), 'FACTORY::SUMMARY::build exit=0 errors=0\nFACTORY::SUMMARY::filter exit=0\n');
  fs.writeFileSync(join(dir, 'verify-red-raw.txt'), 'FACTORY::RED::1\n');
  const result = () => ({ id: 'A', codeChange: true, needsRealInfra: false, transitions: ['CLOSED'], toState: 'CLOSED', band: 'LIGHT' });
  assert.match(f.call('deterministicVerifyOverride', f.cfg, f.ledger, f.graph.items[0], result()).reason, /REALINFRA/);
  const key = 'adjudicator:realinfra-override';
  const ruling = { verdict: 'OVERRULED', headline: 'Pure logic', reasons: ['The defect is in the pure parser'] };
  const native = { ...result(), gates: { [key]: 'OVERRULED' }, gateDetails: { [key]: ruling },
    infraClassification: { version: 1, original: true, effective: false, adjudication: { ...ruling, reason: 'No database access' } } };
  assert.equal(f.call('deterministicVerifyOverride', f.cfg, f.ledger, f.graph.items[0], native), null);
  const port = { ...result(), gates: { [key]: 'OVERRULED' }, realInfraClassification: { original: true, effective: false, adjudication: ruling, reason: 'No database access' } };
  assert.equal(f.call('deterministicVerifyOverride', f.cfg, f.ledger, f.graph.items[0], port), null);
  delete native.gates[key];
  assert.match(f.call('deterministicVerifyOverride', f.cfg, f.ledger, f.graph.items[0], native).reason, /REALINFRA/);
});

test('actual fold budget deferrals are idempotent, bounded, and consume no quality attempts', t => {
  const f = fixture(t);
  for (let n = 0; n < 3; n++) {
    f.call('cmdGroup', { ids: 'A' });
    const row = f.readLedger().items.A;
    const path = f.writeResult({ cycle: n + 1, runId: row.runId, results: [{ id: 'A', resultId: 'A#' + (n + 1), runId: row.runId,
      toState: 'FAILED', transitions: ['FAILED'], attemptsDelta: 1, budgetDeferred: true, failure: { kind: 'budget', stage: 'runner' } }] });
    f.call('cmdFold', path, {}); f.call('cmdFold', path, {});
    assert.equal(f.readLedger().items.A.attempts, 0);
    assert.equal(f.readLedger().items.A.budgetDeferrals, n + 1);
  }
  assert.equal(f.readLedger().items.A.state, 'ESCALATED');
  assert.equal(JSON.parse(fs.readFileSync(join(f.cfg.paths.items, 'A/last-failure.json'), 'utf8')).failure.kind, 'budget');
});

test('unstarted id-less budget result is also idempotent', t => {
  const f = fixture(t); f.call('cmdGroup', { ids: 'A' });
  const row = f.readLedger().items.A;
  const path = f.writeResult({ cycle: 1, runId: row.runId, results: [{ id: 'A', toState: 'CLAIMED', budgetStopped: true, transitions: [] }] });
  f.call('cmdFold', path, {}); f.call('cmdFold', path, {});
  assert.equal(f.readLedger().items.A.budgetDeferrals, 1);
  assert.equal(f.readLedger().items.A.attempts, 0);
});

test('actual reconstruct carries run/claim identities and checkpoint observations through duplicate folds', t => {
  const f = fixture(t); f.call('cmdGroup', { ids: 'A' });
  const row = f.readLedger().items.A;
  const observation = { version: 1, runId: row.runId, itemId: 'A', attemptId: 'checkpoint', dispatchId: 'checkpoint-logical',
    stage: 'A:checkpoint', phase: 'Checkpoint', overhead: true, outcome: 'started' };
  writeJsonAtomic(join(f.cfg.paths.items, 'A/result.json'), { id: 'A', resultId: 'A#1', runId: row.runId, claimId: row.claimId,
    toState: 'FAILED', transitions: ['FAILED'], attemptsDelta: 1, attemptObservations: [observation], failure: { kind: 'quality', stage: 'runner' } });
  f.call('cmdReconstruct', { 'usage-tokens': '42' });
  const path = join(f.root, 'state/results-cycle-1.json');
  const payload = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.equal(payload.runId, row.runId); assert.equal(payload.results[0].driverClaimId, row.claimId);
  assert.equal(payload.attemptObservations.length, 1);
  f.call('cmdFold', path, {}); f.call('cmdFold', path, {});
  assert.equal(f.readLedger().items.A.attempts, 1);
  assert.equal(f.events.filter(e => e.event === 'usage').length, 1);
  assert.equal(f.events.find(e => e.event === 'usage').attrs.usageId, row.runId + ':usage:final');
  const records = f.events.filter(e => e.attrs?.observation).map(e => e.attrs.observation);
  assert.equal(aggregateObservations(records).calls.physical, 1);
});

test('actual fold emits deterministic failure outcome and rejects stale claim before mutation', t => {
  const f = fixture(t, [item('A', { files: ['A.cs'] })]); f.call('cmdGroup', { ids: 'A' });
  const row = f.readLedger().items.A;
  const result = { id: 'A', resultId: 'A#1', runId: row.runId, claimId: 'wrong', admission: { attempted: true }, toState: 'CLOSED', transitions: ['CLOSED'], attemptsDelta: 1, codeChange: true };
  f.call('cmdFold', f.writeResult({ runId: row.runId, cycle: 1, results: [result] }), {});
  assert.equal(f.readLedger().items.A.state, 'CLAIMED');
  result.claimId = row.claimId;
  f.call('cmdFold', f.writeResult({ runId: row.runId, cycle: 1, results: [result] }), {});
  assert.equal(f.readLedger().items.A.state, 'FAILED');
  const complete = f.events.find(e => e.attrs?.observation?.phase === 'completed').attrs.observation;
  assert.equal(complete.outcome, 'FAILED'); assert.equal(complete.lateDeterministicFailure, true);
});

function transcript(target, { suite = true, truncated = false } = {}) {
  return `FACTORY::BUILD::START ${target}\nFACTORY::BUILD::0 errors=0 warnings=0\nFACTORY::SUMMARY::build exit=0 errors=0 warnings=0\n`
    + `FACTORY::TEST::FILTER::START ${target} :: Regression\nPassed! Failed: 0, Passed: 1\nFACTORY::SUMMARY::filter exit=0\n`
    + (suite ? `FACTORY::TEST::SUITE::START ${target}\n` + (truncated ? '' : 'FACTORY::SUMMARY::suite exit=0 failed=0 passed=3\n') : '');
}

function nativeReceiptFixture(t, { final = false, code = true } = {}) {
  const f = fixture(t, [item('A', { files: code ? ['src/A.cs'] : ['A.md'], band: 'FULL' })]);
  f.call('cmdGroup', { ids: 'A' });
  const ledger = f.readLedger(), row = ledger.items.A, dir = join(f.cfg.paths.items, 'A'), wt = row.worktree;
  const files = ['app.sln', 'src/A.cs', 'tests/Tests.csproj', 'tests/Regression.cs'];
  for (const file of files) {
    fs.mkdirSync(dirname(join(wt, file)), { recursive: true }); fs.writeFileSync(join(wt, file), 'content');
  }
  const git = { root: () => wt, head: () => '1'.repeat(40), index: () => files.map(path => ({ path, mode: '100644', oid: '2'.repeat(40) })), untracked: () => [] };
  const collect = (root, metadata) => collectEvidenceIdentity(root, metadata, { git });
  f.context.verifyNativeReceipt = args => verifyNativeReceipt({ ...args, collect });
  const passId = row.runId + '-' + row.claimId;
  const initial = join(dir, 'verify-initial-' + passId + '.txt'), integration = join(dir, 'verify-integrate-' + passId + '.txt');
  const raw = transcript('app.sln').replace('FILTER::START app.sln', 'FILTER::START tests/Tests.csproj');
  fs.writeFileSync(initial, code ? raw : 'PASS acceptance assertion');
  fs.writeFileSync(integration, raw.replace(/FACTORY::TEST::FILTER::START[\s\S]*?(?=FACTORY::TEST::SUITE::START)/, ''));
  fs.writeFileSync(join(dir, 'verify-red-raw.txt'), 'FACTORY::RED::START tests/Tests.csproj :: Regression\nFACTORY::RED::1\n');
  writeJsonAtomic(join(dir, 'test.json'), { runCmd: 'dotnet test tests/Tests.csproj --filter Regression' });
  const wi = f.graph.items[0];
  const metadata = { requestVersion: 1, requestIdentity: { itemId: 'A', runId: row.runId, claimId: row.claimId,
    attemptNumber: row.attemptNumber, boundary: final ? 'post-final-verify' : 'post-mutation', passId, codeChange: code, integrationRequired: false },
    acceptance: wi.acceptance, policies: {}, profile: '', inputs: {}, engineMount: null,
    reviewerContract: { version: 'native-review-v2', briefs: {}, briefsDirectory: f.cfg.paths.agents, routes: {}, band: 'FULL', gates: null, portfolio: {} },
    context: { title: wi.title, files: wi.files, regressionTest: wi.regressionTest, planner: null, infraClassification: null,
      verificationOnly: false, baselineFailures: [], acceptedPlanDeviation: null, verificationTargets: ['app.sln'],
      verificationContract: code ? { expected: { build: ['app.sln'], filter: [{ target: 'tests/Tests.csproj', filter: 'Regression' }], suite: ['app.sln'] },
        integrationExpected: { build: ['app.sln'], suite: ['app.sln'] } } : null },
    verificationTranscript: initial, integrationTranscript: null };
  const evidence = collect(wt, metadata);
  if (final) {
    metadata.verificationTranscript = join(dir, 'verify-final-' + evidence.hash + '.txt');
    fs.writeFileSync(metadata.verificationTranscript, raw);
    fs.writeFileSync(integration, raw.replace(/FACTORY::TEST::FILTER::START[\s\S]*?(?=FACTORY::TEST::SUITE::START)/, ''));
  }
  const output = meta => ({ ...collect(wt, meta), request: nativeEvidenceRequest(wt, meta, dir), shadowSnapshotHash: null,
    verification: { pass: true, reason: 'complete' }, integration: meta.integrationTranscript ? { pass: true, reason: 'complete' } : null,
    redProof: { markerFound: true, exitCode: 1 }, rootCause: { nonTestCount: 1, files: ['src/A.cs'], skipped: false } });
  const persist = (meta, result) => {
    const path = join(dir, 'native-evidence-' + result.request.digest + '.json');
    writeJsonAtomic(path, { metadata: meta, result }); return path;
  };
  const result = { id: 'A', runId: row.runId, claimId: row.claimId, codeChange: code, band: 'FULL', toState: 'CLOSED', transitions: ['CLOSED'],
    nativeEvidenceVersion: 1, reviewPortfolio: {}, evidenceIdentity: output(metadata), initialVerification: { passId, transcript: initial },
    ...(code ? { integrationVerification: { passId, transcript: integration }, integrateRaw: true } : {}),
    ...(final ? { finalVerification: { refreshed: true, codeChanged: true, transcript: metadata.verificationTranscript, evidenceHash: evidence.hash } } : {}) };
  const receiptPath = persist(metadata, result.evidenceIdentity);
  const integratedMetadata = { ...metadata, integrationTranscript: code ? integration : null,
    requestIdentity: { ...metadata.requestIdentity, boundary: 'post-integrate', integrationRequired: code } };
  const integrationReceiptPath = persist(integratedMetadata, output(integratedMetadata));
  const check = () => f.call('deterministicVerifyOverride', f.cfg, ledger, wi, structuredClone(result));
  return { ...f, ledger, row, dir, wt, metadata, result, receiptPath, integrationReceiptPath, initial, integration, raw, output, persist, check, collect };
}

for (const options of [{}, { final: true }, { code: false }]) test('actual override accepts bound native receipt ' + JSON.stringify(options), t => {
  const f = nativeReceiptFixture(t, options);
  assert.equal(f.check(), null);
  writeJsonAtomic(join(f.dir, 'evidence-input.json'), { omitted: 'mutable relay handoff is not authority' });
  assert.equal(f.check(), null);
  fs.writeFileSync(join(f.wt, 'src/A.cs'), 'source changed after receipt');
  assert.match(f.check().reason, /stale against current worktree/);
});

const nativeAttacks = {
  'omitted nullable shadow hash from relay': f => { delete f.result.evidenceIdentity.shadowSnapshotHash; },
  'omitted populated shadow hash from relay': f => { const receipt = JSON.parse(fs.readFileSync(f.receiptPath)); receipt.result.shadowSnapshotHash = 'a'.repeat(64); writeJsonAtomic(f.receiptPath, receipt); delete f.result.evidenceIdentity.shadowSnapshotHash; },
  'forged syntactically valid identity': f => { f.result.evidenceIdentity.hash = 'f'.repeat(64); },
  'forged identity in receipt too': f => { f.result.evidenceIdentity.hash = 'f'.repeat(64); f.persist(f.metadata, f.result.evidenceIdentity); },
  'missing receipt': f => fs.unlinkSync(f.receiptPath),
  'missing integration receipt': f => fs.unlinkSync(f.integrationReceiptPath),
  'omitted request with producer fields': f => { delete f.result.nativeEvidenceVersion; delete f.result.evidenceIdentity.request; },
  'stripped identity with portfolio': f => { delete f.result.nativeEvidenceVersion; delete f.result.evidenceIdentity; },
  'spoof OpenCode marker with native evidence': f => { delete f.result.nativeEvidenceVersion; f.result.runtime = 'opencode'; delete f.result.evidenceIdentity.request; },
  'unsupported contract version': f => { f.result.nativeEvidenceVersion = 2; },
  'altered metadata under original digest': f => { f.metadata.context.planner = { altered: true }; f.persist(f.metadata, f.result.evidenceIdentity); },
  'omitted review source': f => { delete f.metadata.reviewerContract.briefs; f.persist(f.metadata, f.result.evidenceIdentity); },
  'stale claim with fresh digest': f => { f.metadata.requestIdentity.claimId = 'other'; f.result.evidenceIdentity = f.output(f.metadata); f.persist(f.metadata, f.result.evidenceIdentity); },
  'changed policy with fresh digest': f => { f.metadata.policies = { noNewComments: true }; f.result.evidenceIdentity = f.output(f.metadata); f.persist(f.metadata, f.result.evidenceIdentity); },
  'wrong-file pass with fresh digest': f => { f.metadata.verificationTranscript = join(f.dir, 'unrelated.txt'); fs.writeFileSync(f.metadata.verificationTranscript, f.raw); f.result.evidenceIdentity = f.output(f.metadata); f.persist(f.metadata, f.result.evidenceIdentity); },
  'missing requested transcript despite green legacy': f => { fs.unlinkSync(f.initial); fs.writeFileSync(join(f.dir, 'verify-raw.txt'), f.raw); },
  'self-report cannot hide truncated transcript': f => fs.writeFileSync(f.initial, f.raw + 'FACTORY::TEST::SUITE::START app.sln\n'),
  'self-report cannot hide truncated integration': f => fs.writeFileSync(f.integration, 'FACTORY::BUILD::START app.sln\n'),
  'verification pass must be boolean': f => { f.result.evidenceIdentity.verification.pass = 'true'; f.persist(f.metadata, f.result.evidenceIdentity); },
  'failed verification output': f => { f.result.evidenceIdentity.verification.pass = false; f.persist(f.metadata, f.result.evidenceIdentity); },
  'integration result identity forged': f => { const receipt = JSON.parse(fs.readFileSync(f.integrationReceiptPath)); receipt.result.codeHash = 'a'.repeat(64); writeJsonAtomic(f.integrationReceiptPath, receipt); },
};
for (const [name, attack] of Object.entries(nativeAttacks)) test('actual native override rejects ' + name, t => {
  const f = nativeReceiptFixture(t); assert.equal(f.check(), null);
  attack(f); const rejected = f.check(); assert.ok(rejected, name); assert.match(rejected.reason, /native evidence|initial verification|integration verification/);
});

test('native receipt checks supplied complete expected metadata and physical containment', t => {
  const f = nativeReceiptFixture(t);
  const args = { result: f.result, row: f.row, item: f.graph.items[0], itemDir: f.dir, worktree: f.wt, repoRoot: f.root,
    codeChange: true, collect: f.collect, expectedMetadata: f.metadata };
  assert.equal(verifyNativeReceipt(args).pass, true);
  assert.match(verifyNativeReceipt({ ...args, expectedMetadata: { ...f.metadata, profile: 'altered' } }).reason, /expected metadata/);
  const outside = join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.renameSync(f.receiptPath, join(outside, 'receipt.json'));
  fs.symlinkSync(outside, join(f.dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  f.result.evidenceIdentity.request.artifactDir = join(f.dir, 'alias');
  assert.match(f.check().reason, /directory mismatch/);
});

test('direct Node and legacy results do not acquire native authority from a runtime label', t => {
  const f = fixture(t, [item('A', { files: ['A.cs'] })]); f.call('cmdGroup', { ids: 'A' });
  const ledger = f.readLedger(), dir = join(f.cfg.paths.items, 'A');
  fs.writeFileSync(join(dir, 'verify-red-raw.txt'), 'FACTORY::RED::1\n');
  const result = { id: 'A', codeChange: true, band: 'FULL', toState: 'CLOSED', runtime: 'opencode', evidenceIdentity: { version: 3, hash: 'a'.repeat(64) } };
  assert.match(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], structuredClone(result)).reason, /no machine/);
  fs.writeFileSync(join(dir, 'verify-raw.txt'), transcript('app.sln'));
  assert.equal(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], structuredClone(result)), null);
});

test('code sweep independently parses commands instead of trusting green execution booleans', t => {
  const f = fixture(t, [item('A', { files: ['A.cs'], solution: 'app.sln' })]);
  const { launch, result } = sweepSetup(f);
  result.sweep.execution.verificationRequired = true;
  fs.writeFileSync(join(launch.worktree.path, 'app.sln'), 'solution');
  fs.writeFileSync(launch.sweep.verificationTranscript, transcript(join(launch.worktree.path, 'app.sln'), { truncated: true }));
  f.call('cmdSweepFold', f.writeResult(result));
  assert.equal(f.readLedger().items.A.state, 'FAILED');
});

test('final transcript requires containment, current content identity and complete markers', t => {
  const f = fixture(t), dir = join(f.cfg.paths.items, 'A'), wt = join(f.root, 'wt');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(wt); fs.writeFileSync(join(wt, 'app.sln'), 'solution');
  const hash = 'a'.repeat(64), path = join(dir, 'verify-final-' + hash + '.txt');
  writeJsonAtomic(join(dir, 'evidence-input.json'), { reviewerContract: {} });
  const result = { band: 'FULL', evidenceIdentity: { version: EVIDENCE_IDENTITY_VERSION, hash }, finalVerification: { refreshed: true, codeChanged: true, evidenceHash: hash, transcript: path } };
  const args = { result, itemDir: dir, worktree: wt, repoRoot: f.root, targets: ['app.sln'], collect: () => ({ version: EVIDENCE_IDENTITY_VERSION, hash }) };
  fs.writeFileSync(join(dir, 'verify-red-raw.txt'), 'FACTORY::TEST::FILTER::START app.sln :: Regression\nFACTORY::RED::1\n');
  writeJsonAtomic(join(dir, 'test.json'), { runCmd: 'bash build-test.sh filter app.sln "Regression"' });
  fs.writeFileSync(path, transcript(join(wt, 'app.sln')));
  assert.equal(verifyFinalTranscript(args).pass, true);
  result.evidenceIdentity.version = 1;
  assert.match(verifyFinalTranscript(args).reason, /identity mismatch/);
  result.evidenceIdentity.version = EVIDENCE_IDENTITY_VERSION;
  assert.equal(verifyFinalTranscript({ ...args, collect: () => ({ version: 1, hash }) }).pass, false);
  assert.match(verifyFinalTranscript({ ...args, engineMount: { path: 'factory', sourceRoot: f.root } }).reason, /engine mount mismatch/);
  const evidenceInputs = { includePaths: ['eng/settings'] };
  assert.match(verifyFinalTranscript({ ...args, evidenceInputs }).reason, /input contract mismatch/);
  writeJsonAtomic(join(dir, 'evidence-input.json'), { reviewerContract: {}, inputs: evidenceInputs });
  assert.equal(verifyFinalTranscript({ ...args, evidenceInputs, collect: (_root, metadata) => {
    assert.deepEqual(metadata.inputs, evidenceInputs); return { version: EVIDENCE_IDENTITY_VERSION, hash };
  } }).pass, true);
  assert.equal(verifyFinalTranscript({ ...args, collect: () => ({ hash: 'b'.repeat(64) }) }).pass, false);
  fs.writeFileSync(path, transcript(join(wt, 'app.sln'), { suite: false }));
  assert.equal(verifyFinalTranscript(args).pass, false);
  result.finalVerification.transcript = join(f.root, 'elsewhere.txt'); fs.writeFileSync(result.finalVerification.transcript, transcript(join(wt, 'app.sln')));
  assert.equal(verifyFinalTranscript(args).pass, false);
  assert.equal(verifyTranscript(transcript(join(f.root, 'elsewhere.txt')), { worktree: wt }).pass, false);
});

test('actual fold override uses final transcript rather than historical green and checks current snapshot', t => {
  const f = fixture(t, [item('A', { files: ['A.cs'] })]); f.call('cmdGroup', { ids: 'A' });
  const ledger = f.readLedger(), row = ledger.items.A, dir = join(f.cfg.paths.items, 'A'), wt = row.worktree;
  fs.writeFileSync(join(wt, 'app.sln'), 'solution'); fs.writeFileSync(join(wt, 'tests.csproj'), 'tests');
  fs.writeFileSync(join(dir, 'verify-red-raw.txt'), `FACTORY::TEST::FILTER::START ${join(wt, 'tests.csproj')} :: Regression\nFACTORY::RED::1\n`);
  writeJsonAtomic(join(dir, 'test.json'), { runCmd: 'dotnet test tests.csproj --filter "Regression"' });
  fs.writeFileSync(join(dir, 'verify-raw.txt'), transcript(join(wt, 'app.sln')));
  writeJsonAtomic(join(dir, 'evidence-input.json'), { reviewerContract: {} });
  const hash = 'c'.repeat(64), path = join(dir, 'verify-final-' + hash + '.txt');
  const freshText = transcript(join(wt, 'app.sln')).replace('FILTER::START ' + join(wt, 'app.sln'), 'FILTER::START ' + join(wt, 'tests.csproj'));
  fs.writeFileSync(path, freshText);
  const result = () => ({ id: 'A', toState: 'CLOSED', transitions: ['CLOSED'], band: 'FULL', codeChange: true,
    evidenceIdentity: { version: EVIDENCE_IDENTITY_VERSION, hash }, finalVerification: { refreshed: true, codeChanged: true, transcript: path, evidenceHash: hash } });
  f.context.verifyFinalTranscript = args => verifyFinalTranscript({ ...args, collect: () => ({ version: EVIDENCE_IDENTITY_VERSION, hash }) });
  assert.equal(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], result()), null);
  fs.writeFileSync(path, freshText + `FACTORY::TEST::SUITE::START ${join(wt, 'app.sln')}\n`);
  assert.match(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], result()).reason, /final verification/);
  fs.writeFileSync(path, freshText);
  f.context.verifyFinalTranscript = args => verifyFinalTranscript({ ...args, collect: () => ({ hash: 'd'.repeat(64) }) });
  assert.match(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], result()).reason, /stale/);
});

test('fold captures per-target/test baseline and rejects equal-count substitution, legacy counts and reFix recapture', t => {
  const f = fixture(t, [item('A', { files: ['A.cs'] })]); f.call('cmdGroup', { ids: 'A' });
  const ledger = f.readLedger(), row = ledger.items.A, dir = join(f.cfg.paths.items, 'A'), wt = row.worktree;
  fs.writeFileSync(join(wt, 'app.sln'), 'solution');
  fs.writeFileSync(join(dir, 'verify-red-raw.txt'), 'FACTORY::RED::1\n');
  const failing = (name, target = join(wt, 'app.sln')) => `FACTORY::TEST::SUITE::START ${target}\n`
    + 'FACTORY::TEST::FAILURE ' + JSON.stringify({ source: 'Tests.dll/net8.0', test: name }) + '\n'
    + 'FACTORY::SUMMARY::suite exit=1 failed=1 passed=4\n';
  const raw = name => 'FACTORY::SUMMARY::build exit=0 errors=0\n' + failing(name);
  const baselinePath = join(dir, 'baseline-raw.txt');
  fs.writeFileSync(baselinePath, failing('Old'));
  fs.writeFileSync(join(dir, 'verify-raw.txt'), raw('Old'));
  const result = () => ({ id: 'A', codeChange: true, band: 'FULL', toState: 'CLOSED', baselineFailures: ['Old'] });
  const check = () => f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], result());
  assert.equal(check(), null);
  fs.writeFileSync(join(dir, 'verify-raw.txt'), raw('New'));
  assert.match(check().reason, /new suite failure identities/);
  fs.writeFileSync(join(dir, 'verify-raw.txt'), raw('Old') + failing('Old', join(wt, 'other.sln')));
  assert.match(check().reason, /no unique captured baseline/);
  fs.writeFileSync(join(dir, 'verify-raw.txt'), raw('Old'));
  fs.writeFileSync(baselinePath, 'FACTORY::SUMMARY::suite exit=1 failed=1 passed=4\n');
  assert.match(check().reason, /captured target\/test baseline/);
  fs.writeFileSync(baselinePath, failing('Old'));
  row.prevState = 'FAILED';
  row.history.push({ to: 'CLAIMED', at: new Date(Date.now() - 1000).toISOString() });
  assert.match(check().reason, /absent/);
});

test('physical observations adapt native retries, shared sweep overhead and incomplete writer snapshots', () => {
  const row = {}; const identity = admitAttempt(row, 'run', { cycle: 1 });
  const raw = { version: 1, runId: 'run', itemId: 'A', attemptId: 'physical', dispatchId: 'logical', stage: 'A:runner', phase: 'Verify', outcome: 'ok', retry: 1 };
  const events = [];
  observePhysical({ attemptObservations: [raw, { ...raw, attemptId: 'pending', outcome: 'started' }, { ...raw, attemptId: 'sweep', itemId: 'sweep' }] }, { A: row }, e => events.push(e));
  const observations = events.map(e => e.attrs.observation);
  assert.equal(observations[0].attemptId, identity.claimId);
  assert.equal(observations[2].bucket, 'shared-overhead');
  assert.equal(aggregateObservations(observations).calls.physical, 3);
});

test('command-specific expectations accept mixed solution/project layout and reject extra/missing invocations', t => {
  const f = fixture(t), wt = join(f.root, 'wt');
  for (const file of ['app.sln', 'other.sln', 'src/App.csproj', 'src/App.cs', 'tests/App.Tests.csproj', 'tests/Regression.cs']) {
    fs.mkdirSync(dirname(join(wt, file)), { recursive: true }); fs.writeFileSync(join(wt, file), 'content');
  }
  const testData = { testFiles: ['tests/Regression.cs'], runCmd: 'dotnet test "tests/App.Tests.csproj" --filter "Regression"' };
  const redText = 'FACTORY::RED::START tests/App.Tests.csproj :: Regression\nFACTORY::RED::1\n';
  const expected = verificationExpectations({ item: item('A', { files: ['src/App.cs'], solution: 'app.sln' }), test: testData, worktree: wt, band: 'FULL', redText });
  const raw = transcript('app.sln').replace('FILTER::START app.sln', 'FILTER::START tests/App.Tests.csproj');
  assert.equal(verifyTranscript(raw, { worktree: wt, expected }).pass, true);
  assert.equal(verifyTranscript(raw.replace(/FACTORY::TEST::SUITE::START[\s\S]*/, ''), { worktree: wt, expected }).pass, false);
  assert.equal(verifyTranscript(raw.replace('FILTER::START tests/App.Tests.csproj', 'FILTER::START app.sln'), { worktree: wt, expected }).pass, false);
  assert.equal(verifyTranscript(raw.replace(':: Regression', ':: Other'), { worktree: wt, expected }).pass, false);
  assert.equal(verifyTranscript(raw + transcript('other.sln'), { worktree: wt, expected }).pass, false);
  const light = verificationExpectations({ item: item('A', { files: ['src/App.cs'] }), test: testData, worktree: wt, band: 'LIGHT', redText });
  assert.equal(verifyTranscript(transcript('src/App.csproj', { suite: false }).replace('FILTER::START src/App.csproj', 'FILTER::START tests/App.Tests.csproj'),
    { worktree: wt, expected: light, required: ['build', 'filter'] }).pass, true);
  assert.throws(() => verificationExpectations({ item: {}, test: { ...testData, runCmd: 'dotnet test other.sln --filter Wrong' }, worktree: wt, band: 'FULL', redText }), /disagrees/);
});

test('mixed native/normalized observations preserve supersession and suppress runtime lifecycle verdicts', () => {
  const row = {}; const identity = admitAttempt(row, 'run', { cycle: 1 });
  const native = { version: 1, runId: 'run', itemId: 'A', attemptId: 'physical', dispatchId: 'logical', stage: 'A:runner', phase: 'Verify', outcome: 'started' };
  const port = makeObservation({ kind: 'dispatch', id: 'opencode:p', dispatchId: 'p', runId: 'run', itemId: 'A', attemptId: identity.claimId, outcome: 'completed' });
  const runtimeComplete = makeObservation({ kind: 'item-attempt', id: 'runtime:complete', runId: 'run', itemId: 'A', attemptId: identity.claimId, attemptNumber: 1, outcome: 'CLOSED' });
  const events = [];
  observePhysical({ attemptObservations: [native, port, runtimeComplete], results: [{ attemptObservations: [{ ...native, outcome: 'completed' }] }] }, { A: row }, e => events.push(e));
  const report = aggregateObservations(events.map(e => e.attrs.observation));
  assert.equal(report.calls.physical, 2); assert.equal(report.conflicts.length, 0);
  assert.equal(events.filter(e => e.attrs.observation.kind === 'item-attempt').length, 0);
  assert.equal(events.filter(e => e.attrs.observation.id.startsWith('native:physical:')).length, 2);
});

test('actual fold reads attempt-bound initial/integration proof and ignores stale historical transcript', t => {
  const f = fixture(t, [item('A', { files: ['src/A.cs'], band: 'FULL' })]); f.call('cmdGroup', { ids: 'A' });
  const ledger = f.readLedger(), row = ledger.items.A, dir = join(f.cfg.paths.items, 'A'), wt = row.worktree;
  for (const file of ['app.sln', 'tests/Tests.csproj', 'tests/Regression.cs']) {
    fs.mkdirSync(dirname(join(wt, file)), { recursive: true }); fs.writeFileSync(join(wt, file), 'content');
  }
  writeJsonAtomic(join(dir, 'test.json'), { testFiles: ['tests/Regression.cs'], runCmd: 'bash build-test.sh red tests/Tests.csproj Regression' });
  fs.writeFileSync(join(dir, 'verify-red-raw.txt'), 'FACTORY::RED::START tests/Tests.csproj :: Regression\nFACTORY::RED::1\n');
  fs.writeFileSync(join(dir, 'verify-raw.txt'), 'FACTORY::SUMMARY::build exit=1 errors=1\n');
  fs.writeFileSync(join(dir, 'integrate-raw.txt'), 'FACTORY::SUMMARY::build exit=1 errors=1\n');
  const passId = row.runId + '-' + row.claimId;
  const initial = join(dir, 'verify-initial-' + passId + '.txt'), integration = join(dir, 'verify-integrate-' + passId + '.txt');
  const raw = transcript('app.sln').replace('FILTER::START app.sln', 'FILTER::START tests/Tests.csproj');
  fs.writeFileSync(initial, raw);
  fs.writeFileSync(integration, raw.replace(/FACTORY::TEST::FILTER::START[\s\S]*?(?=FACTORY::TEST::SUITE::START)/, ''));
  const result = () => ({ id: 'A', runId: row.runId, claimId: row.claimId, codeChange: true, band: 'FULL', toState: 'CLOSED', transitions: ['CLOSED'], integrateRaw: true,
    initialVerification: { passId, transcript: initial }, integrationVerification: { passId, transcript: integration } });
  assert.equal(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], result()), null);
  const stale = result(); stale.initialVerification.passId = 'other-claim';
  assert.match(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], stale).reason, /run\/claim/);
});

test('OpenCode durable admission is collected without runtime lifecycle verdict conflict', t => {
  const f = fixture(t); f.call('cmdGroup', { ids: 'A' }); const row = f.readLedger().items.A;
  writeJsonAtomic(join(f.cfg.paths.items, 'A/dispatch/d-session.json'), { itemId: 'A', runId: row.runId, attemptId: row.claimId,
    sessionId: 'ses_live', status: 'admitted', startedAt: Date.now() });
  f.call('cmdReconstruct', {});
  assert.equal(f.readLedger().items.A.observedAttemptNumber, 1);
  const runtime = makeObservation({ kind: 'item-attempt', id: 'runtime:complete', runId: row.runId, itemId: 'A', attemptId: row.claimId, attemptNumber: 1, outcome: 'CLOSED' });
  f.call('cmdFold', f.writeResult({ cycle: 1, runId: row.runId, attemptObservations: [runtime], results: [{ id: 'A', resultId: 'A#1', claimId: row.claimId,
    runId: row.runId, transitions: ['FAILED'], toState: 'FAILED', attemptsDelta: 1 }] }), {});
  const records = f.events.filter(e => e.attrs?.observation).map(e => e.attrs.observation);
  const report = aggregateObservations(records);
  assert.equal(report.conflicts.length, 0); assert.equal(report.firstPass.closed, 0); assert.equal(report.firstPass.items, 1);
  assert.deepEqual(records.filter(r => r.phase === 'completed').map(r => r.outcome), ['FAILED']);
});

test('recovery commands and actual override require fresh proof despite inherited green or empty evidence', t => {
  const f = fixture(t, [item('A', { files: ['src/A.cs'], band: 'FULL' })]);
  f.call('cmdGroup', { ids: 'A' });
  let ledger = f.readLedger(), row = ledger.items.A, wt = row.worktree, dir = join(f.cfg.paths.items, 'A');
  for (const file of ['app.sln', 'src/A.cs', 'tests/Tests.csproj', 'tests/Regression.cs']) {
    fs.mkdirSync(dirname(join(wt, file)), { recursive: true }); fs.writeFileSync(join(wt, file), 'content');
  }
  const old = join(dir, 'verify-integrate-' + row.runId + '-' + row.claimId + '.txt');
  fs.writeFileSync(old, transcript('app.sln'));
  writeJsonAtomic(join(dir, 'result.json'), { id: 'A', resultId: 'A#1', codeChange: true, band: 'FULL',
    initialVerification: { passId: row.runId + '-' + row.claimId, transcript: old },
    integrationVerification: { passId: row.runId + '-' + row.claimId, transcript: old }, finalVerification: { refreshed: true, codeChanged: true } });
  writeJsonAtomic(join(dir, 'test.json'), { testFiles: ['tests/Regression.cs'], runCmd: 'dotnet test tests/Tests.csproj --filter Regression' });
  fs.writeFileSync(join(dir, 'verify-red-raw.txt'), 'FACTORY::RED::START tests/Tests.csproj :: Regression\nFACTORY::RED::1\n');
  ledger.items.A.state = 'FAILED'; writeJsonAtomic(f.cfg.paths.ledger, ledger);
  f.cfg.evidenceInputs = { includePaths: ['eng/recovery.settings'] };
  f.call('cmdRecover', {}, ['A']);
  ledger = f.readLedger(); row = ledger.items.A;
  const skeleton = JSON.parse(fs.readFileSync(join(dir, 'recovery/recovery-fold.json'), 'utf8')).results[0];
  assert.equal(skeleton.initialVerification, undefined); assert.equal(skeleton.integrationVerification, undefined); assert.equal(skeleton.finalVerification, undefined);
  const contract = row.recoveryVerification;
  assert.deepEqual(JSON.parse(fs.readFileSync(contract.metadataFile, 'utf8')).inputs, f.cfg.evidenceInputs);
  const commands = fs.readFileSync(join(dir, 'recovery/README.md'), 'utf8');
  assert.ok(commands.includes(contract.transcript)); assert.ok(!commands.includes('tee -a ' + join(dir, 'integrate-raw.txt')));
  const raw = transcript('app.sln').replace('FILTER::START app.sln', 'FILTER::START tests/Tests.csproj');
  fs.writeFileSync(contract.transcript, raw.replace('exit=0 errors=0', 'exit=1 errors=1'));
  assert.match(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], structuredClone(skeleton)).reason, /recovery verification.*build failed/);
  fs.writeFileSync(old, '');
  const hash = 'e'.repeat(64);
  writeJsonAtomic(contract.beforeIdentity, { version: EVIDENCE_IDENTITY_VERSION, hash });
  fs.writeFileSync(contract.transcript, raw);
  writeJsonAtomic(contract.afterIdentity, { version: EVIDENCE_IDENTITY_VERSION, hash });
  f.context.verifyRecoveryTranscript = args => verifyRecoveryTranscript({ ...args, collect: () => ({ version: EVIDENCE_IDENTITY_VERSION, hash }) });
  assert.equal(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], structuredClone(skeleton)), null);
  f.cfg.evidenceInputs = { includePaths: ['eng/changed.settings'] };
  assert.match(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], structuredClone(skeleton)).reason, /input contract mismatch/);
  f.cfg.evidenceInputs = { includePaths: ['eng/recovery.settings'] };
  f.context.verifyRecoveryTranscript = args => verifyRecoveryTranscript({ ...args, collect: () => ({ hash: 'f'.repeat(64) }) });
  assert.match(f.call('deterministicVerifyOverride', f.cfg, ledger, f.graph.items[0], structuredClone(skeleton)).reason, /snapshot changed/);
});

test('fold and resume diagnose drift without calling a repair or changing owner files', t => {
  const f = fixture(t); f.call('cmdGroup', { ids: 'A' });
  const ownerFile = join(f.root, 'A.md'); fs.writeFileSync(ownerFile, 'owner edits');
  fs.writeFileSync(f.cfg.paths.runScript, 'launcher');
  const dirty = [{ file: 'A.md', was: 'old', now: 'owner' }];
  f.context.driftAgainstSnapshot = () => dirty;
  f.context.splitDriftByStatus = () => ({ dirty, committed: [] });
  f.context.repairDirtyDrift = () => assert.fail('destructive repair called');
  f.call('cmdResume', {});
  const row = f.readLedger().items.A;
  f.call('cmdFold', f.writeResult({ runId: row.runId, cycle: 1, results: [{ id: 'A', resultId: 'A#1', toState: 'FAILED', transitions: ['FAILED'] }] }), {});
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), 'owner edits');
  assert.ok(f.logs.filter(line => line.includes('No files changed')).length >= 2);
});

test('GC protects mixed-state shared worktree then removes and clears every CLOSED reference once', t => {
  const f = fixture(t, [item('A'), item('B')]);
  const wt = join(f.root, 'shared'); fs.mkdirSync(wt); fs.writeFileSync(join(wt, 'fix.txt'), 'unfinished fix');
  f.ledger.items.A.state = 'CLOSED'; f.ledger.items.B.state = 'FAILED';
  f.ledger.items.A.worktree = wt; f.ledger.items.B.worktree = join(wt, '../shared');
  f.ledger.items.A.branch = f.ledger.items.B.branch = 'factory/sweep';
  writeJsonAtomic(f.cfg.paths.ledger, f.ledger);
  const removed = []; f.context.removeWorktree = path => removed.push(path);
  f.context.pruneWorktrees = () => {}; f.context.pruneStaleBranch = () => ({ deleted: true });
  f.call('cmdGc', { yes: true }); assert.equal(removed.length, 0);
  assert.equal(fs.readFileSync(join(wt, 'fix.txt'), 'utf8'), 'unfinished fix');
  const ledger = f.readLedger(); ledger.items.B.state = 'CLOSED'; writeJsonAtomic(f.cfg.paths.ledger, ledger);
  f.call('cmdGc', { yes: true }); assert.equal(removed.length, 1);
  assert.equal(f.readLedger().items.A.worktree, null); assert.equal(f.readLedger().items.B.worktree, null);
});

test('group persists every graph-owned solution and refuses ambiguous ownership before claim', t => {
  const f = fixture(t, [item('A', { files: ['A/A.cs', 'B/B.cs'], band: 'FULL' })]);
  for (const file of ['A/A.cs', 'A/A.sln', 'B/B.cs', 'B/B.sln']) {
    fs.mkdirSync(dirname(join(f.root, file)), { recursive: true }); fs.writeFileSync(join(f.root, file), 'content');
  }
  f.cfg.solutions = { A: 'A/A.sln', B: 'B/B.sln' };
  f.call('cmdGroup', { ids: 'A' });
  const launch = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  assert.deepEqual(launch.items[0].verificationTargets, ['A/A.sln', 'B/B.sln']);
  assert.deepEqual(f.readLedger().items.A.verificationTargets, ['A/A.sln', 'B/B.sln']);
  const expected = { build: launch.items[0].verificationTargets, filter: [{ target: 'A/A.sln', filter: 'Regression' }], suite: launch.items[0].verificationTargets };
  assert.equal(verifyTranscript(transcript('A/A.sln'), { worktree: f.root, expected }).pass, false);
  const second = transcript('B/B.sln').replace(/FACTORY::TEST::FILTER::START[\s\S]*?(?=FACTORY::TEST::SUITE::START)/, '');
  assert.equal(verifyTranscript(transcript('A/A.sln') + second, { worktree: f.root, expected }).pass, true);
  fs.writeFileSync(join(f.root, 'B/Other.sln'), 'other');
  assert.throws(() => affectedVerificationTargets(f.graph.items[0], {}, f.root), /ambiguous/);
});

test('unmapped nested production projects keep owning solutions for FULL and integration suites', t => {
  const wi = item('A', { target: 'Service', solution: 'Service/Service.sln', band: 'FULL',
    files: ['Service/src/Service.Api/Handler.cs', 'Other/src/Other.Api/Handler.cs'] });
  const f = fixture(t, [wi]);
  for (const service of ['Service', 'Other']) for (const file of [
    `${service}/${service}.sln`, `${service}/src/${service}.Api/${service}.Api.csproj`,
    `${service}/src/${service}.Api/Handler.cs`, `${service}/tests/${service}.Tests/Tests.csproj`,
    `${service}/tests/${service}.Tests/Regression.cs`,
  ]) {
    fs.mkdirSync(dirname(join(f.root, file)), { recursive: true }); fs.writeFileSync(join(f.root, file), 'content');
  }
  const canonicalTargets = values => process.platform === 'win32' ? values.map(value => value.toLowerCase()) : values;
  assert.deepEqual(affectedVerificationTargets({ ...wi, files: [wi.files[0]] }, {}, f.root, wi.solution), canonicalTargets(['Service/Service.sln']));
  f.call('cmdGroup', { ids: 'A' });
  const launch = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  const targets = canonicalTargets(['Other/Other.sln', 'Service/Service.sln']);
  assert.deepEqual(launch.items[0].verificationTargets, targets);
  assert.deepEqual(f.readLedger().items.A.verificationTargets, targets);
  const testData = { testFiles: ['Service/tests/Service.Tests/Regression.cs'],
    runCmd: 'dotnet test Service/tests/Service.Tests/Tests.csproj --filter Regression' };
  const redText = 'FACTORY::RED::START Service/tests/Service.Tests/Tests.csproj :: Regression\nFACTORY::RED::1\n';
  const full = verificationExpectations({ item: wi, test: testData, worktree: f.root, targets, band: 'FULL', redText });
  const relativePaths = values => values.map(value => value.replace(/\\/g, '/').toLowerCase());
  assert.deepEqual(relativePaths(full.build), relativePaths(targets.map(target => join(f.root, target))));
  assert.deepEqual(full.suite, full.build);
  const light = verificationExpectations({ item: wi, test: testData, worktree: f.root, targets, band: 'LIGHT', redText });
  assert.ok(light.build.every(target => target.endsWith('.csproj')));
  assert.deepEqual(light.suite, []);
  const primaryRaw = transcript('Service/Service.sln').replace('FILTER::START Service/Service.sln', 'FILTER::START Service/tests/Service.Tests/Tests.csproj');
  const siblingRaw = transcript('Other/Other.sln').replace(/FACTORY::TEST::FILTER::START[\s\S]*?(?=FACTORY::TEST::SUITE::START)/, '');
  assert.equal(verifyTranscript(primaryRaw, { worktree: f.root, expected: full }).pass, false);
  assert.equal(verifyTranscript(primaryRaw + siblingRaw, { worktree: f.root, expected: full }).pass, true);
  const integration = (primaryRaw + siblingRaw).replace(/FACTORY::TEST::FILTER::START[\s\S]*?(?=FACTORY::TEST::SUITE::START)/, '');
  assert.equal(verifyTranscript(integration, { worktree: f.root, expected: { build: targets, suite: targets }, required: ['build', 'suite'] }).pass, true);
});

test('Windows native, MSYS and case aliases compare as one contained transcript target', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), wt = join(f.root, 'WorkTree'); fs.mkdirSync(wt); fs.writeFileSync(join(wt, 'App.sln'), 'solution');
  const native = join(wt, 'App.sln');
  const msys = native.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()).toUpperCase();
  assert.equal(verifyTranscript(transcript(msys), { worktree: wt, targets: [native] }).pass, true);
});

test('failed OpenCode execution counts admission but pre-invocation failure does not', t => {
  const f = fixture(t, [item('A'), item('B')]); f.call('cmdGroup', { ids: 'A,B' });
  for (const id of ['A', 'B']) {
    const row = f.readLedger().items[id];
    writeJsonAtomic(join(f.cfg.paths.items, id, 'dispatch/d-session.json'), { itemId: id, runId: row.runId, attemptId: row.claimId,
      sessionId: id === 'A' ? 'ses_executed' : null, status: 'failed', startedAt: Date.now(),
      observation: makeObservation({ kind: 'dispatch', id: id + ':failed', runId: row.runId, itemId: id, attemptId: row.claimId, dispatchId: id,
        sessionId: id === 'A' ? 'ses_executed' : null, outcome: 'failed', outputTokens: id === 'A' ? 10 : null }) });
  }
  f.call('cmdReconstruct', {});
  assert.equal(f.readLedger().items.A.observedAttemptNumber, 1);
  assert.equal(f.readLedger().items.B.observedAttemptNumber, undefined);
});

test('reservation and before-start deferral do not enter first-attempt cohort; early checkpoint does', t => {
  const f = fixture(t); f.call('cmdGroup', { ids: 'A' });
  let row = f.readLedger().items.A;
  const observations = () => f.events.filter(e => e.attrs?.observation).map(e => e.attrs.observation);
  assert.equal(aggregateObservations(observations()).firstPass.items, 0);
  f.call('cmdFold', f.writeResult({ runId: row.runId, cycle: 1, results: [{ id: 'A', runId: row.runId, claimId: row.claimId, budgetStopped: true, admission: { status: 'deferred', attempted: false } }] }), {});
  assert.equal(aggregateObservations(observations()).firstPass.items, 0);
  f.call('cmdGroup', { ids: 'A' }); row = f.readLedger().items.A;
  assert.equal(row.attemptNumber, 1);
  writeJsonAtomic(join(f.cfg.paths.items, 'A/progress.json'), { id: 'A', runId: row.runId, claimId: row.claimId, resultId: 'A#2',
    progressStage: 'post-test-author', admission: { version: 1, runId: row.runId, claimId: row.claimId, attempted: true, status: 'admitted' } });
  f.call('cmdReconstruct', {});
  assert.equal(aggregateObservations(observations()).firstPass.items, 1);
  assert.equal(f.readLedger().items.A.observedAttemptNumber, 1);
  assert.equal(observations().find(o => o.kind === 'item-attempt').startedAt, null);
});

test('resume artifact reuse reserves fresh run/claim and cycle while exact replay retains launch bytes', t => {
  const f = fixture(t);
  f.context.emitLauncherScript = (_cfg, args, label) => {
    const path = label ? f.cfg.paths.runScript.replace(/\.js$/, '-' + label + '.js') : f.cfg.paths.runScript;
    fs.writeFileSync(path, JSON.stringify(args)); return path;
  };
  f.call('cmdGroup', { ids: 'A' });
  const before = JSON.parse(fs.readFileSync(f.cfg.paths.runArgs, 'utf8'));
  const bytes = fs.readFileSync(f.cfg.paths.runScript, 'utf8');
  f.call('cmdResume', {});
  assert.equal(fs.readFileSync(f.cfg.paths.runScript, 'utf8'), bytes);
  writeJsonAtomic(join(f.cfg.paths.items, 'A/progress.json'), { id: 'A', runId: before.runId, claimId: before.items[0].claimId,
    resultId: 'A#1', progressStage: 'post-plan', plannerRequired: false, admission: { attempted: true } });
  f.call('cmdResume', { reuse: true });
  const freshScript = f.readLedger().items.A.runScript;
  const after = JSON.parse(fs.readFileSync(freshScript.replace('run-script', 'run-args').replace(/\.js$/, '.json'), 'utf8'));
  assert.notEqual(after.runId, before.runId); assert.notEqual(after.items[0].claimId, before.items[0].claimId);
  assert.equal(after.cycle, before.cycle + 1); assert.equal(after.items[0].attemptNumber, 2);
  assert.equal(f.readLedger().items.A.runId, after.runId);
  assert.equal(f.readLedger().items.A.state, 'CLAIMED');
  assert.equal(JSON.parse(fs.readFileSync(freshScript, 'utf8')).runId, after.runId);
  assert.equal(fs.readFileSync(f.cfg.paths.runScript, 'utf8'), bytes);
});

test('telemetry report renders the fresh snapshot and excludes report events from its query window', async t => {
  const f = fixture(t);
  const prior = [
    { event: 'item_folded', cycle: 0, ts: '2026-09-01T00:00:00Z' },
    { event: 'item_folded', cycle: 0, ts: '2026-09-01T01:00:00Z' },
    { event: 'token_usage_snapshot', cycle: 0, ts: '2026-09-10T01:00:00Z' },
  ];
  f.context.readEvents = () => structuredClone(prior);
  let window;
  f.context.queryPrometheusTokenUsage = async (_cfg, since, until) => { window = [since, until]; return { inputTokens: 1, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, totalTokens: null, cacheHitRate: null, source: 'prometheus', scope: 'unfiltered-metric-window', selector: {} }; };
  await f.call('cmdTelemetryReport', {});
  assert.deepEqual(window, [Date.parse(prior[0].ts), Date.parse(prior[1].ts)]);
  const report = fs.readFileSync(join(f.cfg.paths.reports, 'telemetry-latest.md'), 'utf8');
  assert.match(report, /unfiltered-metric-window/); assert.match(report, /unknown/);
});

test('mount exclusion requires lexical and physical containment; product traversal still fails', t => {
  const f = fixture(t), host = join(f.root, 'host'), external = join(f.root, 'host-sibling');
  fs.mkdirSync(host); fs.mkdirSync(external); fs.mkdirSync(join(host, 'engine'));
  fs.symlinkSync(external, join(host, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(join(host, 'engine'), join(f.root, 'outside-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(join(host, 'engine'), join(host, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveRepoRoot(external, { FACTORY_REPO_ROOT: host }), host);
  assert.equal(containedMountRelative(host, external), null);
  assert.equal(containedMountRelative(host, host), null);
  assert.equal(containedMountRelative(host, join(host, 'escape')), null);
  assert.equal(containedMountRelative(host, join(f.root, 'outside-alias')), null);
  assert.equal(containedMountRelative(host, join(host, 'alias')), 'engine');
  fs.writeFileSync(join(host, 'owner.md'), 'owner edits');
  const dirty = { paths: ['owner.md', 'engine/runtime.json'], dirs: [] };
  assert.deepEqual(unclaimedMainDrift(dirty, null, [], { repoRoot: host }), dirty.paths);
  assert.deepEqual(unclaimedMainDrift(dirty, containedMountRelative(host, join(host, 'engine')), [], { repoRoot: host }), ['owner.md']);
  assert.throws(() => unclaimedMainDrift({ paths: ['../owner.md'], dirs: [] }, null, [], { repoRoot: host }), /escapes repository/);
  assert.throws(() => unclaimedMainDrift(dirty, null, ['../owner.md'], { repoRoot: host }), /escapes repository/);
  assert.throws(() => unclaimedMainDrift({ paths: ['escape/file.md'], dirs: [] }, null, [], { repoRoot: host }), /outside repository/);
});

test('actual CLI generates LF launchers from CRLF source and preserves replay with an external engine', t => {
  const parent = process.env.FACTORY_TEST_TMP_ROOT || (process.platform === 'win32' ? 'C:/Users/AYEFYM~1/AppData/Local/Temp/opencode' : tmpdir());
  const root = fs.mkdtempSync(join(parent, 'driver-launch-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const engine = join(root, 'external-engine'), host = join(root, 'host');
  fs.mkdirSync(engine); fs.mkdirSync(host);
  const repo = resolve(dirname(fileURLToPath(driverUrl)), '..');
  for (const dir of ['_workflow', 'config', 'agents']) fs.cpSync(join(repo, dir), join(engine, dir), { recursive: true });
  fs.copyFileSync(join(repo, 'VERSION'), join(engine, 'VERSION'));
  const factoryPath = join(engine, '_workflow/factory.js');
  const crlf = fs.readFileSync(factoryPath, 'utf8').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(factoryPath, crlf);
  for (const dir of ['objects', 'refs/heads']) fs.mkdirSync(join(host, '.git', dir), { recursive: true });
  fs.writeFileSync(join(host, '.git/HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(join(host, '.git/config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
  fs.writeFileSync(join(host, 'owner.md'), 'owner edits\r\n');
  const preload = join(root, 'process-boundary.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdirSync} from 'node:fs';
const real = cp.execFileSync;
cp.execFileSync = (file, args, opts) => {
  if (file === 'docker') throw new Error('fixture has no Docker');
  if (file !== 'git') throw new Error('Unexpected process ' + file);
  if (args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[4], {recursive:true}); return ''; }
  if (args.includes('sparse-checkout')) return '';
  if (args.includes('status')) return real(file, args, opts);
  if (args.includes('ls-files') || args.includes('log') || args.includes('diff')) return '';
  throw new Error('Unexpected git request ' + JSON.stringify(args));
};
syncBuiltinESMExports();
`);
  const state = join(engine, 'state');
  fs.mkdirSync(join(state, 'items'), { recursive: true });
  fs.mkdirSync(join(state, 'sweeps')); fs.mkdirSync(join(engine, 'reports')); fs.mkdirSync(join(engine, 'queue'));
  writeJsonAtomic(join(state, 'findings-graph.json'), { items: [item('A', { acceptance: 'Preserve literal $& and $` and $\' with CRLF\r\ntext.' }), item('B')] });
  const cli = (...args) => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(engine, '_workflow/driver.mjs'), ...args], {
      cwd: host, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, FACTORY_REPO_ROOT: host, FACTORY_CONTROLLER: 'launcher-fixture', FACTORY_TELEMETRY: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
    return result.stdout;
  };
  const checkLauncher = name => {
    const path = join(state, name), bytes = fs.readFileSync(path);
    assert.equal(bytes.includes(13), false, name + ' contains CR bytes');
    const args = JSON.parse(fs.readFileSync(path.replace('run-script', 'run-args').replace(/\.js$/, '.json'), 'utf8'));
    const injected = 'const __FACTORY_BATCH__ = ' + JSON.stringify(args) + ';';
    assert.ok(bytes.toString().includes(injected));
    assert.equal(bytes.toString().replace(injected, '/*__FACTORY_BATCH_INJECT__*/'), crlf.replace(/\r\n/g, '\n'));
    return args;
  };
  cli('init');
  cli('select', '--ids', 'A'); checkLauncher('run-script.js');
  cli('claim', 'A'); checkLauncher('run-script.js');
  cli('reset', 'A');
  cli('group', '--ids', 'A', '--label', 'crlf');
  const before = checkLauncher('run-script-crlf.js');
  const oldPath = join(state, 'run-script-crlf.js');
  fs.writeFileSync(oldPath, fs.readFileSync(oldPath, 'utf8').replace(/\n/g, '\r\n'));
  const replay = fs.readFileSync(oldPath);
  cli('resume'); assert.deepEqual(fs.readFileSync(oldPath), replay);
  cli('resume', '--reuse');
  const row = JSON.parse(fs.readFileSync(join(state, 'ledger.json'), 'utf8')).items.A;
  const fresh = checkLauncher(row.runScript.split(/[\\/]/).pop());
  assert.notEqual(fresh.runId, before.runId); assert.notEqual(fresh.items[0].claimId, before.items[0].claimId);
  assert.deepEqual(fs.readFileSync(oldPath), replay);
  writeJsonAtomic(join(state, 'sweeps/sweep-0.json'), { label: 'CRLF', sites: [{ findingId: 'B' }] });
  cli('sweep', '0'); checkLauncher('run-script-sweep-0.js');
  const ownerBefore = fs.readFileSync(join(host, 'owner.md')), ledgerBefore = fs.readFileSync(join(state, 'ledger.json'));
  for (const args of [['main-check', 'A'], ['main-check', '--all']]) {
    const output = cli(...args);
    assert.match(output, /MAIN-DRIFT unclaimed/); assert.match(output, /owner\.md/);
    assert.doesNotMatch(output, /check failed|SKIPPED/);
  }
  assert.deepEqual(fs.readFileSync(join(host, 'owner.md')), ownerBefore);
  assert.deepEqual(fs.readFileSync(join(state, 'ledger.json')), ledgerBefore);
  assert.equal(fs.readFileSync(factoryPath, 'utf8'), crlf);
});
