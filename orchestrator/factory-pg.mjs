/**
 * factory-pg.mjs — PostgreSQL telemetry store for the factory (KI-E385).
 *
 * Zero npm deps: all postgres calls go through
 *   kubectl -n <namespace> exec postgres-0 -- psql -U postgres -d factory_telemetry
 * and all embedding calls go through
 *   docker exec -i factory-vectorizer python3 /embed.py
 *
 * The FACTORY_PG_ENABLED env var (or orchestrator.config.json pgTelemetry.enabled)
 * controls whether this module is active. Graceful no-op when disabled or unreachable.
 *
 * Exports:
 *   recordBatchMetrics(runId, batchResults, batchMeta)  — write run + item rows
 *   hillClimbAnalysis(cfg)                              — read recent runs, suggest
 *   markImprovementProposed(kiId, patternKey, failureClass) — track proposals
 */

import { execFileSync, spawnSync } from 'node:child_process';

const PG_NS        = process.env.FACTORY_PG_NAMESPACE || 'default';
const PG_POD       = 'postgres-0';
const PG_USER      = 'postgres';
const PG_DB        = 'factory_telemetry';
const EMBED_CONTAINER = process.env.FACTORY_EMBED_CONTAINER || 'factory-vectorizer';
const EMBED_SCRIPT    = '/embed.py';

// ── Low-level helpers ─────────────────────────────────────────────────────────

/** Run SQL via kubectl exec, return stdout string. Throws on psql error. */
function pgRun(sql, { quiet = false } = {}) {
  const r = spawnSync('kubectl', [
    '-n', PG_NS, 'exec', PG_POD, '--',
    'psql', '-U', PG_USER, '-d', PG_DB,
    '-t',         // tuples-only (no headers, no row count)
    '-A',         // unaligned (no padding)
    '-c', sql,
  ], { encoding: 'utf8', timeout: 20_000 });

  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim();
    if (!quiet) throw new Error(`pgRun failed: ${msg}`);
    return '';
  }
  return (r.stdout || '').trim();
}

/** Run multiple statements via kubectl exec with stdin (for large inserts). */
function pgScript(sql, { quiet = false } = {}) {
  const r = spawnSync('kubectl', [
    '-n', PG_NS, 'exec', '-i', PG_POD, '--',
    'psql', '-U', PG_USER, '-d', PG_DB,
    '-t', '-A',
  ], { input: sql, encoding: 'utf8', timeout: 30_000 });

  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim();
    if (!quiet) throw new Error(`pgScript failed: ${msg}`);
    return '';
  }
  return (r.stdout || '').trim();
}

