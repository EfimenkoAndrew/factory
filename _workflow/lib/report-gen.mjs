/**
 * report-gen.mjs — report generation functions extracted from driver.mjs.
 *
 * Extracted to keep driver.mjs under the 384 KB Workflow-tool hard cap (KI-E350) and
 * to make report logic independently testable. Functions that need to resolve paths
 * accept an `abs` callback (the driver's path resolver) so the module stays decoupled
 * from REPO_ROOT.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { countByState, ACTIVE, FORWARD, OFFRAMPS } from './ledger.mjs';
import { waitingOnDeps, byId } from './graph.mjs';

const now = () => new Date().toISOString();

// ---- progress / burndown reports -----------------------------------------------

export function progressMd(cfg, ledger, graph) {
  const counts = countByState(ledger);
  const total = Object.values(ledger.items).length;
  const closed = counts.CLOSED || 0;
  const order = [...FORWARD, ...OFFRAMPS];
  const rows = order.filter((s) => counts[s]).map((s) => `| ${s} | ${counts[s]} |`).join('\n');
  const wait = waitingOnDeps(graph, ledger);
  const inflight = Object.values(ledger.items).filter((r) => ACTIVE.includes(r.state));
  const esc = Object.values(ledger.items).filter((r) => r.state === 'ESCALATED' || r.state === 'BLOCKED');
  const recentClosed = Object.values(ledger.items).filter((r) => r.state === 'CLOSED')
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 10);
  return [
    '# Factory PROGRESS',
    '',
    `_Generated ${now()} · cycle ${ledger.cycle} · ${total} item(s) · ${closed} CLOSED (${total ? Math.round((closed / total) * 100) : 0}%)_`,
    '',
    '## State counts',
    '',
    '| State | Count |',
    '|---|---|',
    rows || '| (none) | 0 |',
    '',
    `## In-flight (${inflight.length})`,
    inflight.length ? inflight.map((r) => `- \`${r.id}\` — ${r.state}${r.worktree ? ' @ ' + r.worktree : ''}`).join('\n') : '_none_',
    '',
    `## Escalated / Blocked (${esc.length}) → see queue/decisions.md`,
    esc.length ? esc.map((r) => `- \`${r.id}\` — ${r.state}${r.note ? ': ' + r.note : ''}`).join('\n') : '_none_',
    '',
    `## Waiting on deps (${wait.length})`,
    wait.length ? wait.map((w) => `- \`${w.id}\` ⟵ ${w.unmet.join(', ')}`).join('\n') : '_none_',
    '',
    `## Recently CLOSED (${recentClosed.length})`,
    recentClosed.length ? recentClosed.map((r) => `- \`${r.id}\` (${r.updatedAt})`).join('\n') : '_none_',
    '',
  ].join('\n');
}

export function burndownMd(cfg, ledger, graph) {
  const items = byId(graph);
  const bySev = { CRITICAL: { total: 0, closed: 0 }, HIGH: { total: 0, closed: 0 }, MEDIUM: { total: 0, closed: 0 }, LOW: { total: 0, closed: 0 } };
  for (const [id, row] of Object.entries(ledger.items)) {
    const wi = items[id]; if (!wi) continue;
    const b = bySev[wi.severity]; if (!b) continue;
    b.total++; if (row.state === 'CLOSED') b.closed++;
  }
  const rows = Object.entries(bySev).map(([s, b]) => `| ${s} | ${b.total} | ${b.closed} | ${b.total - b.closed} |`).join('\n');
  return [
    '# Burn-down',
    '',
    `_Generated ${now()} · cycle ${ledger.cycle}_`,
    '',
    '| Severity | Total | CLOSED | Remaining |',
    '|---|---|---|---|',
    rows,
    '',
    '> CRITICAL→0 and a strictly-monotonic-down finding count are the factory success signals (PLAN.md §11).',
    '',
  ].join('\n');
}

// ---- cost reports ---------------------------------------------------------------

export function costSnapshot(ledger) {
  const byModel = {};
  for (const row of Object.values(ledger.items)) for (const [m, t] of Object.entries(row.cost || {})) byModel[m] = (byModel[m] || 0) + t;
  const total = Object.values(byModel).reduce((a, b) => a + b, 0);
  const closed = Object.values(ledger.items).filter((r) => r.state === 'CLOSED').length;
  const opus = Object.entries(byModel).filter(([m]) => /opus/i.test(m)).reduce((a, [, t]) => a + t, 0);
  // KI-E150 (ported from a host-mount session) — real per-item token totals (factory.js's
  // concurrency-safe budget.spent() attribution), distinct from byModel/total above which only ever
  // counted agent CALLS, never tokens. Summed only over CLOSED items with a real tokensUsed figure —
  // an item folded before this change, or one whose only work was sweep-mode/pre-band-only, may have
  // no tokensUsed at all; excluded rather than silently counted as 0, so totalTokens/tokensPerClosed
  // don't understate the true average.
  const closedWithTokens = Object.values(ledger.items).filter((r) => r.state === 'CLOSED' && typeof r.tokensUsed === 'number' && r.tokensUsed > 0);
  const totalTokens = closedWithTokens.reduce((a, r) => a + r.tokensUsed, 0);
  return { cycle: ledger.cycle, byModel, total, closed, callsPerClosed: closed ? Math.round(total / closed * 10) / 10 : null, opusShare: total ? Math.round(opus / total * 100) / 100 : 0, totalTokens, closedWithTokens: closedWithTokens.length, tokensPerClosed: closedWithTokens.length ? Math.round(totalTokens / closedWithTokens.length) : null };
}

// KI-E150 — the N most token-expensive CLOSED items (real per-item totals, not call counts). Bounded
// so this stays a report, not a full ledger dump; sorted desc so the costliest work is always visible
// first regardless of how many items have a recorded tokensUsed.
export function topTokenItems(ledger, n) {
  return Object.entries(ledger.items)
    .filter(([, r]) => r.state === 'CLOSED' && typeof r.tokensUsed === 'number' && r.tokensUsed > 0)
    .sort((a, b) => b[1].tokensUsed - a[1].tokensUsed)
    .slice(0, n)
    .map(([id, r]) => ({ id, tokensUsed: r.tokensUsed }));
}

/**
 * @param {function} abs — driver's path resolver (p => presolve(REPO_ROOT, p))
 */
