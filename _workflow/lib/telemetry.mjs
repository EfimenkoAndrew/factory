// Telemetry — event-sourced observability for the factory (ai-factory-observability spine
// AD-1..3, AD-10, AD-11). ONE append-only JSONL stream (telemetry/data/events.jsonl) is the
// source of truth for every factory action; Prometheus/Grafana/OTLP and the evaluation
// reports are DERIVED views. Emission is OBSERVATIONAL ONLY: it never throws, never blocks
// factory work, and an emitted event is NEVER fold evidence (KI-E7).
//
// Sources (AD-2 authority ranking): 'driver' (deterministic — commands, claims, folds),
// 'agent' (best-effort live wall-clock from stage subagents via telemetry-emit.mjs),
// 'derived' (fold-time mtime backfill of stage timelines), 'orchestrator'.
// Kill-switch: FACTORY_TELEMETRY=0. Stream location override: FACTORY_TELEMETRY_DIR.
import { appendFileSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // _bmad-output/ai-factory/_workflow/lib
export const FACTORY_ROOT = resolve(HERE, '..', '..');
// Hard serialization cap. Typical events are ~300 B; the truncation guard keeps real lines well
// under 4096 (PIPE_BUF), so concurrent O_APPEND writers interleave whole lines, never fragments.
export const MAX_LINE = 8192;
export const SOURCES = ['driver', 'agent', 'derived', 'orchestrator'];
// Contextual envelope fields copied verbatim from a partial event (everything else rides in attrs).
export const EVENT_FIELDS = ['runId', 'cycle', 'lane', 'item', 'stage', 'role', 'model', 'effort', 'outcome', 'durMs', 'attempts', 'session'];

export function telemetryEnabled() { return process.env.FACTORY_TELEMETRY !== '0'; }
export function telemetryFile() {
  const dir = process.env.FACTORY_TELEMETRY_DIR || join(FACTORY_ROOT, 'telemetry', 'data');
  return join(dir, 'events.jsonl');
}

// Build the v1 envelope from a partial (pure — selftest-covered). Unknown top-level keys are
// dropped (put extras in attrs); unknown ATTRS are preserved (forward-compat, consumers ignore).
export function buildEvent(e) {
  const ev = { v: 1, ts: (e && e.ts) || new Date().toISOString(), source: (e && e.source) || 'driver', event: (e && e.event) || 'unknown' };
  for (const k of EVENT_FIELDS) if (e && e[k] !== undefined && e[k] !== null) ev[k] = e[k];
  if (e && e.attrs && typeof e.attrs === 'object') ev.attrs = e.attrs;
  return ev;
}

// Serialize with the oversize guard (pure): a line over maxLine drops attrs (stamped truncated),
// and as a last resort collapses to the bare envelope — the stream NEVER carries an unparseable
// or fragment-prone line.
export function serializeEvent(ev, maxLine = MAX_LINE) {
  let line = JSON.stringify(ev);
  if (line.length > maxLine) {
    line = JSON.stringify({ ...ev, attrs: undefined, truncated: true });
    if (line.length > maxLine) line = JSON.stringify({ v: 1, ts: ev.ts, source: ev.source, event: ev.event, item: ev.item, truncated: true });
  }
  return line;
}

// The single append point (AD-3). Returns true when a line was written; false when disabled or
// on any error (stderr one-liner). NEVER throws.
export function emit(e) {
  try {
    if (!telemetryEnabled()) return false;
    const file = telemetryFile();
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, serializeEvent(buildEvent(e)) + '\n'); // flag 'a' => O_APPEND (atomic whole-line interleave under PIPE_BUF)
    return true;
  } catch (err) {
    try { process.stderr.write('[telemetry] emit skipped: ' + (err && err.message) + '\n'); } catch { /* never throw */ }
    return false;
  }
}
export function emitMany(events) { let n = 0; for (const e of events || []) if (emit(e)) n++; return n; }

// ---- deterministic stage-timeline backfill (AD-11) -----------------------------------------
// Artifact filename -> lifecycle stage (factory phase names, lowercased). gate-*.md / review-*.md
// map via stageForArtifact's pattern branch.
export const STAGE_ARTIFACTS = [
  ['plan.md', 'plan'], ['test.json', 'test'], ['verify-red-raw.txt', 'test'],
  ['fix.json', 'fix'], ['verify.json', 'verify'], ['verify-raw.txt', 'verify'],
  ['adjudication.md', 'gates'], ['decision.md', 'gates'], ['refute.md', 'refute'],
  ['reaudit.md', 'reaudit'], ['integrate.md', 'integrate'], ['integrate-raw.txt', 'integrate'],
  ['mutation-proof.txt', 'integrate'], ['result.json', 'checkpoint'],
];
export function stageForArtifact(name) {
  for (const [f, s] of STAGE_ARTIFACTS) if (name === f) return s;
  if (/^gate-.*\.md$/.test(name) || /^review-.*\.md$/.test(name)) return 'gates';
  return null;
}

