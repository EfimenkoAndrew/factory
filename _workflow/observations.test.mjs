import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { makeObservation, validateObservation, aggregateObservations, observationEvent, renderObservationReport, adaptNativeAttemptObservation, normalizeAttemptObservations } from './lib/observations.mjs';
import { aggregateEvents, renderTelemetryReport } from './lib/telemetry.mjs';
import { parseTokenUsageVector, tokenUsageSummary, cacheHitRate, buildTokenUsageQuery } from './lib/token-usage.mjs';
import { projectedCalls, projectedCallBreakdown } from './lib/band-cost.mjs';
import { freezeExperiment, validateFrozenExperiment, blindPacket, reportExperiment, renderExperimentReport } from './lib/calibration.mjs';
import { observationFixture, experimentFixture } from './fixtures/calibration-synthetic.mjs';
import { main } from './calibrate.mjs';
import { nativeObservationFixture } from './fixtures/observation-producers.mjs';
import { dispatchObservation } from './opencode/observations.mjs';
import { admitAttempt, lifecycleObservation, observe, observeAdmission, observePhysical } from './lib/driver-integration.mjs';
import { execSmoke, smokeBatch } from './lib/_execsmoke.mjs';

test('current native source -> checkpoint/final snapshots -> normalizer -> report matches physical calls', async (t) => {
  const docs = readFileSync(new URL('./CALIBRATION.md', import.meta.url), 'utf8');
  for (const [kind, band, conditions] of [
    ['light-code', 'LIGHT', { redCoverage: true }],
    ['light-doc', 'LIGHT', {}],
    ['full-code', 'FULL', { redCoverage: true, planCommitment: true }],
  ]) {
    const run = await nativeObservationFixture(kind);
    assert.equal(run.result.results[0].toState, 'CLOSED');
    t.diagnostic(kind + ': ' + run.calls.length + ' invocations');
    const documented = docs.match(new RegExp('\\| `' + kind + '` \\| (\\d+) \\|'));
    assert.ok(documented, 'documented native calibration row: ' + kind);
    assert.equal(run.calls.length, Number(documented[1]));
    assert.equal(projectedCalls(run.item, band, conditions), run.calls.length);
    const breakdown = projectedCallBreakdown(run.item, band, conditions).components;
    assert.equal(breakdown.initialVerificationPreparation, run.calls.filter(c => c.label.endsWith(':progress-writer') && c.prompt.includes('initial verification output')).length);
    assert.equal(breakdown.integrationPreparation, run.calls.filter(c => c.label.endsWith(':progress-writer') && c.prompt.includes('integration output')).length);
    const admissionCalls = run.calls.filter(c => c.label.endsWith(':progress:admission'));
    assert.equal(breakdown.admission, admissionCalls.length);
    assert.equal(run.calls[0], admissionCalls[0], 'admission persists before any semantic worker');
    assert.equal(run.checkpoints[0].progressStage, 'admission');
    assert.equal(run.checkpoints[0].admission.attempted, true);
    assert.equal(breakdown.admission + breakdown.checkpoints + breakdown.postPlanCheckpoint + breakdown.postTestCheckpoint, run.calls.filter(c => c.prompt.includes('CHECKPOINT-BEGIN\n')).length);
    assert.equal(breakdown.postPlanCheckpoint, run.calls.filter(c => c.label.endsWith(':progress:post-plan')).length);
    assert.equal(breakdown.postTestCheckpoint, run.calls.filter(c => c.label.endsWith(':progress:post-test')).length);
    assert.equal(breakdown.planAndTwoReviews, run.calls.filter(c => /:(planner|plan-feasibility-probe|plan-quality-probe)$/.test(c.label)).length);
    assert.equal(breakdown.evidenceIdentity, run.calls.filter(c => c.label.endsWith(':evidence-identity')).length);
    assert.equal(breakdown.reaudit, run.calls.filter(c => c.label.endsWith(':re-auditor')).length);
    assert.equal(run.calls.filter((c) => c.label.endsWith(':evidence-identity')).length, 4);
    assert.equal(run.calls.some((c) => /:(red-proof-probe|rootcause-probe)$/.test(c.label)), false);
    const lastSnapshot = run.checkpoints.at(-1);
    assert.equal(lastSnapshot.attemptObservations.at(-1).outcome, 'started');
    const raw = [...run.checkpoints.flatMap((c) => c.attemptObservations), ...run.result.attemptObservations,
      ...run.result.results.flatMap((r) => r.attemptObservations)];
    const normalized = normalizeAttemptObservations(raw, () => ({ itemAttemptId: 'claim-' + kind }));
    assert.deepEqual(normalized.invalid, []);
    for (const observations of [normalized.records, [...normalized.records].reverse()]) {
      const report = aggregateEvents(observations.map(observationEvent)).observations;
      assert.deepEqual(report.conflicts, []);
      assert.equal(report.calls.physical, run.calls.length);
      assert.equal(report.calls.terminal, run.calls.length);
      assert.equal(report.calls.incomplete, 0);
      assert.equal(report.supersededStarts, run.calls.length);
      assert.equal(report.calls.checkpoints, run.checkpoints.length);
      assert.equal(report.calls.sharedOverhead, report.calls.checkpoints);
      assert.equal(report.coverage.actualModel.known, 0);
      assert.equal(report.delivery.knownCost, 0);
      assert.equal(report.delivery.costPerAccepted, null);
    }
    const recoveredOnly = normalizeAttemptObservations(lastSnapshot.attemptObservations, () => ({ itemAttemptId: 'claim-' + kind }));
    const incomplete = aggregateObservations(recoveredOnly.records);
    assert.equal(incomplete.calls.physical, run.calls.length);
    assert.equal(incomplete.calls.incomplete, run.calls.length);
    assert.equal(incomplete.calls.terminal, 0);
    assert.match(renderObservationReport(incomplete), new RegExp('incomplete/unknown: ' + run.calls.length));
  }
});

