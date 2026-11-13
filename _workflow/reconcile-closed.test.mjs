// KI-E452 — genuine BEHAVIORAL check of `reconcileClosedCandidates` (driver.mjs), extracted via the
// SAME parenthesis-balanced source-extraction technique `_mainguard-driver-tests.mjs` already uses
// for cmdMainCheck/cmdFold (driver.mjs has no exports; this proves the REAL shipped function, not a
// re-derived string, so a future edit to the real logic cannot silently drift from what this asserts).
//
// Root incident this guards against: three of four cycle-177 escalations (FLAGSVC-H-7, MEDIA-H12,
// CONFIG-H11-SHARED) each had an already-complete, all-gates-APPROVED CLOSED result.json sitting
// unfolded while the ledger still showed FAILED/ESCALATED/orphaned-CLAIMED — nothing detected this
// automatically; a human had to notice it by hand every time. This test pins the detection logic that
// now catches it, and pins every guard that keeps it from ever firing on something it shouldn't.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFunction } from './lib/_mainguard-driver-tests.mjs';

const source = readFileSync(new URL('./driver.mjs', import.meta.url), 'utf8');
const code = extractFunction(source, 'reconcileClosedCandidates');
const run = (...args) => new Function('return (' + code + ')(...arguments);')(...args);

const closedResult = (id, gates = { 'gate:developer': 'APPROVED', 'gate:qa': 'APPROVED' }) =>
  ({ id, toState: 'CLOSED', codeChange: true, gates });

function ledgerWith(items) {
  return { items };
}

test('a CLOSED item is never a candidate, even with a result.json lying around', () => {
  const ledger = ledgerWith({ A: { state: 'CLOSED' } });
  const result = run(ledger, () => closedResult('A'), null);
  assert.deepEqual(result, []);
});

test('a genuinely in-flight CLAIMED item (admitted:true) is never touched, even with a clean result', () => {
  const ledger = ledgerWith({ A: { state: 'CLAIMED', attemptIdentity: { admitted: true } } });
  const result = run(ledger, () => closedResult('A'), null);
  assert.deepEqual(result, [], 'a live run must never be preempted by the reconciler');
});

test('a READY item is never a candidate — only FAILED/ESCALATED/BLOCKED/orphaned-CLAIMED are eligible', () => {
  const ledger = ledgerWith({ A: { state: 'READY' } });
  const result = run(ledger, () => closedResult('A'), null);
  assert.deepEqual(result, []);
});

test('ESCALATED with no result.json at all -> not a candidate, readResult throwing never crashes the scan', () => {
  const ledger = ledgerWith({ A: { state: 'ESCALATED' } });
  const result = run(ledger, () => { throw new Error('ENOENT'); }, null);
  assert.deepEqual(result, []);
});

test('ESCALATED with a result.json that did NOT reach CLOSED -> not a candidate', () => {
  const ledger = ledgerWith({ A: { state: 'ESCALATED' } });
  const result = run(ledger, () => ({ id: 'A', toState: 'FAILED', codeChange: true, gates: { x: 'APPROVED' } }), null);
  assert.deepEqual(result, []);
});

test('ESCALATED with a CLOSED result but codeChange !== true (doc-only) -> excluded by design', () => {
  // Doc-only items have nothing machine-verifiable to re-run; they stay on the human recovery path.
  const ledger = ledgerWith({ A: { state: 'ESCALATED' } });
  const result = run(ledger, () => ({ id: 'A', toState: 'CLOSED', codeChange: false, gates: { x: 'APPROVED' } }), null);
  assert.deepEqual(result, []);
});

test('ESCALATED with a CLOSED result but ANY gate is not APPROVED -> real dissent, needs a human, never auto', () => {
  const ledger = ledgerWith({ A: { state: 'ESCALATED' } });
  const result = run(ledger, () => closedResult('A', { 'gate:developer': 'APPROVED', 'gate:qa': 'CHANGES_REQUIRED' }), null);
  assert.deepEqual(result, []);
});

test('ESCALATED with a CLOSED result and an EMPTY gates map -> not a candidate (no evidence of real review)', () => {
  const ledger = ledgerWith({ A: { state: 'ESCALATED' } });
  const result = run(ledger, () => closedResult('A', {}), null);
  assert.deepEqual(result, []);
});

test('result.id mismatch against the requested item id -> rejected defensively, never a candidate', () => {
  const ledger = ledgerWith({ A: { state: 'ESCALATED' } });
  const result = run(ledger, () => closedResult('B'), null); // wrong id inside the file
  assert.deepEqual(result, []);
});

test('THE REAL INCIDENT SHAPE: ESCALATED + complete CLOSED + all gates APPROVED -> IS a candidate (FLAGSVC-H-7/MEDIA-H12 shape)', () => {
  const ledger = ledgerWith({ 'FLAGSVC-H-7': { state: 'ESCALATED' } });
  const result = run(ledger, () => closedResult('FLAGSVC-H-7'), null);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'FLAGSVC-H-7');
  assert.equal(result[0].result.toState, 'CLOSED');
});

test('an ORPHANED CLAIMED (admitted:false) with a clean matching result -> IS a candidate (CONFIG-H11-SHARED shape)', () => {
  const ledger = ledgerWith({ 'CONFIG-H11-SHARED': { state: 'CLAIMED', attemptIdentity: { admitted: false, startedAt: null } } });
  const result = run(ledger, () => closedResult('CONFIG-H11-SHARED'), null);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'CONFIG-H11-SHARED');
});

test('BLOCKED and FAILED are also eligible states, same as ESCALATED', () => {
  const ledger = ledgerWith({ A: { state: 'BLOCKED' }, B: { state: 'FAILED' } });
  const result = run(ledger, (id) => closedResult(id), null);
  assert.deepEqual(result.map((r) => r.id).sort(), ['A', 'B']);
});

test('the --ids filter (only) restricts the scan to exactly the named items', () => {
  const ledger = ledgerWith({ A: { state: 'ESCALATED' }, B: { state: 'ESCALATED' }, C: { state: 'ESCALATED' } });
  const result = run(ledger, (id) => closedResult(id), new Set(['B']));
  assert.deepEqual(result.map((r) => r.id), ['B']);
});

test('multiple eligible items are all returned, each paired with its own result', () => {
  const ledger = ledgerWith({
    'FLAGSVC-H-7': { state: 'ESCALATED' },
    'MEDIA-H12': { state: 'ESCALATED' },
    'CONFIG-H11-SHARED': { state: 'CLAIMED', attemptIdentity: { admitted: false, startedAt: null } },
    'ERIKA-H8': { state: 'CLOSED' }, // already closed — must NOT reappear
  });
  const result = run(ledger, (id) => closedResult(id), null);
  assert.deepEqual(result.map((r) => r.id).sort(), ['CONFIG-H11-SHARED', 'FLAGSVC-H-7', 'MEDIA-H12']);
});
