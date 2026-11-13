// tools/ai-factory/_workflow/opencode/routing.mjs
//
// OPENCODE ADAPTER (KI-O1). Verbatim port of factory.js's routing/band/flow-selection logic
// (lines ~104-217 of _workflow/factory.js as of this port — diff against that file if it changes).
// Pure functions, no side effects, no model calls.
//
// FIDELITY GAP, CLOSED (previously documented as open — see `roleRoute` below): factory.js's
// `agent(prompt, opts)` can select a MODEL PER CALL (opus for hard gates, fable-5 for planner/
// adjudicator, haiku for cheap probes, sonnet for the rest) because Claude Code's native Workflow
// runtime exposes that as an `opts.model` parameter. OpenCode's own `Task` tool still has no
// equivalent (every subagent call dispatched THROUGH `Task` runs on whatever model backs the chosen
// `subagent_type`, fixed for the whole session) — but `dispatcher.mjs` + `server-api.mjs` now give a
// host an alternate path that DOES honour per-call routing: `roleRoute` resolves the intended
// model/effort for a call (applying the launch-time RT/FLOW_RT snapshot when the host captured one,
// so a routing.mjs edit mid-run cannot retroactively change an in-flight attempt's cost accounting),
// and `server-api.mjs` applies that to each fresh worker session it spins up. The legacy `Task`-only
// path (this file's RT/FLOW_RT tables consulted purely as intended-routing metadata for `res.cost`
// bookkeeping / audit-trail honesty, exactly as before) remains fully supported for a host that has
// not wired the dispatcher/server-api path — `roleRoute` degrades to that same metadata-only RT/
// FLOW_RT lookup when no `routing` snapshot is supplied. See KNOWN-ISSUES.md KI-O1 for the original
// writeup; actual-model accounting must still never silently claim the intended tier ran when the
// legacy Task path is what actually executed the call.

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
// KI-E468 (2026-09-02): fixerMech/testMech routed to claude-haiku-4-5 — the mechanical HANDS. See
// factory.js RT's KI-E468 comment for the full history (this is a re-attempt of a reverted experiment)
// and KI-E469 for the sonnet plannerMech that now briefs them. Supersedes the KI-E92 sonnet-4-6 routing.
export const RT = {
  fixerMech: { model: 'claude-haiku-4-5', effort: 'medium' }, fixerCrit: { model: 'claude-opus-4-8', effort: 'high' },
  fixerStepCrit: { model: 'claude-sonnet-4-6', effort: 'high' }, // KI-E473 — see factory.js RT
  fixerConsolidate: { model: 'claude-sonnet-4-6', effort: 'high' }, // KI-E472 — see factory.js RT
  testMech: { model: 'claude-sonnet-4-6', effort: 'high' }, testCrit: { model: 'claude-opus-4-8', effort: 'high' },
  planner: { model: 'claude-fable-5', effort: 'high', attempts: 1, fallback: { model: 'claude-opus-4-8', effort: 'high' } }, // KI-E261 -- attempts mirrored for RT-table parity; NOT YET wired into dispatcher.mjs's own retry loop (a separate mechanism from factory.js's tryAgent) -- this field is currently inert on the opencode dispatch path
  plannerMech: { model: 'claude-sonnet-4-6', effort: 'high' }, // KI-E469 — see factory.js RT
  runner: { model: 'claude-sonnet-4-6', effort: 'medium' },
  gArch: { model: 'claude-opus-4-8', effort: 'high' }, gDev: { model: 'claude-sonnet-4-6', effort: 'high' },
  gQa: { model: 'claude-sonnet-4-6', effort: 'high' }, gSec: { model: 'claude-opus-4-8', effort: 'high' }, gPo: { model: 'claude-sonnet-4-6', effort: 'high' }, // KI-E253 (gPo). gSec: KI-E258 reverted by KI-E259 same day (2026-09-27) -- security stays real opus unconditionally
  rCode: { model: 'claude-opus-4-8', effort: 'high' }, rAdv: { model: 'claude-opus-4-8', effort: 'high' }, rAdvMech: { model: 'claude-sonnet-4-6', effort: 'high' }, // KI-E253
  rEdge: { model: 'claude-sonnet-4-6', effort: 'high' }, rTest: { model: 'claude-sonnet-4-6', effort: 'high' }, rNfr: { model: 'claude-sonnet-4-6', effort: 'medium' }, // KI-E253: decoupled from rEdge
  refuter: { model: 'claude-opus-4-8', effort: 'high' }, reauditor: { model: 'claude-sonnet-4-6', effort: 'high' }, integrator: { model: 'claude-sonnet-4-6', effort: 'high' },
  adjudicator: { model: 'claude-fable-5', effort: 'max', attempts: 1, fallback: { model: 'claude-opus-4-8', effort: 'max' } }, decisionFramer: { model: 'claude-opus-4-8', effort: 'medium' }, // KI-E261 -- attempts mirrored, same inert-on-this-path note as RT.planner above
};
export const FLOW_RT = {
  'review.code': RT.rCode, 'review.adversarial': RT.rAdv, 'review.edgecase': RT.rEdge, 'review.testreview': RT.rTest,
  'review.editorial_structure': { model: 'claude-sonnet-4-6', effort: 'medium' }, 'review.editorial_prose': { model: 'claude-sonnet-4-6', effort: 'medium' },
  'review.nfr': RT.rNfr, // KI-E253: decoupled from rEdge, own tier
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
  // KI-E253: this push existed in factory.js's flowsFor (KI-E249) but was never mirrored here — the
  // opencode dispatch path has never actually run the NFR review stage at all. Matches factory.js
  // exactly: every code item, advisory-only ('nfr' band, not 'method' — never blocks by itself).
  if (code) out.push({ skill: 'bmad-testarch-nfr', routeKey: 'review.nfr', band: 'nfr', blocking: false });
  return out;
}