test('native retry/checkpoint physical cost is counted without fabricating money or model', async () => {
  const run = await nativeObservationFixture('light-code', { retries: true });
  const n = normalizeAttemptObservations(run.result.attemptObservations, () => ({ itemAttemptId: 'claim-retry' }));
  const report = aggregateObservations(n.records);
  assert.deepEqual(n.invalid, []);
  const fresh = await nativeObservationFixture('light-code');
  assert.equal(report.calls.physical, run.calls.length);
  assert.equal(run.calls.length - fresh.calls.length, report.calls.retries);
  const docs = readFileSync(new URL('./CALIBRATION.md', import.meta.url), 'utf8');
  assert.equal(Number(docs.match(/(\d+) physical invocations, including (\d+) checkpoint writers/)[1]), run.calls.length);
  assert.equal(Number(docs.match(/(\d+) physical invocations, including (\d+) checkpoint writers/)[2]), run.checkpoints.length);
  assert.equal(report.calls.retries, 2);
  assert.equal(report.calls.sharedOverhead, run.checkpoints.length);
  assert.equal(report.coverage.actualModel.known, 0);
  assert.equal(report.coverage.measuredCost.known, 0);
});

test('native SWEEP persists one admission relay per site before shared semantic work', async () => {
  const batch = smokeBatch();
  batch.items = [];
  batch.policies = {};
  batch.sweep = { index: 1, label: 'observational-doc-sweep', theme: 'doc-drift',
    worktree: { path: '/tmp/exec-smoke-sweep', branch: 'factory/sweep' },
    sites: ['one', 'two'].map(id => ({ findingId: id, target: id, files: ['docs/' + id + '.md'], claimId: 'claim-' + id, attemptNumber: 1 })) };
  const { result, calls } = await execSmoke(readFileSync(new URL('./factory.js', import.meta.url), 'utf8'), batch);
  const admissionCalls = calls.filter(c => c.label.endsWith(':progress:admission'));
  assert.equal(admissionCalls.length, batch.sweep.sites.length);
  assert.deepEqual(calls.slice(0, admissionCalls.length), admissionCalls);
  for (const site of batch.sweep.sites) {
    const call = admissionCalls.find(c => c.label === site.findingId + ':progress:admission');
    assert.ok(call);
    const snapshot = JSON.parse(call.prompt.split('CHECKPOINT-BEGIN\n')[1].split('\nCHECKPOINT-END')[0]);
    assert.equal(snapshot.admission.attempted, true);
    assert.equal(snapshot.claimId, site.claimId);
    assert.equal(result.sweep.sites.find(s => s.findingId === site.findingId).applied, true);
  }
  const normalized = normalizeAttemptObservations(result.attemptObservations, raw => raw.itemId === 'sweep'
    ? { itemId: 'cluster-1', itemAttemptId: 'cluster-claim-1' } : { itemAttemptId: 'claim-' + raw.itemId });
  assert.deepEqual(normalized.invalid, []);
  const report = aggregateObservations(normalized.records);
  assert.equal(report.calls.physical, calls.length);
  assert.equal(report.calls.checkpoints, admissionCalls.length);
  assert.equal(report.calls.sharedOverhead, admissionCalls.length);
  assert.equal(normalized.records.filter(r => r.itemId === 'cluster-1').length,
    calls.filter(c => c.label.startsWith('sweep:') && !c.label.startsWith('sweep:apply:')).length);
  assert.equal(report.coverage.actualModel.known, 0);
});