export function readCostHistory(cfg, abs) {
  const p = join(abs(cfg.paths.reports), 'cost-history.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Append a per-cycle cost snapshot (last-write-wins per cycle) — the trend source for the cost report.
// Called on cost-changing events (fold) + the explicit `cost` command. This is OBSERVABILITY only —
// there is NO budget gate / governor (owner direction 2026-06-27).
/**
 * @param {function} abs — driver's path resolver
 */
export function recordCostSnapshot(cfg, ledger, abs) {
  mkdirSync(abs(cfg.paths.reports), { recursive: true });
  const p = join(abs(cfg.paths.reports), 'cost-history.jsonl');
  const lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
  const snap = JSON.stringify({ at: now(), ...costSnapshot(ledger) });
  let prevCycle = null;
  if (lines.length) { try { prevCycle = JSON.parse(lines[lines.length - 1]).cycle; } catch { /* ignore */ } }
  if (prevCycle === ledger.cycle) lines[lines.length - 1] = snap; else lines.push(snap);
  writeFileSync(p, lines.join('\n') + '\n');
}

export function costMd(ledger, history) {
  const s = costSnapshot(ledger);
  const rows = Object.entries(s.byModel).sort((a, b) => b[1] - a[1]).map(([m, t]) => `| ${m} | ${t} | ${s.total ? Math.round(t / s.total * 100) : 0}% |`).join('\n');
  // Marginal column (2026-07-12): the cumulative Calls/closed average HIDES a failing recent cycle —
  // cycle 31's marginal cost was 24 calls/close while the cumulative read 13.5. Δ is vs the previous
  // history row; "n/+0" flags a cycle that spent calls and closed nothing (the loudest signal here).
  const hs = history || [];
  const marginalOf = (h) => {
    const i = hs.indexOf(h);
    const prev = i > 0 ? hs[i - 1] : null;
    const dCalls = h.total - (prev ? prev.total : 0);
    const dClosed = h.closed - (prev ? prev.closed : 0);
    if (dClosed > 0) return String(Math.round((dCalls / dClosed) * 10) / 10);
    return dCalls > 0 ? `${dCalls}/+0` : '—';
  };
  const trend = hs.slice(-10).map((h) => `| ${h.cycle} | ${h.total} | ${h.closed} | ${h.callsPerClosed ?? '—'} | ${marginalOf(h)} | ${Math.round((h.opusShare || 0) * 100)}% |`).join('\n');
  // KI-E150 (ported from a host-mount session) — real per-item token totals now exist (factory.js's
  // concurrency-safe budget.spent() attribution, ledger.mjs's foldResults accumulation). Rendered
  // alongside the pre-existing call-count table rather than replacing it — call counts are still the
  // "who did the work" model-routing signal; tokens answer "how expensive was it", a genuinely
  // different question this report couldn't answer at all before. closedWithTokens can be less than
  // closed: an item folded before this change, or whose only work was sweep-mode/pre-band-only
  // (checkpoint-writer bookkeeping calls are deliberately NOT attributed — see the KI-E150
  // KNOWN-ISSUES.md entry), has no tokensUsed to include.
  const top = topTokenItems(ledger, 10);
  const topRows = top.map((t) => `| ${t.id} | ${t.tokensUsed.toLocaleString()} |`).join('\n');
  return [
    '# Cost report — agent calls by model (routing evidence)',
    '',
    `_Generated ${now()} · cycle ${ledger.cycle}_`,
    '',
    '_Counts are routed agent-calls per model (the faithful "who did the work" signal) — model routing',
    'evidence, not a spend total. Real per-item TOKEN totals (KI-E150) are tracked separately below; a',
    'per-cycle whole-run token total (KI-E23) is still recorded in the cycle report. This report is',
    'OBSERVABILITY, not a governor — there is no budget gate (owner direction 2026-06-27)._',
    '',
    '| Model | Agent calls | Share |',
    '|---|---|---|',
    rows || '| (none recorded) | 0 | 0% |',
    `| **Total** | **${s.total}** | **100%** |`,
    '',
    '## Efficiency',
    '',
    `- **Closed findings:** ${s.closed}`,
    `- **Agent-calls / closed finding:** ${s.callsPerClosed ?? '— (none closed yet)'}`,
    `- **Opus share of calls:** ${Math.round(s.opusShare * 100)}% _(PLAN §4 goal: opus reserved for hard reasoning + the 3 hard gates + refute)_`,
    `- **Tokens / closed finding:** ${s.tokensPerClosed ? s.tokensPerClosed.toLocaleString() : '— (no per-item token data yet)'} _(KI-E150 — real total ${s.totalTokens.toLocaleString()} across ${s.closedWithTokens} of ${s.closed} closed item(s) with recorded tokensUsed)_`,
    '',
    '## Top 10 closed items by tokens (KI-E150)',
    '',
    '| Item | Tokens |',
    '|---|---|',
    topRows || '| _(no per-item token data yet)_ |  |',
    '',
    '## Per-cycle trend',
    '',
    '| Cycle | Calls | Closed | Calls/closed (cum) | Marginal Δcalls/Δclosed | Opus % |',
    '|---|---|---|---|---|---|',
    trend || '| _(no history yet)_ |  |  |  |  |  |',
    '',
    '> Goal (PLAN.md §4/§11): haiku/sonnet do the volume; opus only the hard parts; cost/closed-finding trends down.',
    '',
  ].join('\n');
}

// ---- effectiveness report (KI-E441) -----------------------------------------------

/**
 * effectivenessMd — cross-cutting factory effectiveness metrics:
 *   - fixType close rates + attempt distribution
 *   - severity close rates
 *   - first-pass / second-pass / 3+-pass rates
 *   - gate rework rate (items with any CHANGES_REQUIRED gate verdict)
 *   - adjudication rate
 *   - retry-exhausted backlog
 *   - verificationOnly fast-path activation rate (KI-E440-A)
 *   - band distribution (LIGHT / FULL) on CLOSED items
 *   - refuterLight utilization (mechanical vs non-mechanical HIGH items)
 *   - throughput trend (closures per cycle, last 10)
 */
export function effectivenessMd(cfg, ledger, graph, history) {
  const maxRetries = (cfg && cfg.maxItemRetries != null) ? cfg.maxItemRetries : 2;
  const items = byId(graph);
  const allRows = Object.values(ledger.items);
  const closed = allRows.filter((r) => r.state === 'CLOSED');
  const n = closed.length;

  // fixType stats
  const ft = {};
  for (const wi of (graph.items || [])) {
    const row = ledger.items[wi.id]; if (!row) continue;
    const k = wi.fixType || 'unknown';
    if (!ft[k]) ft[k] = { total: 0, closed: 0, escalated: 0, retryExh: 0, attempts: [] };
    ft[k].total++;
    if (row.state === 'CLOSED') { ft[k].closed++; ft[k].attempts.push(row.attempts || 0); }
    if (row.state === 'ESCALATED') ft[k].escalated++;
    if (row.state === 'READY' && (row.attempts || 0) > maxRetries + (row.retryBonus || 0)) ft[k].retryExh++;
  }
  const ftRows = Object.entries(ft).sort((a, b) => b[1].closed - a[1].closed).map(([k, d]) => {
    const closeRate = d.total ? Math.round(d.closed / d.total * 100) : 0;
    const avg = d.attempts.length ? (d.attempts.reduce((a, b) => a + b, 0) / d.attempts.length).toFixed(2) : '—';
    const dist1 = d.attempts.filter((a) => a === 1).length;
    const dist2 = d.attempts.filter((a) => a === 2).length;
    const dist3p = d.attempts.filter((a) => a >= 3).length;
    return `| ${k} | ${d.total} | ${d.closed} (${closeRate}%) | ${d.escalated} | ${d.retryExh} | ${avg} | ${dist1} / ${dist2} / ${dist3p} |`;
  }).join('\n');

  // severity stats
  const sv = {};
  for (const wi of (graph.items || [])) {
    const row = ledger.items[wi.id]; if (!row) continue;
    const k = wi.severity || 'UNKNOWN';
    if (!sv[k]) sv[k] = { total: 0, closed: 0, escalated: 0, retryExh: 0 };
    sv[k].total++;
    if (row.state === 'CLOSED') sv[k].closed++;
    if (row.state === 'ESCALATED') sv[k].escalated++;
    if (row.state === 'READY' && (row.attempts || 0) > maxRetries + (row.retryBonus || 0)) sv[k].retryExh++;
  }
  const svOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const svRows = svOrder.filter((k) => sv[k]).map((k) => {
    const d = sv[k];
    return `| ${k} | ${d.total} | ${d.closed} (${Math.round(d.closed / d.total * 100)}%) | ${d.escalated} | ${d.retryExh} |`;
  }).join('\n');

  // attempt distribution
  const pass1 = closed.filter((r) => (r.attempts || 0) === 1).length;
  const pass2 = closed.filter((r) => (r.attempts || 0) === 2).length;
  const pass3p = closed.filter((r) => (r.attempts || 0) >= 3).length;
  const pass0 = closed.filter((r) => (r.attempts || 0) === 0).length; // sweep/owner-decision closes

  // gate rework & adjudication
  const withRework = closed.filter((r) => Object.values(r.gates || {}).some((v) => v === 'CHANGES_REQUIRED')).length;
  const withAdj = closed.filter((r) => r.gates && r.gates.adjudicator).length;

  // verificationOnly activations (KI-E440-A) — tracked since 2026-11-03; 0 expected before that date
  const voItems = closed.filter((r) => r.verificationOnly === true);
  const voCount = voItems.length;

  // band distribution
  const bands = { LIGHT: 0, FULL: 0, unknown: 0 };
  for (const r of closed) {
    const ids = r.attemptIdentities || {};
    let found = false;
    for (const ai of Object.values(ids)) { if (ai.band) { bands[ai.band] = (bands[ai.band] || 0) + 1; found = true; break; } }
    if (!found) bands.unknown++;
  }

  // retry-exhausted total
  const retryExhTotal = allRows.filter((r) => r.state === 'READY' && (r.attempts || 0) > maxRetries + (r.retryBonus || 0)).length;
  const retryExhMech = (graph.items || []).filter((wi) => {
    const row = ledger.items[wi.id];
    return wi.fixType === 'mechanical' && row && row.state === 'READY' && (row.attempts || 0) > maxRetries + (row.retryBonus || 0);
  }).length;

  // throughput trend (last 10 cycles from history)
  const hs = (history || []).slice(-10);
  const trendRows = hs.map((h, i) => {
    const prev = i > 0 ? hs[i - 1] : null;
    const dClosed = prev ? h.closed - prev.closed : '—';
    return `| ${h.cycle} | ${h.closed} | ${typeof dClosed === 'number' ? (dClosed >= 0 ? '+' : '') + dClosed : dClosed} |`;
  }).join('\n');

  return [
    '# Factory Effectiveness (KI-E441)',
    '',
    `_Generated ${now()} · cycle ${ledger.cycle} · ${n} CLOSED of ${allRows.length} total_`,
    '',
    '## Fix-type close rates',
    '',
    '| fixType | Total | Closed (%) | Escalated | Retry-exhausted | Avg attempts | 1st / 2nd / 3rd+ pass |',
    '|---|---|---|---|---|---|---|',
    ftRows || '| _(no data)_ |  |  |  |  |  |  |',
    '',
    '## Severity close rates',
    '',
    '| Severity | Total | Closed (%) | Escalated | Retry-exhausted READY |',
    '|---|---|---|---|---|',
    svRows || '| _(no data)_ |  |  |  |  |',
    '',
    '## Attempt distribution (CLOSED items)',
    '',
    `- **Total CLOSED**: ${n}`,
    `- **Sweep / owner-decision closes (0 attempts)**: ${pass0} (${n ? Math.round(pass0 / n * 100) : 0}%)`,
    `- **First-pass success (1 attempt)**: ${pass1} (${n ? Math.round(pass1 / n * 100) : 0}%)`,
    `- **Second-pass success (2 attempts)**: ${pass2} (${n ? Math.round(pass2 / n * 100) : 0}%)`,
    `- **Third-pass+ success (≥3 attempts)**: ${pass3p} (${n ? Math.round(pass3p / n * 100) : 0}%)`,
    '',
    '## Gate & review quality',
    '',
    `- **Gate rework rate** (CHANGES_REQUIRED in any gate): ${withRework} / ${n} = ${n ? Math.round(withRework / n * 100) : 0}%`,
    `- **Adjudication rate** (dispute resolved by adjudicator): ${withAdj} / ${n} = ${n ? Math.round(withAdj / n * 100) : 0}%`,
    '',
    '## KI-E440 token-reduction fast-paths',
    '',
    `- **verificationOnly fast-path activations** (KI-E440-A, tracked since 2026-11-03): ${voCount} CLOSED items`,
    `  - ${voCount > 0 ? voItems.map((r) => r.id).join(', ') : '_none yet — first batch dispatched after feature shipped_'}`,
    `- **Band distribution on CLOSED items**: LIGHT=${bands.LIGHT} | FULL=${bands.FULL} | unknown (pre-band-tracking)=${bands.unknown}`,
    '',
    '## Retry-exhausted backlog',
    '',
    `- **Total retry-exhausted READY items**: ${retryExhTotal} (invisible to \`suggest\`, need manual retry-budget relief)`,
    `  - Mechanical: ${retryExhMech} | Non-mechanical: ${retryExhTotal - retryExhMech}`,
    `  - Configured \`maxItemRetries\`: ${maxRetries}`,
    '',
    '## Throughput trend (last 10 cycles)',
    '',
    '| Cycle | Cumulative CLOSED | Δ this cycle |',
    '|---|---|---|',
    trendRows || '| _(no history yet)_ |  |  |',
    '',
    '> Key health signals: mechanical close rate ≥50%, first-pass rate ≥50%, gate rework <25%, retry-exhausted backlog flat or shrinking.',
    '',
  ].join('\n');
}

/**
 * @param {function} abs — driver's path resolver
 */
export function writeReports(cfg, ledger, graph, abs) {
  writeFileSync(abs(cfg.paths.progress), progressMd(cfg, ledger, graph));
  mkdirSync(abs(cfg.paths.reports), { recursive: true });
  writeFileSync(abs(cfg.paths.burndown), burndownMd(cfg, ledger, graph));
  const history = readCostHistory(cfg, abs);
  writeFileSync(join(abs(cfg.paths.reports), 'cost-latest.md'), costMd(ledger, history));
  writeFileSync(join(abs(cfg.paths.reports), 'effectiveness-latest.md'), effectivenessMd(cfg, ledger, graph, history));
}
