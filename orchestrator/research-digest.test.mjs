// KI-E359 — behavioral guard for the research-digest module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeResearchProposals, runResearchDigest } from './research-digest.mjs';

test('computeResearchProposals generates reflexion proposal when items fail 2+ times', () => {
  const runs = [
    { id: 'X-1', toState: 'FAILED', decisiveGate: 'gate:developer', stageCount: 8 },
    { id: 'X-1', toState: 'FAILED', decisiveGate: 'gate:developer', stageCount: 9 },
    { id: 'X-2', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 7 },
    { id: 'X-2', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 8 },
    { id: 'X-3', toState: 'CLOSED', stageCount: 4 },
  ];
  const ledger = {
    items: {
      'X-1': { state: 'FAILED', attempts: 2 },
      'X-2': { state: 'FAILED', attempts: 2 },
      'X-3': { state: 'CLOSED', attempts: 1 },
    },
  };
  const config = {};
  const stateDir = mkdtempSync(join(tmpdir(), 'rd-state-'));
  try {
    const props = computeResearchProposals(runs, ledger, config, stateDir);
    assert.ok(props.some((p) => p.key === 'reflexion:failed-no-reflection'), 'reflexion proposal generated for multi-failure items');
    assert.ok(props.every((p) => typeof p.impact === 'number'), 'all proposals have numeric impact');
    assert.ok(props.length >= 1, 'at least one proposal returned');
    // proposals must be sorted by impact descending
    for (let i = 0; i < props.length - 1; i++) {
      assert.ok(props[i].impact >= props[i + 1].impact, 'proposals sorted by impact descending');
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('computeResearchProposals generates architect ToT proposal when architect-gate fails frequently', () => {
  const runs = Array.from({ length: 10 }, (_, i) => ({
    id: `A-${i}`,
    toState: 'FAILED',
    decisiveGate: 'gate:architect',
    stageCount: 6,
  }));
  const ledger = { items: Object.fromEntries(runs.map((r) => [r.id, { state: 'FAILED', attempts: 1 }])) };
  const props = computeResearchProposals(runs, ledger, {}, mkdtempSync(join(tmpdir(), 'rd-')));
  const totProp = props.find((p) => p.key === 'tot:plan-branching');
  assert.ok(totProp, 'ToT plan-branching proposal generated when architect failures are high');
  assert.ok(totProp.impact >= 30, 'ToT proposal has meaningful impact score');
});

test('implementation-completeness proposal names affected item ids, not "[object Object]" (regression)', () => {
  // KI-E359 bug: the NO-PRODUCTION-CODE branch interpolated the raw run-object array
  // (baselineAbsent) instead of the deduped id array (baselineItems) into the detail string,
  // so every affected-items list rendered the literal string "[object Object]".
  const runs = [
    { id: 'NOPROD-1', toState: 'FAILED', overrideReason: 'fold-override:verify-baseline-absent', stageCount: 6 },
    { id: 'PHANTOM-1', toState: 'FAILED', overrideReason: 'fold-override:phantom-manifest', stageCount: 5 },
  ];
  const ledger = { items: { 'NOPROD-1': { state: 'FAILED', attempts: 1 }, 'PHANTOM-1': { state: 'FAILED', attempts: 1 } } };
  const stateDir = mkdtempSync(join(tmpdir(), 'rd-notdone-'));
  try {
    const props = computeResearchProposals(runs, ledger, {}, stateDir);
    const p = props.find((pr) => pr.key === 'implementation-completeness:not-done-pattern');
    assert.ok(p, 'proposal generated when a not-done override fires');
    assert.ok(!p.detail.includes('[object Object]'), 'detail never renders a raw object as text');
    assert.ok(p.detail.includes('NOPROD-1'), 'the NO-PRODUCTION-CODE affected-items list names the real item id');
    assert.ok(p.detail.includes('PHANTOM-1'), 'the PHANTOM MANIFEST affected-items list names the real item id');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runResearchDigest writes RESEARCH-DIGEST.md and queues fresh proposals, deduplicating on second run', () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-full-'));
  try {
    mkdirSync(join(root, 'reports'), { recursive: true });
    mkdirSync(join(root, 'state'), { recursive: true });
    mkdirSync(join(root, 'queue'), { recursive: true });
    mkdirSync(join(root, 'config'), { recursive: true });

    const runs = [
      { id: 'Y-1', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 7 },
      { id: 'Y-1', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 8 },
      { id: 'Y-1', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 9 },
      { id: 'Y-2', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 6 },
      { id: 'Y-2', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 7 },
      { id: 'Y-2', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 8 },
      { id: 'Y-3', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 5 },
      { id: 'Y-3', toState: 'FAILED', decisiveGate: 'gate:architect', stageCount: 6 },
      { id: 'Y-4', toState: 'CLOSED', stageCount: 3 },
    ];
    writeFileSync(
      join(root, 'reports', 'runs.jsonl'),
      runs.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    writeFileSync(join(root, 'state', 'ledger.json'), JSON.stringify({
      items: {
        'Y-1': { state: 'FAILED', attempts: 3 },
        'Y-2': { state: 'FAILED', attempts: 3 },
        'Y-3': { state: 'FAILED', attempts: 2 },
        'Y-4': { state: 'CLOSED', attempts: 1 },
      },
    }));
    writeFileSync(join(root, 'config', 'orchestrator.config.json'), JSON.stringify({}));

    // First run — should produce proposals + queue file
    const r1 = runResearchDigest(root);
    assert.ok(r1.proposals.length >= 1, 'first run produces at least one proposal');
    assert.ok(r1.fresh >= 1, 'first run queues at least one fresh proposal');
    assert.ok(existsSync(join(root, 'reports', 'RESEARCH-DIGEST.md')), 'RESEARCH-DIGEST.md written');
    const queueFiles1 = readdirSync(join(root, 'queue')).filter((f) => f.startsWith('factory-improvement-research-'));
    assert.ok(queueFiles1.length >= 1, 'queue file written on first run');

    // Second run — may queue remaining proposals (queue is capped at 2/run, so a 3rd proposal can fire here).
    // Third run with same data — all proposals seen, fresh=0.
    runResearchDigest(root);
    const r3 = runResearchDigest(root);
    assert.strictEqual(r3.fresh, 0, 'third run deduplicates — all proposals already queued');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runResearchDigest is graceful with empty runs and no ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-empty-'));
  try {
    mkdirSync(join(root, 'reports'), { recursive: true });
    mkdirSync(join(root, 'state'), { recursive: true });
    mkdirSync(join(root, 'queue'), { recursive: true });
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'orchestrator.config.json'), JSON.stringify({}));
    // No runs.jsonl, no ledger.json — structural checks (calibration) may still fire.
    const r = runResearchDigest(root);
    assert.ok(typeof r.proposals === 'object', 'returns proposals array');
    assert.ok(r.fresh >= 0, 'fresh count is non-negative');
    assert.ok(existsSync(join(root, 'reports', 'RESEARCH-DIGEST.md')), 'digest report still written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
