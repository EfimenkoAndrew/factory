// KI-E110 (2026-09-02) — PROJECTED BATCH COST, in the same unit the yield report measures.
//
// KI-E88 gave `suggest` a band-mix line (how many LIGHT vs FULL), which tells the operator the SHAPE
// of a batch but not its SIZE. Meanwhile KI-E107 reports ACTUAL agent-call spend per outcome. Those
// two only become useful together: a projection in a different unit from the measurement cannot be
// checked against it, so it never gets calibrated and quietly turns into folklore.
//
// So this projects in physical agent invocations — the exact unit `item_folded`'s cost map records
// and KI-E107's yield table aggregates. An operator can compare a projection against last cycle's
// real calls/item and see whether the model is honest. A prettier estimate in tokens or dollars
// would be strictly worse, because KI-E66 established per-item tokens are not recoverable and any
// currency figure would be fabricated.
//
// Superseded the original flat BASE_CALLS/GATE_CALLS/REVIEW_CALLS/PLANNER_CALLS constants (ported
// from a host-mount session): the pipeline grew far more pre-band/checkpoint/collector stages than a
// single per-band constant could represent honestly. `projectedCallBreakdown` below exposes every
// counted component by name so a caller (or a human comparing against a real execSmoke trace) can
// see exactly what is and is not being counted, not just a single opaque total.
// See `_workflow/CALIBRATION.md § Conditional call projections` for the fixture-verified counts this
// model is checked against.
//
// RECONCILED 2026-09-27 against a live execSmoke trace of the CURRENT factory.js (light-code=39,
// light-doc=27, full-code=45 physical calls — see CALIBRATION.md) after KI-E469/E220-E259 added many
// mandatory pre-band stages this formula never re-synced against. Two categories of finding:
//  (a) MISSING real stages, now added below: testAuthor; the mechanical fixer's own phantom-manifest
//      self-correction loop (calibrated against the default execSmoke stub: 4 fixer dispatches incl.
//      3 inline phantom-manifest-probe rechecks); a SEPARATE, always-on pre-band phantom-manifest-
//      probe pass (prebandPhantomManifest, distinct from the fixer-loop's own inline checks); the
//      red-proof-probe/rootcause-probe dispatches THEMSELVES (redProofProbe/rootCauseProbe) — these
//      always run for a codeChange item; the pre-existing `redProof`/`rootCause` fields only ever
//      counted a CONDITIONAL bounded-amend fallback beyond that base probe, never the probe call
//      itself, which is why they stayed correct and are UNCHANGED here; review-nfr, registration-
//      drift-probe, docsync-probe, concurrency-scan-probe, vacuous-test-scan-probe (all codeChange-
//      unconditional, same shape as the pre-existing `leftover` field); a second "amend cycle" runner
//      re-verify + postamend-probe pass for codeChange items; pack-hash-probe (unconditional); the
//      integrator dispatch (unconditional, was never modeled at all). `planCommitment` is PROMOTED
//      from an opt-in condition flag to unconditional: it fired in all three live-traced fixtures with
//      no counterexample, consistent with KI-E469 giving every item a real plan to check commitments
//      against.
//  (b) DEAD stages, confirmed via `git log -S` to have been introduced in ONE bulk merge
//      (f05c98389, "consume standalone factory repo's evolved capability") that this repo's factory.js
//      never actually implemented: `admission` (a driver-level bookkeeping event in
//      driver-integration.mjs's admitAttempt/observeAdmission, not an agent dispatch at all — it was
//      never going to show up as a physical call), `evidenceIdentity`'s nonzero default, and the
//      progress-writer-based `initialVerificationPreparation`/`integrationPreparation`/
//      `postPlanCheckpoint`/`postTestCheckpoint` (factory.js has never contained a "progress-writer"
//      label in its history). These fields are KEPT (zeroed, some still conditions-overridable) rather
//      than deleted, so the breakdown's shape stays stable for any caller already destructuring it —
//      but they no longer silently inflate the total for a capability this repo's factory.js does not
//      have. `implementation`/`implementationChecks`'s fixed counts are the DEFAULT execSmoke stub's
//      deterministic behavior (a calibration constant for these specific fixtures), not a claim about
//      how many attempts a real LLM needs — same "floor, not exact" caveat the render text carries.
export function projectedCallBreakdown(item = {}, band, conditions = {}) {
  const full = band === 'FULL';
  const files = (item.files || []).map((f) => f.replace(/\\/g, '/'));
  const docFile = (f) => /\.md$/i.test(f) || /(^|\/)docs?\//i.test(f);
  const code = files.length ? files.some((f) => !docFile(f)) : true;
  const codeChange = conditions.codeChange ?? (files.length ? files.some((f) => /\.cs$/.test(f)) : true);
  const doc = files.some(docFile);
  // KI-E469 (2026-09-02, factory.js:445 `planner: crit ? RT.planner : RT.plannerMech`) gave the
  // mechanical tier its own real planner dispatch (sonnet decides the approach, haiku executes) —
  // every item now plans, none is routed to a null/skipped planner.
  const planner = 3;
  const lenses = new Set(['code']);
  if (full) {
    const theme = (item.theme || '').toLowerCase();
    if (/security|auth|crypto|multitenan|token|secret/.test(theme)) lenses.add('security');
    if (/concurren|idempoten|race|dataflow|money|payment|financ/.test(theme)) lenses.add('edge-case');
    if (/architect|layer|design|cross-service|contract/.test(theme) || item.severity === 'CRITICAL') lenses.add('architecture');
  }
  const components = {
    admission: 0, // dead — driver-level bookkeeping, not a physical agent dispatch; see header note
    testAuthor: 1,
    implementation: 4, // fixer dispatches; default-stub calibrated (see header note)
    implementationChecks: 3, // inline phantom-manifest-probe rechecks, one per non-final fixer attempt
    runner: 1, // the base build+test verify pass — always runs at least once
    initialVerificationPreparation: 0, // dead — no "progress-writer" label ever existed; see header note
    integrationPreparation: 0, // dead — same as above
    checkpoints: 5,
    postPlanCheckpoint: 0, // dead — checkpoints:5 already counts every real checkpoint write
    postTestCheckpoint: 0, // dead — same as above
    planAndTwoReviews: planner,
    roleGates: full ? (item.gateSet?.length || 5) : 2,
    methodReviews: code ? 3 : 2,
    editorial: doc ? 2 : 0,
    earlyEdge: code ? 1 : 0,
    redProofProbe: codeChange ? 1 : 0, // the probe call itself — always runs on a codeChange item
    redProof: codeChange && conditions.redProofFallback === true ? 1 : 0, // a bounded amend BEYOND the probe
    rootCauseProbe: codeChange ? 1 : 0,
    rootCause: codeChange && conditions.rootCauseFallback === true ? 1 : 0,
    prebandPhantomManifest: codeChange ? 1 : 0, // separate from implementationChecks — this one is pre-band, unconditional per item
    reviewNfr: codeChange ? 1 : 0,
    leftover: codeChange ? 1 : 0,
    registrationDrift: codeChange ? 1 : 0,
    docSync: codeChange ? 1 : 0,
    concurrencyScan: codeChange ? 1 : 0,
    vacuousTestScan: codeChange ? 1 : 0,
    runnerAmend: codeChange ? 1 : 0, // second verify pass after the pre-band amend cycle
    postamendProbe: codeChange ? 1 : 0,
    packHashProbe: 1,
    planCommitment: 1, // promoted from opt-in — fires unconditionally now (see header note)
    evidenceIdentity: conditions.identityCalls ?? 0, // default changed 4->0; still overridable, see header note
    integrator: 1,
    refuter: full || conditions.needsRealInfra === true ? 1 : 0,
    reaudit: lenses.size,
  };
  for (const name of ['redCoverage', 'acceptanceScan', 'efProbe', 'breadthProbe', 'ledgerProbe', 'commentProbe', 'shadowScan', 'realInfraMarker', 'mainDriftProbe', 'priorFindingProbe']) {
    components[name] = conditions[name] === true ? 1 : 0;
  }
  if (!Number.isInteger(components.evidenceIdentity) || components.evidenceIdentity < 0) throw new TypeError('identityCalls must be a nonnegative integer');
  return { total: Object.values(components).reduce((sum, n) => sum + n, 0), components,
    assumptions: 'Fresh successful native item path; one physical invocation per dispatch; default review flows. The mechanical fixer\'s own phantom-manifest self-correction loop is counted as part of a normal successful path (calibrated against the default execSmoke stub); retries/amends BEYOND that, plus fallback, adjudication, plan nudge, and final-verification refresh, are not. Pre-band probes (red-proof/rootcause/leftover/registration-drift/docsync/concurrency/vacuous-test/review-nfr) count once per codeChange item; their bounded-amend fallbacks (redProofFallback/rootCauseFallback) count only when explicitly enabled. Conditional probes outside that set count only when explicitly enabled; absent files assume code. Early failure and reuse may cost less. SWEEP site admission requires separate calibration.' };
}

