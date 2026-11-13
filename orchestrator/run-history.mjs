// KI-E307 — cumulative run-history index + rollup dashboard (the factory lacked a committed,
// queryable record ACROSS runs; per-item artifacts exist under state/items/<id>/_runs/ (KI-E300)
// and per-telemetry reports/telemetry-latest.md exists, but nothing tied runs together).
//
//   recordRuns(root, ids)       — append one compact JSON line per just-folded item to
//                                 reports/runs.jsonl (append-only, dedup by resultId). Committed.
//   renderFactoryReport(root)   — regenerate reports/FACTORY-REPORT.md: ledger state, throughput,
//                                 the gates that reject fixes most, items needing attention, and a
//                                 recent-runs table. The at-a-glance handoff for the next session.
//
// Both are invoked per-fold from orchestrate.mjs; reports/ is git-committed by every workflow, so
// the record survives runner/cache loss and is "passed further". Zero deps (Node builtins only).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '0');
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

// KI-E313: the AUTHORITATIVE outcome of an attempt is the ledger's most-recent TERMINAL transition,
// NOT result.json.toState — the fold applies deterministic overrides (e.g. an over-claimed "CLOSED"
// whose verify transcript lacks a captured baseline is overridden to FAILED) that result.json does
// not reflect. Returns CLOSED/FAILED/ESCALATED/BLOCKED (ignoring a later autoFix FAILED→READY reset,
// which is non-terminal), or null when the ledger has no terminal transition for the item.
export function ledgerOutcome(root, id) {
  try {
    const l = JSON.parse(readFileSync(join(root, 'state', 'ledger.json'), 'utf8'));
    const it = (l.items || {})[id];
    if (!it) return null;
    const TERMINAL = new Set(['CLOSED', 'FAILED', 'ESCALATED', 'BLOCKED']);
    const hist = it.history || [];
    for (let i = hist.length - 1; i >= 0; i--) { if (TERMINAL.has(hist[i].to)) return hist[i].to; }
    return TERMINAL.has(it.state) ? it.state : null;
  } catch { return null; }
}

// KI-E315: a gate verdict is "passing" UNLESS it matches a rejection pattern. Not every pass is the
// literal "APPROVED" — the reaudit gate reports e.g. "code=ok security=ok". Treating those as
// not-approved wrongly showed CLOSED items as 20/21 and contradicted "all N gates APPROVED".
export function gatePassed(verdict) {
  return !/CHANGES_REQUIRED|REJECT|\bFAIL|BLOCK|NOT[ _]?OK|DENIED|\bERROR/i.test(String(verdict || ''));
}