/** Embed an array of strings, return array of 384-dim float arrays (or nulls on failure). */
function embedBatch(texts) {
  if (!texts || texts.length === 0) return [];
  const input = JSON.stringify(texts.map((t) => String(t || '').slice(0, 512)));
  const r = spawnSync('docker', ['exec', '-i', EMBED_CONTAINER, 'python3', EMBED_SCRIPT], {
    input,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) return texts.map(() => null);
  try {
    const vecs = JSON.parse(r.stdout.trim());
    return Array.isArray(vecs) ? vecs : texts.map(() => null);
  } catch {
    return texts.map(() => null);
  }
}

/** Escape a string value for embedding into SQL literals. */
function esc(s) {
  if (s == null) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Format a vector array as a pgvector literal '[0.1,0.2,…]' or NULL. */
function vecLit(arr) {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return 'NULL';
  return `'[${arr.join(',')}]'`;
}

/** JSONB literal or NULL. */
function jsonLit(obj) {
  if (obj == null) return 'NULL';
  return esc(JSON.stringify(obj));
}

// ── Check if pg telemetry is available ───────────────────────────────────────

let _pgAvailable = null;
function isPgAvailable() {
  if (_pgAvailable !== null) return _pgAvailable;
  try {
    pgRun('SELECT 1', { quiet: true });
    _pgAvailable = true;
  } catch {
    _pgAvailable = false;
  }
  return _pgAvailable;
}

// ── recordBatchMetrics ────────────────────────────────────────────────────────

/**
 * Write one factory_runs row + N factory_item_runs rows after a batch fold.
 *
 * @param {string}   runId        - orchestrator run UUID
 * @param {object[]} batchResults - array of fold result objects from checkpoints()
 * @param {object}   batchMeta    - { cycle, maxLanes, backend, cfg, runsJsonl }
 */
export function recordBatchMetrics(runId, batchResults, batchMeta = {}) {
  if (!isPgAvailable()) return;

  const { cycle = null, maxLanes = null, backend = null, cfg = null } = batchMeta;

  // ── Aggregate run-level metrics ───────────────────────────────────────────
  const dispatched = batchResults.length;
  let closed = 0, failed = 0, escalated = 0, partial = 0;
  let totalTokens = 0;

  // Gate verdicts aggregation
  const gatePass = {}, gateFail = {};

  // Item-level rows for factory_item_runs
  const itemRows = [];

  for (const r of batchResults) {
    const state = (r.toState || '').toUpperCase();
    if (state === 'CLOSED')    closed++;
    else if (state === 'FAILED' || state === 'RED')    failed++;
    else if (state === 'ESCALATED') escalated++;
    else partial++;

    totalTokens += r.tokensUsed || 0;

    // Gate verdicts
    for (const [g, v] of Object.entries(r.gates || {})) {
      if (v === 'APPROVED') gatePass[g] = (gatePass[g] || 0) + 1;
      else                  gateFail[g] = (gateFail[g] || 0) + 1;
    }

    const failureClass = classifyFailureClass(r);
    const noteText = [r.note, r.overrideReason].filter(Boolean).join(' | ');

    itemRows.push({
      runId,
      itemId: r.id,
      fromState: r.fromState || null,
      toState: state,
      attemptNumber: r.attemptNumber || null,
      decisiveGate: r.decisiveGate || null,
      overrideReason: r.overrideReason || null,
      failureClass,
      tokensUsed: r.tokensUsed || null,
      gateVerdicts: r.gates || null,
      noteText: noteText || null,
    });
  }

  const closeRate    = dispatched > 0 ? (closed / dispatched) : 0;
  const failureRate  = dispatched > 0 ? ((failed + escalated) / dispatched) : 0;
  const tokensPerClose = closed > 0 ? (totalTokens / closed) : null;

  const gateVerdicts = {};
  const allGates = new Set([...Object.keys(gatePass), ...Object.keys(gateFail)]);
  for (const g of allGates) {
    gateVerdicts[g] = { pass: gatePass[g] || 0, fail: gateFail[g] || 0 };
  }

  // ── Build summary text for embedding ─────────────────────────────────────
  const summaryText = [
    `cycle=${cycle} lanes=${maxLanes} backend=${backend}`,
    `dispatched=${dispatched} closed=${closed} failed=${failed} escalated=${escalated}`,
    `close_rate=${closeRate.toFixed(3)} failure_rate=${failureRate.toFixed(3)}`,
    tokensPerClose ? `tokens_per_close=${tokensPerClose.toFixed(0)}` : 'no_closes',
    ...Object.entries(gateVerdicts).map(([g, v]) => `${g}:${v.pass}p/${v.fail}f`),
  ].join(' ');

  // Item note texts for embedding
  const noteTexts = itemRows.map((r) => r.noteText || `${r.toState} ${r.failureClass || ''}`);

  // ── Embed in batch (one call for the run summary + all item notes) ────────
  const allTexts = [summaryText, ...noteTexts];
  const allVecs  = embedBatch(allTexts);
  const summaryVec = allVecs[0] || null;
  const itemVecs   = allVecs.slice(1);

  // ── Write run row ─────────────────────────────────────────────────────────
  const configSnapshot = cfg ? {
    maxLanes: cfg.maxLanes,
    backend: cfg.backend,
    weeklyTokenLimit: cfg.weeklyTokenLimit,
    hillClimb: cfg.hillClimb,
  } : null;

  const runSql = `
INSERT INTO factory_runs (
  run_id, cycle, max_lanes, backend,
  dispatched, closed, failed, escalated, partial,
  tokens_total,
  close_rate, failure_rate, tokens_per_close,
  gate_verdicts, factory_config, summary_text, summary_vec
) VALUES (
  ${esc(runId)}, ${cycle ?? 'NULL'}, ${maxLanes ?? 'NULL'}, ${esc(backend)},
  ${dispatched}, ${closed}, ${failed}, ${escalated}, ${partial},
  ${totalTokens || 'NULL'},
  ${closeRate.toFixed(6)}, ${failureRate.toFixed(6)}, ${tokensPerClose != null ? tokensPerClose.toFixed(2) : 'NULL'},
  ${jsonLit(gateVerdicts)}, ${jsonLit(configSnapshot)}, ${esc(summaryText)}, ${vecLit(summaryVec)}
)
ON CONFLICT (run_id) DO UPDATE SET
  closed = EXCLUDED.closed,
  failed = EXCLUDED.failed,
  close_rate = EXCLUDED.close_rate,
  failure_rate = EXCLUDED.failure_rate,
  tokens_per_close = EXCLUDED.tokens_per_close,
  gate_verdicts = EXCLUDED.gate_verdicts,
  summary_text = EXCLUDED.summary_text,
  summary_vec = EXCLUDED.summary_vec;
`;

  // ── Write item rows ───────────────────────────────────────────────────────
  const itemInserts = itemRows.map((r, i) => `
INSERT INTO factory_item_runs (
  run_id, item_id, from_state, to_state, attempt_number,
  decisive_gate, override_reason, failure_class,
  tokens_used, gate_verdicts, note_text, note_vec
) VALUES (
  ${esc(r.runId)}, ${esc(r.itemId)}, ${esc(r.fromState)}, ${esc(r.toState)}, ${r.attemptNumber ?? 'NULL'},
  ${esc(r.decisiveGate)}, ${esc(r.overrideReason)}, ${esc(r.failureClass)},
  ${r.tokensUsed ?? 'NULL'}, ${jsonLit(r.gateVerdicts)}, ${esc(r.noteText)}, ${vecLit(itemVecs[i] || null)}
);`).join('\n');

  try {
    pgScript(runSql + '\n' + itemInserts);
  } catch (e) {
    // non-fatal — telemetry must never crash the factory
    console.error(`[factory-pg] recordBatchMetrics failed: ${e.message}`);
  }

  // ── Hill climb after recording ────────────────────────────────────────────
  try {
    const suggestions = hillClimbInternal();
    if (suggestions.length > 0) {
      console.log(`[factory-pg] hill-climb suggestions:`);
      for (const s of suggestions) console.log(`  · ${s.param}: ${s.reason}`);
    }
  } catch { /* non-fatal */ }
}

// ── Failure class classifier (mirrors postBatchFailureAnalysis detection) ─────

function classifyFailureClass(result) {
  const note = (result.note || result.overrideReason || '').toLowerCase();
  const toState = (result.toState || '').toUpperCase();
  if (note.includes('phantom') || note.includes('worktree diff shows no change')) return 'phantom-manifest';
  if (note.includes('build') && (note.includes('error') || note.includes('fail'))) return 'build-error';
  if (note.includes('test') && note.includes('fail')) return 'test-failure';
  if (note.includes('gate') && (note.includes('reject') || note.includes('fail'))) return 'gate-rejection';
  if (toState === 'FAILED') return 'fold-failed';
  if (toState === 'ESCALATED') return 'escalated';
  return null;
}

// ── hillClimbAnalysis ─────────────────────────────────────────────────────────

/**
 * Read the last N runs from factory_runs, compute fitness trend, suggest parameter nudges.
 * Called automatically after recordBatchMetrics. Also exportable for manual queries.
 *
 * Returns array of { param, direction, reason, fitness, prevFitness } objects.
 */
export function hillClimbAnalysis() {
  if (!isPgAvailable()) return [];
  return hillClimbInternal();
}

function hillClimbInternal() {
  // Fetch last 10 runs ordered oldest-first
  const rawRows = pgRun(`
SELECT run_id, cycle, max_lanes, close_rate, failure_rate, tokens_per_close,
       tokens_total, closed, dispatched, recorded_at
FROM factory_runs
ORDER BY id DESC
LIMIT 10;
`, { quiet: true });

  if (!rawRows) return [];

  const rows = rawRows.split('\n').filter(Boolean).map((line) => {
    const [run_id, cycle, max_lanes, close_rate, failure_rate, tokens_per_close,
           tokens_total, closed, dispatched, recorded_at] = line.split('|');
    return {
      run_id: (run_id || '').trim(),
      cycle: parseInt(cycle) || 0,
      max_lanes: parseInt(max_lanes) || 0,
      close_rate: parseFloat(close_rate) || 0,
      failure_rate: parseFloat(failure_rate) || 0,
      tpc: parseFloat(tokens_per_close) || 0,
      tokens_total: parseInt(tokens_total) || 0,
      closed: parseInt(closed) || 0,
      dispatched: parseInt(dispatched) || 0,
    };
  }).filter((r) => r.run_id).reverse(); // oldest first

  if (rows.length < 3) return []; // need at least 3 runs

  const avg = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0) / arr.length;
  const half = Math.floor(rows.length / 2);
  const prev  = rows.slice(0, half);
  const recent = rows.slice(half);

  const prevCR    = avg(prev, 'close_rate');
  const recentCR  = avg(recent, 'close_rate');
  const prevFR    = avg(prev, 'failure_rate');
  const recentFR  = avg(recent, 'failure_rate');
  const prevTPC   = avg(prev, 'tpc');
  const recentTPC = avg(recent, 'tpc');

  // Fitness = close_rate − failure_rate penalty + efficiency bonus
  // Simple: CR / (1 + FR*2) * (prevTPC > 0 ? prevTPC / max(recentTPC, 1) : 1)
  const fitness = (cr, fr, tpc, baseTpc) => {
    const efficiencyBonus = baseTpc > 0 && tpc > 0 ? Math.min(baseTpc / tpc, 2) : 1;
    return (cr / (1 + fr * 2)) * efficiencyBonus;
  };

  const prevFitness   = fitness(prevCR, prevFR, prevTPC, prevTPC);
  const recentFitness = fitness(recentCR, recentFR, recentTPC, prevTPC);

  const suggestions = [];
  const latestLanes = recent[recent.length - 1]?.max_lanes || 0;

  // Close rate dropped > 15% → reduce concurrency pressure
  if (recentCR < prevCR * 0.85 && recentCR < 0.5) {
    suggestions.push({
      param: 'max_lanes',
      direction: -1,
      reason: `Close rate dropped ${((1 - recentCR / prevCR) * 100).toFixed(1)}% (${prevCR.toFixed(2)} → ${recentCR.toFixed(2)}). Reduce lanes from ${latestLanes} to ${Math.max(1, latestLanes - 1)} to reduce phantom-manifest / infra pressure.`,
      fitness: recentFitness,
      prevFitness,
    });
  }

  // Failure rate spiked > 30% → reduce lanes regardless of close rate
  if (recentFR > prevFR * 1.3 && recentFR > 0.3) {
    suggestions.push({
      param: 'max_lanes',
      direction: -1,
      reason: `Failure rate spiked ${((recentFR / prevFR - 1) * 100).toFixed(1)}% (${prevFR.toFixed(2)} → ${recentFR.toFixed(2)}). Reduce lanes to stabilise.`,
      fitness: recentFitness,
      prevFitness,
    });
  }

  // Close rate improving, failure stable → try one more lane
  if (recentCR > prevCR * 1.1 && recentFR <= prevFR * 1.1 && latestLanes < 16) {
    suggestions.push({
      param: 'max_lanes',
      direction: +1,
      reason: `Close rate up ${((recentCR / prevCR - 1) * 100).toFixed(1)}% with stable failure rate. Try lanes=${latestLanes + 1}.`,
      fitness: recentFitness,
      prevFitness,
    });
  }

  // Tokens per close up > 25% with stable close rate → model is being wasteful
  if (prevTPC > 0 && recentTPC > prevTPC * 1.25 && recentCR >= prevCR * 0.9) {
    suggestions.push({
      param: 'model_efficiency',
      direction: -1,
      reason: `Tokens/close up ${((recentTPC / prevTPC - 1) * 100).toFixed(1)}% (${Math.round(prevTPC).toLocaleString()} → ${Math.round(recentTPC).toLocaleString()}) with stable close rate — consider lighter model tier for low-band items.`,
      fitness: recentFitness,
      prevFitness,
    });
  }

  // Fitness plateau (< 5% change either way) for 6+ runs
  if (rows.length >= 6 && Math.abs(recentFitness - prevFitness) < 0.05 * prevFitness) {
    suggestions.push({
      param: 'exploration',
      direction: 0,
      reason: `Fitness plateau detected (prev=${prevFitness.toFixed(3)}, recent=${recentFitness.toFixed(3)}). Consider exploring a different item band, increasing proposals aggressiveness, or adjusting the curriculum.`,
      fitness: recentFitness,
      prevFitness,
    });
  }

  // Write hill state row for each suggestion
  if (suggestions.length > 0) {
    const fromRunId = rows[0]?.run_id || 'unknown';
    const toRunId   = rows[rows.length - 1]?.run_id || 'unknown';
    for (const s of suggestions) {
      try {
        pgScript(`
INSERT INTO factory_hill_state (
  from_run_id, to_run_id, window_runs,
  param_name, param_value,
  avg_close_rate, avg_failure_rate, avg_tpc,
  fitness, suggestion, suggestion_dir
) VALUES (
  ${esc(fromRunId)}, ${esc(toRunId)}, ${rows.length},
  ${esc(s.param)}, ${jsonLit(s.direction)},
  ${recentCR.toFixed(6)}, ${recentFR.toFixed(6)}, ${recentTPC > 0 ? recentTPC.toFixed(2) : 'NULL'},
  ${recentFitness.toFixed(6)}, ${esc(s.reason)}, ${s.direction}
);`);
      } catch { /* non-fatal */ }
    }
  }

  return suggestions;
}

// ── markImprovementProposed ───────────────────────────────────────────────────

/**
 * Record that a postBatchFailureAnalysis proposal was generated.
 * Called from postBatchFailureAnalysis when a proposal or direct-fix is applied.
 */
export function markImprovementProposed(kiId, patternKey, failureClass = null) {
  if (!isPgAvailable()) return;
  try {
    pgScript(`
INSERT INTO factory_improvement_outcomes (ki_id, pattern_key, failure_class)
VALUES (${esc(kiId)}, ${esc(patternKey)}, ${esc(failureClass)})
ON CONFLICT DO NOTHING;`);
  } catch { /* non-fatal */ }
}

/**
 * Mark a previously-proposed improvement as closed, measure effectiveness.
 * effectiveness = 1.0 if failures_after = 0, 0.0 if unchanged.
 */
export function markImprovementClosed(kiId, failuresBefore, failuresAfter, windowRuns) {
  if (!isPgAvailable()) return;
  const eff = failuresBefore > 0
    ? Math.max(0, 1 - failuresAfter / failuresBefore)
    : (failuresAfter === 0 ? 1 : 0);
  try {
    pgScript(`
UPDATE factory_improvement_outcomes
SET closed_at = now(),
    failures_before = ${failuresBefore},
    failures_after  = ${failuresAfter},
    window_runs     = ${windowRuns},
    effectiveness   = ${eff.toFixed(3)}
WHERE ki_id = ${esc(kiId)}
  AND closed_at IS NULL;`);
  } catch { /* non-fatal */ }
}

// ── Convenience: recent runs summary for reporting ────────────────────────────

/**
 * Return a compact text summary of the last N runs for logging.
 * Used by orchestrate.mjs to print a one-liner after each batch.
 */
export function recentRunsSummary(n = 5) {
  if (!isPgAvailable()) return '';
  try {
    const rows = pgRun(`
SELECT cycle, max_lanes, closed, dispatched, close_rate, failure_rate,
       COALESCE(tokens_per_close::text, 'n/a') AS tpc, recorded_at
FROM factory_runs
ORDER BY id DESC
LIMIT ${n};
`, { quiet: true });
    if (!rows) return '';
    const lines = rows.split('\n').filter(Boolean).map((line) => {
      const [cycle, lanes, closed, dispatched, cr, fr, tpc, ts] = line.split('|');
      return `  cycle=${(cycle||'?').trim()} lanes=${(lanes||'?').trim()} closed=${(closed||'0').trim()}/${(dispatched||'0').trim()} CR=${parseFloat(cr||0).toFixed(2)} FR=${parseFloat(fr||0).toFixed(2)} TPC=${(tpc||'n/a').trim()}`;
    });
    return `[pg-telemetry] last ${lines.length} runs:\n${lines.join('\n')}`;
  } catch { return ''; }
}