test('native producer -> actual driver reservation/admission/normalization -> authoritative final totals', async () => {
  const row = { id: 'SMOKE-CODE' }, events = [], warnings = [];
  const emit = event => events.push(event), warn = message => warnings.push(message);
  const identity = admitAttempt(row, 'driver-integrated-native', { cycle: 1, band: 'LIGHT' });
  emit({ event: 'claim_reserved', item: row.id, runId: identity.runId, attrs: { claimId: identity.claimId } });
  assert.equal(aggregateEvents(events).observations.firstPass.items, 0);
  const run = await nativeObservationFixture('light-code', { identity });
  const rows = { [row.id]: row };
  for (const checkpoint of run.checkpoints) {
    observeAdmission(checkpoint, row, emit, warn);
    observePhysical({ results: [checkpoint] }, rows, emit, warn);
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    observeAdmission(run.result.results[0], row, emit, warn);
    observePhysical(run.result, rows, emit, warn);
  }
  identity.completedAt = '2026-09-19T12:00:00Z';
  observe(lifecycleObservation(identity, row.id, 'completed', 'FAILED', true), emit, warn);
  const report = aggregateEvents(events).observations;
  assert.deepEqual(warnings, []);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.calls.physical, run.calls.length);
  assert.equal(report.calls.checkpoints, run.checkpoints.length);
  assert.equal(report.calls.incomplete, 0);
  assert.equal(report.firstPass.items, 1);
  assert.equal(report.firstPass.closed, 0, 'driver rejection overrides native CLOSED without competing lifecycle events');
  assert.equal(report.lateDeterministicFailures, 1);
  assert.equal(report.delivery.accepted, 0);
  assert.equal(report.delivery.costPerAccepted, null);
  assert.equal(report.coverage.actualModel.known, 0);
});

test('reserved/budget-deferred work is not admitted and does not consume first-attempt ordinal', () => {
  const row = { id: 'not-started' }, events = [];
  const first = admitAttempt(row, 'reserved-run', { cycle: 1 });
  assert.equal(observeAdmission({ id: row.id, claimId: first.claimId, runId: first.runId, budgetStopped: true, admission: { attempted: false } }, row, e => events.push(e)), false);
  assert.equal(aggregateEvents(events).observations.firstPass.items, 0);
  const next = admitAttempt(row, 'admitted-run', { cycle: 2 });
  assert.equal(next.attemptNumber, 1);
  assert.equal(observeAdmission({ id: row.id, claimId: next.claimId, runId: next.runId, admission: { attempted: true } }, row, e => events.push(e)), true);
  assert.equal(aggregateEvents(events).observations.firstPass.items, 1);
  assert.equal(aggregateEvents(events).observations.firstPass.closed, 0);
});

