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
    // "admission" (a driver-level bookkeeping event in driver-integration.mjs's admitAttempt/
    // observeAdmission) is not a physical agent dispatch and never appears in an execSmoke trace of
    // factory.js — confirmed via `git log -S` that factory.js has never contained a ":progress:admission"
    // label. breakdown.admission is 0 for exactly this reason (see band-cost.mjs's header comment).
    assert.equal(run.calls.filter(c => c.label.endsWith(':progress:admission')).length, 0);
    assert.equal(breakdown.admission, 0);
    assert.equal(breakdown.admission + breakdown.checkpoints + breakdown.postPlanCheckpoint + breakdown.postTestCheckpoint, run.calls.filter(c => c.prompt.includes('CHECKPOINT-BEGIN\n')).length);
    assert.equal(breakdown.postPlanCheckpoint, run.calls.filter(c => c.label.endsWith(':progress:post-plan')).length);
    assert.equal(breakdown.postTestCheckpoint, run.calls.filter(c => c.label.endsWith(':progress:post-test')).length);
    assert.equal(breakdown.planAndTwoReviews, run.calls.filter(c => /:(planner|plan-feasibility-probe|plan-quality-probe)$/.test(c.label)).length);
    assert.equal(breakdown.evidenceIdentity, run.calls.filter(c => c.label.endsWith(':evidence-identity')).length);
    assert.equal(breakdown.reaudit, run.calls.filter(c => c.label.endsWith(':re-auditor')).length);
    // evidence-identity is dead (no such label has ever existed in factory.js — see band-cost.mjs's
    // header note), so this is 0 for every kind, not the old stale 4.
    assert.equal(run.calls.filter((c) => c.label.endsWith(':evidence-identity')).length, 0);
    // red-proof-probe/rootcause-probe DO run — always, for a codeChange item (light-code/full-code);
    // never for a doc-only item (light-doc). The old blanket "never appears" claim was stale.
    assert.equal(run.calls.some((c) => /:(red-proof-probe|rootcause-probe)$/.test(c.label)), kind !== 'light-doc');
    const lastSnapshot = run.checkpoints.at(-1);
    // CORRECTED (2026-09-27) -- 'started' is structurally impossible here in this repo's real
    // factory.js: checkpointProgress/checkpointResult BOTH filter the shared attemptObservations
    // array into the snapshot BEFORE dispatching their OWN checkpoint-writer call (so that writer's
    // own observation can never land in the very snapshot it writes), and every checkpoint is only
    // ever taken AFTER its preceding stage's dispatches are fully awaited -- nothing is ever
    // mid-flight at the moment a snapshot is taken. Verified empirically: 0 'started' entries appear
    // anywhere in a real run's combined raw observations (see report.supersededStarts below). The
    // trailing entry of the final snapshot is always already resolved.
    assert.equal(lastSnapshot.attemptObservations.at(-1).outcome, 'completed');
    // run.result.attemptObservations does not exist -- attemptObservations lives per-item under
    // run.result.results[], never at the batch envelope's top level (run.result's real keys are
    // {mode, cycle, plan, usage, results}, the real Workflow batch envelope shape).
    const raw = [...run.checkpoints.flatMap((c) => c.attemptObservations),
      ...run.result.results.flatMap((r) => r.attemptObservations)];
    const normalized = normalizeAttemptObservations(raw, () => ({ itemAttemptId: 'claim-' + kind }));
    assert.deepEqual(normalized.invalid, []);
    for (const observations of [normalized.records, [...normalized.records].reverse()]) {
      const report = aggregateEvents(observations.map(observationEvent)).observations;
      assert.deepEqual(report.conflicts, []);
      // physical/terminal are run.calls.length - 1, permanently: the FINAL checkpoint-writer's own
      // dispatch (checkpointResult's ':checkpoint' call, always the last physical call in any run)
      // can never appear in any snapshot, by construction (see above) -- verified structural, not a
      // fixture quirk.
      assert.equal(report.calls.physical, run.calls.length - 1);
      assert.equal(report.calls.terminal, run.calls.length - 1);
      assert.equal(report.calls.incomplete, 0);
      // Nothing is ever captured mid-flight in this repo's real checkpoint model (see above) -- there
      // is never a 'started' entry to be superseded by a later terminal one.
      assert.equal(report.supersededStarts, 0);
      // Of run.checkpoints.length physical checkpoint writes, exactly one -- the FINAL
      // checkpointResult dispatch -- is the same permanently-unobservable write as above; the other
      // KI-E137-named progress-checkpoints DO eventually get captured by a later snapshot.
      assert.equal(report.calls.checkpoints, run.checkpoints.length - 1);
      // NOT report.calls.checkpoints -- sharedOverhead is fed by the same fictional "admission
      // relay" concept CALIBRATION.md's stale prose described (see the correction there); with no
      // real admission mechanism, sharedOverhead stays 0, verified empirically.
      assert.equal(report.calls.sharedOverhead, 0);
      assert.equal(report.coverage.actualModel.known, 0);
      assert.equal(report.delivery.knownCost, 0);
      assert.equal(report.delivery.costPerAccepted, null);
    }
    const recoveredOnly = normalizeAttemptObservations(lastSnapshot.attemptObservations, () => ({ itemAttemptId: 'claim-' + kind }));
    const incomplete = aggregateObservations(recoveredOnly.records);
    // The last snapshot IS effectively the final result's own attemptObservations (checkpointResult
    // filters before dispatching, so `run.checkpoints.at(-1)` and
    // `run.result.results[0].attemptObservations` carry the same content) -- every entry already
    // carries its own resolved, terminal outcome directly (matching the 'completed' fix above), so
    // recovering from JUST the last checkpoint needs no separate confirmation event and leaves
    // nothing ambiguous -- a real, positive kill-resilience property of this design, not a gap.
    assert.equal(incomplete.calls.physical, run.calls.length - 1);
    assert.equal(incomplete.calls.incomplete, 0);
    assert.equal(incomplete.calls.terminal, run.calls.length - 1);
    assert.match(renderObservationReport(incomplete), /incomplete\/unknown: 0/);
  }
});

