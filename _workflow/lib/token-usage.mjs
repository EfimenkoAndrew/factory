// Session token-usage + cache-hit-rate telemetry (KI-E66). Cache-hit-rate did not exist ANYWHERE
// in the factory's own event stream before this — the only signal (claude_code_token_usage_tokens_total,
// Claude-Code-session-side OTLP) fed two Grafana panels only (KI-E28), and per KI-E28/KI-E33/the
// 2026-07-24 analysis's F5, those panels have been permanently empty on every host observed to
// date because the OTLP metrics-exporter env was never actually configured. This module is a
// best-effort BRIDGE: when Prometheus has the metric for a requested window, pull it into the
// durable events.jsonl stream (AD-9) as a token_usage_snapshot event, so evaluation does not
// depend on Grafana/Prometheus staying up or ever having been configured correctly.
//
// Scope is CYCLE-level, not per-item: the metric carries no item/task dimension (Claude Code has
// no concept of a factory work item), and the factory runs 2-3 items CONCURRENTLY (SKILL.md), so
// a window-based per-item attribution would double-count overlapping siblings. True per-item
// token measurement is not available from inside factory.js's sandboxed Workflow runtime either —
// confirmed by direct platform documentation (the runtime's `budget` global exposes only a
// whole-turn/whole-workflow output-token counter, `budget.spent()`, already the basis of the
// existing KI-E23 `usage` event) and by this factory's own multi-month development history never
// achieving better than a whole-run total despite KI-E23 explicitly wanting per-item granularity.
// apportionTokensByCallShare() below ships the best HONEST alternative: a disclosed apportionment
// of the real, measured cycle total across items by their real, measured call-count share — never
// presented as a per-item measurement.
//
// Zero new deps (AD-4): plain fetch, same as the OTLP export path already uses.

// Prometheus query response -> {inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}.
// Label values are Claude Code's own OTel semantic-convention names, taken VERBATIM from the
// already-authored dashboard panels (telemetry/grafana/dashboards/ai-factory.json — "Claude Code
// token rate by type" / "Prompt-cache hit ratio"): type ∈ {input, output, cacheRead, cacheCreation}.
// Pure — selftest-covered with fixture Prometheus JSON, no live query needed to test this half.
export function parseTokenUsageVector(promJson) {
  const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const result = (promJson && promJson.data && promJson.data.result) || [];
  for (const series of result) {
    if (!series || typeof series !== 'object') continue;
    const type = String((series.metric && series.metric.type) || '');
    const last = series.value || (Array.isArray(series.values) ? series.values[series.values.length - 1] : null);
    const value = Number(last && last[1]);
    if (!Number.isFinite(value)) continue;
    if (type === 'input') out.inputTokens += value;
    else if (type === 'output') out.outputTokens += value;
    else if (type === 'cacheRead') out.cacheReadTokens += value;
    else if (type === 'cacheCreation') out.cacheCreationTokens += value;
    // an unrecognized type is silently dropped from the typed buckets but never crashes the parse —
    // the raw Prometheus response is still whatever a caller wants to log for diagnosis.
  }
  return out;
}

// Cache hit ratio — the SAME formula already authored in the Grafana "Prompt-cache hit ratio"
// panel (cacheRead / (cacheRead + cacheCreation + input)), reused here rather than inventing a
// second, subtly different definition. Returns null (not 0/NaN) when there is no signal at all —
// a bare 0 would read as "measured, zero hits", exactly the silent-miscount failure class KI-E40
// already had to fix once for gate verdicts. output tokens are excluded: they are never a caching
// concern (nothing reads the model's own output back in as a cache hit).
export function cacheHitRate(usage) {
  const read = Number(usage && usage.cacheReadTokens) || 0;
  const creation = Number(usage && usage.cacheCreationTokens) || 0;
  const input = Number(usage && usage.inputTokens) || 0;
  const denom = read + creation + input;
  return denom > 0 ? read / denom : null;
}

export function tokenUsageSummary(usage) {
  const u = usage || {};
  const inputTokens = Number(u.inputTokens) || 0;
  const outputTokens = Number(u.outputTokens) || 0;
  const cacheReadTokens = Number(u.cacheReadTokens) || 0;
  const cacheCreationTokens = Number(u.cacheCreationTokens) || 0;
  return {
    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    cacheHitRate: cacheHitRate(u),
  };
}

// Build the instant-query PromQL for the total token increase over [sinceMs, untilMs], summed by
// type. increase() over a counter gives the raw growth across the window; evaluated "sum by (type)
// (increase(metric[Ns]))" at time=untilMs is mathematically the window total (dividing two rates
// over the identical window, as the dashboard's ratio panel does, cancels to the same ratio this
// raw-increase form produces — kept as increase() rather than rate() here because the caller wants
// absolute token counts for the window, not a per-second rate).
export function buildTokenUsageQuery(sinceMs, untilMs) {
  const windowSec = Math.max(1, Math.round((untilMs - sinceMs) / 1000));
  return { query: `sum by (type) (increase(claude_code_token_usage_tokens_total[${windowSec}s]))`, time: Math.round(untilMs / 1000) };
}

// Apportion a REAL, measured whole-cycle token total across items by call-count share (the
// existing, accurate per-item per-model call counts already tracked in ledger.items[*].cost /
// item_folded.attrs.cost). This is explicitly NOT a per-item measurement — every caller MUST
// label it as an apportionment/estimate, never as measured data (KI-E66). Items with zero calls
// recorded get no row (nothing to apportion against); rounding means the per-item sum may differ
// from totalTokens by a few tokens — expected for a proportional split, not a bug.
export function apportionTokensByCallShare(totalTokens, perItemCallCounts) {
  const entries = Object.entries(perItemCallCounts || {}).filter(([, n]) => Number(n) > 0);
  const totalCalls = entries.reduce((a, [, n]) => a + Number(n), 0);
  const out = {};
  if (!totalCalls || !(Number(totalTokens) > 0)) return out;
  for (const [item, n] of entries) out[item] = Math.round((Number(n) / totalCalls) * Number(totalTokens));
  return out;
}
