// KI-B1 — routing-drift guard. factory.js MUST inline its RT/FLOW_RT routing table (the Workflow runtime
// cannot read config/model-routing.json), so the inline copy and the config can silently diverge. This
// reads factory.js as TEXT, brace-matches + evaluates the RT + FLOW_RT object literals (pure literals of
// {model, effort} — safe to eval in a no-scope Function), and compares the load-bearing routes against
// model-routing.json. Returns a list of drift strings (empty = in sync). Run from lib/_selftest.mjs.
import { readFileSync } from 'node:fs';

function extractLiteral(src, name) {
  const start = src.indexOf('const ' + name + ' =');
  if (start < 0) return null;
  const open = src.indexOf('{', start); // tolerate any whitespace between '=' and '{'
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

function evalLiteral(lit, scope) {
  if (!lit) throw new Error('literal not found');
  const keys = Object.keys(scope || {});
  // eslint-disable-next-line no-new-func
  return Function(...keys, '"use strict"; return (' + lit + ');')(...keys.map((k) => scope[k]));
}

// factory RT key -> model-routing.json route key (the cost-bearing routes). reauditor was previously
// EXCLUDED (KI-B8 — "intentionally inherit on both sides"); KI-L49 pinned it to an explicit model
// (model:null inherited the session model and died on Fable-5 credit-exhaustion), so it is now
// drift-checked like every other route to keep the two copies from diverging again.
const RT_MAP = {
  fixerMech: 'fixer.mechanical', fixerCrit: 'fixer.critical',
  testMech: 'test_author.mechanical', testCrit: 'test_author.critical',
  planner: 'planner', runner: 'runner',
  gArch: 'gate.architect', gDev: 'gate.developer', gQa: 'gate.qa', gSec: 'gate.security', gPo: 'gate.po',
  rCode: 'review.code', rAdv: 'review.adversarial', rEdge: 'review.edgecase', rTest: 'review.testreview',
  refuter: 'refuter', reauditor: 'reauditor', integrator: 'integrator', adjudicator: 'adjudicator', decisionFramer: 'decision_framer',
};
const FLOW_KEYS = ['review.code', 'review.adversarial', 'review.edgecase', 'review.testreview', 'review.editorial_structure', 'review.editorial_prose'];

// KI-B1 (closed 2026-07-12): build the FACTORY-format routing tables from config/model-routing.json,
// using the SAME mapping the drift guard checks. The driver injects the result into runArgs
// (`routing: {RT, FLOW_RT}`) at group/sweep emit, and factory.js Object.assigns it OVER its inline
// tables — so the config is AUTHORITATIVE at launch and the dual-maintenance drift risk is gone for
// every emitted run. The inline tables remain as the drift-guarded fallback (legacy args launches,
// hand runs, older emitted scripts). Only {model, effort} ride along — the config's extra fields
// (`when`, `escalate_effort`, `on_conflict`) are driver/docs concerns, not factory call opts —
// EXCEPT `fallback: {model, effort}` (KI-D10), which IS a call opt: call() falls back to it when the
// primary model returns null. It rides along so a config-declared fallback is honoured on emitted runs.
export function buildFactoryRouting(routing) {
  const routes = (routing && routing.routes) || {};
  const pick = (k) => {
    const c = routes[k];
    if (!(c && c.model)) return null;
    const v = { model: c.model, effort: c.effort };
    if (c.fallback && c.fallback.model) v.fallback = { model: c.fallback.model, effort: c.fallback.effort };
    return v;
  };
  const RT = {};
  for (const [rtKey, routeKey] of Object.entries(RT_MAP)) { const v = pick(routeKey); if (v) RT[rtKey] = v; }
  const FLOW_RT = {};
  for (const k of FLOW_KEYS) { const v = pick(k); if (v) FLOW_RT[k] = v; }
  return { RT, FLOW_RT };
}

export function checkRoutingDrift(factoryJsPath, routing) {
  const src = readFileSync(factoryJsPath, 'utf8');
  const routes = routing.routes || {};
  const drift = [];
  let RT, FLOW_RT;
  try { RT = evalLiteral(extractLiteral(src, 'RT'), {}); } catch (e) { return ['could not parse RT literal: ' + e.message]; }
  // FLOW_RT references RT (e.g. RT.rCode), so eval it with RT injected into scope.
  try { FLOW_RT = evalLiteral(extractLiteral(src, 'FLOW_RT'), { RT }); } catch (e) { return ['could not parse FLOW_RT literal: ' + e.message]; }
  for (const [rtKey, routeKey] of Object.entries(RT_MAP)) {
    const inline = RT[rtKey], cfg = routes[routeKey];
    if (!inline) { drift.push('RT.' + rtKey + ' missing in factory.js'); continue; }
    if (!cfg) { drift.push('route ' + routeKey + ' missing in model-routing.json'); continue; }
    const cfgModel = cfg.model === 'inherit-audit-wave' ? null : cfg.model;
    if (inline.model !== cfgModel) drift.push('model drift ' + rtKey + ' vs ' + routeKey + ': factory=' + inline.model + ' config=' + cfgModel);
    // KI-D10: a fallback route is a real call opt — drift-check it too, so an inline/config fallback
    // mismatch (or one side declaring a fallback the other lacks) is caught, not silently divergent.
    const inlineFb = (inline.fallback && inline.fallback.model) || null;
    const cfgFb = (cfg.fallback && cfg.fallback.model) || null;
    if (inlineFb !== cfgFb) drift.push('fallback drift ' + rtKey + ' vs ' + routeKey + ': factory=' + inlineFb + ' config=' + cfgFb);
  }
  for (const flowKey of FLOW_KEYS) {
    const inline = FLOW_RT[flowKey], cfg = routes[flowKey];
    if (inline && cfg && inline.model !== cfg.model) drift.push('FLOW_RT drift ' + flowKey + ': factory=' + inline.model + ' config=' + cfg.model);
  }
  return drift;
}
