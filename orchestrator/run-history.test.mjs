// KI-E307 — behavioral guard for the cumulative run-history index + dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordRuns, renderFactoryReport, gatePassed } from './run-history.mjs';

function seed(root, id, result, ledgerState) {
  mkdirSync(join(root, 'state', 'items', id), { recursive: true });
  writeFileSync(join(root, 'state', 'items', id, 'result.json'), JSON.stringify(result));
  const lp = join(root, 'state', 'ledger.json');
  const l = existsSync(lp) ? JSON.parse(readFileSync(lp, 'utf8')) : { items: {}, cycle: 1 };
  l.items[id] = { state: ledgerState, attempts: 1 };
  writeFileSync(lp, JSON.stringify(l));
}

test('recordRuns appends one line per folded item and dedups by resultId', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-'));
  try {
    seed(root, 'A-1', { resultId: 'A-1#1', toState: 'FAILED', band: 'FULL', attemptsDelta: 1, tokensUsed: 1000, fixSteps: 2, filesChanged: ['x'], gates: { 'probe:docsync-scan': 'CHANGES_REQUIRED', nfr: 'APPROVED' }, transitions: ['RED', 'GREEN', 'FAILED'] }, 'FAILED');
    seed(root, 'B-1', { resultId: 'B-1#1', toState: 'CLOSED', band: 'FULL', attemptsDelta: 1, tokensUsed: 500, gates: { nfr: 'APPROVED' } }, 'CLOSED');
    assert.equal(recordRuns(root, ['A-1', 'B-1']), 2, 'two runs recorded');
    assert.equal(recordRuns(root, ['A-1', 'B-1']), 0, 'idempotent — no duplicate lines on a re-record');
    const lines = readFileSync(join(root, 'reports', 'runs.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).decisiveGate, 'probe:docsync-scan', 'a FAILED run records the rejecting gate');
    assert.equal(JSON.parse(lines[1]).decisiveGate, null, 'a CLOSED run has no decisive gate');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renderFactoryReport produces the dashboard sections incl. gate histogram + stuck items', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-'));
  try {
    seed(root, 'A-1', { resultId: 'A-1#1', toState: 'FAILED', tokensUsed: 1000, gates: { 'probe:docsync-scan': 'CHANGES_REQUIRED' } }, 'FAILED');
    recordRuns(root, ['A-1']);
    seed(root, 'A-1', { resultId: 'A-1#2', toState: 'FAILED', tokensUsed: 1100, gates: { 'probe:docsync-scan': 'CHANGES_REQUIRED' } }, 'FAILED');
    recordRuns(root, ['A-1']);
    const md = readFileSync(renderFactoryReport(root), 'utf8');
    for (const re of [/# Factory Report/, /## Ledger state/, /## Throughput/, /Gates that reject fixes most/, /probe:docsync-scan/, /Stuck items/, /## Recent runs/]) {
      assert.match(md, re);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KI-E313: recordRuns reports the fold OVERRIDE (ledger FAILED), not the agent claim (result CLOSED)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rh-'));
  try {
    mkdirSync(join(root, 'state', 'items', 'X-1'), { recursive: true });
    writeFileSync(join(root, 'state', 'items', 'X-1', 'result.json'), JSON.stringify({ resultId: 'X-1#1', toState: 'CLOSED', gates: { reaudit: 'CHANGES_REQUIRED' } }));
    // ledger: fold overrode CLAIMED→FAILED, then autoFix reset FAILED→READY (the H-2 shape).
    writeFileSync(join(root, 'state', 'ledger.json'), JSON.stringify({ items: { 'X-1': { state: 'READY', history: [{ from: 'CLAIMED', to: 'FAILED', note: 'deterministic fold-time override' }, { from: 'FAILED', to: 'READY', note: 'reset/un-claim' }] } }, cycle: 1 }));
    recordRuns(root, ['X-1']);
    const rec = JSON.parse(readFileSync(join(root, 'reports', 'runs.jsonl'), 'utf8').trim());
    assert.equal(rec.toState, 'FAILED', 'records the fold override (last terminal transition), not the agent claim');
    assert.equal(rec.claimedState, 'CLOSED', 'preserves the agent claim for the record');
    assert.equal(rec.overrode, true, 'flags that the fold overrode the claim');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KI-E315: gatePassed treats APPROVED + reaudit "code=ok security=ok" as passing, rejections as not', () => {
  assert.equal(gatePassed('APPROVED'), true);
  assert.equal(gatePassed('code=ok security=ok'), true, 'reaudit compound-ok verdict passes');
  assert.equal(gatePassed('CHANGES_REQUIRED'), false);
  assert.equal(gatePassed('code=FAIL security=ok'), false, 'a reaudit with a failing dimension does not pass');
});
