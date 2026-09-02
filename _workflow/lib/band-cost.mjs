// KI-E110 (2026-09-02) — PROJECTED BATCH COST, in the same unit the yield report measures.
//
// KI-E88 gave `suggest` a band-mix line (how many LIGHT vs FULL), which tells the operator the SHAPE
// of a batch but not its SIZE. Its own row states the gap it left open — "roughly a 4x gate-panel
// difference" — as prose the operator has to re-derive mentally every time. Meanwhile KI-E107 now
// reports ACTUAL agent-call spend per outcome. Those two only become useful together: a projection
// in a different unit from the measurement cannot be checked against it, so it never gets calibrated
// and quietly turns into folklore.
//
// So this projects in AGENT CALLS — the exact unit `item_folded`'s cost map records and KI-E107's
// yield table aggregates. An operator can compare a projection against last cycle's real calls/item
// and see whether the model is honest. That comparability is the whole point; a prettier estimate in
// tokens or dollars would be strictly worse, because KI-E66 established per-item tokens are not
// recoverable and any currency figure would be fabricated.
//
// The counts below are DERIVED from what the pipeline actually dispatches, not invented: each is a
// stage `factory.js runItem()` calls exactly once on the happy path. They are a FLOOR, and the
// function says so — retries, amends, adjudication and re-gates all add calls, and a FAILED item
// re-bands up to `maxItemRetries + maxBonusRounds` times. Under-promising is the safe direction for
// a planning aid: an operator surprised by a cheaper batch changes nothing, one surprised by an
// expensive batch has already spent it.

// Stages every item pays regardless of band (test-author, fixer, runner/verify, integrator,
// checkpoint) plus the always-on pre-band probes (red-proof, rootcause, leftover-classify).
const BASE_CALLS = 8;

// Band A role gates: LIGHT runs developer+qa; FULL runs the full five-role panel.
const GATE_CALLS = { LIGHT: 2, FULL: 5 };

// Band B method review flows (code/adversarial/edgecase/testreview) + refuter + re-audit lenses.
// LIGHT may skip the refuter (KI-E12/P7) and runs a single-lens re-audit; FULL runs the panel.
const REVIEW_CALLS = { LIGHT: 3, FULL: 7 };

// The planner runs only for a non-mechanical item (factory.js: `crit = item.fixType !== 'mechanical'`).
const PLANNER_CALLS = 1;

export function projectedCalls(item, band) {
  const b = band === 'FULL' ? 'FULL' : 'LIGHT';
  const planner = (item && item.fixType === 'mechanical') ? 0 : PLANNER_CALLS;
  return BASE_CALLS + GATE_CALLS[b] + REVIEW_CALLS[b] + planner;
}

// Batch roll-up: { total, byBand: { LIGHT: {items, calls}, FULL: {...} } }.
export function projectBatch(items, bandOf) {
  const byBand = {};
  let total = 0;
  for (const wi of items || []) {
    const b = (bandOf ? bandOf(wi) : 'LIGHT') === 'FULL' ? 'FULL' : 'LIGHT';
    const c = projectedCalls(wi, b);
    const slot = byBand[b] = byBand[b] || { items: 0, calls: 0 };
    slot.items += 1;
    slot.calls += c;
    total += c;
  }
  return { total, byBand };
}

// One line for `suggest`/`group`. Renders the FULL-vs-LIGHT per-item delta explicitly, because that
// ratio is the single largest cost lever the operator actually controls at scheduling time.
export function renderProjection(proj) {
  if (!proj || !proj.total) return '';
  const parts = ['LIGHT', 'FULL']
    .filter((b) => proj.byBand[b])
    .map((b) => `${proj.byBand[b].items} ${b} x ~${Math.round(proj.byBand[b].calls / proj.byBand[b].items)}`);
  return `projected ~${proj.total} agent calls (${parts.join(' + ')}) — a floor: retries/amends/adjudication add more, and a FAILED item re-bands. Same unit as the KI-E107 yield report, so compare it against last cycle's real calls/item.`;
}
