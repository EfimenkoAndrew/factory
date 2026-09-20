import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shadowEligible } from './shadow-scan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'shadow-scan-'));
const ids = [];
const run = args => execFileSync(process.execPath, [join(root, '_workflow/opencode/runtime.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, FACTORY_TELEMETRY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  for (const mode of ['approved', 'mixed', 'negative', 'disagreement', 'unavailable', 'changed-feedback', 'snapshot-unavailable', 'policy-off', 'pooled-failure']) {
    const id = 'SHADOW-' + process.pid + '-' + mode; ids.push(id);
    const dir = join(root, 'state/items', id), fx = join(temp, 'fixture.json');
    writeFileSync(fx, JSON.stringify({ item: { id, target: 'Fixture', fixType: 'mechanical', severity: 'HIGH', theme: 'docs', files: ['README.md'], acceptance: 'Invalid input is rejected; valid input is accepted.' }, worktreePath: temp, cycle: 1 }));
    run(['init', id, '--fixture', fx]);
    const path = join(dir, 'opencode-progress.json'), p = JSON.parse(readFileSync(path));
    p.phase = 'acceptance'; p.reFix = true; p.policies.shadowConsolidatedScan = mode !== 'policy-off';
    p.plan = { approach: 'MUST validate input', steps: ['Reject invalid input before processing', 'Accept valid input without changing it'] };
    if (mode === 'snapshot-unavailable') p.shadowPackReady = false;
    writeFileSync(join(dir, 'review-pack.md'), 'FROZEN PRE-AMENDMENT DIFF');
    writeFileSync(join(dir, 'feedback.md'), 'Current rejection: invalid input is still processed');
    if (mode === 'pooled-failure') p.phase = 'plan_review';
    writeFileSync(path, JSON.stringify(p));
    const next = JSON.parse(run(['next', id]));
    if (mode === 'policy-off') {
      assert.equal(shadowEligible(p), false); assert.equal(next.agents.length, 1); assert.equal(next.agents[0].role, 'acceptance-probe'); continue;
    }
    if (mode === 'snapshot-unavailable') {
      const sample = JSON.parse(readFileSync(join(dir, 'shadow-scan.json')));
      assert.equal(sample.verdict, 'SKIPPED'); assert.equal(Object.keys(sample.axes).length, 3);
      assert.ok(Object.values(sample.axes).every(a => a.separate === null && a.consolidated === null));
      assert.equal(next.agents.length, 1); assert.equal(next.agents[0].role, 'acceptance-probe'); continue;
    }
    if (mode === 'pooled-failure') {
      run(['fail', id, '--dispatch', next.agents[0].dispatchId, '--reason', 'settled worker failure']);
      const draining = JSON.parse(readFileSync(path));
      assert.equal(draining.phase, 'plan_review'); assert.equal(draining.pendingSet.calls.length, 2);
      const remaining = JSON.parse(run(['next', id])); assert.equal(remaining.agents.length, 1);
      const answer = join(temp, 'answer.json'); writeFileSync(answer, '{"honored":true}');
      run(['submit', id, '--role', remaining.agents[0].key, '--dispatch', remaining.agents[0].dispatchId, '--json', answer]);
      const final = JSON.parse(readFileSync(path)); assert.equal(final.phase, 'done'); assert.equal(final.res.failureKind, 'agent-unavailable');
      continue;
    }
    assert.equal(next.agents.length, 4);
    const initial = JSON.parse(readFileSync(path)); assert.equal(initial.phase, 'shadow_scan');
    assert.equal(initial.shadowSnapshot.beforeAmendment, true);
    for (const call of next.agents) {
      const prompt = JSON.parse(readFileSync(call.promptRef)).prompt;
      assert.match(prompt, /CURRENT worktree|CURRENT snapshot|current snapshot/);
      assert.doesNotMatch(prompt, /separate.*CHANGES_REQUIRED/);
      if (mode === 'unavailable' && call.role === 'consolidated-scan-shadow') {
        run(['fail', id, '--dispatch', call.dispatchId, '--reason', 'settled malformed output']); continue;
      }
      const result = call.role === 'consolidated-scan-shadow' ? { acceptanceCovered: ['approved', 'disagreement'].includes(mode), planHonored: mode !== 'negative', findingHonored: mode === 'approved' }
        : call.role === 'acceptance-probe' ? { covered: mode === 'approved' }
          : { honored: mode === 'approved' || call.role === 'plan-commitment-probe' && mode !== 'negative' };
      const answer = join(temp, 'answer.json'); writeFileSync(answer, JSON.stringify(result));
      run(['submit', id, '--role', call.key, '--dispatch', call.dispatchId, '--json', answer]);
      if (mode === 'changed-feedback' && call.role === 'acceptance-probe') writeFileSync(join(dir, 'feedback.md'), 'Different feedback after one original probe');
    }
    const after = JSON.parse(readFileSync(path)), sample = JSON.parse(readFileSync(join(dir, 'shadow-scan.json')));
    assert.equal(after.phase, 'acceptance'); assert.deepEqual(after.res.transitions, initial.res.transitions);
    assert.equal(after.res.toState, initial.res.toState);
    assert.equal(sample.verdict, ['unavailable', 'changed-feedback'].includes(mode) ? 'SKIPPED' : mode === 'disagreement' ? 'DISAGREE' : 'AGREE');
    assert.equal(sample.axes.acceptanceCovered.separate, mode === 'approved'); assert.equal(sample.axes.findingHonored.separate, mode === 'approved');
    assert.equal(sample.axes.planHonored.separate, mode !== 'negative');
    assert.equal(sample.snapshotId, initial.shadowSnapshot.snapshotId);
    if (mode === 'changed-feedback') {
      assert.ok(Object.values(sample.axes).every(a => a.verdict === 'SKIPPED'));
      assert.equal(after.initialScans, undefined);
      assert.equal(JSON.parse(run(['next', id])).agents[0].role, 'acceptance-probe'); continue;
    }
    if (mode === 'approved') {
      const continued = JSON.parse(run(['next', id]));
      assert.ok(continued.agents.every(c => !['acceptance-probe', 'plan-commitment-probe'].includes(c.role)));
      const accepted = JSON.parse(readFileSync(path));
      assert.equal(accepted.res.gates['probe:acceptance-scan'], 'APPROVED');
      assert.equal(accepted.res.gates['probe:plan-commitment-scan'], 'APPROVED');
      assert.equal(accepted.history.filter(h => h.event === 'scan-reused').length, 2);
      continue;
    }
    assert.equal(JSON.parse(run(['next', id])).agents[0].role, 'fixer', 'original negative acceptance result drives amendment without duplicate scan');
    const reused = JSON.parse(readFileSync(path));
    assert.equal(reused.phase, 'acceptance_amend');
    assert.ok(reused.history.some(h => h.event === 'scan-reused' && h.role === 'acceptance-probe'));
    const amend = reused.pendingSet.calls[0], answer = join(temp, 'amend.json');
    writeFileSync(answer, '{"applied":false,"scopeStop":false,"summary":"explained","note":"note-only amendment still invalidates cached scans"}');
    run(['submit', id, '--role', amend.key, '--dispatch', amend.dispatchId, '--json', answer]);
    assert.equal(JSON.parse(readFileSync(path)).initialScans, undefined);
  }
  console.log('Shadow CLI: mixed/negative frozen pre-amendment axes, policy off, unavailable fail-open, independent authoritative continuation and pooled failure drain passed');
} finally {
  for (const id of ids) rmSync(join(root, 'state/items', id), { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
}
