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
import { appendFileSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apportionTokensByCallShare, tokenUsageSummary } from './token-usage.mjs'; // KI-E66 — cache-hit-rate + per-item apportioned tokens
import { aggregateObservations, renderObservationReport, canonicalJson } from './observations.mjs'; // ported from a host-mount session — duplicate-safe identity + observation-cohort reporting

const HERE = dirname(fileURLToPath(import.meta.url)); // _bmad-output/ai-factory/_workflow/lib
export const FACTORY_ROOT = resolve(HERE, '..', '..');
// Hard serialization cap. Typical events are ~300 B; the truncation guard keeps real lines well
// under 4096 (PIPE_BUF), so concurrent O_APPEND writers interleave whole lines, never fragments.
export const MAX_LINE = 8192;
export const SOURCES = ['driver', 'agent', 'derived', 'orchestrator'];
// Contextual envelope fields copied verbatim from a partial event (everything else rides in attrs).
export const EVENT_FIELDS = ['id', 'runId', 'cycle', 'lane', 'item', 'stage', 'role', 'model', 'effort', 'outcome', 'durMs', 'attempts', 'session'];

export function telemetryEnabled() { return process.env.FACTORY_TELEMETRY !== '0'; }
export function telemetryFile() {
  const dir = process.env.FACTORY_TELEMETRY_DIR || join(FACTORY_ROOT, 'telemetry', 'data');
  return join(dir, 'events.jsonl');
}
// KI-E352: monthly archive files alongside events.jsonl (e.g. events-2026-09.jsonl).
// Returns sorted list of existing archive paths (oldest first).
export function telemetryArchiveFiles() {
  const dir = process.env.FACTORY_TELEMETRY_DIR || join(FACTORY_ROOT, 'telemetry', 'data');
  try {
    return readdirSync(dir)
      .filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch { return []; }
}
// KI-E352: rotate events.jsonl when it exceeds rotateBytes (default 40 MB). Lines whose ts
// month != currentMonth are appended into events-YYYY-MM.jsonl archives; events.jsonl keeps
// only the current month. Safe to call at run start (idempotent, never throws, best-effort).
export function rotateEvents(rotateBytes = 40 * 1024 * 1024) {
  try {
    const file = telemetryFile();
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size <= rotateBytes) return; // nothing to do
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const dir = dirname(file);
    const byMonth = new Map();
    const keep = [];
    for (const line of lines) {
      try {
        const month = (JSON.parse(line).ts || '').slice(0, 7);
        if (!month || month === currentMonth) { keep.push(line); continue; }
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(line);
      } catch { keep.push(line); }
    }
    if (!byMonth.size) return; // all lines are current-month — no rotation needed
    for (const [month, archiveLines] of byMonth) {
      appendFileSync(join(dir, `events-${month}.jsonl`), archiveLines.join('\n') + '\n');
    }
    appendFileSync(file + '.tmp', keep.join('\n') + '\n');
    renameSync(file + '.tmp', file); // atomic replace
  } catch (err) {
    try { process.stderr.write('[telemetry] rotateEvents skipped: ' + (err && err.message) + '\n'); } catch { /* never throw */ }
  }
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
// KI-E42/KI-E71/KI-E137/KI-E140 (killed-run artifact quarantine + canonical vocabulary) now live in
// lib/artifacts.mjs's versioned `classifyArtifact` (engine sync, 2026-09) — it generalizes this
// file's original STAGE_ARTIFACTS/CONTROL_ARTIFACTS/nonCanonicalArtifacts (kept those two KI's exact
// entries as a strict subset) into a single classifier that ALSO correctly recognizes verification
// transcripts, recovery evidence, and native-evidence files as canonical — filenames the narrower
// original list did not know about and would have false-flagged as improvisation debris.
import { stageForArtifact } from './artifacts.mjs';
export { STAGE_ARTIFACTS, CONTROL_ARTIFACTS, stageForArtifact, nonCanonicalArtifacts } from './artifacts.mjs';

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
    for (const entry of readdirSync(itemDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const f = entry.name;
      const stage = stageForArtifact(f);
      if (!stage) continue;
      try {
        const st = statSync(join(itemDir, f));
        if (!st.isFile()) continue;
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
// KI-E352: when no specific file is given, also include monthly archive files so callers get
// the full event history. opts.allFiles=false disables (current month only).
export function readEvents(file, opts = {}) {
  if (file) {
    try { return parseEvents(readFileSync(file, 'utf8'), opts.limit || 0); } catch { return []; }
  }
  const includeArchives = opts.allFiles !== false;
  try {
    const archives = includeArchives ? telemetryArchiveFiles() : [];
    const parts = [...archives, telemetryFile()];
    const combined = parts.map((p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } }).join('');
    return parseEvents(combined, opts.limit || 0);
  } catch { return []; }
}

export function quantile(nums, q) {
  if (!nums || !nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

// ---- gate-verdict vocabulary (KI-E40) -------------------------------------------------------
// The fold's gates map carries role-specific ok-vocabularies: APPROVED (gates / review flows /
// probes), UPHELD (adjudicator), CONFIRMED (adjudicator-regate), 'code=ok security=ok' key=ok
// families (reaudit), 'converged-remedy …' prose (direct-recovery). The report previously
// counted ONLY the literal APPROVED — rendering 100%-passing reaudit/adjudicator/regate/
// direct-recovery rows as 0% and poisoning the quality signal. verdictOk() classifies; unknown
// vocabulary counts not-ok AND is surfaced by the report footnote (self-reporting drift instead
// of a silent miscount).
export const KNOWN_FAIL_VERDICT = /^(CHANGES[_-]REQUIRED|REJECTED|REFUTED|OVERTURNED|OVERRULED|FAILED|BLOCKED)$/i;
// Known-fail reaudit FAMILIES (review find): 'code=ok security=no' / 'code=NULL' are the reaudit's
// real failure vocabulary — they count not-ok (verdictOk is strict all-ok), and they must not
// pollute the unclassified-drift footnote as if they were unrecognized passes.
export const KNOWN_FAIL_FAMILY = /^[\w.-]+=(ok|no|null|fail)(\s+[\w.-]+=(ok|no|null|fail))*$/i;
export function verdictOk(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  if (/^(APPROVED|UPHELD|CONFIRMED)$/i.test(s)) return true;
  if (/^converged-remedy\b/i.test(s)) return true;
  return /^[\w.-]+=ok(\s+[\w.-]+=ok)*$/i.test(s); // reaudit families — EVERY token must be key=ok
}

// ---- direct-recovery classification (KI-E46) ------------------------------------------------
// The KI-E20 `recover` scaffold folds with resultId "<id>#<cycle>r" (also #Nr2, #Nr3 …) and a
// note that STARTS with "direct-recovery"; older hand-rolled recovery folds carried a literal
// 'direct-recovery' key in the gates map instead. The KPI previously recognized ONLY the
// gates-map signature, so every scaffolded recovery close (9 of the 13 live recoveries) read as a
// plain re-band close — under-counting the factory's DOMINANT close path (direct-recovery rate
// rendered 4/29 = 14% vs 13/29 = 45% real, per the KI-E46 registry row). All live signatures
// classify now; the fold ALSO stamps attrs.direct + attrs.resultId at emit time so future
// streams never need prose sniffing.
export function isRecoveryResultId(rid) { return /#\d+r\d*$/i.test(String(rid || '')); }
export function isDirectRecoveryFold(attrs) {
  const a = attrs || {};
  if (a.direct === true) return true;
  if (a.gates && a.gates['direct-recovery'] !== undefined) return true;
  if (isRecoveryResultId(a.resultId)) return true;
  return /^direct-recovery\b/i.test(String(a.note || '').trim()); // prefix-anchored: a mid-note mention never classifies
}

// KI-E49 — agent event-vocabulary clamp. Agents free-typed --event names into the stream
// (live: probe / dummy_probe / tool_use); the AD-10 agent seam emits exactly two canonical
// events. Anything else becomes 'agent_note' (the original name is preserved by the caller in
// attrs.origEvent) so the stream vocabulary stays bounded without losing the breadcrumb.
// KI-E458: 'stage_heartbeat' is a THIRD sanctioned agent event (never evidentiary, same as
// stage_start/stage_end) — an optional, best-effort progress ping an agent emits before/after a
// single operation it expects might run long (a dotnet build/test, a real-infra wait). Its sole
// purpose is to leave a breadcrumb for the "Unmatched agent stage_starts" report below: when a
// stage never reaches stage_end (agent died mid-stage, KI-D8 class), the LAST heartbeat note is
// the only visibility into where it was stuck — previously that gap was completely silent.
export const AGENT_EVENTS = ['stage_start', 'stage_end', 'stage_heartbeat'];
export function clampAgentEvent(name) {
  const n = String(name || '').trim();
  return AGENT_EVENTS.includes(n) ? n : 'agent_note';
}

// KI-E13 gap-fence: a derived stage duration above this spans a dead gap between runs (cross-session
// relaunch, overnight idle — the KI-E9 16.5h `plan` row), not real stage work. The fold stamps
// attrs.gapSuspect at emit time; aggregation ALSO applies the threshold defensively so pre-fix
// historical events are fenced too. Fenced durations are excluded from percentiles and reported.
export const GAP_FENCE_MS = 4 * 3600 * 1000;

// ported from a host-mount session — identifies exact-duplicate telemetry records so a relaunch
// that re-emitted the SAME fold/usage event (a killed run's `resume`, a retried `cmdFold`) does not
// silently inflate a count-based report a second time. Identity is deliberately narrow: only events
// that carry an explicit `attrs.observationId` / `attrs.usageId`, or the two shapes this stream
// already makes derivable (`item_folded` by `[item, resultId]` — KI-B4's own fold-idempotency key;
// `usage` by `runId`), are eligible for dedup at all. Every other event (the vast majority of the
// stream — stage_start/stage_end, gate results, etc., which carry no such identity) is `legacy` and
// passes through completely UNTOUCHED, in original order — this is what keeps this function safe to
// introduce without redefining any existing count for a stream that predates it. A "duplicate" is
// the STABLE part of the record (everything except `ts`, so two deliveries of literally the same
// event at different receive times still collapse) being byte-identical via `canonicalJson`; two
// DIFFERENT payloads sharing one identity are a `conflicts` entry (a real inconsistency to surface,
// never silently resolved by picking one).
export function deduplicateTelemetryEvents(events) {
  const groups = new Map(), legacy = [];
  let duplicates = 0;
  for (const e of events || []) {
    if (!e || typeof e !== 'object' || !e.event) continue;
    const a = e.attrs || {};
    let identity = a.observationId || a.usageId || e.id;
    if (!identity && e.event === 'item_folded' && a.resultId) identity = JSON.stringify([e.item, a.resultId]);
    if (!identity && e.event === 'usage' && e.runId) identity = e.runId;
    if (!identity) { legacy.push(e); continue; }
    const key = JSON.stringify([e.event, identity]);
    const { ts, ...stable } = e;
    if (!groups.has(key)) groups.set(key, new Map());
    const variants = groups.get(key), signature = canonicalJson(stable);
    if (variants.has(signature)) duplicates++; else variants.set(signature, e);
  }
  const records = [...legacy], conflicts = [];
  for (const [key, variants] of groups) {
    if (variants.size > 1) conflicts.push(key); else records.push([...variants.values()][0]);
  }
  const order = new Map((events || []).map((e, i) => [e, i]));
  records.sort((a, b) => order.get(a) - order.get(b));
  return { records, duplicates, conflicts, unidentified: legacy.length };
}

// `observationOptions`: forwarded to aggregateObservations for the `attempt_observation` cohort
// report (agg.observations) — see observations.mjs.
export function aggregateEvents(events, observationOptions = {}) {
  const agg = { total: 0, byEvent: {}, bySource: {}, outcomes: {}, cycles: {}, gates: {}, stages: {}, agentStages: {}, models: {}, infraSuspect: 0, items: {}, itemFolds: {}, failedAt: {}, gapOutliers: [], agentPairs: {}, usage: [], itemCallCounts: {}, tokenUsageSnapshots: [], callsByOutcome: {} };
  const dedup = deduplicateTelemetryEvents(events);
  agg.deduplication = { duplicates: dedup.duplicates, conflicts: dedup.conflicts, unidentified: dedup.unidentified };
  agg.observations = aggregateObservations((events || []).filter((e) => e?.event === 'attempt_observation').map((e) => e.attrs?.observation), observationOptions);
  // Engine sync 2026-09: counts now read the DEDUPLICATED stream (dedup.records), not the raw one —
  // a relaunch's exact-duplicate re-emission no longer inflates a count, and a conflicting-signature
  // pair (genuinely ambiguous, never silently resolved by picking one) is excluded from counts
  // entirely and only surfaced via agg.deduplication.conflicts.
  for (const e of dedup.records) {
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
      if (e.attrs && e.attrs.cost) {
        for (const [m, n] of Object.entries(e.attrs.cost)) agg.models[m] = (agg.models[m] || 0) + (Number(n) || 0);
        // KI-E107 — agent-call spend attributed to the item's OUTCOME. `agg.models` above answers
        // "which models did we call"; `agg.outcomes` answers "how did items end". Neither answers the
        // question that actually governs cost: WHAT SHARE OF THE WORK WENT TO ITEMS THAT NEVER
        // CLOSED. That is the factory's yield, and it was underivable from the report despite both
        // inputs sitting in the same event. Call counts are the only per-item cost unit that is real
        // and measured (KI-E66 established per-item TOKENS are structurally unavailable inside the
        // Workflow runtime), so this is a call-weighted proxy — directional, never billed.
        const callsHere = Object.values(e.attrs.cost).reduce((a, n) => a + (Number(n) || 0), 0);
        const st107 = (e.attrs && e.attrs.toState) || e.outcome || '?';
        const bucket = agg.callsByOutcome[st107] = agg.callsByOutcome[st107] || { calls: 0, items: 0 };
        bucket.calls += callsHere;
        bucket.items += 1;
        // KI-E66: per-item call-count total (across all models), KEYED BY CYCLE — the real/accurate
        // share weight apportionTokensByCallShare() divides that SAME cycle's real measured token
        // total across. Never a token count itself, just the existing per-item cost map's own call
        // tally; cycle-keyed so a retried item's later-cycle calls don't dilute an earlier cycle's
        // apportionment (or vice versa).
        if (e.item && e.cycle != null) {
          const itemCalls = Object.values(e.attrs.cost).reduce((a, n) => a + (Number(n) || 0), 0);
          const byItem = agg.itemCallCounts[e.cycle] = agg.itemCallCounts[e.cycle] || {};
          byItem[e.item] = (byItem[e.item] || 0) + itemCalls;
        }
      }
      if (e.item) {
        agg.items[e.item] = st;
        // KI-E13 KPIs: the per-item fold sequence (stream order = chronological) with the
        // direct-recovery signature (KI-E46: emit stamp / gates key / #Nr resultId / note prefix)
        // and the KI-E23b band stamp (KI-E48 band-split KPI).
        (agg.itemFolds[e.item] = agg.itemFolds[e.item] || []).push({ st, direct: isDirectRecoveryFold(e.attrs), band: (e.attrs && e.attrs.band) || null });
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
    // KI-E40: fold-time usage events (KI-E23 emits one per folded results file) — collected so
    // the report renders token spend instead of leaving it invisible in the raw stream.
    if (e.event === 'usage' && e.attrs && typeof e.attrs.outputTokens === 'number') {
      agg.usage.push({ cycle: e.cycle != null ? e.cycle : '?', file: e.attrs.file || '?', outputTokens: e.attrs.outputTokens });
    }
    // KI-E66: cycle-scoped session token usage + cache hit rate, best-effort-bridged from
    // Prometheus at telemetry-report time (driver.mjs queryPrometheusTokenUsage). Never per-item —
    // see lib/token-usage.mjs's header for why.
    if (e.event === 'token_usage_snapshot' && e.attrs) {
      // ported from a host-mount session: re-derive via tokenUsageSummary (rather than reading each
      // bucket off attrs directly) so a bucket the underlying query genuinely could not measure
      // renders as unknown, not a silently fabricated 0 — and so the row can say WHERE the number
      // came from (source/scope/selector) instead of presenting every snapshot with the same
      // unqualified cycle-scoped confidence regardless of whether it was label-filtered.
      agg.tokenUsageSnapshots.push({
        cycle: e.cycle != null ? e.cycle : '?', ts: e.ts,
        ...tokenUsageSummary(e.attrs, { source: e.attrs.source || 'legacy-prometheus', scope: e.attrs.scope || 'unfiltered-metric-window' }),
      });
    }
    // KI-E13 liveness: pair agent stage_start/stage_end per item+role — an unmatched start is an
    // agent that died mid-stage (classifier-blocked / killed; the KI-D8 class), invisible before.
    // KI-E48: the same pairing derives a best-effort agent-reported DURATION from the two ts
    // stamps (agents never pass --durMs — they cannot know their own wall-clock), so the
    // "agent-reported" table stops rendering permanently empty. Latest-start-wins (a retried
    // stage measures the final attempt); gap-fenced; never evidentiary (AD-12 unchanged).
    if (e.source === 'agent' && (e.event === 'stage_start' || e.event === 'stage_end' || e.event === 'stage_heartbeat')) {
      const k = (e.item || '?') + ' :: ' + (e.role || e.stage || '?');
      const p = agg.agentPairs[k] = agg.agentPairs[k] || { starts: 0, ends: 0 };
      if (e.event === 'stage_start') { p.starts++; p.lastStartMs = Date.parse(e.ts) || undefined; p.lastHeartbeat = undefined; }
      else if (e.event === 'stage_heartbeat') {
        // KI-E458: only the LATEST heartbeat since the most recent start matters — it is the
        // breadcrumb for wherever a stage that never reaches stage_end actually got stuck.
        const note = (e.attrs && e.attrs.note) ? String(e.attrs.note).slice(0, 200) : '(no note)';
        p.lastHeartbeat = { note, ts: e.ts };
      } else {
        p.ends++;
        if (typeof e.durMs !== 'number' && p.lastStartMs) {
          const d = (Date.parse(e.ts) || 0) - p.lastStartMs;
          const stage = normalizeStage(e.stage) || roleToStage(e.role);
          if (stage && d > 0 && d <= GAP_FENCE_MS) (agg.agentStages[stage] = agg.agentStages[stage] || []).push(d);
          p.lastStartMs = undefined;
        }
        p.lastHeartbeat = undefined;
      }
    }
  }
  return agg;
}

// KI-E107 — render the calls-by-outcome table plus the two derived ratios that make it actionable.
// Pure (string in, string out) so the selftest can pin the arithmetic without a Prometheus or a
// telemetry stack. Report-side ONLY: this reads the append-only stream and never feeds a verdict
// (KI-E7 — telemetry is observational, never evidentiary).
export function renderCallsByOutcome(callsByOutcome) {
  const entries = Object.entries(callsByOutcome || {}).filter(([, v]) => v && v.calls > 0);
  if (!entries.length) return '_none — needs item_folded events carrying a cost map (KI-E23)._';
  const total = entries.reduce((a, [, v]) => a + v.calls, 0);
  if (!total) return '_none — needs item_folded events carrying a cost map (KI-E23)._';
  entries.sort((a, b) => b[1].calls - a[1].calls);
  const rows = entries.map(([st, v]) => `| ${st} | ${v.items} | ${v.calls} | ${((v.calls / total) * 100).toFixed(1)}% | ${(v.calls / v.items).toFixed(1)} |`);
  const closed = (callsByOutcome.CLOSED && callsByOutcome.CLOSED.calls) || 0;
  // "Wasted" is deliberately NOT "everything that is not CLOSED": an ESCALATED item reached a human
  // with its analysis intact and a BLOCKED one surfaced a real scope question — both are the system
  // working, so neither is counted as waste. A FAILED round is not necessarily a total loss either
  // (some output may be reused by a later attempt, KI-E474/E123/E124) — the label below says only
  // that it is neither wasted lifetime cost nor a rejected human delivery, not that nothing survived.
  const failed = (callsByOutcome.FAILED && callsByOutcome.FAILED.calls) || 0;
  return [
    '| Outcome | Items | Agent calls | Share | Calls/item |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `**Yield — calls landing on a CLOSED item: ${((closed / total) * 100).toFixed(1)}%** (${closed}/${total}).`,
    `**FAILED spend: ${((failed / total) * 100).toFixed(1)}%** (${failed}/${total}) — calls on failed folds; some output may be reused later. This is neither wasted lifetime cost nor rejected human delivery. ESCALATED/BLOCKED spend is deliberately NOT counted here: those reached a human with the analysis intact, which is the system working, not waste.`,
  ].join('\n');
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
  // KI-E40: classify per-role ok-vocabularies (APPROVED/UPHELD/CONFIRMED/key=ok/converged-remedy)
  // instead of counting only the literal APPROVED; surface any vocabulary the classifier does not
  // recognize so drift self-reports instead of silently reading as 0%.
  const gateRows = Object.entries(agg.gates).map(([g, vs]) => {
    const total = Object.values(vs).reduce((a, b) => a + b, 0);
    const okN = Object.entries(vs).reduce((a, [k, n]) => a + (verdictOk(k) ? n : 0), 0);
    return `| ${g} | ${total} | ${okN} | ${total ? Math.round((okN / total) * 100) : 0}% |`;
  });
  const unclassified = [];
  for (const [g, vs] of Object.entries(agg.gates)) {
    for (const [k, n] of Object.entries(vs)) {
      const kt = String(k).trim();
      if (!verdictOk(k) && !KNOWN_FAIL_VERDICT.test(kt) && !KNOWN_FAIL_FAMILY.test(kt)) unclassified.push(`${g} → \`${k}\`×${n}`);
    }
  }
  const cycleRows = Object.entries(agg.cycles).sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([c, v]) => `| ${c} | ${v.folded} | ${v.closed} |`);
  // KI-E13 KPIs — the two factory-quality headline numbers, from the per-item fold sequences.
  // Engine sync 2026-09: first-pass's denominator is now ALL folded items, not just ones that
  // eventually closed — restricting to closedItems silently excluded every item still open/
  // escalated/blocked after repeated failed attempts from the denominator, inflating the rate.
  // This is still a LEGACY PROXY, not a true first-attempt measurement (an item can be folded
  // more than once per "attempt" and a killed run's own fold sequence isn't distinguishable from
  // here) — see the attempt_observation cohort report below for the versioned, honest metric.
  const perItem = Object.values(agg.itemFolds || {});
  const closedItems = perItem.filter((fs) => fs.length && fs[fs.length - 1].st === 'CLOSED');
  const firstPass = perItem.filter((fs) => fs[0].st === 'CLOSED' && !fs[0].direct);
  const recovered = closedItems.filter((fs) => fs.some((f) => f.st === 'CLOSED' && f.direct));
  const pct = (a, b) => b ? Math.round((a / b) * 100) + '%' : 'n/a';
  // KI-E48 — band-split first-pass (the §A.34 watch-list measurement): an item is keyed by the
  // band of its FIRST fold (the run whose outcome defines first-pass). Rows render only once
  // band stamps exist in the stream (KI-E23b, cycle 47+); a pure-legacy stream stays unchanged.
  const bandOf = (fs) => (fs[0] && fs[0].band) || '(unstamped)';
  const bandRows = [];
  const bandNames = [...new Set(perItem.map(bandOf))];
  if (bandNames.some((b) => b !== '(unstamped)')) {
    for (const b of bandNames.sort()) {
      const allB = perItem.filter((fs) => bandOf(fs) === b);
      const fpB = allB.filter((fs) => fs[0].st === 'CLOSED' && !fs[0].direct);
      bandRows.push(`| First-observed-fold close — ${b} band (KI-E48) | ${fpB.length}/${allB.length} = ${pct(fpB.length, allB.length)} |`);
    }
  }
  const kpi = [
    '| KPI | Value |', '|---|---|',
    `| Items folded (unique) | ${perItem.length} |`,
    `| Items closed | ${closedItems.length} |`,
    `| First-pass close rate (legacy proxy: clean first observed fold / all folded items) | ${firstPass.length}/${perItem.length} = ${pct(firstPass.length, perItem.length)} |`,
    `| Direct-recovery rate (recovered closes / closed) | ${recovered.length}/${closedItems.length} = ${pct(recovered.length, closedItems.length)} |`,
    ...bandRows,
  ].join('\n');
  const failedRows = Object.entries(agg.failedAt || {}).sort((a, b) => b[1] - a[1]).map(([s, n]) => `| ${s} | ${n} |`);
  const gapRows = (agg.gapOutliers || []).map((g) => `| ${g.item} | ${g.stage} | ${(g.durMs / 3600000).toFixed(1)}h |`);
  const unmatched = Object.entries(agg.agentPairs || {}).filter(([, p]) => p.starts > p.ends)
    .map(([k, p]) => `| ${k} | ${p.starts} | ${p.ends} | ${p.lastHeartbeat ? p.lastHeartbeat.note + ' @ ' + p.lastHeartbeat.ts : '_none emitted_'} |`);
  return [
    '# Factory telemetry report',
    '',
    `_Generated ${meta.generatedAt || new Date().toISOString()} · source ${meta.file || 'events.jsonl'} · ${agg.total} event(s)_`,
    '',
    '## KPIs (KI-E13)', '', kpi, '',
    '_Legacy folds cannot identify killed attempts or prove the observed first fold was the first attempt. Use versioned attempt observations below for the first-attempt cohort metric._', '',
    // ported from a host-mount session: duplicate/conflict visibility + the attempt_observation
    // cohort report, both purely additive read-outs of aggregateEvents' new agg.deduplication /
    // agg.observations fields — guarded with `?.` throughout so a hand-built `agg` fixture that
    // predates these fields (constructed directly rather than via aggregateEvents) renders a plain
    // zero/none line instead of throwing.
    `Event deduplication: ${agg.deduplication?.duplicates || 0} duplicates; ${agg.deduplication?.conflicts?.length || 0} conflicting immutable identities excluded. Identity-less legacy events are not guessed from filenames or timestamps.`, '',
    agg.observations ? renderObservationReport(agg.observations) : '', '',
    '## Events by type', '', kv(agg.byEvent, 'Event', 'Count'), '',
    '## Events by source', '', kv(agg.bySource, 'Source', 'Count'), '',
    '## Item outcomes (folded)', '', kv(agg.outcomes, 'State', 'Items'),
    '', `Infra-suspect results: ${agg.infraSuspect}`, '',
    '## Per-cycle folds', '', cycleRows.length ? ['| Cycle | Folded | Closed |', '|---|---|---|', ...cycleRows].join('\n') : '_none_', '',
    '## Stage durations — derived (mtime backfill, deterministic; gap-fenced)', '', stageTable(agg.stages), '',
    '## Gap-fenced duration outliers (excluded from percentiles — dead time between runs, KI-E13)', '',
    gapRows.length ? ['| Item | Stage | Wall |', '|---|---|---|', ...gapRows].join('\n') : '_none_', '',
    '## Failure concentration (final stage before a FAILED fold)', '',
    '_Reading (KI-E40): `checkpoint` here means the item ran the FULL band and wrote its checkpoint before the FAILED verdict — late-failure spend, not a checkpoint crash. An agent that DIED mid-checkpoint shows under Unmatched agent stage_starts (KI-D8) instead._', '',
    failedRows.length ? ['| Stage | FAILED folds ending here |', '|---|---|', ...failedRows].join('\n') : '_none_', '',
    '## Stage durations — agent-reported (best-effort, non-evidentiary)', '', stageTable(agg.agentStages), '',
    '## Unmatched agent stage_starts (agent died mid-stage — blocked/killed, KI-D8 class)', '',
    '_Last heartbeat (KI-E458) is the latest stage_heartbeat note emitted after the unmatched start — the only visibility into where the agent was stuck, when it bothered to emit one; "_none emitted_" means the stage died before its first heartbeat or the agent never emits them (older items/roles predating this instruction)._', '',
    unmatched.length ? ['| Item :: role | starts | ends | Last heartbeat |', '|---|---|---|---|', ...unmatched].join('\n') : '_none_', '',
    '## Gate verdicts', '', gateRows.length ? ['| Gate | Runs | Ok | Rate |', '|---|---|---|---|', ...gateRows].join('\n') : '_none_', '',
    unclassified.length ? `_Unclassified verdict vocabulary (counted not-ok — extend verdictOk() if these are passes, KI-E40): ${unclassified.join(', ')}_\n` : '',
    '## Fold-time token usage (KI-E23 usage events)', '',
    (agg.usage || []).length
      ? ['| Cycle | Results file | Output tokens |', '|---|---|---|',
        ...agg.usage.map((u) => `| ${u.cycle} | ${u.file} | ${u.outputTokens.toLocaleString('en-US')} |`),
        `| **total** | | **${agg.usage.reduce((a, u) => a + u.outputTokens, 0).toLocaleString('en-US')}** |`].join('\n')
      : '_none — usage events land on folds from KI-E23 onward_', '',
    '## Session token usage & cache hit rate (KI-E66, Prometheus-derived)', '',
    '_Requires `driver.mjs preflight` to report `cost telemetry: ready` for the session that ran the cycle (KI-E33) AND a reachable Prometheus with the claude_code_token_usage_tokens_total metric. A time window stamped with a cycle is not proof of cycle/session attribution: an unfiltered query includes every matching session/host in that Prometheus. NOT per-item either way — Claude Code has no concept of a factory work item, and the factory runs 2-3 items concurrently (SKILL.md), so a per-item window query would double-count overlapping siblings. See "Per-item apportioned tokens" below for the best available item-level view; missing token buckets stay unknown, never fabricated as zero._', '',
    (agg.tokenUsageSnapshots || []).length
      // ported from a host-mount session: an unknown (null) bucket renders literally as 'unknown'
      // rather than being coerced to '0' by an unguarded .toLocaleString() (which would also throw
      // on null) — the same "don't fabricate a measurement" discipline as token-usage.mjs itself.
      // The extra Source / scope / selector column surfaces whether a row is a shared/unfiltered
      // window read or one narrowed to this run, since those carry different attribution confidence.
      ? ['| Cycle | Input | Output | Cache read | Cache creation | Total | Cache hit rate | Source / scope / selector |', '|---|---|---|---|---|---|---|---|',
        ...agg.tokenUsageSnapshots.map((u) => `| ${u.cycle} | ${u.inputTokens?.toLocaleString('en-US') ?? 'unknown'} | ${u.outputTokens?.toLocaleString('en-US') ?? 'unknown'} | ${u.cacheReadTokens?.toLocaleString('en-US') ?? 'unknown'} | ${u.cacheCreationTokens?.toLocaleString('en-US') ?? 'unknown'} | ${u.totalTokens?.toLocaleString('en-US') ?? 'unknown'} | ${u.cacheHitRate == null ? 'unknown' : Math.round(u.cacheHitRate * 100) + '%'} | ${u.source} / ${u.scope} / ${JSON.stringify(u.selector)} |`)].join('\n')
      : '_NOT gathered — either the session lacked the OTLP metrics-exporter env (`driver.mjs preflight`) or Prometheus was unreachable when this report ran (`driver.mjs telemetry-report` re-attempts the query every time; re-run after fixing either)_', '',
    '## Per-item apportioned tokens (estimate — NOT a measurement, KI-E66)', '',
    '_Real per-item token measurement is not available: the Workflow runtime exposes only a whole-run output-token counter (no per-item split), confirmed by this factory'
      + "'s own multi-month history never achieving better despite KI-E23 wanting per-item granularity. This table divides each cycle's REAL, measured output-token total (the Fold-time token usage section above) across that cycle's items by their REAL, measured call-count share (ledger cost map) — a disclosed apportionment of a real number, never a fabricated one. Treat as directional, not exact._",
    '',
    (() => {
      const rows = [];
      for (const u of agg.usage || []) {
        const shares = apportionTokensByCallShare(u.outputTokens, (agg.itemCallCounts || {})[u.cycle] || {});
        for (const [item, tok] of Object.entries(shares).sort((a, b) => b[1] - a[1])) rows.push(`| ${u.cycle} | ${item} | ${tok.toLocaleString('en-US')} |`);
      }
      return rows.length ? ['| Cycle | Item | Apportioned output tokens (est.) |', '|---|---|---|', ...rows].join('\n') : '_none — needs both a fold-time usage event and item_folded cost data for the same cycle_';
    })(), '',
    '## Agent-call volume by model (from fold cost)', '', kv(agg.models, 'Model', 'Calls'), '',
    // KI-E107 — the yield section. See aggregateEvents for why call-count is the unit.
    '## Agent-call spend by outcome (KI-E107)', '',
    '_The share of the factory\'s work that reached a CLOSED item. Call counts are the only per-item cost unit that is real and measured — KI-E66 established that per-item TOKEN counts are structurally unavailable inside the Workflow runtime (`budget` exposes a whole-run counter only, and a direct empirical test confirmed an `agent()` call\'s own cost is not recoverable from outside the sandbox). So this is a call-weighted proxy: directional, never a bill. It is the one number that makes a cost argument settleable — an optimisation that lowers total calls but lowers the CLOSED share is not a saving._', '',
    renderCallsByOutcome(agg.callsByOutcome), '',
  ].join('\n');
}

// KI-E176 (2026-09-14) — durable, human-readable log of every CONTINUED run: a Workflow the
// controller stopped mid-flight (a deliberate pause, a crash, a laptop sleep) and relaunched into
// the SAME claim/worktree (the `resume` + relaunch shape KI-E140 already prints), as opposed to an
// independent fresh attempt from a new `group` claim. `cmdMarkLaunched --continued` emits the
// `run_continued` source-of-truth event (AD-3: one append-only stream, this report is a derived
// view); this function renders that history. Pure — takes the already-read event array, never reads
// the stream itself, so it is directly unit-testable without a telemetry file on disk.
export function continuedRunsMd(events) {
  const rows = (events || []).filter((e) => e && e.event === 'run_continued');
  const lines = ['# Continued runs', '', 'Every run stopped mid-flight and relaunched into the SAME claim/worktree (`resume` + relaunch, KI-E140/KI-E176) — never a fresh `group` claim.', ''];
  if (!rows.length) { lines.push('_None yet._'); return lines.join('\n') + '\n'; }
  lines.push('| Item | Cycle | Stopped (task / run) | Relaunched (task / run) | Logged at |', '|---|---|---|---|---|');
  for (const e of rows) {
    const a = e.attrs || {};
    lines.push(`| ${e.item || ''} | ${e.cycle ?? ''} | ${a.previousTaskId || '?'} / ${a.previousRunId || '?'} | ${a.newTaskId || '?'} / ${a.newRunId || '?'} | ${e.ts || ''} |`);
  }
  return lines.join('\n') + '\n';
}