test('native retry/checkpoint physical cost is counted without fabricating money or model', async () => {
  const run = await nativeObservationFixture('light-code', { retries: true });
  const n = normalizeAttemptObservations(run.result.results[0].attemptObservations, () => ({ itemAttemptId: 'claim-retry' }));
  const report = aggregateObservations(n.records);
  assert.deepEqual(n.invalid, []);
  const fresh = await nativeObservationFixture('light-code');
  // run.calls.length - 1, not run.calls.length: the final checkpointResult dispatch (the last
  // physical call in any run) is never embedded in attemptObservations, by construction (see the
  // matching note in the test above). The retry DELTA on the next line is unaffected -- both runs
  // carry the same structural -1, so it cancels out.
  assert.equal(report.calls.physical, run.calls.length - 1);
  assert.equal(run.calls.length - fresh.calls.length, report.calls.retries);
  const docs = readFileSync(new URL('./CALIBRATION.md', import.meta.url), 'utf8');
  // The doc's "N physical invocations, including M checkpoint writers" line describes exactly this
  // fixture (a LIGHT C# fixture with two unavailable test-author retries -- see options.retries in
  // fixtures/observation-producers.mjs) -- re-traced 2026-09-27 to 41/5, was stale at 28/7.
  assert.equal(Number(docs.match(/(\d+) physical invocations, including (\d+) checkpoint writers/)[1]), run.calls.length);
  assert.equal(Number(docs.match(/(\d+) physical invocations, including (\d+) checkpoint writers/)[2]), run.checkpoints.length);
  assert.equal(report.calls.retries, 2);
  // Not run.checkpoints.length -- see the matching note in the test above (no real admission
  // mechanism feeds sharedOverhead; it is 0).
  assert.equal(report.calls.sharedOverhead, 0);
  assert.equal(report.coverage.actualModel.known, 0);
  assert.equal(report.coverage.measuredCost.known, 0);
});