test('OpenCode dispatch records plus driver admission/final lifecycle report authoritative outcomes', () => {
  const state = { dispatchId: 'oc-d1', runId: 'oc-run', itemId: 'oc-item', attemptId: 'oc-claim',
    requestedModel: { providerID: 'provider', modelID: 'requested' }, runtimeVersion: { version: 'fixture-v2' },
    promptHash: 'prompt', inputHash: 'input', startedAt: 1000, completedAt: 2000, status: 'completed',
    outcome: { usage: { input: 100, output: 20, cache: { read: 50, write: 0 } }, cost: 0.25 } };
  const ledgerRow = { id: state.itemId };
  const identity = admitAttempt(ledgerRow, state.runId, { cycle: 1, band: 'LIGHT' });
  state.attemptId = identity.claimId;
  const dispatch = dispatchObservation(state, { role: 'review-code', phase: 'gates', route: { effort: 'low' } });
  const events = [], warn = message => assert.fail(message);
  const emit = event => events.push(event);
  emit({ event: 'claim_reserved', runId: state.runId, item: state.itemId, attrs: { claimId: identity.claimId } });
  assert.equal(aggregateEvents(events).observations.firstPass.items, 0);
  const result = { id: state.itemId, runId: state.runId, claimId: identity.claimId, attemptObservations: [dispatch],
    admission: { attempted: true, startedAt: dispatch.startedAt } };
  observeAdmission(result, ledgerRow, emit, warn);
  identity.completedAt = dispatch.completedAt;
  observe(lifecycleObservation(identity, state.itemId, 'completed', 'CLOSED'), emit, warn);
  observePhysical({ results: [result] }, { [state.itemId]: ledgerRow }, emit, warn);
  const rows = events.filter(e => e.event === 'attempt_observation').map(e => e.attrs.observation);
  const normalized = normalizeAttemptObservations([...rows, ...rows]);
  assert.deepEqual(normalized.invalid, []);
  assert.deepEqual(normalized.records.find(r => r.kind === 'dispatch'), dispatch);
  const report = aggregateEvents(normalized.records.map(observationEvent)).observations;
  assert.equal(report.calls.physical, 1);
  assert.equal(report.firstPass.closed, 1);
  assert.equal(report.delivery.accepted, 0);
  assert.equal(report.delivery.knownCost, 0.25);
  assert.equal(report.coverage.actualModel.known, 0);
  assert.equal(report.coverage.inputTokens.known, 1);
  assert.equal(dispatch.actualModel, null);
  const resolved = dispatchObservation({ ...state, dispatchId: 'oc-d2', outcome: { ...state.outcome, actualModel: 'provider/actually-selected' } }, { role: 'review-code', phase: 'gates' });
  const native = { version: 1, runId: 'native-r', itemId: 'native-i', attemptId: 'native-physical', dispatchId: 'native-logical', outcome: 'completed', requestedModel: 'native-requested', actualModel: null };
  const mixed = normalizeAttemptObservations([...rows, resolved, native], () => ({ itemAttemptId: 'native-claim' }));
  const both = aggregateObservations(mixed.records);
  assert.equal(both.calls.physical, 3);
  assert.equal(both.coverage.actualModel.known, 1);
  assert.equal(both.modelPairs['["provider/requested","provider/actually-selected"]'], 1);
  assert.equal(both.modelPairs['["native-requested",null]'], 1);
});

test('lifecycle reconciliation excludes conflicting terminal observations and incompatible starts', () => {
  const raw = { version: 1, runId: 'r', itemId: 'i', dispatchId: 'logical', attemptId: 'physical', outcome: 'started' };
  const normalize = (rows) => normalizeAttemptObservations(rows, () => ({ itemAttemptId: 'claim' })).records;
  const start = normalize([raw])[0];
  const final = normalize([{ ...raw, outcome: 'completed' }])[0];
  assert.notEqual(start.id, final.id);
  assert.equal(start.dispatchId, final.dispatchId);
  assert.equal(aggregateObservations([start, final]).calls.physical, 1);
  for (const bad of [normalize([{ ...raw, outcome: 'unavailable' }])[0], { ...final, measuredCost: 1, currency: 'USD', costSource: 'fixture' }]) {
    const report = aggregateObservations([start, final, bad]);
    assert.ok(report.conflicts.length);
    assert.equal(report.calls.physical, 0);
  }
  assert.ok(aggregateObservations([start, { ...final, requestedModel: 'changed' }]).conflicts.length);
  assert.equal(normalizeAttemptObservations([{ ...raw, version: 99 }]).invalid.length, 1);
  const pendingCost = aggregateObservations([{ ...start, measuredCost: 5, currency: 'USD', costSource: 'partial', attributionConfidence: 'direct' }], {
    cohort: { id: 'pending', itemIds: ['i'], runIds: ['r'], lifetimeComplete: true },
  });
  assert.equal(pendingCost.calls.physical, 1);
  assert.equal(pendingCost.calls.incomplete, 1);
  assert.equal(pendingCost.delivery.knownCost, 0);
  assert.equal(pendingCost.delivery.complete, false);
});

