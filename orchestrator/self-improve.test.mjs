// KI-E309 — behavioral guard for the self-improvement analyzer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeProposals, analyzeSelfImprovement } from './self-improve.mjs';

test('computeProposals flags a dominant rejecting gate and a stuck item, ranked by impact', () => {
  const runs = [
    { id: 'A-1', toState: 'FAILED', decisiveGate: 'probe:docsync-scan', tokensUsed: 1000 },
    { id: 'A-1', toState: 'FAILED', decisiveGate: 'probe:docsync-scan', tokensUsed: 1100 },
    { id: 'B-1', toState: 'FAILED', decisiveGate: 'probe:docsync-scan', tokensUsed: 900 },
    { id: 'C-1', toState: 'CLOSED', tokensUsed: 500 },
  ];
  const ledger = { items: { 'A-1': { state: 'FAILED' }, 'B-1': { state: 'FAILED' }, 'C-1': { state: 'CLOSED' } } };
  const props = computeProposals(runs, ledger);
  assert.ok(props.some((p) => p.key === 'gate:probe:docsync-scan'), 'dominant rejecting gate is proposed');
  assert.ok(props.some((p) => p.key === 'stuck:A-1'), 'the item stuck on the same gate is proposed');
  assert.ok(props[0].impact >= props[props.length - 1].impact, 'proposals are impact-ranked');
});

test('analyzeSelfImprovement writes the backlog + queues fresh proposals once (dedup on second pass)', () => {
  const root = mkdtempSync(join(tmpdir(), 'si-'));
  try {
    mkdirSync(join(root, 'reports'), { recursive: true });
    mkdirSync(join(root, 'state'), { recursive: true });
    const runs = [
      { id: 'A-1', toState: 'FAILED', decisiveGate: 'probe:docsync-scan' },
      { id: 'A-1', toState: 'FAILED', decisiveGate: 'probe:docsync-scan' },
      { id: 'B-1', toState: 'FAILED', decisiveGate: 'probe:docsync-scan' },
    ];
    writeFileSync(join(root, 'reports', 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(root, 'state', 'ledger.json'), JSON.stringify({ items: { 'A-1': { state: 'FAILED' }, 'B-1': { state: 'FAILED' } }, cycle: 1 }));
    const r1 = analyzeSelfImprovement(root);
    assert.ok(r1.fresh >= 1, 'queued at least one proposal');
    assert.ok(existsSync(join(root, 'reports', 'SELF-IMPROVEMENT.md')), 'backlog report written');
    assert.match(readFileSync(join(root, 'reports', 'SELF-IMPROVEMENT.md'), 'utf8'), /Self-Improvement Backlog/);
    assert.ok(readdirSync(join(root, 'queue')).some((f) => f.startsWith('factory-improvement-')), 'queue file written');
    const r2 = analyzeSelfImprovement(root);
    assert.equal(r2.fresh, 0, 'dedup — the same findings are not re-queued on a second pass');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// KI-E454 — recency decay. Live incident this codified: "infra:no-verdict" sat at impact 80
// (20 occurrences) for weeks after ~19 of those 20 had aged out, because raw counts never decay.
test('computeProposals: a mostly-old occurrence count is outranked by a smaller, mostly-recent one', () => {
  const NOW = Date.UTC(2026, 10, 8); // fixed, deterministic "now" — 2026-11-08
  const DAY = 86400000;
  const oldRun = (id, daysAgo) => ({ id, toState: 'FAILED', decisiveGate: null, overrode: false, ts: new Date(NOW - daysAgo * DAY).toISOString() });
  // Stale pattern: 20 occurrences, 19 from ~35 days ago (long decayed), 1 from yesterday.
  const staleRuns = [...Array.from({ length: 19 }, (_, i) => oldRun(`STALE-${i}`, 35)), oldRun('STALE-19', 1)];
  // Fresh pattern: only 6 occurrences, but ALL from yesterday — same shape (no decisiveGate, no override).
  const freshRuns = Array.from({ length: 6 }, (_, i) => oldRun(`FRESH-${i}`, 1));
  const closedPadding = Array.from({ length: 30 }, (_, i) => ({ id: `PAD-${i}`, toState: 'CLOSED', ts: new Date(NOW - 1 * DAY).toISOString() }));
  const ledger = { items: {} };

  const staleProps = computeProposals([...staleRuns, ...closedPadding], ledger, null, NOW);
  const stale = staleProps.find((p) => p.key === 'infra:no-verdict');
  const freshProps = computeProposals([...freshRuns, ...closedPadding], ledger, null, NOW);
  const fresh = freshProps.find((p) => p.key === 'infra:no-verdict');
  assert.ok(stale && fresh, 'both scenarios produce the infra:no-verdict proposal');
  assert.ok(fresh.impact > stale.impact, `6 recent occurrences (impact ${fresh.impact}) should outrank 20 mostly-month-old ones (impact ${stale.impact})`);

  // Without decay (now far in the future of everything, so all weights ~0) the raw count would have won:
  // sanity-check the decay actually moved the needle, not just zeroed both out.
  assert.ok(stale.impact > 0 && fresh.impact > 0, 'decayed impact is still positive, not collapsed to zero');
});

test('computeProposals: recency decay is a pure function of `now` — no wall-clock dependency', () => {
  const ts = new Date(Date.UTC(2026, 9, 1)).toISOString();
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `X-${i}`, toState: 'FAILED', decisiveGate: null, overrode: false, ts }));
  const ledger = { items: {} };
  const now = Date.UTC(2026, 9, 1); // same instant as ts — zero age
  const a = computeProposals(runs, ledger, null, now);
  const b = computeProposals(runs, ledger, null, now);
  assert.deepEqual(a, b, 'identical (runs, ledger, now) inputs produce byte-identical output');
});

test('computeProposals: a run with no `ts` gets full weight (never silently zeroed)', () => {
  const now = Date.now();
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `Y-${i}`, toState: 'FAILED', decisiveGate: null, overrode: false })); // no ts at all
  const ledger = { items: {} };
  const props = computeProposals(runs, ledger, null, now);
  const infra = props.find((p) => p.key === 'infra:no-verdict');
  assert.ok(infra, 'proposal still fires for timestamp-less runs');
  assert.equal(infra.impact, 20, 'no-ts runs behave exactly like the pre-KI-E454 raw count (5 * 4 = 20)');
});
