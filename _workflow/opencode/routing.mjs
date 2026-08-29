// tools/ai-factory/_workflow/opencode/routing.mjs
//
// OPENCODE ADAPTER (KI-O1). Verbatim port of factory.js's routing/band/flow-selection logic
// (lines ~104-217 of _workflow/factory.js as of this port — diff against that file if it changes).
// Pure functions, no side effects, no model calls.
//
// IMPORTANT FIDELITY GAP (document honestly, do not paper over): factory.js's `agent(prompt, opts)`
// can select a MODEL PER CALL (opus for hard gates, fable-5 for planner/adjudicator, haiku for cheap
// probes, sonnet for the rest) because Claude Code's native Workflow runtime exposes that as an
// `opts.model` parameter. OpenCode's `Task` tool has no equivalent — every subagent call runs on
// whatever model backs the chosen `subagent_type` ("general"/"explore"), fixed for the whole
// OpenCode session. The RT/FLOW_RT tables below are kept SOLELY as intended-routing metadata (for
// `res.cost` bookkeeping / audit-trail honesty about what SHOULD have run on which tier) — the
// orchocode session must record the ACTUAL model used (its own) in cost/telemetry, never silently
// claim the intended tier ran. See KNOWN-ISSUES.md KI-O1 for the full writeup.

// BMAD review-named skill -> the agent brief that encodes its methodology (agents/<role>.md).
export const SKILL_ROLE = {
  'bmad-code-review': 'review-code',
  'bmad-review-adversarial-general': 'review-adversarial',
  'bmad-review-edge-case-hunter': 'review-edgecase',
  'bmad-testarch-test-review': 'review-testreview',
  'bmad-editorial-review-structure': 'review-editorial-structure',
  'bmad-editorial-review-prose': 'review-editorial-prose',
};

// Intended-routing table (metadata only — see fidelity-gap note above). Verbatim from factory.js RT.
// KI-E92 (2026-08-28): fixerMech/testMech routed to claude-sonnet-4-6 — see factory.js RT's KI-E92 comment.
export const RT = {
  fixerMech: { model: 'claude-sonnet-4-6', effort: 'medium' }, fixerCrit: { model: 'claude-opus-4-8', effort: 'high' },
  testMech: { model: 'claude-sonnet-4-6', effort: 'medium' }, testCrit: { model: 'claude-opus-4-8', effort: 'high' },
  planner: { model: 'claude-fable-5', effort: 'high', fallback: { model: 'claude-opus-4-8', effort: 'high' } },
  runner: { model: 'claude-sonnet-5', effort: 'low' },
  gArch: { model: 'claude-opus-4-8', effort: 'high' }, gDev: { model: 'claude-sonnet-5', effort: 'medium' },
  gQa: { model: 'claude-sonnet-5', effort: 'medium' }, gSec: { model: 'claude-opus-4-8', effort: 'high' }, gPo: { model: 'claude-opus-4-8', effort: 'medium' },
  rCode: { model: 'claude-opus-4-8', effort: 'high' }, rAdv: { model: 'claude-opus-4-8', effort: 'high' },
  rEdge: { model: 'claude-sonnet-5', effort: 'medium' }, rTest: { model: 'claude-sonnet-5', effort: 'medium' },
  refuter: { model: 'claude-opus-4-8', effort: 'high' }, reauditor: { model: 'claude-sonnet-5', effort: 'medium' }, integrator: { model: 'claude-sonnet-5', effort: 'medium' },
  adjudicator: { model: 'claude-fable-5', effort: 'max', fallback: { model: 'claude-opus-4-8', effort: 'max' } }, decisionFramer: { model: 'claude-opus-4-8', effort: 'medium' },
};
export const FLOW_RT = {
  'review.code': RT.rCode, 'review.adversarial': RT.rAdv, 'review.edgecase': RT.rEdge, 'review.testreview': RT.rTest,
  'review.editorial_structure': { model: 'claude-sonnet-5', effort: 'low' }, 'review.editorial_prose': { model: 'claude-sonnet-5', effort: 'low' },
};

// Derive the applicable BMAD review-flows from files[] — kept in AGREEMENT with factory.js's flowsFor
// (code(if code)+adversarial+test-review always; edge-case for every code item; editorial on doc files).
export function flowsFor(item) {
  if (item.reviewFlows && item.reviewFlows.length) return item.reviewFlows;
  const files = item.files || [];
  const isDoc = (f) => /\.md$/i.test(f) || /(^|\/)docs?\//i.test(f);
  const code = files.some((f) => !isDoc(f));
  const doc = files.some(isDoc);
  const out = [];
  if (code) out.push({ skill: 'bmad-code-review', routeKey: 'review.code', band: 'method', blocking: true });
  out.push({ skill: 'bmad-review-adversarial-general', routeKey: 'review.adversarial', band: 'method', blocking: true });
  if (code) out.push({ skill: 'bmad-review-edge-case-hunter', routeKey: 'review.edgecase', band: 'method', blocking: true });
  out.push({ skill: 'bmad-testarch-test-review', routeKey: 'review.testreview', band: 'method', blocking: true });
  if (doc) out.push({ skill: 'bmad-editorial-review-structure', routeKey: 'review.editorial_structure', band: 'editorial', blocking: false }, { skill: 'bmad-editorial-review-prose', routeKey: 'review.editorial_prose', band: 'editorial', blocking: false });
  return out;
}