// CORRECTED (2026-09-27) -- the original test's whole premise (a per-site ":progress:admission"
// checkpoint relay, feeding a result.attemptObservations array) never existed in this repo's real
// runSweep/applySweepSite (factory.js): confirmed via `git log -S` (no ":progress:admission" label
// has EVER appeared in factory.js's history) and via a live execSmoke trace, which additionally
// showed result.attemptObservations is entirely absent from a sweep result (runSweep's `res` object
// never gains that field the way a normal item's checkpointResult does) -- calling
// normalizeAttemptObservations on it throws immediately, so this test's tail never actually ran.
// Same "ported from an abandoned merge, never wired into this repo's real factory.js" lineage as the
// admission/evidenceIdentity dead components band-cost.mjs already accounts for as 0. Sweeps are a
// human-supervised, cross-cutting pattern-application pathway distinct from the main per-item
// pipeline; adding kill-resilience observation-tracking to it would be new production functionality
// on the live pipeline, out of scope here (same reasoning that deferred the native-checkpoint
// inlining gap) -- not attempted. Rewritten to check what the pathway actually, verifiably does:
// exactly one design call precedes every site's own apply call, each site gets its own correctly
// labeled + costed apply dispatch, and the result reflects each site's real outcome.
test('native SWEEP designs once then applies each site with its own correctly labeled dispatch', async () => {
  const batch = smokeBatch();
  batch.items = [];
  batch.policies = {};
  batch.sweep = { index: 1, label: 'observational-doc-sweep', theme: 'doc-drift',
    worktree: { path: '/tmp/exec-smoke-sweep', branch: 'factory/sweep' },
    sites: ['one', 'two'].map(id => ({ findingId: id, target: id, files: ['docs/' + id + '.md'], claimId: 'claim-' + id, attemptNumber: 1 })) };
  const { result, calls } = await execSmoke(readFileSync(new URL('./factory.js', import.meta.url), 'utf8'), batch);
  assert.equal(result.attemptObservations, undefined, 'sweeps do not attach an observation trail (see note above) -- this is the current, confirmed reality, not an aspiration');
  const designCalls = calls.filter(c => c.label === 'sweep:design');
  assert.equal(designCalls.length, 1, 'the canonical fix pattern is designed exactly once for the whole cluster');
  const applyCalls = calls.filter(c => c.label.startsWith('sweep:apply:'));
  assert.equal(applyCalls.length, batch.sweep.sites.length, 'one apply dispatch per site, no admission relay in between');
  assert.deepEqual(calls.slice(0, 1), designCalls, 'design always runs first, before any site is applied');
  for (const site of batch.sweep.sites) {
    const call = applyCalls.find(c => c.label === 'sweep:apply:' + site.findingId);
    assert.ok(call, 'each site has its own apply dispatch labeled by findingId');
    assert.equal(result.sweep.sites.find(s => s.findingId === site.findingId).applied, true);
  }
  const gateCalls = calls.filter(c => c.label.startsWith('sweep:gate-'));
  // opus cost = design (1) + the opus-routed gates dispatched after apply (gate-architect,
  // gate-security) -- cost is a model-keyed total, not per-call-type, so it is NOT just the design
  // call alone.
  assert.equal(result.sweep.cost['claude-opus-4-8'], designCalls.length + gateCalls.length);
  assert.equal(result.sweep.cost['claude-sonnet-4-6'], batch.sweep.sites.length, 'each site apply call is costed to sonnet');
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
  // Both -1: the final checkpointResult dispatch is never embedded in any snapshot's
  // attemptObservations, by construction -- see the matching note in the first test above.
  assert.equal(report.calls.physical, run.calls.length - 1);
  assert.equal(report.calls.checkpoints, run.checkpoints.length - 1);
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

test('typed cost bases separate measurement coverage from comparable totals and preserve legacy unknowns', () => {
  const { rows, options } = observationFixture();
  const d = rows.find(r => r.kind === 'dispatch');
  for (const costBasis of ['invoice', 'list-equivalent', 'runtime-reported', 'unknown']) {
    const report = aggregateObservations(rows.map(r => r === d ? { ...r, costBasis } : r), options);
    assert.equal(report.delivery.measurementComplete, true);
    assert.equal(report.delivery.complete, false);
    assert.equal(report.delivery.knownCost, null);
    assert.equal(report.delivery.costPerAccepted, null);
    assert.equal(report.accounting.groups.length, 2);
    assert.ok(report.accounting.byRole.some(g => g.role === 'fixer' && g.costBasis === costBasis));
  }
  const legacy = rows.map(r => {
    const { costBasis, costParentDispatchId, costIncludesChildren, severity, ...old } = r;
    return old;
  });
  assert.deepEqual(validateObservation(legacy.find(r => r.kind === 'dispatch')), []);
  const report = aggregateObservations(legacy, options);
  assert.equal(report.delivery.knownCost, 15);
  assert.equal(report.delivery.complete, false);
  assert.equal(report.accounting.groups[0].costBasis, 'unknown');
  assert.equal(report.findings.reportedSeverity.unknown, 5);
  assert.throws(() => makeObservation({ ...d, costBasis: 'probably billed' }), /costBasis/);
});

test('inclusive controller cost replaces linked worker costs with order-independent nonoverlap', () => {
  const { rows, options } = observationFixture();
  const workers = rows.filter(r => r.kind === 'dispatch').map(r => ({ ...r, costParentDispatchId: 'controller' }));
  const parent = makeObservation({ kind: 'dispatch', id: 'controller', dispatchId: 'controller', runId: 'run-1',
    bucket: 'shared-overhead', role: 'controller', actualModel: 'controller-model', runtimeVersion: 'runtime-1',
    costIncludesChildren: true, measuredCost: 20, currency: 'USD', costBasis: 'synthetic', costSource: 'fixture',
    outcome: 'completed', attributionConfidence: 'shared' });
  const input = [...workers, parent, ...rows.filter(r => r.kind !== 'dispatch')];
  const report = aggregateObservations(input, options);
  assert.equal(report.delivery.knownCost, 20);
  assert.equal(report.delivery.costPerAccepted, 20);
  assert.equal(report.accounting.excludedChildren.length, 12);
  assert.equal(report.accounting.byRole.length, 1);
  assert.equal(report.accounting.byModel[0].actualModel, 'controller-model');
  assert.equal(report.accounting.byRuntime[0].runtimeVersion, 'runtime-1');
  assert.equal(aggregateObservations(input.toReversed(), options).delivery.knownCost, 20);
  const shared = input.map(r => r === parent ? { ...r, usageScope: 'shared-counter-delta' } : r);
  assert.equal(aggregateObservations(shared, options).delivery.costPerAccepted, 20);
  assert.equal(aggregateObservations(input.map(r => r === parent ? { ...r, measuredCost: null } : r), options).delivery.complete, false);
  for (const broken of [input.filter(r => r !== parent), input.map(r => r === parent ? { ...r, costIncludesChildren: false } : r),
    input.map(r => r === parent ? { ...r, costParentDispatchId: workers[0].dispatchId } : r)]) {
    assert.equal(aggregateObservations(broken, options).delivery.complete, false);
    assert.ok(aggregateObservations(broken, options).accounting.conflicts.length);
  }
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
  rows.push(makeObservation({ kind: 'dispatch', id: 'recover-call', runId: 'run-2', itemId: 'item-1', attemptId: 'recovery', dispatchId: 'recover-call', outcome: 'completed', measuredCost: 4, currency: 'USD', costSource: 'fixture', costBasis: 'synthetic', attributionConfidence: 'direct' }));
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
  assert.match(md, /First-observed-fold close — LIGHT band \(KI-E48\) \| 1\/10 = 10%/);
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
  // evidenceIdentity now defaults to 0 (was 4 — dead, see band-cost.mjs's header note), so
  // identityCalls:1 ADDS 1 relative to `usual`, not subtracts 3; redProofFallback/rootCauseFallback
  // are unchanged, still +1 each beyond the always-on redProofProbe/rootCauseProbe base.
  assert.equal(projectedCalls(code, 'LIGHT', { identityCalls: 1, redCoverage: true, redProofFallback: true, rootCauseFallback: true }), usual + 1 + 2);
  assert.equal(projectedCalls(doc, 'LIGHT', { identityCalls: 1 }), projectedCalls(doc, 'LIGHT') + 1);
  assert.equal(projectedCallBreakdown(code, 'LIGHT').components.admission, 0);
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

test('calibration totals and paired deltas cannot pool accounting bases', () => {
  const { manifest, submissions, adjudications } = experimentFixture();
  for (const s of submissions.filter(s => s.caseId === 'case-1')) s.costBasis = 'invoice';
  const report = reportExperiment(manifest, submissions, adjudications);
  assert.equal(report.arms.challenger.accounting.measurementComplete, true);
  assert.equal(report.arms.challenger.costComplete, false);
  assert.equal(report.arms.challenger.knownCostUSD, null);
  assert.equal(report.arms.challenger.costPerBlindAccepted, null);
  assert.equal(report.paired.challenger.knownCostDeltaUSD, null);
  assert.equal(report.paired.challenger.costDeltas.length, 2);
  for (const s of submissions) delete s.costBasis;
  const legacy = reportExperiment(manifest, submissions, adjudications);
  assert.equal(legacy.arms.challenger.costComplete, false);
  assert.equal(legacy.arms.challenger.accounting.costBasis, 'unknown');
  assert.equal(legacy.paired.challenger.costPairs, 0);
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