test('ten-item cohort includes failed and killed first attempts; acceptance remains explicit', () => {
  const { rows, options } = observationFixture();
  const report = aggregateObservations(rows, options);
  assert.deepEqual(report.firstPass, { closed: 1, items: 10, rate: 0.1, unknownOrdinalItems: 0 });
  assert.equal(report.delivery.accepted, 1);
  assert.equal(report.delivery.costPerAccepted, 15);
  assert.equal(report.calls.physical, 12);
  assert.equal(report.calls.retries, 1);
  assert.equal(report.calls.fallbacks, 1);
  assert.equal(report.calls.sharedOverhead, 1);
  assert.equal(report.coverage.actualModel.known, 1);
  assert.equal(aggregateObservations(rows.filter((r) => r.kind !== 'acceptance'), options).delivery.accepted, 0);
  assert.equal(aggregateObservations(rows).delivery.costPerAccepted, null);
  assert.match(renderObservationReport(report), /1\/10 \(10.0%\)/);
});

test('immutable observations survive refold and reject identity reuse without order dependence', () => {
  const { rows, options } = observationFixture();
  const report = aggregateObservations([...rows, ...rows], options);
  assert.equal(report.delivery.knownCost, 15);
  assert.equal(report.duplicates, rows.length);
  const dispatch = rows.find((r) => r.kind === 'dispatch');
  const changed = { ...dispatch, measuredCost: 100 };
  const conflict = aggregateObservations([...rows, changed], options);
  assert.equal(conflict.delivery.complete, false);
  assert.equal(conflict.delivery.knownCost, 14);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(aggregateObservations([changed, ...rows], options).delivery.knownCost, 14);
  const alias = aggregateObservations([...rows, { ...dispatch, id: 'another-observation-id' }], options);
  assert.equal(alias.calls.physical, 11);
  assert.equal(alias.conflicts.length, 1);
});

test('partial currency/usage attribution never becomes all-in cost', () => {
  const { rows, options } = observationFixture();
  const d = rows.find((r) => r.kind === 'dispatch');
  for (const patch of [{ measuredCost: null }, { currency: 'EUR' }, { usageScope: 'shared-counter-delta', attributionConfidence: 'estimated' }]) {
    const report = aggregateObservations(rows.map((r) => r === d ? { ...r, ...patch } : r), options);
    assert.equal(report.delivery.costPerAccepted, null);
    assert.equal(report.delivery.missingCostDispatches, 1);
    assert.equal(report.delivery.knownCost, 14);
  }
  assert.throws(() => aggregateObservations(rows, { cohort: { id: 'missing-fields' } }), /cohort/);
});

test('acceptance revisions use instants; simultaneous conflicts do not count accepted delivery', () => {
  const { rows, options } = observationFixture();
  const accepted = rows.find((r) => r.id === 'human-accepts');
  const rejection = { ...accepted, id: 'later-rejection', status: 'rejected', recordedAt: '2026-09-19T12:30:00+02:00' };
  assert.equal(aggregateObservations([...rows, rejection], options).delivery.accepted, 0);
  const conflict = { ...rejection, recordedAt: '2026-09-19T12:00:00+02:00' };
  assert.equal(aggregateObservations([...rows, conflict], options).delivery.accepted, 0);
  assert.equal(aggregateObservations([conflict, ...rows], options).delivery.accepted, 0);
});

test('version and unknown validation prevents default zero/model inference', () => {
  const row = makeObservation({ kind: 'dispatch', id: 'd', runId: 'r', itemId: 'i', attemptId: 'a', dispatchId: 'd', requestedModel: 'route' });
  assert.equal(row.actualModel, null);
  assert.equal(row.outputTokens, null);
  assert.equal(row.retry, null);
  assert.ok(validateObservation({ ...row, version: 2 }).length);
  assert.throws(() => makeObservation({ ...row, outputTokens: -1 }), /outputTokens/);
  assert.throws(() => makeObservation({ ...row, startedAt: '2026-09-19T11:00:00Z', completedAt: '2026-09-19T10:00:00Z' }), /precedes/);
  assert.throws(() => makeObservation({ kind: 'acceptance', id: 'a', runId: 'r', itemId: 'i', status: 'accepted' }), /explicit/);
});