// ---- canonical stage vocabulary (AD-12) -----------------------------------------------------
// ONE stage enum for every consumer. Agents emit --role (their exact brief name — they know it);
// stage is DERIVED here, never free-typed by an LLM. normalizeStage() maps every legacy/loose
// vocabulary (ledger states, phase titles, role names) onto the enum so no third vocabulary
// escapes into aggregation.
export const STAGES = ['plan', 'test', 'fix', 'verify', 'gates', 'refute', 'reaudit', 'integrate', 'checkpoint'];
const ROLE_STAGE = {
  'planner': 'plan', 'decision-framer': 'plan', 'sweep-designer': 'plan', 'normalizer': 'plan',
  'test-author': 'test', 'fixer': 'fix', 'runner': 'verify', 'marker-probe': 'verify', // KI-E10 probe rides the verify stage
  'refuter': 'refute', 're-auditor': 'reaudit', 'reauditor': 'reaudit',
  'integrator': 'integrate', 'adjudicator': 'gates', 'reporter': 'checkpoint',
};
export function roleToStage(role) {
  const r = String(role || '').toLowerCase().trim();
  if (ROLE_STAGE[r]) return ROLE_STAGE[r];
  if (/^gate-/.test(r) || /^review-/.test(r)) return 'gates';
  if (/checkpoint/.test(r)) return 'checkpoint';
  return null;
}
export function normalizeStage(stage) {
  const s = String(stage || '').toLowerCase().trim().replace(/[_\s]+/g, '-');
  if (STAGES.includes(s)) return s;
  const MAP = {
    'red': 'test', 'green': 'fix', 'built': 'verify', 'tested': 'verify', 'gated': 'gates',
    'refute-ok': 'refute', 'refute+re-audit': 'refute', 'reaudited': 'reaudit', 're-audit': 'reaudit',
    'integrated': 'integrate', 'closed': 'integrate',
  };
  if (MAP[s]) return MAP[s];
  return roleToStage(s); // last chance: the value was actually a role name
}
// Stat state/items/<id>/ artifacts -> ONE row per stage, mtime-ordered:
// {stage, files[], firstMs, mtimeMs (= last artifact), ts (= last), bandSpanMs}.
// Analysis finding F3 (2026-07-17): the review band's artifacts land CONCURRENTLY — emitting one
// row per artifact made sequential mtime deltas read as per-reviewer runtimes. Same-stage
// artifacts now collapse into one span (first..last), mirroring the exporter's one-span-per-stage
// assembly. opts.sinceMs drops artifacts older than the current attempt (re-fix rounds reuse the dir).
export function deriveStageTimeline(itemDir, opts = {}) {
  const byStage = new Map();
  try {
    if (!existsSync(itemDir)) return [];
    for (const f of readdirSync(itemDir)) {
      const stage = stageForArtifact(f);
      if (!stage) continue;
      try {
        const st = statSync(join(itemDir, f));
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue;
        const row = byStage.get(stage);
        if (!row) byStage.set(stage, { stage, files: [f], firstMs: st.mtimeMs, mtimeMs: st.mtimeMs });
        else {
          row.files.push(f);
          row.firstMs = Math.min(row.firstMs, st.mtimeMs);
          row.mtimeMs = Math.max(row.mtimeMs, st.mtimeMs);
        }
      } catch { /* per-file best-effort */ }
    }
  } catch { /* derivation is observational */ }
  const out = [...byStage.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const r of out) { r.ts = new Date(r.mtimeMs).toISOString(); r.bandSpanMs = r.mtimeMs - r.firstMs; }
  return out;
}

// ---- read + aggregate (AD-9 evaluation path; pure aggregation is selftest-covered) ----------
export function parseEvents(text, limit = 0) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const e = JSON.parse(t); if (e && typeof e === 'object' && e.event) out.push(e); } catch { /* tolerate bad lines */ }
  }
  return limit > 0 ? out.slice(-limit) : out;
}
export function readEvents(file, opts = {}) {
  try { return parseEvents(readFileSync(file || telemetryFile(), 'utf8'), opts.limit || 0); } catch { return []; }
}

