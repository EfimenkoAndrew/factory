import { makeObservation } from '../lib/observations.mjs';
import { freezeExperiment, blindId } from '../lib/calibration.mjs';

export function observationFixture() {
  const rows = [];
  const add = (kind, id, extra) => rows.push(makeObservation({ kind, id, runId: 'run-1', ...extra }));
  for (let i = 0; i < 10; i++) {
    const itemId = 'item-' + i, attemptId = itemId + '-attempt-1';
    add('item-attempt', attemptId + '-start', { itemId, attemptId, attemptNumber: 1, phase: 'started' });
    if (i !== 9) add('item-attempt', attemptId + '-end', { itemId, attemptId, attemptNumber: 1, outcome: i === 0 ? 'CLOSED' : 'FAILED' });
    add('dispatch', itemId + '-dispatch-1', { itemId, attemptId, dispatchId: itemId + '-dispatch-1', stage: 'fix', role: 'fixer',
      requestedModel: 'requested-alias', actualModel: i === 0 ? 'actual-resolved-model' : null,
      retry: 0, fallback: false, outcome: i === 9 ? 'killed' : 'completed', measuredCost: 1, currency: 'USD', costSource: 'fixture-bill', attributionConfidence: 'direct' });
  }
  add('dispatch', 'retry', { itemId: 'item-1', attemptId: 'item-1-attempt-1', dispatchId: 'retry', retry: 1,
    fallback: true, outcome: 'error', measuredCost: 2, currency: 'USD', costSource: 'fixture-bill', attributionConfidence: 'direct' });
  add('dispatch', 'checkpoint', { bucket: 'shared-overhead', dispatchId: 'checkpoint', stage: 'checkpoint', retry: 0, outcome: 'completed',
    measuredCost: 3, currency: 'USD', costSource: 'fixture-bill', attributionConfidence: 'shared' });
  add('acceptance', 'human-accepts', { itemId: 'item-0', actor: 'fixture-human', sourceRef: 'fixture:decision/1',
    recordedAt: '2026-09-19T10:00:00Z', status: 'accepted', delivered: true, escapedDefects: 0, correctionMinutes: 5 });
  add('acceptance', 'human-rejects', { itemId: 'item-1', actor: 'fixture-human', sourceRef: 'fixture:decision/2',
    recordedAt: '2026-09-19T10:00:00Z', status: 'rejected', delivered: false, correctionMinutes: 20 });
  for (const [id, role, canonicalFindingId, adjudication] of [
    ['f1', 'security', 'auth-gap', 'valid'], ['f2', 'code', 'auth-gap', 'valid'],
    ['f3', 'security', 'secret-leak', 'valid'], ['f4', 'code', 'bad-claim', 'false-positive'],
    ['f5', 'code', null, 'unresolved'],
  ]) add('finding', id, { itemId: 'item-0', snapshotId: 'snapshot-1', findingId: id, role, canonicalFindingId, adjudication, independent: true, blind: true });
  add('reuse', 'reuse-hit', { itemId: 'item-0', attemptId: 'item-0-attempt-1', stage: 'gates', status: 'hit', reason: 'identity-match', savedCalls: 5 });
  add('reuse', 'reuse-miss', { itemId: 'item-1', attemptId: 'item-1-attempt-1', stage: 'gates', status: 'miss', reason: 'policy-changed' });
  return { rows, options: { cohort: { id: 'synthetic-ten-items', itemIds: Array.from({ length: 10 }, (_, i) => 'item-' + i), runIds: ['run-1'], lifetimeComplete: true } } };
}

export function experimentFixture() {
  const manifest = freezeExperiment({ experimentId: 'synthetic-consolidated-scans', baselineArm: 'baseline-sonnet-4.6',
    arms: [{ id: 'baseline-sonnet-4.6', requestedModel: 'sonnet-4.6', contract: 'Complete original independent scan instructions.' },
      { id: 'challenger', requestedModel: null, contract: 'Complete consolidated scan instructions.' }],
    cases: ['approved', 'rejected', 'mixed'].map((originalOutcome, i) => ({ caseId: 'case-' + i, itemId: 'item-' + i,
      stratum: ['documentation', 'ordinary-code', 'high-risk'][i], originalOutcome,
      snapshot: { baseRevision: 'frozen-fixture-revision', acceptance: 'No forbidden TODO; preserve required guard.', policy: { noDeferredWork: true },
        reviewerContract: 'Inspect the frozen files and report concrete violations.',
        files: { ['src\\case-' + i + '.txt']: i === 0 ? 'guard present' : 'TODO guard missing' } } })) });
  const submissions = manifest.cases.flatMap((c, i) => manifest.arms.map((arm, j) => ({
    blindId: blindId(manifest, c.caseId, arm.id), caseId: c.caseId, armId: arm.id, snapshotHash: c.snapshotHash,
    actualModel: j ? null : 'sonnet-4.6', status: 'completed', measuredCost: j ? 1 : 2, currency: 'USD', costSource: 'synthetic-bill',
    inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null,
    extraReads: 0, formatFailures: 0, physicalCalls: j ? 1 : 3, reusedCalls: 0,
    findings: i === 0 ? [] : (j === 1 && i === 1 ? [] : [{ findingId: 'f-' + i, role: j ? 'consolidated' : 'original', text: 'Required guard missing at line 1.' }]),
  })));
  const adjudicator = { blind: true, independent: true, adjudicator: 'fixture-adjudicator' };
  const adjudications = { version: 1, experimentDigest: manifest.digest,
    outcomes: submissions.map((s) => ({ ...adjudicator, blindId: s.blindId, outcome: s.caseId === 'case-0' ? 'accepted' : s.caseId === 'case-1' ? 'rejected' : 'mixed', escapedDefects: null, correctionMinutes: null })),
    findings: submissions.flatMap((s) => s.findings.map((f) => ({ ...adjudicator, blindId: s.blindId, findingId: f.findingId, canonicalFindingId: 'missing-guard', outcome: 'valid' }))),
    truth: manifest.cases.map((c, i) => ({ ...adjudicator, caseId: c.caseId, complete: true, validFindingIds: i === 0 ? [] : ['missing-guard'] })),
  };
  return { manifest, submissions, adjudications };
}
