// KI-E309 — automatic self-improvement ANALYZER (the mandatory "improve the factory" mechanism).
// Reads the cumulative run record (reports/runs.jsonl, KI-E307) + the live ledger, finds SYSTEMIC
// weaknesses, and writes:
//   * reports/SELF-IMPROVEMENT.md — a ranked, actionable proposal backlog (committed, human-readable);
//   * queue/factory-improvement-<date>.md — the top NEW proposals, in the queue the consumer
//     (KI-E310, `driver ingest-improvements`) turns into normal gated work items.
// Runs every fold from orchestrate.mjs. It is READ-ONLY analysis — it never edits the factory's own
// code; proposals are executed as ordinary work items (gates + PR + human merge, KI-E303). Dedup is
// by a stable proposal key in state/self-improve.json, so the same finding is not re-queued each run.
// KI-E354 — also queries Prometheus (http://localhost:9090) for ALL gate rejections across all
// attempts, not just the decisive gate. This surfaces "silent re-fix" bottlenecks (gates that burn
// extra rounds without ever being the killing blow) and stage duration anomalies. Falls back
// gracefully when Prometheus is unavailable.
// Zero deps (Node builtins only).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// KI-E366: read telemetry/data/events.jsonl for gate rejection counts and stage duration averages.
// Returns { gateRejections: {gate: count}, stageDurations: {stage: avgSec}, stageDurationsP95: {stage: p95Sec}, source: 'telemetry' } or null.
function readTelemetrySnapshot(root) {
  try {
    const telPath = join(root, 'telemetry', 'data', 'events.jsonl');
    if (!existsSync(telPath)) return null;
    const stageDurMs = {};
    const gateRejections = {};
    for (const line of readFileSync(telPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      // Per-stage wall-clock durations from derived::stage_end (has item+stage+durMs).
      if (e.source === 'derived' && e.event === 'stage_end' && e.stage && e.durMs) {
        (stageDurMs[e.stage] = stageDurMs[e.stage] || []).push(e.durMs);
      }
      // Gate rejections: agent::stage_end where role=gate-* and verdict is a rejection.
      if (e.source === 'agent' && e.event === 'stage_end' && typeof e.role === 'string' && e.role.startsWith('gate-')) {
        const verdict = e.attrs?.verdict || '';
        if (/CHANGES_REQUIRED|REJECT|\bFAIL|BLOCK|NOT[ _]?OK|DENIED|\bERROR/i.test(verdict)) {
          const gate = e.role.replace('-', ':'); // 'gate-developer' -> 'gate:developer'
          gateRejections[gate] = (gateRejections[gate] || 0) + 1;
        }
      }
    }
    const stageDurations = {};
    const stageDurationsP95 = {};
    for (const [stage, durs] of Object.entries(stageDurMs)) {
      if (!durs.length) continue;
      const sorted = [...durs].sort((a, b) => a - b);
      stageDurations[stage] = durs.reduce((a, b) => a + b, 0) / durs.length / 1000; // ms → seconds
      stageDurationsP95[stage] = sorted[Math.floor(sorted.length * 0.95)] / 1000;
    }
    return { gateRejections, stageDurations, stageDurationsP95, source: 'telemetry' };
  } catch { return null; }
}

// KI-E354: query Prometheus for gate rejection counts and stage duration averages.
// Returns { gateRejections: {gate: count}, stageDurations: {stage: avgSec} } or null.
// Only queries when an explicit URL is provided — no localhost default, so test environments
// with an incidental Prometheus on port 9090 don't inject real data into deterministic tests.
function fetchPrometheusSnapshot(prometheusUrl) {
  if (!prometheusUrl) return null;
  try {
    const base = prometheusUrl;
    const qGates = encodeURIComponent('factory_gate_verdicts_total');
    const qDur = encodeURIComponent('factory_stage_duration_seconds_sum/factory_stage_duration_seconds_count');
    const rawGates = execSync(`curl -sf "${base}/api/v1/query?query=${qGates}"`, { timeout: 3000, encoding: 'utf8' });
    const rawDur = execSync(`curl -sf "${base}/api/v1/query?query=${qDur}"`, { timeout: 3000, encoding: 'utf8' });
    const gateResults = JSON.parse(rawGates).data.result;
    const durResults = JSON.parse(rawDur).data.result;
    const gateRejections = {};
    for (const r of gateResults) {
      const v = r.metric; const count = parseInt(r.value[1], 10);
      if (v.verdict && ['CHANGES_REQUIRED','FAIL','FAILED','REJECTED'].includes(v.verdict) && v.gate) {
        gateRejections[v.gate] = (gateRejections[v.gate] || 0) + count;
      }
    }
    const stageDurations = {};
    for (const r of durResults) {
      const stage = r.metric.stage; const avg = parseFloat(r.value[1]);
      if (stage && isFinite(avg) && avg > 0) stageDurations[stage] = avg;
    }
    return { gateRejections, stageDurations };
  } catch { return null; }
}

function readRuns(p) {
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) { if (line.trim()) { try { out.push(JSON.parse(line)); } catch { /* torn */ } } }
  return out;
}

