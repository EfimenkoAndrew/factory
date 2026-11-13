// KI-E455 — genuine BEHAVIORAL check of `backfillTrackers` (driver.mjs), extracted via the SAME
// parenthesis-balanced source-extraction technique `_mainguard-driver-tests.mjs` already uses for
// cmdMainCheck/cmdFold and reconcile-closed.test.mjs uses for reconcileClosedCandidates (driver.mjs
// has no exports; this proves the REAL shipped function, not a re-derived string, so a future edit
// to the real logic cannot silently drift from what this asserts).
//
// Root incident this guards against: a KI-E453 recovery (`driver.mjs reconstruct` + `fold`) folded
// ITEM-A/ITEM-B cleanly into the ledger, but hillClimb/bandit/simulatedAnnealing/retrospective/
// zero-closure-streak never saw it — those trackers only updated inside orchestrate.mjs's own
// normal per-lane loop, which a manual recovery path bypasses entirely. This test pins the decision
// logic that now closes that gap (and the opt-out that keeps orchestrate.mjs's own call site from
// double-counting), using fully injected dependencies — no real subprocess, no real filesystem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFunction } from './lib/_mainguard-driver-tests.mjs';

const source = readFileSync(new URL('./driver.mjs', import.meta.url), 'utf8');
const code = extractFunction(source, 'backfillTrackers');
const run = (...args) => new Function('return (' + code + ')(...arguments);')(...args);

function fakeDeps() {
  const calls = { writeJsonAtomic: [], unlinkSync: [], execFileSync: [], logs: [] };
  return {
    calls,
    deps: {
      writeJsonAtomic: (path, data) => calls.writeJsonAtomic.push({ path, data }),
      unlinkSync: (path) => calls.unlinkSync.push(path),
      execFileSync: (cmd, args, opts) => { calls.execFileSync.push({ cmd, args, opts }); return 'backfill-trackers (KI-E455): fed 2 applied result(s)\n'; },
      randomUUID: () => 'fixed-uuid-1234',
      join: (...parts) => parts.join('/'),
      factoryRoot: '/fake/factory/root',
      log: (s) => calls.logs.push(s),
    },
  };
}

test('skips entirely when --skip-tracker-update is passed, even with applied results', () => {
  const { calls, deps } = fakeDeps();
  const applied = [{ id: 'A-1', toState: 'CLOSED' }];
  const didRun = run({ 'skip-tracker-update': true }, applied, deps);
  assert.equal(didRun, false, 'reports it did not run');
  assert.equal(calls.execFileSync.length, 0, 'never spawns the backfill subprocess');
  assert.equal(calls.writeJsonAtomic.length, 0, 'never writes a payload file');
});

test('skips entirely when nothing was applied this fold', () => {
  const { calls, deps } = fakeDeps();
  const didRun = run({}, [], deps);
  assert.equal(didRun, false);
  assert.equal(calls.execFileSync.length, 0);
});

test('runs by default (no flag) when results were applied, and cleans up its payload file', () => {
  const { calls, deps } = fakeDeps();
  const applied = [{ id: 'ITEM-A', toState: 'CLOSED' }, { id: 'ITEM-B', toState: 'CLOSED' }];
  const didRun = run({}, applied, deps);
  assert.equal(didRun, true, 'reports it ran');
  assert.equal(calls.writeJsonAtomic.length, 1, 'writes exactly one payload file');
  assert.deepEqual(calls.writeJsonAtomic[0].data.ids, ['ITEM-A', 'ITEM-B'], 'payload carries the applied ids');
  assert.deepEqual(calls.writeJsonAtomic[0].data.applied, applied, 'payload carries the full applied result objects (postBatchFailureAnalysis needs the rich shape)');
  assert.equal(calls.execFileSync.length, 1, 'spawns exactly one subprocess');
  assert.equal(calls.execFileSync[0].cmd, 'node');
  assert.deepEqual(calls.execFileSync[0].args.slice(1), ['backfill-trackers', calls.writeJsonAtomic[0].path], 'invokes orchestrate.mjs backfill-trackers with the SAME payload path it just wrote');
  assert.ok(calls.execFileSync[0].args[0].endsWith('orchestrator/orchestrate.mjs'), 'targets orchestrate.mjs, not driver.mjs itself (the functions live there)');
  assert.equal(calls.unlinkSync.length, 1, 'cleans up the temp payload file');
  assert.equal(calls.unlinkSync[0], calls.writeJsonAtomic[0].path, 'cleans up the SAME file it wrote, not a different path');
  assert.ok(calls.logs.some((l) => l.includes('fed 2 applied result')), 'surfaces the subprocess output to the caller');
});

test('a subprocess failure is logged and swallowed — never thrown — and the payload file is still cleaned up', () => {
  const { calls, deps } = fakeDeps();
  deps.execFileSync = () => { throw new Error('orchestrate.mjs exited 1'); };
  const applied = [{ id: 'X-1', toState: 'FAILED' }];
  assert.doesNotThrow(() => run({}, applied, deps));
  const didRun = run({}, applied, deps);
  assert.equal(didRun, true, 'still reports it attempted the backfill');
  assert.ok(calls.logs.some((l) => l.includes('non-fatal') && l.includes('KI-E455')), 'logs the failure non-fatally');
  assert.equal(calls.unlinkSync.length, 2, 'cleanup still runs on both calls despite the thrown error (finally block)');
});

test('a payload-write failure is also swallowed, not thrown', () => {
  const { calls, deps } = fakeDeps();
  deps.writeJsonAtomic = () => { throw new Error('disk full'); };
  const applied = [{ id: 'Y-1', toState: 'CLOSED' }];
  assert.doesNotThrow(() => run({}, applied, deps));
  assert.equal(calls.execFileSync.length, 0, 'never spawns the subprocess when the payload could not be written');
  assert.ok(calls.logs.some((l) => l.includes('non-fatal')));
});
