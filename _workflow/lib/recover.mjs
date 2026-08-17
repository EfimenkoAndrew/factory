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
// From BLOCKED (KI-E34) the same FULL chain applies: the owner ruling is recorded, the operator runs
// `driver reset <id>` (BLOCKED's only legal ledger edge is -> READY), and the fold re-enters via CLAIMED.
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
  // KI-E20 (review fix): `band` is a carried machine-evidence flag too — a FULL-band prior arms the
  // KI-E19 build+suite PAIR rule on the recovery fold as well (recovery is never a lighter path).
  for (const k of ['codeChange', 'needsRealInfra', 'rootCauseFiles', 'verificationOnly', 'integrateRaw', 'band']) {
    if (prior && prior[k] !== undefined) r[k] = prior[k];
  }
  // KI-E34 (review fix): a prior-less recovery (a seed-BLOCKED item that never ran) must not silently
  // take the codeChange=false no-machine-evidence path at the fold override. FILL-prompt the flag —
  // and an UNFILLED marker is a truthy string, so the override demands full code evidence: fails closed.
  if (!prior || prior.codeChange === undefined) r.codeChange = '<FILL: true|false — REQUIRED: true demands RED proof + machine green at the fold override>';
  return r;
}

// KI-E81: the stage sequence a factory.js item transitions through, in order. Mirrors factory.js's
// own res.transitions.push(...) call sites exactly, so a mismatch here is a mismatch there. Kept
// as an ordered list (not a Set) because "which stage is NEXT" is positional.
const STAGE_SEQUENCE = ['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED', 'INTEGRATED'];

// KI-E81: given a FAILED result's own `transitions` array (the authoritative stage-reached
// record — see last-failure.md's "Stage reached" line, also state/items/<id>/last-failure.json)
// and its `gates` map (which carries a `reaudit` string like "code=ok edge-case=ok" or
// "code=NULL" the moment the re-audit stage is REACHED, independent of whether it ultimately
// converged), decide whether this is the narrow "died on exactly ONE late-pipeline stage, with
// gates/refuter already APPROVED" shape a pure infra-outage death repeatedly produces.
//
// Deliberately narrow: only the two cleanest, most common shapes are recognized —
//   - reached REAUDITED, nothing past it -> only `integrator` is missing.
//   - reached REFUTE_OK, nothing past it -> only `re-auditor` is missing; lenses come directly
//     from the ALREADY-RECORDED `gates.reaudit` string (e.g. "code=NULL" -> ['code']), never
//     re-derived — this sidesteps needing to port factory.js's theme/band-based lens-selection
//     logic (reauditLenses()) into driver.mjs, which the Workflow-runtime split (KI-E2) makes
//     awkward to share safely. A multi-lens FULL-band re-audit death, or a death BEFORE
//     REFUTE_OK (refuter itself missing, or no gate ever ran), returns stage:null — the caller
//     falls back to a normal re-group for those.
export function missingStageFrom(transitions, gates) {
  const stages = Array.isArray(transitions) ? transitions : [];
  const last = stages.length ? stages[stages.length - 1] : null;
  if (last === 'REAUDITED') return { stage: 'integrator', lenses: [] };
  if (last === 'REFUTE_OK') {
    const reaudit = gates && typeof gates.reaudit === 'string' ? gates.reaudit : '';
    const lenses = reaudit.split(/\s+/).filter(Boolean).map((pair) => pair.split('=')[0]).filter(Boolean);
    if (lenses.length) return { stage: 're-auditor', lenses };
  }
  return { stage: null, lenses: [] };
}
