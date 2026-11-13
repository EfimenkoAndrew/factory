// KI-E236 — genuine BEHAVIORAL check of `integritySweepDecision` (driver.mjs), extracted via the
// SAME parenthesis-balanced source-extraction technique `_mainguard-driver-tests.mjs` already uses
// for cmdMainCheck/cmdFold (driver.mjs has no exports; this proves the REAL shipped function, not a
// re-derived string, so a future edit to the real logic cannot silently drift from what this asserts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFunction } from './lib/_mainguard-driver-tests.mjs';

const source = readFileSync(new URL('./driver.mjs', import.meta.url), 'utf8');
const code = extractFunction(source, 'integritySweepDecision');
const run = (...args) => new Function('return (' + code + ')(...arguments);')(...args);

const abs = (p) => p; // identity — the real driver.mjs abs() is repo-root resolution, irrelevant to this pure decision logic

test('no recoveryVerification recorded (a normal, non-recovery close) -> skip, never flagged as drift', () => {
  const result = run('ITEM-A', { worktree: '/wt/ITEM-A' }, {}, abs);
  assert.deepEqual(result, { status: 'skip', reason: 'no-evidence' });
});

test('recoveryVerification present but worktree gone (GC\'d) -> skip with an explicit message, never crashes', () => {
  const io = { existsSync: () => false, readJsonIfExists: () => { throw new Error('should not be called'); }, collectEvidenceIdentity: () => { throw new Error('should not be called'); } };
  const row = { worktree: '/wt/ITEM-B', recoveryVerification: { afterIdentity: '/x/after.json', metadataFile: '/x/meta.json' } };
  const result = run('ITEM-B', row, io, abs);
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'worktree-gone');
  assert.match(result.message, /SKIP ITEM-B: worktree gone/);
});

test('recorded evidence file missing on disk -> skip with an explicit message', () => {
  const io = { existsSync: () => true, readJsonIfExists: () => null, collectEvidenceIdentity: () => { throw new Error('should not be called'); } };
  const row = { worktree: '/wt/ITEM-C', recoveryVerification: { afterIdentity: '/x/after.json', metadataFile: '/x/meta.json' } };
  const result = run('ITEM-C', row, io, abs);
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'evidence-missing');
  assert.match(result.message, /SKIP ITEM-C: recorded evidence file missing/);
});

test('re-deriving the current identity throws (e.g. a corrupt worktree) -> skip, never propagates the exception', () => {
  const io = {
    existsSync: () => true,
    readJsonIfExists: () => ({ hash: 'irrelevant' }),
    collectEvidenceIdentity: () => { throw new Error('boom: unmerged index entry'); },
  };
  const row = { worktree: '/wt/ITEM-D', recoveryVerification: { afterIdentity: '/x/after.json', metadataFile: '/x/meta.json' } };
  const result = run('ITEM-D', row, io, abs);
  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'identity-error');
  assert.match(result.message, /boom: unmerged index entry/);
});

test('current hash matches the hash recorded at close time -> clean, no drift reported', () => {
  const io = {
    existsSync: () => true,
    readJsonIfExists: (p) => (p === '/x/after.json' ? { hash: 'same-hash-abc' } : { some: 'metadata' }),
    collectEvidenceIdentity: () => ({ hash: 'same-hash-abc' }),
  };
  const row = { worktree: '/wt/ITEM-E', recoveryVerification: { afterIdentity: '/x/after.json', metadataFile: '/x/meta.json' } };
  const result = run('ITEM-E', row, io, abs);
  assert.deepEqual(result, { status: 'clean' });
});

test('current hash DIFFERS from the hash recorded at close time -> drift, actionable message naming the item, close date and evidence path', () => {
  const io = {
    existsSync: () => true,
    readJsonIfExists: (p) => (p === '/x/after.json' ? { hash: 'original-hash-at-close' } : { some: 'metadata' }),
    collectEvidenceIdentity: () => ({ hash: 'different-hash-now' }), // simulates a silently-reverted file, e.g. a real production incident
  };
  const row = {
    worktree: '/wt/ITEM-F',
    recoveryVerification: { afterIdentity: '/x/after.json', metadataFile: '/x/meta.json', transcript: '/x/transcript.txt' },
    history: [{ to: 'GATED', at: '2026-08-01T00:00:00Z' }, { to: 'CLOSED', at: '2026-08-07T12:00:00Z' }],
  };
  const result = run('ITEM-F', row, io, abs);
  assert.equal(result.status, 'drift');
  assert.match(result.message, /INTEGRITY-DRIFT ITEM-F/);
  assert.match(result.message, /2026-08-07T12:00:00Z/, 'names the actual CLOSED transition date, not an earlier history entry');
  assert.match(result.message, /\/x\/after\.json/, 'points at the recorded evidence for a human to diff against');
  assert.match(result.message, /\/x\/transcript\.txt/, 'also points at the transcript when recorded');
  assert.match(result.message, /Do NOT auto-repair/i, 'never suggests self-repair — same posture as KI-E45\\/E89\\/E146');
});

test('drift message falls back to "unknown date" when no CLOSED history entry is recorded', () => {
  const io = {
    existsSync: () => true,
    readJsonIfExists: (p) => (p === '/x/after.json' ? { hash: 'h1' } : {}),
    collectEvidenceIdentity: () => ({ hash: 'h2' }),
  };
  const row = { worktree: '/wt/ITEM-G', recoveryVerification: { afterIdentity: '/x/after.json', metadataFile: '/x/meta.json' }, history: [] };
  const result = run('ITEM-G', row, io, abs);
  assert.equal(result.status, 'drift');
  assert.match(result.message, /unknown date/);
});