export function routesFor(item) {
  const crit = item.fixType !== 'mechanical';
  const flows = {};
  // KI-E253: see factory.js's identical comment — review.adversarial ran on opus for every item
  // regardless of complexity; split on the same crit signal every other role here already uses.
  for (const f of flowsFor(item)) flows[f.routeKey] = f.routeKey === 'review.adversarial' ? (crit ? RT.rAdv : RT.rAdvMech) : (FLOW_RT[f.routeKey] || RT.rAdv);
  return {
    planner: crit ? RT.planner : RT.plannerMech, testAuthor: crit ? RT.testCrit : RT.testMech, fixer: crit ? RT.fixerCrit : RT.fixerMech, // KI-E469
    fixerStep: crit ? RT.fixerStepCrit : RT.fixerMech, // KI-E473 — stepwise STEP calls only; mechanical steps stay on the haiku hands
    fixerConsolidate: crit ? RT.fixerCrit : RT.fixerConsolidate, // KI-E472
    runner: RT.runner, gates: { architect: RT.gArch, developer: RT.gDev, qa: RT.gQa, security: RT.gSec, po: RT.gPo },
    refuter: RT.refuter, reauditor: RT.reauditor, integrator: RT.integrator, adjudicator: RT.adjudicator, decisionFramer: RT.decisionFramer, reviewFlows: flows,
  };
}