export function routesFor(item) {
  const crit = item.fixType !== 'mechanical';
  const flows = {};
  for (const f of flowsFor(item)) flows[f.routeKey] = FLOW_RT[f.routeKey] || RT.rAdv;
  return {
    planner: crit ? RT.planner : null, testAuthor: crit ? RT.testCrit : RT.testMech, fixer: crit ? RT.fixerCrit : RT.fixerMech,
    runner: RT.runner, gates: { architect: RT.gArch, developer: RT.gDev, qa: RT.gQa, security: RT.gSec, po: RT.gPo },
    refuter: RT.refuter, reauditor: RT.reauditor, integrator: RT.integrator, adjudicator: RT.adjudicator, decisionFramer: RT.decisionFramer, reviewFlows: flows,
  };
}

// Re-audit lens set (KI-C10): always 'code', plus theme-relevant lens(es), plus 'architecture' for CRITICAL.
export function reauditLenses(item) {
  const t = (item.theme || '').toLowerCase();
  const out = ['code'];
  if (/security|auth|crypto|multitenan|token|secret/.test(t)) out.push('security');
  if (/concurren|idempoten|race|dataflow|money|payment|financ/.test(t)) out.push('edge-case');
  if (/architect|layer|design|cross-service|contract/.test(t)) out.push('architecture');
  if (item.severity === 'CRITICAL' && out.indexOf('architecture') < 0) out.push('architecture');
  return out.filter((v, i) => out.indexOf(v) === i);
}

// P5 (gate rigor): these themes ALWAYS get the FULL opus gate panel — never LIGHT.
export const BAND_FULL_THEMES = ['security-multitenancy', 'money-correctness', 'idempotency-dataflow', 'concurrency'];
// P2 keyword safety net for a mis-triaged item whose text betrays a real-infra need item.realInfra missed.
export const REALINFRA_SIGNAL = /concurren|race condition|\brace\b|lost update|toctou|isolation level|serializable|deadlock|advisory lock|unique (constraint|index)|23505|fromsql|raw sql|rowversion|optimistic concurren|pessimistic|\bfor update\b|interleav|double-?spend|idempoten.*(dup|race|concurrent)/;

export function bandFor(item) {
  if (item.band === 'LIGHT' || item.band === 'FULL') return item.band;
  if (BAND_FULL_THEMES.indexOf(item.theme) >= 0) return 'FULL';
  if (item.theme === 'doc-drift' || item.fixType === 'mechanical') return 'LIGHT';
  return 'LIGHT';
}

// realInfraLikely / needsRealInfra computation — exact parity with factory.js runItem (~:402
// `realInfraText = (...).toLowerCase()`, ~:410 `pureCoverage = theme === 'test-coverage' &&
// !item.realInfra`, ~:411 the combined expression):
//   1. the haystack is LOWERCASED before REALINFRA_SIGNAL runs (the pattern is all-lowercase — an
//      un-lowered "Race condition in payment settlement" title silently missed the signal, closing
//      an item on an EF in-memory green the native pipeline would park);
//   2. pureCoverage uses `!item.realInfra` (truthiness), NOT `item.realInfra === false` — a
//      test-coverage item with realInfra ABSENT is still pure coverage (KI-L39), so a "deadlock"
//      in its coverage-subject text must NOT re-open the false-fail class the exemption closed.
export function realInfraLikely(item) {
  const pureCoverage = item.theme === 'test-coverage' && !item.realInfra;
  const text = [item.title, item.acceptance, item.regressionTest, item.fixHint].filter(Boolean).join(' ').toLowerCase();
  return !!item.realInfra || (!pureCoverage && REALINFRA_SIGNAL.test(text));
}
export function needsRealInfra(item, filesHaveCs) {
  return !!filesHaveCs && realInfraLikely(item);
}

// Gate-band role set for the current band (factory.js ~769-777): LIGHT drops the opus panel to
// developer+qa only (both forced sonnet); FULL runs whatever gateSet the item/config declares.
export function gateRolesFor(item, band, cfgGateSet) {
  if (band === 'LIGHT') return ['developer', 'qa'];
  if (item.gateSet && item.gateSet.length) return item.gateSet;
  return cfgGateSet || ['architect', 'developer', 'qa', 'security', 'po'];
}