test('native adapter preserves retries as separate physical identities and needs claim identity', () => {
  const native = { version: 1, runId: 'run', itemId: 'item', dispatchId: 'logical', attemptId: 'logical:0',
    stage: 'item:test-author', phase: 'Test', retry: 0, outcome: 'completed', overhead: false, actualModel: null };
  assert.throws(() => adaptNativeAttemptObservation(native), /attemptId/);
  const first = adaptNativeAttemptObservation(native, { itemAttemptId: 'claim' });
  const retry = adaptNativeAttemptObservation({ ...native, attemptId: 'logical:1', retry: 1 }, { itemAttemptId: 'claim' });
  const r = aggregateObservations([first, retry, first]);
  assert.equal(r.calls.physical, 2);
  assert.equal(r.calls.retries, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(first.actualModel, null);
  const overhead = adaptNativeAttemptObservation({ ...native, overhead: true, phase: 'Checkpoint' });
  assert.equal(overhead.itemId, null);
  assert.equal(overhead.bucket, 'shared-overhead');
});

test('reviewer findings count canonical detections, exclusivity, false positives and overlap', () => {
  const { rows } = observationFixture();
  const r = aggregateObservations(rows);
  assert.equal(r.findings.validFindings, 2);
  assert.equal(r.findings.perRole.security.uniqueValid, 1);
  assert.equal(r.findings.perRole.code.uniqueValid, 0);
  assert.equal(r.findings.perRole.code.falsePositives, 1);
  assert.equal(r.findings.perRole.code.falsePositiveRate, 0.5);
  assert.equal(r.findings.overlap['["code","security"]'], 1);
  assert.equal(r.reuse.hits, 1);
  assert.equal(r.reuse.misses, 1);
  assert.equal(r.reuse.savedCallsKnown, 5);
  const f = rows.find((v) => v.id === 'f2');
  const conflict = aggregateObservations([...rows, { ...f, id: 'f-conflict', findingId: 'f-conflict', adjudication: 'false-positive' }]);
  assert.equal(conflict.findings.conflictingAdjudications, 1);
  assert.equal(conflict.findings.validFindings, 1);
  const unresolvedRole = aggregateObservations([...rows, { ...f, id: 'new-role', role: 'unadjudicated-role', adjudication: 'unresolved' }]);
  assert.equal(unresolvedRole.findings.perRole['unadjudicated-role'].valid, 0);
  assert.equal(unresolvedRole.findings.perRole['unadjudicated-role'].unresolved, 1);
});

test('recovery is lifetime spend but never a first-pass close', () => {
  const { rows, options } = observationFixture();
  rows.push(makeObservation({ kind: 'item-attempt', id: 'recover', runId: 'run-2', itemId: 'item-1', attemptId: 'recovery', attemptNumber: 2, recovery: true, outcome: 'CLOSED' }));
  rows.push(makeObservation({ kind: 'dispatch', id: 'recover-call', runId: 'run-2', itemId: 'item-1', attemptId: 'recovery', dispatchId: 'recover-call', outcome: 'completed', measuredCost: 4, currency: 'USD', costSource: 'fixture', attributionConfidence: 'direct' }));
  const r = aggregateObservations(rows, options);
  assert.equal(r.firstPass.closed, 1);
  assert.equal(r.delivery.knownCost, 19);
  assert.equal(r.delivery.accepted, 1);
});

test('telemetry integration fixes legacy denominator and deduplicates fold/run usage identities', () => {
  const folds = Array.from({ length: 10 }, (_, i) => ({ event: 'item_folded', item: 'i' + i, attrs: { resultId: 'i' + i + '#1', toState: i ? 'FAILED' : 'CLOSED', band: 'LIGHT' } }));
  const usage = { event: 'usage', runId: 'stable-run', attrs: { outputTokens: 500 } };
  const { rows, options } = observationFixture();
  const a = aggregateEvents([...folds, ...folds, usage, { ...usage, ts: 'later' }, ...rows.map(observationEvent)], options);
  assert.equal(a.usage.length, 1);
  assert.equal(a.outcomes.FAILED, 9);
  assert.equal(a.deduplication.duplicates, 11);
  assert.equal(a.observations.delivery.costPerAccepted, 15);
  const md = renderTelemetryReport(a, { generatedAt: 'fixture' });
  assert.match(md, /all folded items\) \| 1\/10 = 10%/);
  assert.match(md, /First-observed-fold close — LIGHT band \| 1\/10/);
  assert.equal(aggregateEvents([usage, { ...usage, attrs: { outputTokens: 600 } }]).usage.length, 0);
  const malformed = aggregateEvents([...folds, { event: 'attempt_observation', attrs: { observation: { version: 9 } } }]);
  assert.equal(malformed.outcomes.CLOSED, 1);
  assert.equal(malformed.observations.invalid.length, 1);
});