// KI-E454: exponential recency decay for impact ranking. Without this, a historical run count
// accumulates forever with equal weight regardless of age — a pattern that was 95% from a month
// ago and has occurred once since scores identically to one that is 95% from today, so a long-dead
// issue can outrank a live one indefinitely (the live incident: "30 BLOCKED items" sat at the top
// of SELF-IMPROVEMENT.md long after 19 of those 30 were resolved and reset to READY — the report
// just hadn't been regenerated — and "20 run(s) failed with no gate verdict" stayed top-ranked
// while almost all of its occurrences dated to Oct 4–Nov 1 and only one had happened since).
// HALF_LIFE_DAYS=14 means a run's contribution to impact halves every two weeks; a run with no
// `ts` (older records, or hand-built test fixtures) gets full weight 1 — never silently zeroed.
const HALF_LIFE_DAYS = 14;
function recencyWeight(ts, now) {
  if (!ts) return 1;
  const ageDays = (now - new Date(ts).getTime()) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}
function weightedSum(rs, now) { return rs.reduce((sum, r) => sum + recencyWeight(r.ts, now), 0); }

// Produce the ranked proposals from the run record + ledger + optional Prometheus snapshot.
// Pure (no writes) — the caller persists. metricsSnapshot from fetchPrometheusSnapshot() or null.
// Analyzes ALL items (FAILED, ESCALATED, BLOCKED, CLOSED) so the factory learns from every outcome,
// not just successful ones. Fold-time overrides are classified by reason (phantom-manifest, no-production-
// code, verify-baseline-absent, etc.) and generate targeted proposals — not lumped as "infra failures".
// `now` defaults to Date.now() but is an explicit param so KI-E454's recency decay is deterministically
// testable (a fixed `now` + fixed `ts` fixtures, rather than racing the real clock).
export function computeProposals(runs, ledger, metricsSnapshot = null, now = Date.now()) {
  const items = (ledger && ledger.items) || {};
  const failed = runs.filter((r) => r.toState !== 'CLOSED');
  const proposals = [];

  // 1. Gates that reject fixes most — decisive-gate failures from runs.jsonl.
  // Excludes overridden runs (no decisive gate there — those are analyzed in section 8).
  const gateHist = {}, gateWeighted = {};
  const gateFailedRuns = failed.filter((r) => r.decisiveGate && !r.overrode);
  for (const r of gateFailedRuns) {
    gateHist[r.decisiveGate] = (gateHist[r.decisiveGate] || 0) + 1;
    gateWeighted[r.decisiveGate] = (gateWeighted[r.decisiveGate] || 0) + recencyWeight(r.ts, now);
  }
  const failN = Math.max(1, failed.length);
  for (const [gate, n] of Object.entries(gateHist).sort((a, b) => b[1] - a[1])) {
    if (n < 3 && n / failN < 0.2) continue; // only systemic ones
    proposals.push({
      key: `gate:${gate}`,
      impact: Math.round(gateWeighted[gate] * 10), // KI-E454: recency-weighted, not raw count
      title: `Gate \`${gate}\` rejected ${n} fix attempt(s) (${Math.round((n / failN) * 100)}% of failures)`,
      detail: `A single gate is the dominant failure mode. Make the fixer/planner address \`${gate}\` pre-emptively — e.g. extend the planner's step template or the fixer prompt so the change class \`${gate}\` checks for is produced in the first pass. Extension points: agents/ role briefs, the pre-band probe that owns \`${gate}\`, and classifyFixableError (orchestrate.mjs) already re-fixes it (KI-E306) but a prompt fix would avoid the extra round.`,
    });
  }

  // 2. Items stuck on the same gate/override across runs — targeted gap the generic re-fix can't close.
  const perItem = {};
  for (const r of failed) {
    const sig = r.overrode ? (r.overrideReason || 'fold-override') : (r.decisiveGate || '?');
    (perItem[r.id] = perItem[r.id] || []).push({ sig, ts: r.ts });
  }
  for (const [id, entries] of Object.entries(perItem)) {
    if (entries.length < 2) continue;
    if (!items[id] || !['FAILED', 'ESCALATED', 'BLOCKED'].includes(items[id].state)) continue;
    const same = entries.every((e) => e.sig === entries[0].sig);
    // KI-E454: the count scales with recency; the same-signal bonus stays flat (it signals a
    // structural non-convergence, not a volume of occurrences).
    proposals.push({
      key: `stuck:${id}`,
      impact: Math.round(weightedSum(entries, now) * 6) + (same ? 20 : 0),
      title: `Item \`${id}\` failed ${entries.length}× ${same ? `on the SAME signal \`${entries[0].sig}\`` : 'on varied signals'}`,
      detail: same
        ? `Repeated failure on \`${entries[0].sig}\` — the generic re-fix (KI-E306) is not converging. Needs a targeted intervention: a per-item hint, a plan correction, or an explicit owner decision. Consider BLOCKING and filing a queue decision doc.`
        : `Failing on shifting signals — likely an unstable fix or an under-specified acceptance. Review the item's goal and framing; consider adding clearer per-step verification criteria.`,
    });
  }

  // 3. Fold-time override failures — the "not done / phantom" class. These pass all review gates
  // (or never reach them) but are rejected by deterministic checks at fold time. Previously these
  // were misclassified as "infra failures" because they have no decisive gate. Each override reason
  // gets its own proposal so the improvement is targeted, not generic.

  // 3a. Phantom manifest: agent claims to have changed a file but the worktree diff proves otherwise.
  const phantomRuns = failed.filter((r) => r.overrideReason === 'fold-override:phantom-manifest');
  if (phantomRuns.length >= 1) {
    proposals.push({
      key: 'override:phantom-manifest',
      impact: Math.round(weightedSum(phantomRuns, now) * 20), // KI-E454
      title: `${phantomRuns.length} run(s) failed: agent claimed phantom file changes (never touched the file)`,
      detail: `Items: ${phantomRuns.map((r) => r.id).join(', ')}. The agent's fix.json listed files as modified that were never in the worktree diff — KI-E118 (phantom manifest detector) catches this at fold time. All review gates APPROVED, wasting the full gate-band cost. Root cause: the fixer agent wrote a plan step for a file, declared it done in fix.json, but either (a) edited the WRONG path or (b) never wrote the code at all. Fix: extend the fixer prompt to self-verify each declared file exists in the worktree diff before outputting fix.json (a cheap diff-grep step). Also: extend the planner to cross-check declared files against the item's acceptance path before writing the step list.`,
    });
  }

  // 3b. No production code: agent only touched test files, leaving the production bug unfixed.
  const noProdCodeRuns = failed.filter((r) => r.overrideReason === 'fold-override:no-production-code');
  if (noProdCodeRuns.length >= 1) {
    proposals.push({
      key: 'override:no-production-code',
      impact: Math.round(weightedSum(noProdCodeRuns, now) * 18), // KI-E454
      title: `${noProdCodeRuns.length} run(s) failed: diff touched ONLY test files, no production code changed`,
      detail: `Items: ${noProdCodeRuns.map((r) => r.id).join(', ')}. The fixer added or edited tests without changing the source under test — the production bug remains. This is detected by the fold-time override "fix changed NO non-test source file." Fix: add a planner-level constraint that requires at least one non-test file in the step manifest. The fixer pre-flight should assert src/ or equivalent appears in fix.json BEFORE dispatching to the gate band.`,
    });
  }

  // 3c. Verify baseline absent: agent skips the RED capture step so the fold cannot confirm the fix worked.
  const baselineAbsentRuns = failed.filter((r) => r.overrideReason === 'fold-override:verify-baseline-absent');
  if (baselineAbsentRuns.length >= 1) {
    proposals.push({
      key: 'override:verify-baseline-absent',
      impact: Math.round(weightedSum(baselineAbsentRuns, now) * 16), // KI-E454
      title: `${baselineAbsentRuns.length} run(s) failed: verify baseline missing (RED step was skipped)`,
      detail: `Items: ${baselineAbsentRuns.map((r) => r.id).join(', ')}. The fold requires a captured verify-red.txt (baseline suite run BEFORE the fix) to confirm the fix passes tests that previously failed. ${baselineAbsentRuns.length > 1 ? 'This is a SYSTEMIC pattern' : 'This'} — the fixer skips or fails to commit the RED capture, losing the before/after comparison. Fix: (1) make the RED capture step mandatory and non-skippable in the fixer workflow (factory.js step 0 before any code change); (2) add a cheap pre-gate probe that fails immediately when verify-red.txt is absent, preventing wasteful gate-band spend.`,
    });
  }

  // 3d. Other override categories (worktree debris, over-claim, suite issues, etc.)
  const otherOverrides = failed.filter((r) => r.overrode && r.overrideReason &&
    !['fold-override:phantom-manifest','fold-override:no-production-code','fold-override:verify-baseline-absent'].includes(r.overrideReason));
  if (otherOverrides.length >= 2) {
    const byCat = {};
    for (const r of otherOverrides) (byCat[r.overrideReason] = byCat[r.overrideReason] || []).push(r);
    for (const [cat, rs] of Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)) {
      if (rs.length < 1) continue;
      const ids = rs.map((r) => r.id);
      const label = cat.replace('fold-override:', '').replace(/-/g, ' ');
      proposals.push({
        key: `override:${cat}`,
        impact: Math.round(weightedSum(rs, now) * 10), // KI-E454
        title: `${ids.length} run(s) failed via fold-time override: ${label}`,
        detail: `Items: ${ids.join(', ')}. Category: \`${cat}\`. Read last-failure.md for each item to understand the specific fold check that rejected the claim. This override pattern indicates the agent's execution is consistently inconsistent with what fold-time deterministic checks expect — strengthen the corresponding pre-gate probe or the fixer workflow step that should produce the required artifact.`,
      });
    }
  }

  // 4. BLOCKED items — owner decisions pending. The longer they sit, the more they starve throughput.
  const blockedItems = Object.entries(items).filter(([, v]) => v.state === 'BLOCKED');
  if (blockedItems.length >= 1) {
    proposals.push({
      key: 'blocked:owner-decision-pending',
      impact: blockedItems.length * 8,
      title: `${blockedItems.length} item(s) BLOCKED — owner decisions needed before factory can proceed`,
      detail: `Items: ${blockedItems.map(([id]) => id).join(', ')}. BLOCKED items stall throughput indefinitely. Each has a scope-stop or technical constraint that requires a human owner ruling. Action: review reports/decisions-digest.md (if present) or read each item's last-failure.md for the specific decision needed. These should NOT be re-run by the factory — they need a queue decision doc that converts them to a narrower scoped item or a CLOSED-won't-fix verdict.`,
    });
  }

  // 5a. KI-E393: ESCALATED items — passed all gates, need owner decisions. Before this fix they
  // appeared as decisiveGate:null and were misclassified as "infra failures". Separate them out.
  // Also catches pre-fix historical records where decisiveGate was null despite toState=ESCALATED.
  const escalatedPassed = failed.filter((r) => r.toState === 'ESCALATED' || r.decisiveGate === 'escalation');
  if (escalatedPassed.length >= 1) {
    proposals.push({
      key: 'escalated:owner-needed',
      impact: Math.round(weightedSum(escalatedPassed, now) * 6), // KI-E454
      title: `${escalatedPassed.length} run(s) ESCALATED — passed all gates, awaiting owner decision`,
      detail: `Items: ${[...new Set(escalatedPassed.map((r) => r.id))].join(', ')}. These are NOT failures — the agent completed the fix and all gates approved, but the adjudicator flagged an owner-decision requirement. Review reports/decisions-digest.md and the per-item last-failure.md for the specific decision needed. Do NOT re-dispatch until the owner rules.`,
    });
  }

  // 5b. Infra-failure signal — FAILED runs with no decisive gate AND no fold-time override AND not ESCALATED.
  // Genuine infra failures (agent UNAVAILABLE, not an override). KI-E393: exclude ESCALATED items.
  const trueInfra = failed.filter((r) => !r.decisiveGate && !r.overrode && r.toState !== 'ESCALATED' && r.decisiveGate !== 'escalation');
  if (trueInfra.length >= 3 && trueInfra.length / failN >= 0.25) {
    proposals.push({
      key: 'infra:no-verdict',
      impact: Math.round(weightedSum(trueInfra, now) * 4), // KI-E454 — this is the proposal that motivated the fix: historically ~20 occurrences, almost all from Oct 4–Nov 1
      title: `${trueInfra.length} run(s) failed with no gate verdict and no fold override (likely agent infra / incomplete lanes)`,
      detail: `A quarter+ of failures never reached a gate and were not fold-time overrides — investigate the dispatch/worker/lease path (orchestrate.mjs runLane, the claude-headless spawn, KI-L50 infra-retry). Persistent infra loss starves throughput.`,
    });
  }

  // 6. Cost outliers — the costliest single runs, worth an efficiency look.
  const byTok = [...runs].filter((r) => r.tokensUsed > 0).sort((a, b) => b.tokensUsed - a.tokensUsed).slice(0, 3);
  if (byTok.length && byTok[0].tokensUsed > 500000) {
    proposals.push({
      key: 'cost:outliers',
      impact: 5,
      title: `Costliest runs: ${byTok.map((r) => `${r.id} (${r.tokensUsed.toLocaleString('en-US')} tok)`).join(', ')}`,
      detail: `These items dominate token spend. Consider model-routing (model-routing.json) or a tighter band for their class.`,
    });
  }

  // 7. KI-E354/E366: Gate throughput bottlenecks — gates that cause SILENT re-fix rounds without
  // being the decisive (killing) gate. runs.jsonl only tracks the decisive gate; the metrics source
  // (Prometheus or telemetry events.jsonl) counts every CHANGES_REQUIRED, so the delta = extra rounds burned.
  const metricsSrc = metricsSnapshot?.source || 'Prometheus';
  if (metricsSnapshot && metricsSnapshot.gateRejections) {
    for (const [gate, n] of Object.entries(metricsSnapshot.gateRejections).sort((a, b) => b[1] - a[1])) {
      if (n < 2) continue;
      const decisiveN = gateHist[gate] || 0;
      const silentRounds = n - decisiveN;
      if (silentRounds >= 2 && !proposals.some((p) => p.key === `gate:${gate}`)) {
        proposals.push({
          key: `prom:gate:${gate}`,
          impact: silentRounds * 7,
          title: `Gate \`${gate}\` caused ${n} total rejection(s) — ${silentRounds} silent re-fix round(s) (${metricsSrc})`,
          detail: `${metricsSrc} shows ${n} CHANGES_REQUIRED for \`${gate}\`, but only ${decisiveN} were the decisive failure (visible in runs.jsonl). The remaining ${silentRounds} burned extra re-fix rounds without closing the item. Extend the fixer's pre-flight checklist so this gate's class of finding is produced in the FIRST pass. Current pre-flights: KI-E327 (developer gate), KI-E353 (architect gate) — add an equivalent for \`${gate}\`.`,
        });
      }
    }
  }

  // 8. KI-E354/E366: Stage duration anomalies — stages significantly slower than median.
  if (metricsSnapshot && metricsSnapshot.stageDurations) {
    const entries = Object.entries(metricsSnapshot.stageDurations).filter(([, v]) => v > 0);
    const sorted = [...entries].sort((a, b) => a[1] - b[1]);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)][1] : 0;
    for (const [stage, avg] of entries) {
      if (avg > Math.max(3600, median * 5)) {
        const p95 = metricsSnapshot.stageDurationsP95?.[stage];
        proposals.push({
          key: `prom:slow:${stage}`,
          impact: 3,
          title: `Stage \`${stage}\` avg ${(avg / 60).toFixed(0)} min (${(avg / Math.max(1, median)).toFixed(1)}× median — ${metricsSrc})`,
          detail: `${metricsSrc} avg for \`${stage}\` is ${(avg / 60).toFixed(0)} minutes — ${(avg / Math.max(1, median)).toFixed(1)}× the median stage duration${p95 ? `, P95: ${(p95 / 60).toFixed(0)} min` : ''}. Likely a single extreme outlier or a timeout/context-explosion in one item. Investigate events.jsonl for the distribution; if one item dominates, check its artifacts for the root cause.`,
        });
      }
    }
  }

  // 9. KI-E367: full-redo waste — detect items where consecutive re-fix runs share zero file overlap,
  // meaning the fixer threw away ALL prior work and started from scratch instead of building incrementally.
  const byItemChron = {};
  for (const r of runs) {
    if (!r.id || !Array.isArray(r.filesChangedPaths) || !r.filesChangedPaths.length) continue;
    (byItemChron[r.id] = byItemChron[r.id] || []).push(r.filesChangedPaths);
  }
  let fullRedoCount = 0;
  const fullRedoItems = [];
  for (const [id, runFiles] of Object.entries(byItemChron)) {
    if (runFiles.length < 2) continue;
    for (let i = 1; i < runFiles.length; i++) {
      const prev = new Set(runFiles[i - 1]);
      const overlap = runFiles[i].filter((f) => prev.has(f)).length;
      if (overlap === 0) { fullRedoCount++; if (!fullRedoItems.includes(id)) fullRedoItems.push(id); break; }
    }
  }
  if (fullRedoCount >= 2 && !proposals.some((p) => p.key === 'waste:full-redo')) {
    proposals.push({
      key: 'waste:full-redo',
      impact: fullRedoCount * 12,
      title: `${fullRedoCount} re-fix run(s) threw away ALL prior work (zero file overlap with previous attempt)`,
      detail: `Items: ${fullRedoItems.slice(0, 5).join(', ')}. When probe:plan-commitment-scan flags unhonored steps, the worktree already has partial work from the prior attempt — fixers should add missing steps on top, not redo everything. KI-E367 added PRIOR WORK AUDIT instruction to fixer.md and planner.md. This metric measures how often that rule is violated (zero-overlap re-runs). Each full redo burns ~2× the tokens a targeted additive fix would. If this keeps firing, strengthen the KI-E367 instructions or add a pre-fixer diff-read step.`,
    });
  }

  return proposals.sort((a, b) => b.impact - a.impact);
}