export function projectedCalls(item, band, conditions) {
  return projectedCallBreakdown(item, band, conditions).total;
}

// Batch roll-up: { total, byBand: { LIGHT: {items, calls}, FULL: {...} } }. `conditionsOf(wi)`, when
// given, supplies the per-item conditions object `projectedCalls` accepts (redCoverage/redProofFallback/
// identityCalls/etc.) — omitted, every item projects on its fresh-success/no-fallback defaults.
export function projectBatch(items, bandOf, conditionsOf) {
  const byBand = {};
  let total = 0;
  for (const wi of items || []) {
    const b = (bandOf ? bandOf(wi) : 'LIGHT') === 'FULL' ? 'FULL' : 'LIGHT';
    const c = projectedCalls(wi, b, conditionsOf ? conditionsOf(wi) : undefined);
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
  const parts = ['LIGHT', 'FULL'].filter((b) => proj.byBand[b])
    .map((b) => `${proj.byBand[b].items} ${b} x ~${Math.round(proj.byBand[b].calls / proj.byBand[b].items)}`);
  return `projected ~${proj.total} native agent invocations (${parts.join(' + ')}) — conditional fresh-success floor including the planner + two plan reviews, test-author, the fixer's own phantom-manifest self-correction loop, five checkpoints, the standard pre-band probe set for a code change (red-proof/rootcause/leftover/registration-drift/docsync/concurrency/vacuous-test/review-nfr/phantom-manifest/plan-commitment), a pack-hash refresh, role gates, method reviews, the re-auditor, and the integrator. Retries/amends/adjudication and any explicitly-enabled optional probe add calls beyond this floor. Reuse or early failure can cost less. Physical invocations are not legacy successful-call cost maps, API requests, tokens or bills.`;
}