test('unknown cache buckets remain unknown and selectors state metric scope', () => {
  assert.deepEqual(parseTokenUsageVector(null), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null });
  const partial = parseTokenUsageVector({ data: { result: [{ metric: { type: 'input' }, value: [1, '0'] }, { metric: { type: 'output' }, value: [1, '-1'] }] } });
  assert.equal(partial.inputTokens, 0);
  assert.equal(partial.outputTokens, null);
  assert.equal(cacheHitRate({ cacheReadTokens: 100 }), null);
  assert.equal(tokenUsageSummary(partial).totalTokens, null);
  assert.equal(tokenUsageSummary(partial).scope, 'unfiltered-metric-window');
  const complete = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 };
  assert.equal(tokenUsageSummary(complete).cacheHitRate, 0.9);
  assert.equal(tokenUsageSummary(complete).totalTokens, 1020);
  assert.match(buildTokenUsageQuery(0, 1000, { session_id: 'a"b' }).query, /session_id="a\\"b"/);
  assert.throws(() => buildTokenUsageQuery(1, 0), /increasing/);
  assert.throws(() => buildTokenUsageQuery(0, 1, { 'bad-label': 'x' }), /label/);
  assert.match(renderTelemetryReport(aggregateEvents([{ event: 'token_usage_snapshot', attrs: partial }])), /unknown/);
});

test('projection exposes collector-subsumed scans and planner checkpoint', () => {
  const code = { fixType: 'mechanical', files: ['src\\File.cs'] };
  const doc = { fixType: 'mechanical', files: ['README.md'] };
  const full = { fixType: 'nonmechanical', files: ['src/File.cs'], severity: 'CRITICAL', theme: 'security-multitenancy' };
  const usual = projectedCalls(code, 'LIGHT', { redCoverage: true });
  assert.equal(projectedCalls(code, 'LIGHT', { identityCalls: 1, redCoverage: true, redProofFallback: true, rootCauseFallback: true }), usual - 3 + 2);
  assert.equal(projectedCalls(doc, 'LIGHT', { identityCalls: 1 }), projectedCalls(doc, 'LIGHT') - 3);
  assert.equal(projectedCallBreakdown(code, 'LIGHT').components.admission, 1);
  assert.equal(projectedCallBreakdown(full, 'FULL').components.planAndTwoReviews, 3);
});

test('frozen experiment pins contents, policy and contracts; Windows paths supported', () => {
  const { manifest } = experimentFixture();
  assert.equal(validateFrozenExperiment(manifest), manifest);
  for (const mutate of [
    (m) => { m.cases[0].snapshot.files['src\\case-0.txt'] += 'changed'; },
    (m) => { m.cases[0].snapshot.policy.noDeferredWork = false; },
    (m) => { m.arms[0].contract += 'changed'; },
  ]) { const copy = structuredClone(manifest); mutate(copy); assert.throws(() => validateFrozenExperiment(copy), /digest mismatch/); }
  const bad = structuredClone(manifest); bad.cases[0].snapshot.files['..\\escape'] = 'bad';
  assert.throws(() => freezeExperiment(bad), /relative and contained/);
  const large = structuredClone(manifest);
  large.cases[0].snapshot.files['large.txt'] = 'x'.repeat(450000);
  const frozen = freezeExperiment(large);
  frozen.cases[0].snapshot.files['large.txt'] += 'beyond review-pack truncation';
  assert.throws(() => validateFrozenExperiment(frozen), /digest mismatch/);
});

test('blind packet excludes arm, requested/actual model, role and original verdict', () => {
  const { manifest, submissions } = experimentFixture();
  const packet = blindPacket(manifest, submissions);
  const encoded = JSON.stringify(packet);
  for (const key of ['armId', 'actualModel', 'requestedModel', 'originalOutcome', 'measuredCost', '"role"']) assert.equal(encoded.includes(key), false);
  assert.equal(packet.cases.length, 3);
  assert.equal(packet.cases[1].candidates.length, 2);
  assert.throws(() => blindPacket(manifest, [submissions[0], submissions[0]]), /unique/);
  assert.throws(() => blindPacket(manifest, [{ ...submissions[0], snapshotHash: 'changed' }]), /snapshot mismatch/);
});

