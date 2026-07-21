// Pure aggregation core of the factory-exporter (spine AD-5/AD-12/AD-13 + tests convention:
// pure logic extracted so _selftest.mjs can cover it without HTTP/fs). No node: imports beyond
// crypto — everything here is deterministic state-in/state-out.
import { createHash } from 'node:crypto';

// Histogram buckets (seconds) — mirror the collector's spanmetrics buckets.
export const BUCKETS = [30, 60, 120, 300, 600, 1200, 2400, 3600];

export function createState() {
  return {
    eventsTotal: new Map(),      // event -> Map(source -> n)
    itemState: new Map(),        // item -> latest lifecycle state
    foldsTotal: new Map(),       // toState -> n
    stageHist: new Map(),        // stage -> { buckets: number[], sum, count }   (source:'derived' ONLY — AD-12)
    gateVerdicts: new Map(),     // gate -> Map(verdict -> n)                    (nested — names may contain spaces)
    modelCalls: new Map(),       // model -> n (from fold cost)
    agentStageEvents: new Map(), // stage -> Map(event -> n)  (agent liveness, never durations)
    infraTotal: 0,
    lastEventTsSec: 0,
    parseErrors: 0,
    linesIngested: 0,
    stageBuffer: new Map(),      // "item#cycle" -> [{stage, tsMs, durMs}] awaiting the fold span assembly
  };
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const bump2 = (map, k1, k2, by = 1) => { let m = map.get(k1); if (!m) { m = new Map(); map.set(k1, m); } bump(m, k2, by); };

export function observeStage(state, stage, durMs) {
  let h = state.stageHist.get(stage);
  if (!h) { h = { buckets: new Array(BUCKETS.length + 1).fill(0), sum: 0, count: 0 }; state.stageHist.set(stage, h); }
  const s = durMs / 1000;
  let placed = false;
  for (let i = 0; i < BUCKETS.length; i++) if (s <= BUCKETS[i]) { h.buckets[i]++; placed = true; break; }
  if (!placed) h.buckets[BUCKETS.length]++;
  h.sum += s; h.count++;
}

// Ingest one raw line into state. Returns {folded} when the line was an applied item_folded
// (the caller may then assemble+push the item's trace). Never throws.
export function ingestLine(state, line) {
  const t = String(line || '').trim();
  if (!t) return {};
  let e;
  try { e = JSON.parse(t); } catch { state.parseErrors++; return {}; }
  if (!e || typeof e !== 'object' || !e.event) { state.parseErrors++; return {}; }
  state.linesIngested++;
  bump2(state.eventsTotal, String(e.event), String(e.source || '?'));
  const tsMs = Date.parse(e.ts || '');
  if (Number.isFinite(tsMs)) state.lastEventTsSec = Math.max(state.lastEventTsSec, Math.floor(tsMs / 1000));

  if (e.event === 'item_claimed' && e.item) state.itemState.set(e.item, 'CLAIMED');
  if (e.event === 'transition' && e.item && e.outcome) state.itemState.set(e.item, String(e.outcome));

  if (e.event === 'stage_end' && e.stage && typeof e.durMs === 'number') {
    if (e.source === 'derived') { // AD-12 hard whitelist — ONLY derived feeds the duration authority
      observeStage(state, e.stage, e.durMs);
      if (e.item != null && e.cycle != null && Number.isFinite(tsMs)) {
        const key = `${e.item}#${e.cycle}`;
        if (!state.stageBuffer.has(key)) state.stageBuffer.set(key, []);
        state.stageBuffer.get(key).push({ stage: e.stage, tsMs, durMs: e.durMs });
      }
    } else bump2(state.agentStageEvents, String(e.stage), 'stage_end');
  }
  if (e.event === 'stage_start' && e.source === 'agent' && e.stage) bump2(state.agentStageEvents, String(e.stage), 'stage_start');

  if (e.event === 'item_folded') {
    const st = (e.attrs && e.attrs.toState) || e.outcome || '?';
    bump(state.foldsTotal, String(st));
    if (e.item) state.itemState.set(e.item, String(e.outcome || st));
    if (e.attrs && e.attrs.infraSuspect) state.infraTotal++;
    if (e.attrs && e.attrs.gates) for (const [g, v] of Object.entries(e.attrs.gates)) bump2(state.gateVerdicts, g, String(v));
    if (e.attrs && e.attrs.cost) for (const [m, n] of Object.entries(e.attrs.cost)) bump(state.modelCalls, m, Number(n) || 0);
    if (e.item != null && e.cycle != null) return { folded: e, foldTsMs: tsMs };
  }
  return {};
}

// ---- OTLP span assembly (AD-13: deterministic ids; ONE span per stage — review finding #3) --
export const hexId = (seed, len) => createHash('sha256').update(seed).digest('hex').slice(0, len);
const nanos = (ms) => (BigInt(Math.max(0, Math.round(ms))) * 1000000n).toString();

// Consumes (deletes) the item's buffered stages REGARDLESS of whether the caller pushes
// (review finding #6 — the buffer must never leak when OTLP is disabled).
export function assembleTrace(state, folded, foldTsMs) {
  const resultId = `${folded.item}#${folded.cycle}`;
  const raw = state.stageBuffer.get(resultId) || [];
  state.stageBuffer.delete(resultId);
  // Merge the per-ARTIFACT derived events into ONE span per stage (min start / max end) —
  // duplicate spanIds are invalid OTLP and break trace views + spanmetrics.
  const byStage = new Map();
  for (const s of raw) {
    const m = byStage.get(s.stage);
    const start = s.tsMs - s.durMs;
    if (!m) byStage.set(s.stage, { stage: s.stage, startMs: start, endMs: s.tsMs });
    else { m.startMs = Math.min(m.startMs, start); m.endMs = Math.max(m.endMs, s.tsMs); }
  }
  const stages = [...byStage.values()].sort((a, b) => a.startMs - b.startMs);
  const traceId = hexId(resultId, 32);
  const rootSpanId = hexId(resultId + '|item', 16);
  const endMs = Number.isFinite(foldTsMs) ? foldTsMs : (stages.length ? Math.max(...stages.map((s) => s.endMs)) : 0);
  const startMs = stages.length ? Math.min(...stages.map((s) => s.startMs)) : endMs;
  const attr = (key, value) => ({ key, value: { stringValue: String(value) } });
  const outcome = (folded.attrs && folded.attrs.toState) || folded.outcome || '?';
  const spans = [{
    traceId, spanId: rootSpanId, name: `item ${folded.item}`, kind: 1,
    startTimeUnixNano: nanos(startMs), endTimeUnixNano: nanos(endMs),
    attributes: [attr('factory.item', folded.item), attr('factory.outcome', outcome), attr('factory.cycle', folded.cycle), ...(folded.lane ? [attr('factory.lane', folded.lane)] : [])],
    status: { code: outcome === 'CLOSED' ? 1 : 2 },
  }];
  for (const s of stages) spans.push({
    traceId, spanId: hexId(`${resultId}|${s.stage}`, 16), parentSpanId: rootSpanId, name: s.stage, kind: 1,
    startTimeUnixNano: nanos(s.startMs), endTimeUnixNano: nanos(s.endMs),
    attributes: [attr('factory.item', folded.item), attr('factory.stage', s.stage), attr('factory.outcome', outcome)],
    status: { code: 1 },
  });
  return { resourceSpans: [{ resource: { attributes: [attr('service.name', 'ai-factory')] }, scopeSpans: [{ scope: { name: 'factory-exporter' }, spans }] }] };
}

// ---- Prometheus text exposition (pure over state) -------------------------------------------
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
export function renderMetrics(state) {
  const out = [];
  const put = (name, type, help) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  put('factory_events_total', 'counter', 'Telemetry events ingested, by event and source');
  for (const [ev, srcs] of state.eventsTotal) for (const [src, n] of srcs) out.push(`factory_events_total{event="${esc(ev)}",source="${esc(src)}"} ${n}`);
  put('factory_items', 'gauge', 'Items currently in each lifecycle state (derived from the event stream)');
  const byState = new Map();
  for (const st of state.itemState.values()) bump(byState, st);
  for (const [st, n] of byState) out.push(`factory_items{state="${esc(st)}"} ${n}`);
  put('factory_item_folds_total', 'counter', 'Folded item results by final state');
  for (const [st, n] of state.foldsTotal) out.push(`factory_item_folds_total{tostate="${esc(st)}"} ${n}`);
  put('factory_stage_duration_seconds', 'histogram', 'Derived (mtime-backfilled) stage durations — the only duration authority (AD-12)');
  for (const [stage, h] of state.stageHist) {
    let cum = 0;
    for (let i = 0; i < BUCKETS.length; i++) { cum += h.buckets[i]; out.push(`factory_stage_duration_seconds_bucket{stage="${esc(stage)}",le="${BUCKETS[i]}"} ${cum}`); }
    cum += h.buckets[BUCKETS.length];
    out.push(`factory_stage_duration_seconds_bucket{stage="${esc(stage)}",le="+Inf"} ${cum}`);
    out.push(`factory_stage_duration_seconds_sum{stage="${esc(stage)}"} ${h.sum.toFixed(3)}`);
    out.push(`factory_stage_duration_seconds_count{stage="${esc(stage)}"} ${h.count}`);
  }
  put('factory_gate_verdicts_total', 'counter', 'Gate/review verdicts from folds');
  for (const [g, vs] of state.gateVerdicts) for (const [v, n] of vs) out.push(`factory_gate_verdicts_total{gate="${esc(g)}",verdict="${esc(v)}"} ${n}`);
  put('factory_agent_calls_total', 'counter', 'Agent-call volume by model (from fold cost)');
  for (const [m, n] of state.modelCalls) out.push(`factory_agent_calls_total{model="${esc(m)}"} ${n}`);
  put('factory_infra_failures_total', 'counter', 'Fold results flagged infra-suspect (KI-L50/L53 class)');
  out.push(`factory_infra_failures_total ${state.infraTotal}`);
  put('factory_agent_stage_events_total', 'counter', 'Agent-emitted stage events (liveness/compliance only — never durations of record, AD-12)');
  for (const [s, evs] of state.agentStageEvents) for (const [ev, n] of evs) out.push(`factory_agent_stage_events_total{stage="${esc(s)}",event="${esc(ev)}"} ${n}`);
  put('factory_last_event_timestamp_seconds', 'gauge', 'Unix time of the newest ingested event');
  out.push(`factory_last_event_timestamp_seconds ${state.lastEventTsSec}`);
  put('factory_exporter_lines_ingested_total', 'counter', 'Event lines successfully ingested');
  out.push(`factory_exporter_lines_ingested_total ${state.linesIngested}`);
  put('factory_exporter_parse_errors_total', 'counter', 'Event lines that failed to parse');
  out.push(`factory_exporter_parse_errors_total ${state.parseErrors}`);
  return out.join('\n') + '\n';
}
