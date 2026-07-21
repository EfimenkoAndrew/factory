// KI-E20 (2026-07-21, improvement-analysis P2) — pure helpers for `driver.mjs recover <id>`, the
// direct-recovery scaffold. Evidence (07-18 + 07-20 telemetry analyses): the factory's dominant
// close path for FAILED items is no longer the re-band — 8 of the last 9 FAILED-item closes went
// through §4 direct-recovery (controller applies the reviewer-converged remedy + delta re-gate),
// every step HAND-ROLLED: feedback parsed by eye, re-gate prompts hand-assembled from agents/*.md,
// the recovery-fold JSON typed from memory (two live near-misses on the evidence contract — the
// mutation-proof-vs-integrate-raw footgun). These helpers make that path first-class; the driver
// command composes them with IO. Pure: objects in, objects out — selftest-covered.

// The dissenting reviewers of a prior attempt, from its structured gateDetails (KI-L31 — the
// RETURNED verdicts are authoritative, never the prose artifacts). ":re-gate" rows duplicate their
// base key and probe rows have no re-gate brief — both excluded.
export function dissentersFrom(gateDetails) {
  const out = [];
  for (const [key, d] of Object.entries(gateDetails || {})) {
    if (!d || d.verdict !== 'CHANGES_REQUIRED') continue;
    if (key.includes(':re-gate') || key.startsWith('probe:')) continue;
    out.push({ key, headline: d.headline || '', findings: Array.isArray(d.findings) ? d.findings : [] });
  }
  return out;
}

// gate/review result key -> the agents/<role>.md brief that produced it (mirror of factory.js
// SKILL_ROLE + the gate-role convention).
const KEY_ROLE = {
  'review:code-review': 'review-code',
  'review:review-adversarial-general': 'review-adversarial',
  'review:review-edge-case-hunter': 'review-edgecase',
  'review:testarch-test-review': 'review-testreview',
  'editorial:structure': 'review-editorial-structure',
  'editorial:prose': 'review-editorial-prose',
  'adjudicator': 'adjudicator',
};
export function roleForGateKey(key) {
  const k = String(key || '');
  if (KEY_ROLE[k]) return KEY_ROLE[k];
  if (k.startsWith('gate:')) return 'gate-' + k.slice(5);
  return null;
}

// The fold transitions for a recovery result (the KI-L47/KI-L61/KI-L62 pinned shapes): from FAILED
// the FULL re-entry chain (fold auto-claims from CLAIMED); from ESCALATED a single CLOSED hop (the
// item was already fully verified — recovery only records the human-approved sign-off).
export function recoveryTransitions(fromState) {
  return fromState === 'ESCALATED'
    ? ['CLOSED']
    : ['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED', 'INTEGRATED', 'CLOSED'];
}

// The recovery cycle: the cycle of the FAILED attempt (parsed from the prior checkpoint's
// resultId), so the recovery folds as "<id>#<thatCycle>r" — never a guessed current cycle.
export function priorCycleOf(prior, fallback) {
  const m = prior && typeof prior.resultId === 'string' ? prior.resultId.match(/#(\d+)/) : null;
  return m ? parseInt(m[1], 10) : fallback;
}

// The recovery-fold results-file skeleton. attemptsDelta:0 — a recovery consumes NO retry budget
// (the band already burned the attempt); resultId "<id>#<cycle>r" keeps fold idempotency (KI-B4).
// Machine-evidence flags (codeChange/needsRealInfra/rootCauseFiles/verificationOnly/integrateRaw)
// carry over from the prior checkpoint so the fold's deterministic override re-checks the SAME
// contract the band was held to — a recovery is never a lighter evidentiary path.
export function recoveryFoldSkeleton(id, row, prior, cycle) {
  const r = {
    id,
    resultId: id + '#' + cycle + 'r',
    attemptsDelta: 0,
    transitions: recoveryTransitions(row && row.state),
    toState: 'CLOSED',
    worktree: (row && row.worktree) || (prior && prior.worktree) || null,
    branch: (row && row.branch) || (prior && prior.branch) || null,
    gates: { '<FILL: gate:role / review:flow>': 'APPROVED' },
    note: '<FILL: direct-recovery — the applied remedy, the delta re-gate verdicts, and where the machine evidence lives>',
  };
  for (const k of ['codeChange', 'needsRealInfra', 'rootCauseFiles', 'verificationOnly', 'integrateRaw']) {
    if (prior && prior[k] !== undefined) r[k] = prior[k];
  }
  return r;
}