export function analyzeSelfImprovement(root) {
  const reportsDir = join(root, 'reports');
  const queueDir = join(root, 'queue');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(queueDir, { recursive: true });

  const runs = readRuns(join(reportsDir, 'runs.jsonl'));
  let ledger = { items: {}, cycle: '?' };
  try { ledger = JSON.parse(readFileSync(join(root, 'state', 'ledger.json'), 'utf8')); } catch { /* none yet */ }

  // KI-E354: fetch Prometheus metrics; KI-E366: fall back to local telemetry when Prometheus is unavailable.
  const metricsSnapshot = fetchPrometheusSnapshot(process.env.PROMETHEUS_URL || null)
    || readTelemetrySnapshot(root);

  const proposals = computeProposals(runs, ledger, metricsSnapshot);

  // Dedup against already-queued proposal keys.
  const statePath = join(root, 'state', 'self-improve.json');
  let seen = {};
  try { if (existsSync(statePath)) seen = JSON.parse(readFileSync(statePath, 'utf8')).queued || {}; } catch { /* fresh */ }
  const fresh = proposals.filter((p) => !seen[p.key]).slice(0, 3);

  // Always rewrite the ranked backlog report.
  const R = ['# Factory Self-Improvement Backlog', '', `_Generated ${new Date().toISOString()} · from ${runs.length} recorded run(s)_`, ''];
  if (!proposals.length) {
    R.push('_No systemic weakness detected yet (need more recorded runs, or the factory is healthy)._');
  } else {
    R.push('Ranked by estimated impact. The autonomous consumer (KI-E310) files the top NEW ones as gated work items; the rest are here for review.', '');
    for (const p of proposals) {
      R.push(`### ${p.title}`, '', `- **Impact score:** ${p.impact}${seen[p.key] ? ' · _(already queued)_' : ''}`, `- ${p.detail}`, '');
    }
  }
  writeFileSync(join(reportsDir, 'SELF-IMPROVEMENT.md'), R.join('\n') + '\n');

  // Queue the fresh top proposals (the consumer picks these up).
  if (fresh.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const qPath = join(queueDir, `factory-improvement-${stamp}.md`);
    const Q = ['---', 'kind: factory-improvement', `generated: ${new Date().toISOString()}`, 'source: self-improve.mjs (KI-E309)', '---', '',
      '# Auto-generated factory-improvement proposals', '',
      'Each becomes a gated work item via `driver ingest-improvements` (KI-E310). Nothing self-modifies `master` — the resulting fix goes through the full pipeline + a human-merged PR (KI-E303).', ''];
    for (const p of fresh) { Q.push(`## ${p.title}`, '', `- key: \`${p.key}\``, `- impact: ${p.impact}`, '', p.detail, ''); seen[p.key] = new Date().toISOString(); }
    writeFileSync(qPath, Q.join('\n') + '\n');
    try { mkdirSync(join(root, 'state'), { recursive: true }); writeFileSync(statePath, JSON.stringify({ queued: seen }, null, 2)); } catch { /* best-effort */ }
  }

  return { proposals, fresh: fresh.length };
}

// CLI: `node self-improve.mjs [root]`
if (import.meta.url === `file://${process.argv[1]}`) {
  // Default: FACTORY_ROOT env > argv[2] > guess from CWD.
  // If CWD itself contains 'ai-factory' at the end, it IS the root (avoids double-suffix when
  // the developer runs this directly from the factory directory, KI-E354).
  const cwd = process.cwd();
  const cwdGuess = cwd.endsWith('ai-factory') ? cwd : join(cwd, '_bmad-output', 'ai-factory');
  const root = process.argv[2] || process.env.FACTORY_ROOT || cwdGuess;
  const r = analyzeSelfImprovement(root);
  console.log(`self-improve: ${r.proposals.length} proposal(s), ${r.fresh} newly queued`);
}