// Per-call routing resolution — the actual consumer of routesFor()'s per-role breakdown (closes the
// fidelity gap documented above). `call` is the dispatch descriptor runtime.mjs's agentStep builds
// ({role, routeKey?, lens?, ...}); `routing` is the OPTIONAL launch-time RT/FLOW_RT snapshot
// (`progress.routing`, captured once at init from the enriched launch payload) — when present it is
// authoritative over the live tables here, so a routing.mjs edit mid-attempt can never retroactively
// change an in-flight item's recorded cost tier. Falls back to a cheap haiku/low guess only when
// NEITHER the snapshot nor the live tables resolve a route (should not happen for a known role).
export function roleRoute(item, call, routing) {
  const r = routesFor(item);
  const crit = item.fixType !== 'mechanical';
  // KI-E472/E120 (host-local, ported from factory.js): the stepwise fixer STEP calls and the
  // whole-diff CONSOLIDATE pass share call.role === 'fixer' with a plain single-shot fix (runtime.mjs
  // never dispatches a distinct 'fixer-step' role — see stepwiseSteps()/planNext's 'fix'/
  // 'fix_consolidate' phases), so they cannot be told apart via the keys/rtKeys maps below by role
  // alone. runtime.mjs stamps `call.fixerPhase` ('step' | 'consolidate') ONLY on those two dispatch
  // shapes; every other caller (including a host driving this file directly, or a future producer
  // that never sets the field) falls straight through to the generic 'fixer' resolution beneath,
  // so this is a pure additive branch — never a behaviour change for an unmarked call.
  if (call.role === 'fixer' && call.fixerPhase === 'step') {
    const RT_ = routing?.RT || RT;
    return (crit ? RT_.fixerStepCrit : RT_.fixerMech) || r.fixerStep || { model: 'claude-haiku-4-5', effort: 'low' };
  }
  if (call.role === 'fixer' && call.fixerPhase === 'consolidate') {
    const RT_ = routing?.RT || RT;
    return (crit ? RT_.fixerCrit : RT_.fixerConsolidate) || r.fixerConsolidate || { model: 'claude-haiku-4-5', effort: 'low' };
  }
  const keys = { planner: 'planner', 'test-author': 'testAuthor', fixer: 'fixer', refuter: 'refuter', 're-auditor': 'reauditor', integrator: 'integrator', adjudicator: 'adjudicator', 'decision-framer': 'decisionFramer' };
  const flow = call.routeKey || Object.entries(SKILL_ROLE).find(([, role]) => role === call.role)?.[0];
  const flowKey = call.routeKey || flowsFor(item).find(f => f.skill === flow)?.routeKey;
  const selected = call.role.startsWith('gate-') ? r.gates[call.role.slice(5)] : flowKey ? r.reviewFlows[flowKey] : r[keys[call.role]];
  const rtKeys = { planner: crit ? 'planner' : 'plannerMech', 'test-author': item.fixType === 'mechanical' ? 'testMech' : 'testCrit', fixer: item.fixType === 'mechanical' ? 'fixerMech' : 'fixerCrit', 'gate-architect': 'gArch', 'gate-developer': 'gDev', 'gate-qa': 'gQa', 'gate-security': 'gSec', 'gate-po': 'gPo', refuter: 'refuter', 're-auditor': 'reauditor', integrator: 'integrator', adjudicator: 'adjudicator', 'decision-framer': 'decisionFramer' };
  // KI-E253: review.adversarial's own model is per-item crit-conditional (see routesFor above), but a
  // launch-time routing snapshot's FLOW_RT is a single static value (built once from config, no item
  // awareness) — letting it win here would silently re-apply opus to every item regardless of crit,
  // exactly the blanket behavior this fix removes. Route it through the snapshot's crit-aware RT key
  // instead of its flat FLOW_RT entry; every other flow keeps the original snapshot-first priority.
  if (flowKey === 'review.adversarial') return selected || routing?.RT?.[crit ? 'rAdv' : 'rAdvMech'] || { model: 'claude-haiku-4-5', effort: 'low' };
  return routing?.FLOW_RT?.[flowKey] || routing?.RT?.[rtKeys[call.role]] || selected || { model: 'claude-haiku-4-5', effort: 'low' };
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
// KI-E103 (2026-09-02): this constant had DRIFTED from factory.js's canonical copy — it was still the
// pre-KI-E97 pattern. KI-E97 (2026-08-29) narrowed the bare `concurren` catch-all after FIVE live
// false-positive incidents and added the hyphen-normalised separators + `concurrencyexception`, but
// only factory.js was updated (KI-E97's own row lists no opencode mirror, unlike KI-E92's, which is
// why the drift went unnoticed). The stale copy both OVER-fired — "~10 concurrent 100MB downloads",
// "do not group concurrently with X", "serialize against any concurrent work", "max 10 concurrent)"
// each demanded a Testcontainers marker the item's fix cannot produce, making those items
// structurally UNCLOSABLE in this port while closable in canon — and UNDER-fired on the hyphenated
// `unique-constraint` shape, losing its real-infra floor. Now a byte-identical port of factory.js's
// definition; `lib/port-parity.mjs` + the selftest pin that byte-parity so this class cannot recur.
export const REALINFRA_SIGNAL = /race condition|\brace\b|lost update|toctou|isolation level|serializable|deadlock|advisory lock|unique[\s-]+(constraint|index)|23505|fromsql|raw sql|rowversion|optimistic[\s-]+concurren|pessimistic|\bfor update\b|interleav|double-?spend|idempoten.*(dup|race|concurrent)|concurrencyexception|(?<!\bare\s)(?<!\bis\s)concurren\w*\b(?!\))(?!\s+\d)(?!(ly)?\s+(with|to|against)\b)(?!\s+(\w+\s+)?(downloads?|requests?|clients?|users?|sessions?|connections?|tabs?|calls?|work)\b)/;

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