function readRuns(runsPath) {
  if (!existsSync(runsPath)) return [];
  const out = [];
  for (const line of readFileSync(runsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

// Append a run record for each just-folded item. Idempotent per resultId.
// Classify a fold-time override reason from last-failure.md into a stable category key.
// Categories mirror the deterministic probes and override checks in orchestrate.mjs.
function classifyOverrideReason(lastFailureText) {
  if (!lastFailureText) return 'fold-override:unknown';
  const t = lastFailureText;
  if (/phantom manifest/i.test(t)) return 'fold-override:phantom-manifest';
  if (/changed NO non-test source file/i.test(t)) return 'fold-override:no-production-code';
  if (/verify transcript.*suite failures require a captured target.*baseline/i.test(t)) return 'fold-override:verify-baseline-absent';
  if (/verify transcript.*failed tests lack complete unique identities/i.test(t)) return 'fold-override:test-identity-missing';
  if (/verify transcript.*suite completion missing or duplicated/i.test(t)) return 'fold-override:suite-completion-missing';
  if (/worktree debris/i.test(t)) return 'fold-override:worktree-debris';
  if (/worktree-isolation mismatch/i.test(t)) return 'fold-override:worktree-isolation-mismatch';
  if (/over-claim/i.test(t)) return 'fold-override:over-claim';
  return 'fold-override:other';
}

export function recordRuns(root, ids) {
  const reportsDir = join(root, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const runsPath = join(reportsDir, 'runs.jsonl');
  const seen = new Set(readRuns(runsPath).map((r) => r.resultId).filter(Boolean));
  let added = 0;
  for (const id of ids || []) {
    try {
      const r = JSON.parse(readFileSync(join(root, 'state', 'items', id, 'result.json'), 'utf8'));
      if (!r.resultId || seen.has(r.resultId)) continue;
      const gates = r.gates || {};
      const notApproved = Object.keys(gates).filter((g) => !gatePassed(gates[g])); // KI-E315
      const lo = ledgerOutcome(root, id);            // KI-E313: the fold's actual decision (authoritative)
      const toState = lo || r.toState || '?';
      const gatesTotal = Object.keys(gates).length;
      const fixSteps = r.fixSteps || 0;
      // KI-E365: self-improvement signals — derive here so research-digest.mjs checks can fire.
      const hasReflection = existsSync(join(root, 'state', 'items', id, 'reflection.json'));
      const stageCount = fixSteps + gatesTotal + 1; // +1 for the planner stage
      // Classify fold-time overrides so self-improve can propose targeted fixes for each category
      // (phantom-manifest, no-production-code, verify-baseline-absent, etc.), instead of lumping
      // them all into the misleading "no decisive gate = infra failure" bucket. Reads last-failure.md
      // only when the fold actually overrode the agent's claim (overrode=true).
      const overrode = !!(lo && r.toState && lo !== r.toState);
      let overrideReason = null;
      if (overrode) {
        try {
          const lfText = readFileSync(join(root, 'state', 'items', id, 'last-failure.md'), 'utf8');
          overrideReason = classifyOverrideReason(lfText);
        } catch { overrideReason = 'fold-override:unknown'; }
      }
      const rec = {
        ts: new Date().toISOString(),
        id, resultId: r.resultId, runId: r.runId || null,
        toState, band: r.band || null,
        claimedState: r.toState || null,              // KI-E313: the agent's pre-override claim
        overrode: overrode,
        overrideReason,                               // stable category key for fold-time override failures
        attemptsDelta: r.attemptsDelta ?? null,
        // KI-E393: ESCALATED items pass all gates (notApproved is empty) so they were recorded as
        // decisiveGate:null — misclassified by self-improve.mjs as "infra failures". Fix: when
        // ESCALATED set 'escalation'; when an override fired before any gate (notApproved also empty)
        // use the overrideReason so the histogram shows the true failure category.
        decisiveGate: toState === 'CLOSED' ? null
          : (notApproved[0]
             || (toState === 'ESCALATED' ? 'escalation' : null)
             || (overrode ? (overrideReason || 'fold-override:other') : null)),
        gatesTotal, gatesFailed: notApproved.length,
        tokensUsed: r.tokensUsed || 0, cost: r.cost || {},
        fixSteps, filesChanged: (r.filesChanged || []).length,
        codeChange: !!r.codeChange, transitions: r.transitions || [],
        // Self-improvement signals (KI-E365): these were missing, causing research checks to never fire.
        priorAttemptReuse: r.priorAttemptReuse || null, // which prior attempt artifacts the planner reused
        gateDetails: r.gateDetails || null,              // per-gate verdicts + findings for RLAIF reward mining
        hasReflection,                                   // whether a reflection.json was written this run
        stageCount,                                      // total pipeline stages (planner + fix iters + gates)
        // KI-E367: actual file paths (not just count) so self-improve can detect full-redo waste across consecutive runs.
        filesChangedPaths: r.filesChanged || [],
      };
      appendFileSync(runsPath, JSON.stringify(rec) + '\n');
      seen.add(r.resultId); added++;
    } catch { /* no result.json / unreadable — skip */ }
  }
  return added;
}

// Regenerate the cumulative dashboard from runs.jsonl + the live ledger.
export function renderFactoryReport(root) {
  const reportsDir = join(root, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const runs = readRuns(join(reportsDir, 'runs.jsonl'));
  let ledger = { items: {}, cycle: '?' };
  try { ledger = JSON.parse(readFileSync(join(root, 'state', 'ledger.json'), 'utf8')); } catch { /* none yet */ }
  const items = ledger.items || {};

  const stateCounts = {};
  for (const it of Object.values(items)) stateCounts[it.state] = (stateCounts[it.state] || 0) + 1;

  const closedRuns = runs.filter((r) => r.toState === 'CLOSED').length;
  const totalTokens = runs.reduce((s, r) => s + (r.tokensUsed || 0), 0);
  const gateHist = {};
  for (const r of runs) if (r.decisiveGate) gateHist[r.decisiveGate] = (gateHist[r.decisiveGate] || 0) + 1;
  const topGates = Object.entries(gateHist).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Per-item run tally (how many times each item ran + its states) — the retry/stuck signal.
  const perItem = {};
  for (const r of runs) {
    (perItem[r.id] = perItem[r.id] || { runs: 0, states: [], gates: [] }).runs++;
    perItem[r.id].states.push(r.toState);
    if (r.decisiveGate) perItem[r.id].gates.push(r.decisiveGate);
  }
  const stuck = Object.entries(perItem)
    .filter(([id, v]) => v.runs >= 2 && items[id] && ['FAILED', 'ESCALATED'].includes(items[id].state))
    .map(([id, v]) => ({ id, runs: v.runs, state: items[id].state, gate: v.gates[v.gates.length - 1] || '?' }))
    .sort((a, b) => b.runs - a.runs);

  const L = [];
  L.push('# Factory Report', '');
  L.push(`_Generated ${new Date().toISOString()} · ${runs.length} run(s) recorded · ledger cycle ${ledger.cycle}_`, '');

  L.push('## Ledger state', '', '| State | Count |', '|---|---|');
  for (const s of Object.keys(stateCounts).sort()) L.push(`| ${s} | ${stateCounts[s]} |`);
  L.push('');

  L.push('## Throughput', '');
  L.push(`- Runs recorded: **${num(runs.length)}** · closed in-run: **${num(closedRuns)}** (${pct(closedRuns, runs.length)})`);
  L.push(`- Items CLOSED (ledger): **${stateCounts.CLOSED || 0}** of ${Object.keys(items).length}`);
  L.push(`- Total tokens across recorded runs: **${num(totalTokens)}**` + (runs.length ? ` · avg **${num(Math.round(totalTokens / runs.length))}**/run` : ''));
  L.push('');

  if (topGates.length) {
    L.push('## Gates that reject fixes most (self-improvement signal)', '', '| Gate | rejections |', '|---|---|');
    for (const [g, n] of topGates) L.push(`| \`${g}\` | ${n} |`);
    L.push('');
  }

  L.push('## Needs attention', '');
  if (stuck.length) {
    L.push('**Stuck items (≥2 runs, still FAILED/ESCALATED):**', '', '| Item | runs | state | last gate |', '|---|---|---|---|');
    for (const s of stuck) L.push(`| ${s.id} | ${s.runs} | ${s.state} | \`${s.gate}\` |`);
  } else {
    L.push('_No stuck items (nothing with ≥2 failed runs)._');
  }
  const blocked = Object.values(items).filter((it) => it.state === 'BLOCKED').length;
  if (blocked) L.push('', `**${blocked} BLOCKED item(s)** may await an owner decision — see \`reports/decisions-digest.md\` (ranked by severity × age, with paste-ready reply format).`);
  L.push('');

  const recent = runs.slice(-20).reverse();
  if (recent.length) {
    L.push('## Recent runs', '', '| When | Item | State | Gate | Tokens |', '|---|---|---|---|---|');
    for (const r of recent) L.push(`| ${(r.ts || '').replace('T', ' ').slice(0, 16)} | ${r.id} | ${r.toState} | ${r.decisiveGate ? '`' + r.decisiveGate + '`' : '—'} | ${num(r.tokensUsed)} |`);
    L.push('');
  }

  const outPath = join(reportsDir, 'FACTORY-REPORT.md');
  writeFileSync(outPath, L.join('\n') + '\n');
  return outPath;
}

// CLI: `node run-history.mjs record <id>...` | `node run-history.mjs report [root]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = process.env.FACTORY_ROOT || join(process.cwd(), '_bmad-output', 'ai-factory');
  if (cmd === 'record') { const n = recordRuns(root, rest); console.log(`run-history: recorded ${n} run(s)`); }
  else if (cmd === 'report') { console.log(`run-history: wrote ${renderFactoryReport(rest[0] || root)}`); }
  else { console.error('usage: run-history.mjs record <id>... | report [root]'); process.exitCode = 2; }
}