export function quantile(nums, q) {
  if (!nums || !nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

// KI-E13 gap-fence: a derived stage duration above this spans a dead gap between runs (cross-session
// relaunch, overnight idle — the KI-E9 16.5h `plan` row), not real stage work. The fold stamps
// attrs.gapSuspect at emit time; aggregation ALSO applies the threshold defensively so pre-fix
// historical events are fenced too. Fenced durations are excluded from percentiles and reported.
export const GAP_FENCE_MS = 4 * 3600 * 1000;

export function aggregateEvents(events) {
  const agg = { total: 0, byEvent: {}, bySource: {}, outcomes: {}, cycles: {}, gates: {}, stages: {}, agentStages: {}, models: {}, infraSuspect: 0, items: {}, itemFolds: {}, failedAt: {}, gapOutliers: [], agentPairs: {} };
  for (const e of events || []) {
    if (!e || typeof e !== 'object' || !e.event) continue;
    agg.total++;
    agg.byEvent[e.event] = (agg.byEvent[e.event] || 0) + 1;
    agg.bySource[e.source || '?'] = (agg.bySource[e.source || '?'] || 0) + 1;
    if (e.event === 'item_folded') {
      const st = (e.attrs && e.attrs.toState) || e.outcome || '?';
      agg.outcomes[st] = (agg.outcomes[st] || 0) + 1;
      if (e.cycle != null) { const c = agg.cycles[e.cycle] = agg.cycles[e.cycle] || { folded: 0, closed: 0 }; c.folded++; if (st === 'CLOSED') c.closed++; }
      if (e.attrs && e.attrs.infraSuspect) agg.infraSuspect++;
      if (e.attrs && e.attrs.gates) for (const [g, v] of Object.entries(e.attrs.gates)) { const gg = agg.gates[g] = agg.gates[g] || {}; gg[String(v)] = (gg[String(v)] || 0) + 1; }
      if (e.attrs && e.attrs.cost) for (const [m, n] of Object.entries(e.attrs.cost)) agg.models[m] = (agg.models[m] || 0) + (Number(n) || 0);
      if (e.item) {
        agg.items[e.item] = st;
        // KI-E13 KPIs: the per-item fold sequence (stream order = chronological) with the
        // direct-recovery signature (a 'direct-recovery' key in the fold's gates map).
        (agg.itemFolds[e.item] = agg.itemFolds[e.item] || []).push({ st, direct: !!(e.attrs && e.attrs.gates && e.attrs.gates['direct-recovery']) });
      }
    }
    if (e.event === 'stage_end' && typeof e.durMs === 'number' && e.stage) {
      // AD-12 hard whitelist: ONLY source:'derived' feeds the duration authority — anything else
      // (agent, orchestrator, junk, a forged value) lands in the non-evidentiary agent bucket.
      if (e.source === 'derived') {
        if ((e.attrs && e.attrs.gapSuspect) || e.durMs > GAP_FENCE_MS) agg.gapOutliers.push({ item: e.item || '?', stage: e.stage, durMs: e.durMs });
        else (agg.stages[e.stage] = agg.stages[e.stage] || []).push(e.durMs);
        // KI-E13 failure concentration: the fold stamps attrs.final=<toState> on the item's LAST stage.
        if (e.attrs && e.attrs.final === 'FAILED') agg.failedAt[e.stage] = (agg.failedAt[e.stage] || 0) + 1;
      } else (agg.agentStages[e.stage] = agg.agentStages[e.stage] || []).push(e.durMs);
    }
    // KI-E13 liveness: pair agent stage_start/stage_end per item+role — an unmatched start is an
    // agent that died mid-stage (classifier-blocked / killed; the KI-D8 class), invisible before.
    if (e.source === 'agent' && (e.event === 'stage_start' || e.event === 'stage_end')) {
      const k = (e.item || '?') + ' :: ' + (e.role || e.stage || '?');
      const p = agg.agentPairs[k] = agg.agentPairs[k] || { starts: 0, ends: 0 };
      if (e.event === 'stage_start') p.starts++; else p.ends++;
    }
  }
  return agg;
}

export function renderTelemetryReport(agg, meta = {}) {
  const secs = (ms) => (ms / 1000).toFixed(1) + 's';
  const stageTable = (bucket) => {
    const rows = Object.entries(bucket).map(([s, d]) => `| ${s} | ${d.length} | ${secs(quantile(d, 0.5))} | ${secs(quantile(d, 0.95))} |`);
    return rows.length ? ['| Stage | n | p50 | p95 |', '|---|---|---|---|', ...rows].join('\n') : '_none_';
  };
  const kv = (obj, ha, hb) => {
    const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`);
    return rows.length ? [`| ${ha} | ${hb} |`, '|---|---|', ...rows].join('\n') : '_none_';
  };
  const gateRows = Object.entries(agg.gates).map(([g, vs]) => {
    const total = Object.values(vs).reduce((a, b) => a + b, 0);
    const approved = vs.APPROVED || 0;
    return `| ${g} | ${total} | ${approved} | ${total ? Math.round((approved / total) * 100) : 0}% |`;
  });
  const cycleRows = Object.entries(agg.cycles).sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([c, v]) => `| ${c} | ${v.folded} | ${v.closed} |`);
  // KI-E13 KPIs — the two factory-quality headline numbers, from the per-item fold sequences:
  // first-pass close rate (closes whose FIRST fold was a clean CLOSED — no FAILED round, no
  // direct-recovery) and direct-recovery rate (closes that needed the run protocol §4 remedy path).
  const perItem = Object.values(agg.itemFolds || {});
  const closedItems = perItem.filter((fs) => fs.length && fs[fs.length - 1].st === 'CLOSED');
  const firstPass = closedItems.filter((fs) => fs[0].st === 'CLOSED' && !fs[0].direct);
  const recovered = closedItems.filter((fs) => fs.some((f) => f.st === 'CLOSED' && f.direct));
  const pct = (a, b) => b ? Math.round((a / b) * 100) + '%' : 'n/a';
  const kpi = [
    '| KPI | Value |', '|---|---|',
    `| Items folded (unique) | ${perItem.length} |`,
    `| Items closed | ${closedItems.length} |`,
    `| First-pass close rate (clean first fold / closed) | ${firstPass.length}/${closedItems.length} = ${pct(firstPass.length, closedItems.length)} |`,
    `| Direct-recovery rate (recovered closes / closed) | ${recovered.length}/${closedItems.length} = ${pct(recovered.length, closedItems.length)} |`,
  ].join('\n');
  const failedRows = Object.entries(agg.failedAt || {}).sort((a, b) => b[1] - a[1]).map(([s, n]) => `| ${s} | ${n} |`);
  const gapRows = (agg.gapOutliers || []).map((g) => `| ${g.item} | ${g.stage} | ${(g.durMs / 3600000).toFixed(1)}h |`);
  const unmatched = Object.entries(agg.agentPairs || {}).filter(([, p]) => p.starts > p.ends)
    .map(([k, p]) => `| ${k} | ${p.starts} | ${p.ends} |`);
  return [
    '# Factory telemetry report',
    '',
    `_Generated ${meta.generatedAt || new Date().toISOString()} · source ${meta.file || 'events.jsonl'} · ${agg.total} event(s)_`,
    '',
    '## KPIs (KI-E13)', '', kpi, '',
    '## Events by type', '', kv(agg.byEvent, 'Event', 'Count'), '',
    '## Events by source', '', kv(agg.bySource, 'Source', 'Count'), '',
    '## Item outcomes (folded)', '', kv(agg.outcomes, 'State', 'Items'),
    '', `Infra-suspect results: ${agg.infraSuspect}`, '',
    '## Per-cycle folds', '', cycleRows.length ? ['| Cycle | Folded | Closed |', '|---|---|---|', ...cycleRows].join('\n') : '_none_', '',
    '## Stage durations — derived (mtime backfill, deterministic; gap-fenced)', '', stageTable(agg.stages), '',
    '## Gap-fenced duration outliers (excluded from percentiles — dead time between runs, KI-E13)', '',
    gapRows.length ? ['| Item | Stage | Wall |', '|---|---|---|', ...gapRows].join('\n') : '_none_', '',
    '## Failure concentration (final stage before a FAILED fold)', '',
    failedRows.length ? ['| Stage | FAILED folds ending here |', '|---|---|', ...failedRows].join('\n') : '_none_', '',
    '## Stage durations — agent-reported (best-effort, non-evidentiary)', '', stageTable(agg.agentStages), '',
    '## Unmatched agent stage_starts (agent died mid-stage — blocked/killed, KI-D8 class)', '',
    unmatched.length ? ['| Item :: role | starts | ends |', '|---|---|---|', ...unmatched].join('\n') : '_none_', '',
    '## Gate verdicts', '', gateRows.length ? ['| Gate | Runs | Approved | Rate |', '|---|---|---|---|', ...gateRows].join('\n') : '_none_', '',
    '## Agent-call volume by model (from fold cost)', '', kv(agg.models, 'Model', 'Calls'), '',
  ].join('\n');
}