test('experiments include rejected/mixed cases and measured false negatives against blind truth', () => {
  const { manifest, submissions, adjudications } = experimentFixture();
  const r = reportExperiment(manifest, submissions, adjudications);
  assert.deepEqual(r.cohort.originalOutcomes, { approved: 1, rejected: 1, mixed: 1 });
  assert.equal(r.arms.challenger.falseNegatives, 1);
  assert.equal(r.arms.challenger.referenceFindings, 2);
  assert.equal(r.arms.challenger.falseNegativeRate, 0.5);
  assert.equal(r.arms['baseline-sonnet-4.6'].falseNegatives, 0);
  assert.equal(r.arms.challenger.accepted, 1);
  assert.equal(r.arms.challenger.costPerBlindAccepted, 3);
  assert.equal(r.paired.challenger.cases, 3);
  assert.equal(r.automaticChanges, false);
  assert.match(renderExperimentReport(r), /not human-accepted delivered change/);
});

test('missing/error submissions and unknown adjudication stay in cohort denominators', () => {
  const { manifest, submissions, adjudications } = experimentFixture();
  const missing = submissions.pop();
  adjudications.outcomes = adjudications.outcomes.filter((a) => a.blindId !== missing.blindId);
  adjudications.findings = adjudications.findings.filter((a) => a.blindId !== missing.blindId);
  const r = reportExperiment(manifest, submissions, adjudications);
  assert.equal(r.arms.challenger.cases, 3);
  assert.equal(r.arms.challenger.submitted, 2);
  assert.equal(r.arms.challenger.unresolved, 1);
  assert.equal(r.arms.challenger.costPerBlindAccepted, null);
  const unknown = structuredClone(adjudications);
  unknown.truth = [];
  assert.equal(reportExperiment(manifest, submissions, unknown).arms.challenger.falseNegativeRate, null);
  const unblind = structuredClone(adjudications); unblind.outcomes[0].blind = false;
  assert.throws(() => reportExperiment(manifest, submissions, unblind), /independent and blind/);
  const incomplete = experimentFixture();
  incomplete.submissions[0].status = 'timeout';
  assert.throws(() => reportExperiment(incomplete.manifest, incomplete.submissions, incomplete.adjudications), /non-completed/);
  incomplete.adjudications.outcomes[0].outcome = 'unresolved';
  const errorReport = reportExperiment(incomplete.manifest, incomplete.submissions, incomplete.adjudications);
  assert.equal(errorReport.arms['baseline-sonnet-4.6'].completed, 2);
  assert.equal(errorReport.arms['baseline-sonnet-4.6'].cases, 3);
  assert.equal(errorReport.arms['baseline-sonnet-4.6'].unresolved, 1);
});

test('CLI is read-only with injected JSON IO; real CLI help/error exit codes', () => {
  const fixture = experimentFixture();
  let output;
  const io = { read: (path) => fixture[path], out: (value) => { output = value; } };
  main(['report', 'manifest', 'submissions', 'adjudications', '--json'], io);
  assert.equal(JSON.parse(output).automaticChanges, false);
  main(['blind', 'manifest', 'submissions'], io);
  assert.equal(JSON.parse(output).cases.length, 3);
  assert.throws(() => main(['report', '--out', 'state/ledger.json'], io));
  const help = spawnSync(process.execPath, ['_workflow/calibrate.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /read-only/);
  const invalid = spawnSync(process.execPath, ['_workflow/calibrate.mjs', 'unknown'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
});

test('manual acceptance/finding preparation CLI validates explicit input and never infers delivery cost', () => {
  const prepared = spawnSync(process.execPath, ['_workflow/calibrate.mjs', 'prepare-observations', '_workflow/fixtures/manual-observations.json'], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const rows = JSON.parse(prepared.stdout);
  assert.equal(rows.length, 2);
  let report;
  main(['observations', 'manual', '--json'], { read: () => rows, out: (s) => { report = JSON.parse(s); } });
  assert.equal(report.delivery.accepted, 1);
  assert.equal(report.delivery.costPerAccepted, null);
  assert.equal(report.findings.perRole['review-code'].valid, 1);
  assert.equal(report.calls.physical, 0);
  for (const patch of [{ actor: null }, { delivered: 'true' }, { recordedAt: 'invalid' }]) {
    assert.throws(() => main(['prepare-observations', 'manual'], { read: () => [{ ...rows[0], ...patch }], out: () => assert.fail('invalid manual input emitted') }));
  }
  assert.throws(() => main(['prepare-observations', 'manual'], { read: () => [rows[0], { ...rows[0], status: 'rejected' }], out: () => assert.fail('conflict emitted') }), /conflicting/);
});
