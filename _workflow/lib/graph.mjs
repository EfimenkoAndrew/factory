// Findings-graph load + READY computation (DAG deps + file locks + layer order).
import { existsSync } from 'node:fs';
import { readJson } from './ledger.mjs';
import { lockedFiles, conflictFor } from './locks.mjs';

const LAYER_RANK = { lib: 0, platform: 0, infra: 1, service: 2, portal: 3 };
const SEV_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

export function loadGraph(path) {
  if (!existsSync(path)) return { items: [] };
  const g = readJson(path);
  if (!g.items) g.items = [];
  return g;
}

export function byId(graph) {
  return Object.fromEntries((graph.items || []).map((w) => [w.id, w]));
}

// Schedulable items: ledger state is re-queueable (READY/FAILED/CONFLICT), all
// dependsOn are CLOSED, attempts under the retry bound, and no file-lock conflict
// with an in-flight item. Sorted CRITICAL-first, then libs->services->portals.
// `opts`: { maxItemRetries, target?, themes?, includeEscalate? }.
export function computeReady(graph, ledger, opts) {
  const o = opts || {};
  const items = byId(graph);
  const locks = lockedFiles(graph, ledger);
  const out = [];
  for (const wi of graph.items || []) {
    const row = ledger.items[wi.id];
    if (!row) continue;
    if (!['READY', 'FAILED', 'CONFLICT'].includes(row.state)) continue;
    if (o.target && wi.target !== o.target) continue;
    if (o.themes && o.themes.length && !o.themes.includes(wi.theme)) continue;
    if (wi.autonomyTier === 'blocked') continue;
    if (wi.autonomyTier === 'escalate' && !o.includeEscalate) continue;
    // KI-L41 — per-row EFFECTIVE bound: maxItemRetries + any convergence bonus the fold granted
    // (row.retryBonus). Mirrors escalateExhausted so scheduling and parking never disagree.
    if (typeof o.maxItemRetries === 'number' && row.attempts > o.maxItemRetries + (row.retryBonus || 0)) continue;
    const depsClosed = (wi.dependsOn || []).every((d) => ledger.items[d] && ledger.items[d].state === 'CLOSED');
    if (!depsClosed) continue;
    const conflict = conflictFor(wi, locks);
    if (conflict) continue;
    out.push(wi);
  }
  out.sort((a, b) => {
    const s = (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9);
    if (s) return s;
    const l = (LAYER_RANK[a.layer] ?? 5) - (LAYER_RANK[b.layer] ?? 5);
    if (l) return l;
    return a.id.localeCompare(b.id);
  });
  return out;
}

// Items waiting only on unmet deps (for status visibility).
export function waitingOnDeps(graph, ledger) {
  const out = [];
  for (const wi of graph.items || []) {
    const row = ledger.items[wi.id];
    if (!row || row.state !== 'READY') continue;
    const unmet = (wi.dependsOn || []).filter((d) => !ledger.items[d] || ledger.items[d].state !== 'CLOSED');
    if (unmet.length) out.push({ id: wi.id, unmet });
  }
  return out;
}
