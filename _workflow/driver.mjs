#!/usr/bin/env node
// AI Implementation Factory — main-agent control-plane driver.
//
// The Workflow runtime (factory.js) cannot touch the filesystem or git; this Node CLI
// is the persistence + scheduling half that the main agent runs via Bash BETWEEN
// Workflow invocations. It owns ledger.json (single writer), selects READY items,
// emits run-args.json for the Workflow, folds the Workflow's per-item results back in,
// and regenerates PROGRESS.md / burndown.md. Everything is resumable: state lives on
// disk, so a killed run re-derives from ledger.json + worktree inspection.
//
// Usage (run from repo root):
//   node _bmad-output/ai-factory/_workflow/driver.mjs <command> [args]
// Commands:
//   init [--force]                 build/refresh ledger from findings-graph (resume-safe)
//   status                         counts by state, waiting-on-deps, escalations
//   select [--max N --target T --themes a,b --include-escalate --posture P --worktree PATH:BRANCH]
//                                  compute schedulable items -> write run-args.json
//   claim <id...>                  READY/FAILED/CONFLICT -> CLAIMED (track in-flight for resume)
//   fold <results.json>            apply Workflow per-item results to the ledger
//   resume [--reset-stale]         report in-flight items; optionally reset ACTIVE->READY
//   progress | burndown | cost     regenerate the respective report
//   escalations                    list BLOCKED/ESCALATED; sync queue/decisions.md
//   worktree-add <id> | worktree-remove <path> | worktree-list

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename, relative, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot, swapMountPrefix, toPosix, STOCK_MOUNT } from './lib/rootfind.mjs';
import {
  emptyLedger, loadLedger, syncFromGraph, transition, foldResults,
  countByState, writeJsonAtomic, readJson, unwrapResultEnvelope, ACTIVE, OFFRAMPS, FORWARD,
} from './lib/ledger.mjs';
import { loadGraph, computeReady, waitingOnDeps, byId } from './lib/graph.mjs';
import { loadRouting, resolve as routeResolve, concurrencyFor } from './lib/router.mjs';
import { addWorktree, removeWorktree, listWorktrees, changedFiles, pruneWorktrees, isFactoryWorktreePath } from './lib/worktree.mjs';
import { acquireLock, releaseLock } from './lib/lock.mjs';
import { parseVerifyRaw, verdictFromParse, debrisFiles, parseRedRaw, hasRealInfraMarker, touchedRootCause } from './lib/verify.mjs';
import { preflight, dockerAvailable } from './lib/preflight.mjs';
import { classifyFilesEntry, buildBasenameIndex, acceptanceSurfaceGaps } from './lib/graphaudit.mjs';
import { renderFeedback } from './lib/feedback.mjs';
import { dissentersFrom, roleForGateKey, recoveryFoldSkeleton, priorCycleOf } from './lib/recover.mjs'; // KI-E20 — the direct-recovery scaffold
import { applyConvergenceBonus, effectiveRetryBound } from './lib/convergence.mjs';
import { clusterBySimilarity, sharedLabel, batchPatternFor, sig as simSig, similarSigs } from './lib/similarity.mjs';
import { loadController, isStale as controllerStale, claimController, verifyController, releaseController, DEFAULT_TTL_MINUTES } from './lib/controller.mjs';
import { buildFactoryRouting } from './lib/routing-drift.mjs';
import { githubIssueToItem, markdownChecklistToItems, ingestReport } from './lib/ingest.mjs'; // KI-E27 — multi-source issue ingestion
import { snapshotMainFiles, driftAgainstSnapshot, dirtyMainPaths, filesOverlapDirty } from './lib/mainguard.mjs';
import { buildDocMap, readRoleBriefs } from './lib/promptpack.mjs';
// KI-E7 — telemetry is OBSERVATIONAL ONLY (ai-factory-observability spine AD-1..3/AD-11): emit()
// never throws, never blocks a command, and never feeds a fold verdict. FACTORY_TELEMETRY=0 disables.
import { emit as temit, deriveStageTimeline, readEvents, aggregateEvents, renderTelemetryReport, telemetryFile, GAP_FENCE_MS } from './lib/telemetry.mjs';
import { lintWorktreeDocClaims } from './lib/doclint.mjs'; // F2 — phantom doc-path detection aid at fold (WARN-only)
import { findLeftovers } from './lib/leftover-scan.mjs'; // KI-D12 — deferral/tech-debt lexicon detection aid at fold (WARN-only)

// KI-B1 (closed 2026-07-12): config-authoritative routing for every emitted batch — built from
// config/model-routing.json via the SAME mapping the drift guard checks, injected into runArgs as
// `routing: {RT, FLOW_RT}`; factory.js overlays it onto its inline tables. undefined (factory falls
// back to the drift-guarded inline tables) when the config is missing/unreadable — a launch is never
// blocked on it.
function injectedRouting(cfg) {
  try { return buildFactoryRouting(loadRouting(abs(cfg.paths.modelRouting))); } catch { return undefined; }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = presolve(HERE, '..');           // the factory mount (stock: _bmad-output/ai-factory)
// KI-E17 (portable mounts, SETUP.md): the host repo root is DETECTED — walk up from the mount's
// parent to the first .git (dir or submodule gitfile), FACTORY_REPO_ROOT overrides, legacy ../..
// stays the git-less fallback. loadConfig() then rewrites the committed stock-prefixed config
// paths onto the actual mount, so ANY submodule/clone location works unchanged.
const REPO_ROOT = resolveRepoRoot(FACTORY_ROOT, process.env);
const MOUNT_REL = toPosix(relative(REPO_ROOT, FACTORY_ROOT));
const CONFIG_PATH = join(FACTORY_ROOT, 'config', 'factory.config.json');

// KI-L60 — shadow-driver guard. Every factory ITEM WORKTREE is a full checkout containing its own
// copy of this file plus stale shadow copies of state/ledger.json and config. Invoking the driver by
// relative path with CWD inside a worktree loads THAT copy — every path above then resolves into the
// worktree, and a mutating command would silently operate on (and diverge) the shadow ledger, breaking
// the single-writer invariant. Refuse loudly instead (live near-miss: a cycle-34 fold ENOENT'd on the
// doubled worktree path only because the results file happened not to exist there).
if (isFactoryWorktreePath(HERE)) {
  console.error('driver: REFUSING to run — this driver was loaded from a factory ITEM WORKTREE shadow copy:\n  ' + HERE
    + '\nIts ledger/config paths resolve inside the worktree (stale shadow state, single-writer violation).'
    + '\nRun the PRIMARY copy from the repo root: node _bmad-output/ai-factory/_workflow/driver.mjs <cmd>');
  process.exit(1);
}

function loadConfig() {
  const cfg = readJson(CONFIG_PATH);
  // KI-E17: optional gitignored host overlay (shallow top-level merge + per-key paths merge) —
  // the committed config stays pristine in every host; an unreadable overlay never blocks.
  const localPath = join(FACTORY_ROOT, 'config', 'factory.config.local.json');
  if (existsSync(localPath)) {
    try {
      const local = readJson(localPath);
      const paths = { ...(cfg.paths || {}), ...(local.paths || {}) };
      Object.assign(cfg, local);
      cfg.paths = paths;
    } catch { /* best-effort overlay */ }
  }
  return swapMountPrefix(cfg, STOCK_MOUNT, MOUNT_REL);
}
function abs(p) { return presolve(REPO_ROOT, p); }
function now() { return new Date().toISOString(); }
function parseFlags(argv) {
  const f = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { f[k] = argv[++i]; } else { f[k] = true; }
    } else rest.push(a);
  }
  return { flags: f, rest };
}

// ---- report generation --------------------------------------------------------
function progressMd(cfg, ledger, graph) {
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

function burndownMd(cfg, ledger, graph) {
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

function costSnapshot(ledger) {
  const byModel = {};
  for (const row of Object.values(ledger.items)) for (const [m, t] of Object.entries(row.cost || {})) byModel[m] = (byModel[m] || 0) + t;
  const total = Object.values(byModel).reduce((a, b) => a + b, 0);
  const closed = Object.values(ledger.items).filter((r) => r.state === 'CLOSED').length;
  const opus = Object.entries(byModel).filter(([m]) => /opus/i.test(m)).reduce((a, [, t]) => a + t, 0);
  return { cycle: ledger.cycle, byModel, total, closed, callsPerClosed: closed ? Math.round(total / closed * 10) / 10 : null, opusShare: total ? Math.round(opus / total * 100) / 100 : 0 };
}

function readCostHistory(cfg) {
  const p = join(abs(cfg.paths.reports), 'cost-history.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Append a per-cycle cost snapshot (last-write-wins per cycle) — the trend source for the cost report.
// Called on cost-changing events (fold) + the explicit `cost` command. This is OBSERVABILITY only —
// there is NO budget gate / governor (owner direction 2026-06-27).
function recordCostSnapshot(cfg, ledger) {
  mkdirSync(abs(cfg.paths.reports), { recursive: true });
  const p = join(abs(cfg.paths.reports), 'cost-history.jsonl');
  const lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
  const snap = JSON.stringify({ at: now(), ...costSnapshot(ledger) });
  let prevCycle = null;
  if (lines.length) { try { prevCycle = JSON.parse(lines[lines.length - 1]).cycle; } catch { /* ignore */ } }
  if (prevCycle === ledger.cycle) lines[lines.length - 1] = snap; else lines.push(snap);
  writeFileSync(p, lines.join('\n') + '\n');
}

function costMd(ledger, history) {
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
  return [
    '# Cost report — agent calls by model (routing evidence)',
    '',
    `_Generated ${now()} · cycle ${ledger.cycle}_`,
    '',
    '_Counts are routed agent-calls per model (the faithful "who did the work" signal). Exact token totals',
    'come from each Workflow run summary (subagent_tokens), recorded per cycle in the cycle report. This',
    'report is OBSERVABILITY, not a governor — there is no budget gate (owner direction 2026-06-27)._',
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

function writeReports(cfg, ledger, graph) {
  writeFileSync(abs(cfg.paths.progress), progressMd(cfg, ledger, graph));
  mkdirSync(abs(cfg.paths.reports), { recursive: true });
  writeFileSync(abs(cfg.paths.burndown), burndownMd(cfg, ledger, graph));
  writeFileSync(join(abs(cfg.paths.reports), 'cost-latest.md'), costMd(ledger, readCostHistory(cfg)));
}

// Does a review flow apply to this item? (config reviewFlows[*].appliesWhen vs files[])
function flowApplies(appliesWhen, wi) {
  const files = wi.files || [];
  const isDoc = (f) => /\.md$/i.test(f) || /(^|\/)docs?\//i.test(f);
  const docTouching = files.some(isDoc);
  const codeTouching = files.some((f) => !isDoc(f));
  switch (appliesWhen) {
    case 'all-items': return true;
    case 'code-touching': return codeTouching;
    case 'doc-touching': return docTouching;
    case 'has-regression-test': return true; // every factory item adds a red->green test
    default: return false; // e.g. the human checkpoint (escalate|integrate-handoff) is not an automated subagent
  }
}

// The BMAD review-named flows (Band B method + Band C editorial) that apply to this item.
function applicableReviewFlows(cfg, wi) {
  const rf = cfg.reviewFlows || {};
  const out = [];
  for (const band of ['method', 'editorial']) {
    for (const f of (rf[band] || [])) {
      // Kept in AGREEMENT with factory.js flowsFor: code-review + adversarial + test-review run for
      // every item, and the edge-case hunter runs for EVERY code item too (KI-E12, owner directive
      // 2026-07-19 — it executes EARLY, pre-band, inside the factory's EdgeScan stage).
      if (flowApplies(f.appliesWhen, wi)) out.push({ skill: f.skill, routeKey: f.routeKey, band, blocking: !!f.blocking, order: f.order || 0 });
    }
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

function resolveRoutesForItem(routing, wi) {
  const crit = wi.fixType !== 'mechanical';
  const R = (k, o) => routeResolve(routing, k, o);
  return {
    planner: crit ? R('planner') : null,
    testAuthor: R(crit ? 'test_author.critical' : 'test_author.mechanical'),
    fixer: R(crit ? 'fixer.critical' : 'fixer.mechanical'),
    runner: R('runner'),
    gates: { architect: R('gate.architect'), developer: R('gate.developer'), qa: R('gate.qa'), security: R('gate.security'), po: R('gate.po') },
    refuter: R('refuter'),
    reauditor: R('reauditor'),
    integrator: R('integrator'),
  };
}

// ---- commands -----------------------------------------------------------------
function cmdInit(flags) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledgerPath = abs(cfg.paths.ledger);
  let ledger = flags.force ? null : loadLedger(ledgerPath);
  if (!ledger) ledger = emptyLedger(cfg.paths.graph);
  syncFromGraph(ledger, graph);
  writeJsonAtomic(ledgerPath, ledger);
  writeReports(cfg, ledger, graph);
  const counts = countByState(ledger);
  console.log(`init: ${Object.keys(ledger.items).length} item(s) from ${graph.items.length} graph node(s).`);
  console.log('state counts:', JSON.stringify(counts));
  console.log(`ledger:   ${cfg.paths.ledger}`);
  console.log(`progress: ${cfg.paths.progress}`);
}

function cmdStatus() {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('no ledger yet — run init'); return; }
  console.log(`cycle ${ledger.cycle} · ${Object.keys(ledger.items).length} item(s)`);
  console.log('counts:', JSON.stringify(countByState(ledger)));
  const wait = waitingOnDeps(graph, ledger);
  if (wait.length) console.log('waiting-on-deps:', wait.map((w) => `${w.id}<-${w.unmet.join('+')}`).join(', '));
  const esc = Object.values(ledger.items).filter((r) => ['ESCALATED', 'BLOCKED'].includes(r.state));
  if (esc.length) console.log('escalated/blocked:', esc.map((r) => r.id).join(', '));
  const inflight = Object.values(ledger.items).filter((r) => ACTIVE.includes(r.state));
  if (inflight.length) console.log('in-flight:', inflight.map((r) => `${r.id}:${r.state}`).join(', '));
}

function cmdSelect(flags) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('no ledger yet — run init'); return; }
  const routing = loadRouting(abs(cfg.paths.modelRouting));
  const max = flags.max ? parseInt(flags.max, 10) : 4;
  const ready = computeReady(graph, ledger, {
    maxItemRetries: cfg.maxItemRetries,
    target: flags.target || null,
    themes: flags.themes ? String(flags.themes).split(',') : null,
    includeEscalate: !!flags['include-escalate'],
  });
  let picked;
  if (flags.ids) {
    const want = String(flags.ids).split(',');
    const readyById = Object.fromEntries(ready.map((w) => [w.id, w]));
    picked = want.map((id) => readyById[id]).filter(Boolean);
    const missing = want.filter((id) => !readyById[id]);
    if (missing.length) console.log('WARN: requested ids not schedulable (not READY / blocked / escalate without --include-escalate / dep-or-lock):', missing.join(', '));
  } else {
    picked = ready.slice(0, max);
  }
  let worktree = null;
  if (flags.worktree) {
    const [path, branch] = String(flags.worktree).split(':');
    worktree = { path, branch: branch || ('factory/' + (flags.target || 'cycle')) };
  }
  const runArgs = {
    cycle: ledger.cycle + 1,
    posture: flags.posture || 'throttled',
    concurrency: concurrencyFor(routing, flags.posture || 'throttled'),
    attempts: cfg.attempts,
    repoRoot: REPO_ROOT,
    worktree,
    config: {
      gateSet: cfg.gateSet, hardGates: cfg.hardGates,
      realInfraThemes: cfg.realInfraThemes, blastRadius: cfg.blastRadius,
      auditRoot: cfg.auditRoot, solution: flags.solution || null,
    },
    templatesDir: cfg.paths.agents,
    items: picked.map((wi) => {
      const flows = applicableReviewFlows(cfg, wi);
      const routes = resolveRoutesForItem(routing, wi);
      routes.reviewFlows = Object.fromEntries(flows.map((f) => [f.routeKey, routeResolve(routing, f.routeKey, { escalate: wi.severity === 'CRITICAL' || wi.autonomyTier === 'escalate' })]));
      return {
        ...wi,
        reviewFlows: flows,
        ledger: { state: ledger.items[wi.id].state, attempts: ledger.items[wi.id].attempts, worktree: ledger.items[wi.id].worktree },
        routes,
      };
    }),
  };
  writeJsonAtomic(abs(cfg.paths.runArgs), runArgs);
  console.log(`select: ${picked.length}/${ready.length} schedulable item(s) -> ${cfg.paths.runArgs}`);
  console.log('picked:', picked.map((w) => `${w.id}(${w.severity}/${w.fixType})`).join(', ') || '(none)');
  for (const w of picked) console.log('  review-flows', w.id + ':', applicableReviewFlows(cfg, w).map((f) => f.skill.replace('bmad-', '') + (f.blocking ? '' : '~adv')).join(', ') || '(none)');
}

function cmdClaim(ids) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  let n = 0;
  for (const id of ids) { if (transition(ledger, id, 'CLAIMED', 'driver-claim')) { n++; temit({ source: 'driver', event: 'transition', item: id, cycle: ledger.cycle, outcome: 'CLAIMED' }); } } // KI-E7 finding #12: every state mutation emits, or the items gauge drifts
  writeJsonAtomic(abs(cfg.paths.ledger), ledger);
  writeReports(cfg, ledger, graph);
  console.log(`claimed ${n}/${ids.length}`);
}

function cmdReset(ids) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  let n = 0;
  for (const id of ids) { if (transition(ledger, id, 'READY', 'reset/un-claim')) { n++; temit({ source: 'driver', event: 'transition', item: id, cycle: ledger.cycle, outcome: 'READY' }); } } // KI-E7 finding #12
  writeJsonAtomic(abs(cfg.paths.ledger), ledger);
  writeReports(cfg, ledger, graph);
  console.log(`reset ${n}/${ids.length} to READY`);
}

// Forward states that imply the run claimed a passing build + green test — the ones a deterministic
// verify can contradict. A FAILED/BLOCKED/ESCALATED result has nothing to override.
const FORWARD_PASS = new Set(['GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED', 'INTEGRATED', 'CLOSED']);

// KI-D3/D1 + flow-review P1/P2/P3/P6/P9 — deterministic fold-time authority. If a forward/CLOSED result is
// contradicted by the machine evidence the doing-agents teed, REWRITE the result to FAILED in place (the
// agent's prose is overruled). Returns an override record or null. Mutates `r`.
//
// The load-bearing change (flow review, 2026-06-27): for a CODE item (`r.codeChange`) the machine evidence is
// MANDATORY, not a fallback — absence of a transcript is a FAIL, not an agent-trust pass. A DOC/CONFIG item
// (codeChange=false) keeps the owner-sanctioned no-machine-evidence fallback (it is verified by the grep/
// acceptance assertion the runner reports, and produces no dotnet transcript).
function deterministicVerifyOverride(cfg, ledger, wi, r) {
  const claims = (r.transitions || []).concat(r.toState ? [r.toState] : []);
  if (!claims.some((s) => FORWARD_PASS.has(s))) return null;
  const id = r.id;
  const readIf = (f) => { const p = abs(join(cfg.paths.items, id, f)); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
  const codeChange = !!r.codeChange;
  const baseline = (Array.isArray(r.baselineFailures) && r.baselineFailures.length) || 0;
  const fail = (reason) => {
    r.transitions = ['FAILED']; r.toState = 'FAILED';
    r.note = 'deterministic fold-time override: ' + reason + (r.note ? ' [agent claimed: ' + r.note + ']' : '');
    return { id, reason };
  };

  // --- machine build/test evidence: the verify-stage transcript AND/OR the integrate-stage transcript ---
  // Both are build-test.sh transcripts the doing-agents tee. The INTEGRATE transcript (global build + full
  // suite, which RUNS the new regression test as part of the suite) is the STRONGER green proof — so a code
  // item is evidenced if EITHER transcript carries machine markers. (Flow-review false-negative, ITEM-H9
  // 2026-06-27: the runner self-reported green but did not tee verify-raw.txt; the integrate transcript proved
  // global green — failing the item on the missing intermediate file was wrong; the red proof + integrate
  // green are conclusive.)
  const rawText = readIf('verify-raw.txt');
  const intText = readIf('integrate-raw.txt');
  const vVerdict = rawText ? verdictFromParse(parseVerifyRaw(rawText), baseline) : { pass: true, reason: 'no-machine-evidence' };
  const iVerdict = intText ? verdictFromParse(parseVerifyRaw(intText), baseline) : { pass: true, reason: 'no-machine-evidence' };
  if (!vVerdict.pass) return fail('verify transcript: ' + vVerdict.reason);
  if (!iVerdict.pass) return fail('integrate transcript: ' + iVerdict.reason);
  // P3 — a CODE item MUST carry machine green in EITHER transcript; absence in BOTH is agent-trust → FAIL.
  const hasMachineGreen = (rawText && vVerdict.reason !== 'no-machine-evidence') || (intText && iVerdict.reason !== 'no-machine-evidence');
  if (codeChange && !hasMachineGreen) {
    return fail('code item produced no machine build/test evidence (neither verify-raw.txt nor integrate-raw.txt carries FACTORY:: markers) — agent self-report cannot CLOSE a .cs change');
  }

  // KI-E19 (improvement-analysis P5) — evidence-manifest PAIR rule: a FULL-band code item must show
  // BOTH a green build marker AND a green suite signal (keyed FACTORY::SUMMARY marker or the dotnet
  // summary) in at least ONE transcript — single-marker evidence alone cannot CLOSE it. Motivating
  // near-miss: a recovery transcript where a `filter` run appended AFTER `suite` left the ambient
  // (type-agnostic) dotnet summary line describing the 1-test filter, shadowing the suite's real
  // counts under last-match parsing; the keyed markers + this pair requirement close that hole.
  // Results without r.band (pre-KI-E23 factories, hand-authored recovery folds) skip the rule —
  // backward-compatible by construction.
  if (codeChange && r.band === 'FULL') {
    const pairOk = [rawText, intText].some((t) => {
      if (!t) return false;
      const p = parseVerifyRaw(t);
      return p.build && p.build.exit === 0 && p.build.errors === 0
        && ((p.suite && (p.suite.failed - baseline) <= 0) || p.suiteExit === 0);
    });
    if (!pairOk) return fail('FULL-band code item lacks a build+suite green PAIR in any transcript (KI-E19 manifest rule) — build-only or filter-only evidence cannot CLOSE it');
  }

  // P1 — RED proof: a code item's regression test must have FAILED on old code (non-vacuous).
  // KI-L55 inversion: a verificationOnly result (stale finding / pure coverage — factory.js sets the
  // flag only when the test-author attested it AND the full gate band then approved) has the OPPOSITE
  // machine contract: the pinning/coverage tests must have RUN against the CURRENT tree and PASSED
  // (FACTORY::RED::0) — machine proof the acceptance already holds. A missing transcript still fails.
  if (codeChange) {
    const red = parseRedRaw(readIf('verify-red-raw.txt'));
    if (r.verificationOnly === true) {
      if (!red.hasData) return fail('verificationOnly item has no verify-red-raw.txt transcript (FACTORY::RED:: marker) — cannot machine-prove the acceptance already holds on the current tree');
      if (red.red) {
        // KI-L66 — the flag was an in-run MISCLASSIFICATION, but the transcript satisfies the
        // STRONGER normal red-green contract: a GENUINE discriminating red (exit!=0) plus the
        // machine green already required above. Auto-correct instead of failing — the evidence
        // outranks the classification in BOTH directions (cycle 35: ITEM-TD-13 lacked the
        // flag its evidence needed; cycle 36: ITEM-H5 carried the flag its evidence didn't —
        // the KI-L37 reFix heuristic stamps verificationOnly even when the test-author went on
        // to produce a real red). Clearing the flag also re-arms the P9 root-cause check below.
        console.log(`  KI-L66 ${r.id}: verificationOnly flag contradicted by a GENUINE red (exit=${red.exit}) + machine green — auto-corrected to the normal red-green contract (result closes on the STRONGER evidence)`);
        r.verificationOnly = false;
      }
    } else {
      if (!red.hasData) return fail('no RED proof (verify-red-raw.txt absent / no FACTORY::RED:: marker) — cannot prove the regression test fails on old code (vacuous-test risk)');
      if (!red.red) return fail('RED proof shows the test PASSED on old code (exit=' + red.exit + ') — vacuous test (passes on both old and new code)');
    }
  }

  // P2 — real-infra: a needsRealInfra item must carry a real container marker (not an EF in-memory green).
  // Accept the marker in EITHER transcript (the realInfra test may run in the verify OR the integrate suite).
  if (r.needsRealInfra && !hasRealInfraMarker(rawText || '') && !hasRealInfraMarker(intText || '')) {
    return fail('realInfra item has no FACTORY::REALINFRA:: container marker — a money/security/concurrency/idempotency CRITICAL/HIGH cannot CLOSE on an in-memory green');
  }

  // --- worktree diff: debris (KI-D1) + P9 root-cause touch ---
  let debris = [], changed = null;
  const wtRel = r.worktree || (ledger.items[id] && ledger.items[id].worktree);
  if (wtRel) {
    const wtAbs = presolve(REPO_ROOT, wtRel);
    if (existsSync(wtAbs)) { try { changed = changedFiles(wtAbs); debris = debrisFiles(changed, (wi && wi.files) || []); } catch { /* worktree unreadable -> skip diff checks */ } }
  }
  if (debris.length) return fail('worktree debris: ' + debris.join(', '));
  // P9 — the fix must change real (non-test) code; a diff that touched ONLY tests greened the test, not the bug.
  // KI-L55: skipped for verificationOnly — NO fixer ran by design (stale finding / pure coverage), so a
  // tests-only diff is the CORRECT shape there, not a greened-test-unfixed-bug signal.
  if (codeChange && r.verificationOnly !== true && changed && Array.isArray(r.rootCauseFiles) && r.rootCauseFiles.length && !touchedRootCause(changed, r.rootCauseFiles)) {
    return fail('fix changed NO non-test source file (diff touched only tests) — the test was greened but the root cause was not fixed');
  }

  // P6 — integrate transcript existence: a code item that reached INTEGRATED/CLOSED must have teed it (the
  // green + contradiction checks already ran above via iVerdict; this asserts the transcript is actually there).
  if (codeChange && r.integrateRaw && (r.toState === 'INTEGRATED' || r.toState === 'CLOSED' || claims.includes('INTEGRATED'))) {
    if (!intText) return fail('code item reached INTEGRATED with no integrate-raw.txt — global green unverified');
    if (iVerdict.reason === 'no-machine-evidence') return fail('integrate-raw.txt has no FACTORY:: build/suite markers — global green unverified');
  }
  return null;
}

// KI-C6 — an item that has exhausted its retry budget (attempts > maxItemRetries) is excluded from
// computeReady and would sit FAILED unseen. Escalate it to the human queue so it surfaces, not vanishes.
// KI-L41 — the bound is per-row EFFECTIVE (maxItemRetries + any convergence bonus the row earned),
// via the same effectiveRetryBound() computeReady uses, so parking and scheduling can never disagree.
function escalateExhausted(ledger, cfg) {
  if (typeof cfg.maxItemRetries !== 'number') return [];
  const out = [];
  for (const [id, row] of Object.entries(ledger.items)) {
    const bound = effectiveRetryBound(cfg.maxItemRetries, row);
    if (row.state === 'FAILED' && row.attempts > bound &&
        transition(ledger, id, 'ESCALATED', `auto-escalated: exhausted ${row.attempts} fix attempt(s) (bound ${bound}${row.retryBonus ? ` incl. +${row.retryBonus} convergence bonus` : ''}); needs a human`)) {
      out.push(id);
      temit({ source: 'driver', event: 'transition', item: id, cycle: ledger.cycle, outcome: 'ESCALATED' }); // KI-E7 finding #12
    }
  }
  return out;
}

function cmdFold(file, flags) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  const items = byId(graph);
  // KI-L61: accept the results path repo-root-relative (canonical) OR factory-root-relative (the
  // the run protocol §3 example form `fold state/results-cycle-<N>.json`); absolute passes through the
  // first candidate unchanged. On a miss, name every path tried instead of a bare ENOENT throw.
  const foldCandidates = [presolve(REPO_ROOT, file), presolve(FACTORY_ROOT, file)];
  const foldPath = foldCandidates.find((p) => existsSync(p));
  if (!foldPath) {
    console.error('fold: results file not found. Tried:\n  ' + foldCandidates.join('\n  '));
    process.exitCode = 1;
    return;
  }
  // KI-E31: accept the Workflow harness envelope directly (unwrap {…,result:{…}} → the fold payload), so
  // `fold <task-output>` no longer needs hand-extraction. A direct results file passes through unchanged.
  const results = unwrapResultEnvelope(readJson(foldPath));
  const arr = Array.isArray(results) ? results : results.results || [];
  if (results.cycle) ledger.cycle = Math.max(ledger.cycle, results.cycle);
  // KI-L50 — infra-failure recovery. An agent that returns null after exhausting retries on a TERMINAL
  // infra error (out-of-credits, connection-closed, overloaded, rate-limit) makes the item finish
  // FAILED, which burns an attempt and can push a GOOD item to the human queue (KI-C6) for something
  // that is not its fault (ITEM-C3 cycle 31: re-auditor died on Fable-5 credit-exhaustion). The
  // runtime hides the error string from the script (agent() just returns null), but names the failing
  // agent in the Workflow's <failures> summary the ORCHESTRATOR sees. Pass the affected item id(s) via
  // --infra-retry: the FAILED is still recorded (state stays FAILED so the reFix/verificationOnly path
  // re-runs the already-applied fix next round) but the attempt is NOT counted — a credit outage can
  // never exhaust the retry budget. Deterministic: the operator supplies exactly the ids the runtime
  // flagged as infra-failed, never a heuristic.
  const infraRetry = new Set(flags && flags['infra-retry'] ? String(flags['infra-retry']).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : []);
  const infraApplied = [];
  // KI-L53 — AUTO-detected infra failures: factory.js marks a result infraSuspect=true (and writes the
  // "<stage> agent UNAVAILABLE (null after retries" note) when a stage agent returned null after its
  // retry budget — an infra/credit/skip failure, never a quality verdict. Auto-apply the KI-L50
  // treatment so the operator no longer has to remember --infra-retry for the in-artifact-visible
  // class. Capped per item (cfg.maxInfraRetries, default 3, tracked as row.infraRetries) so a
  // persistently-unavailable stage cannot re-run an item forever — past the cap the attempt counts
  // and the message says how to override. Manual --infra-retry (operator judgment) is never capped.
  const AUTO_INFRA_RE = /UNAVAILABLE \(null after retries|StructuredOutput retry cap \(\d+\) exceeded/; // KI-L68: harness-throw flavour of the KI-L50 infra class
  const infraCap = typeof cfg.maxInfraRetries === 'number' ? cfg.maxInfraRetries : 3;
  for (const r of arr) {
    if (r.toState !== 'FAILED') continue;
    const manual = infraRetry.has(r.id);
    const auto = !manual && (r.infraSuspect === true || AUTO_INFRA_RE.test(String(r.note || '')));
    if (!manual && !auto) continue;
    const row = ledger.items[r.id];
    const used = (row && row.infraRetries) || 0;
    if (auto && used >= infraCap) { console.log(`  infra-suspect ${r.id}: auto-retry cap reached (${used}/${infraCap}) — attempt WILL count; pass --infra-retry ${r.id} to override`); continue; }
    r.attemptsDelta = 0;
    r.note = 'INFRA-FAILURE ' + (auto ? 'auto-detected (KI-L53' : '(KI-L50') + ' — attempt NOT counted; re-run on the reFix path): ' + (r.note || '');
    if (row) row.infraRetries = used + 1;
    infraApplied.push(r.id + (auto ? ' (auto)' : ''));
  }
  // KI-B4 hardening (2026-07-12): every factory-produced result carries a resultId (the idempotency
  // journal); a hand-crafted result WITHOUT one has NO double-fold protection — re-folding its file
  // would double-count cost AND attemptsDelta. Warn loudly instead of silently accepting. (A
  // budget-stopped no-op result is exempt — it is intentionally id-less so `reconstruct` ignores it.)
  for (const r of arr) if (!r.resultId && !r.budgetStopped) console.log(`  WARN: result ${r.id} has NO resultId — no fold-idempotency; a re-fold of this file WILL double-count (give it "<id>#<cycle>[-suffix]")`);
  // Deterministic verify BEFORE the fold so a false-pass is rewritten to FAILED before it is recorded.
  const overrides = [];
  for (const r of arr) { const ov = deterministicVerifyOverride(cfg, ledger, items[r.id], r); if (ov) overrides.push(ov); }
  // KI-L31 — feedback.md: the AUTHORITATIVE reFix feedback, projected deterministically from the
  // structured verdicts each result RETURNED (gateDetails). One writer (this fold), regenerated per
  // attempt — the reFix loop no longer depends on N reviewer agents remembering to write their
  // artifact files (a returned-but-unwritten review otherwise leaves the PRIOR attempt's file as
  // poisoned feedback; see the cycle-20 adversarial case). Results without gateDetails (older
  // factory copies, pre-gate failures) simply skip this — last-failure.md still covers them.
  for (const r of arr) {
    try {
      const fb = renderFeedback(r);
      if (!fb) continue;
      const dir = abs(join(cfg.paths.items, r.id));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'feedback.md'), fb);
    } catch { /* best-effort feedback artifact — never block the fold on it */ }
  }
  // P11 — persist every FAILED reason so a re-fix is not blind. A verify/fold-stage FAIL runs NO gates, so
  // there is no gate-*.md for the re-fix to read; without this the re-attempt repeats the same omission and
  // burns the retry budget (Phase-6 lesson). The re-fix prompt points the test-author + fixer here.
  for (const r of arr) {
    if (r.toState !== 'FAILED') continue;
    try {
      const dir = abs(join(cfg.paths.items, r.id));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const reachedGate = (r.transitions || []).includes('GATED') || Object.keys(r.gates || {}).length > 0;
      const cyc = String(r.resultId || '').split('#')[1] || ledger.cycle || 0;
      // KI-L29 — STALE-ARTIFACT detection. A reviewer can return its verdict via the structured
      // schema yet fail to (re)write its state/items/<id>/<role>.md file; the leftover file is the
      // PRIOR attempt's review, and the next reFix (whose brief says "read gate-*.md/review-*.md")
      // would ingest stale, already-addressed findings while MISSING the fresh ones (cycle-20
      // ITEM-C-DEPLOY: the fresh adversarial NetworkPolicy CRITICAL lived only in the run's
      // journal). Detect: an artifact recorded on THIS result whose file predates the run-script
      // emit (= run start lower bound) was NOT written this attempt — call it out loudly.
      let staleNote = '';
      try {
        const runScriptMtime = existsSync(abs(cfg.paths.runScript)) ? statSync(abs(cfg.paths.runScript)).mtimeMs : 0;
        const stale = [];
        for (const [k, rel] of Object.entries(r.artifacts || {})) {
          const ap = abs(rel);
          if (!existsSync(ap)) { stale.push(`${k} (${rel}) — MISSING`); continue; }
          if (runScriptMtime && statSync(ap).mtimeMs < runScriptMtime) stale.push(`${k} (${rel}) — NOT rewritten this attempt (mtime predates the run)`);
        }
        if (stale.length) staleNote = `\n**⚠ STALE/UNWRITTEN artifacts from this attempt — their on-disk content is the PRIOR attempt's, do NOT trust it as this attempt's feedback; the verdict map below is authoritative:**\n${stale.map((s) => `- ${s}`).join('\n')}\n`;
      } catch { /* best-effort */ }
      writeFileSync(join(dir, 'last-failure.md'),
        `# Last FAILED attempt — ${r.id} (cycle ${cyc})\n\n`
        + `**Stage reached:** ${(r.transitions || []).join(' → ') || '(none)'}\n`
        + `**Reason:** ${r.note || '(no note)'}\n`
        + (reachedGate ? '' : '\n> This attempt FAILED at the test/verify/fold stage — NO review gates ran, so there is no gate-*.md. Read THIS file for what to fix.\n')
        + staleNote
        + `\n**Gate verdicts (if any):** ${JSON.stringify(r.gates || {})}\n`);
    } catch { /* best-effort feedback artifact — never block the fold on it */ }
  }
  // F2 (analysis 2026-07-17) — phantom doc-path detection: lint ADDED doc-diff lines in each
  // not-yet-folded result's worktree for path-like claims that resolve NOWHERE in the tree
  // (cycle-39 ITEM-HI-11: a fabricated `Api/Controllers/Support/` cost a full review round).
  // WARN-only detection aid, same posture as KI-L65 — reviewers/gates stay the verdict.
  for (const r of arr) {
    try {
      if (r.resultId && ledger.folded && ledger.folded[r.resultId]) continue;
      if (!r.worktree || !existsSync(r.worktree)) continue;
      const missing = lintWorktreeDocClaims(r.worktree);
      if (missing.length) console.log(`  ⚠ DOC-PATH-CLAIM ${r.id} (F2): added doc lines assert path(s) that resolve NOWHERE in the tree — likely fabricated; verify before trusting the prose:\n` + missing.map((c) => `      ${c}`).join('\n'));
    } catch { /* detection aid only */ }
  }
  // KI-D12 — LeftoverScan fold backstop: re-run the deterministic linter on each not-yet-folded result's
  // worktree. The pre-band haiku probe is the enforcement (a genuine punt already FAILED the item); this
  // WARN surfaces candidates the probe CLEARED on an item folding to a PASSING state, so a haiku
  // false-negative (a real deferral mis-classified legit) stays human-visible. WARN-only, same posture as F2.
  for (const r of arr) {
    try {
      if (r.resultId && ledger.folded && ledger.folded[r.resultId]) continue;
      if (r.toState !== 'CLOSED' && r.toState !== 'INTEGRATED') continue;
      if (!r.worktree || !existsSync(r.worktree)) continue;
      const hits = findLeftovers(r.worktree, 25);
      if (hits.length) console.log(`  ⚠ LEFTOVER ${r.id} (KI-D12): ${hits.length} deferral-lexicon line(s) in the diff on a PASSING item — the haiku probe cleared them as legit; verify none is an intentionally-created leftover:\n` + hits.map((h) => `      ${h.file} :: ${h.lexeme} :: ${h.line}`).join('\n'));
    } catch { /* detection aid only */ }
  }
  // KI-L65 — MAIN-TREE contamination check: re-hash each not-yet-folded result's files[] in the MAIN
  // tree against the group-time snapshot. Drift before the item's first fold = an agent wrote outside
  // its worktree (witnessed twice in cycle 35: the ITEM-H12 fixer and the ITEM-H5 fixer, both via
  // the absolute REPO ROOT reference path). Warn loudly; never block the fold — the verdict concerns
  // the WORKTREE, and repairing main (restore vs apply the gated copy) is operator judgment.
  // Already-folded results are excluded: the operator's own post-fold apply legitimately drifts them.
  for (const r of arr) {
    try {
      if (r.resultId && ledger.folded && ledger.folded[r.resultId]) continue;
      const snapPath = abs(join(cfg.paths.items, r.id, 'main-snapshot.json'));
      if (!existsSync(snapPath)) continue;
      const drifted = driftAgainstSnapshot(REPO_ROOT, (readJson(snapPath) || {}).files || {});
      if (drifted.length) console.log(`  ⚠ MAIN-TREE CONTAMINATION ${r.id} (KI-L65): item files changed in the MAIN working tree during the run window — an agent likely wrote outside its worktree. Inspect + repair BEFORE applying:\n` + drifted.map((d) => `      ${d.file} (${d.was} -> ${d.now})`).join('\n'));
    } catch { /* detection aid only */ }
  }
  const { applied, rejected, skipped } = foldResults(ledger, arr);
  // KI-L41 — convergence bonus BEFORE the exhaustion sweep: a FAILED round whose blocking-finding
  // set is strictly narrower than the prior round's (fewer findings, max severity not worse — both
  // from the structured gateDetails, never agent self-assessment) earns ONE bonus attempt past
  // maxItemRetries instead of parking. Deterministic; bounded by maxBonusRounds.
  const bonuses = applyConvergenceBonus(ledger, cfg, arr);
  const escalated = escalateExhausted(ledger, cfg);
  writeJsonAtomic(abs(cfg.paths.ledger), ledger);
  recordCostSnapshot(cfg, ledger); // per-cycle cost snapshot for the trend (observability, not a gate)
  writeReports(cfg, ledger, graph);
  cmdEscalationsSync(cfg, ledger, true);
  // KI-E7 telemetry (spine AD-2/AD-11): the authoritative fold record + the deterministic
  // mtime-derived stage timeline per item. Emitted AFTER the ledger write so telemetry can never
  // affect the verdict; the whole block is best-effort by construction (emit never throws).
  try {
    const cyc = results.cycle || ledger.cycle;
    for (const t of applied) temit({ source: 'driver', event: 'transition', item: t.id, cycle: cyc, outcome: t.to });
    // Review finding #1: emit item_folded + timelines ONLY for results the fold actually applied —
    // an idempotent re-fold (skipped) or an entry-hop-rejected result changed nothing, and emitting
    // it would double-count outcomes/durations/model-calls in the authoritative stream.
    const skippedIds = new Set(skipped.map((s) => s.id));
    const appliedIds = new Set(applied.map((a) => a.id));
    for (const r of arr) {
      if (skippedIds.has(r.id) || !appliedIds.has(r.id)) continue;
      const row = ledger.items[r.id] || {};
      const claimHist = (row.history || []).filter((h) => h.to === 'CLAIMED');
      const claimMs = claimHist.length ? Date.parse(claimHist[claimHist.length - 1].at) : 0;
      const tl = deriveStageTimeline(abs(join(cfg.paths.items, r.id)), { sinceMs: claimMs || undefined });
      let prevMs = claimMs || (tl.length ? tl[0].firstMs : 0);
      for (let si = 0; si < tl.length; si++) {
        const s = tl[si];
        // F3: one event per STAGE (same-stage artifacts collapsed); durMs = wall from the previous
        // stage's end; bandSpanMs = first..last artifact inside a parallel band (0 for single-file).
        const durMs = Math.max(0, Math.round(s.mtimeMs - prevMs));
        const at = { files: s.files.length, bandSpanMs: s.bandSpanMs };
        // KI-E13 gap-fence: a duration over GAP_FENCE_MS spans a dead gap between runs (cross-session
        // relaunch, overnight idle — the KI-E9 16.5h `plan` row), not real stage work. Stamp it so the
        // report excludes it from percentiles; the event itself stays (honest wall-clock).
        if (durMs > GAP_FENCE_MS) at.gapSuspect = true;
        // KI-E13: stamp the item's fold outcome on the LAST stage so per-stage failure concentration
        // is derivable from the stream (which stage the item died in).
        if (si === tl.length - 1) at.final = r.toState;
        temit({ source: 'derived', event: 'stage_end', item: r.id, cycle: cyc, lane: row.runLabel || undefined, stage: s.stage, ts: s.ts, durMs, attrs: at });
        prevMs = s.mtimeMs;
      }
      temit({ source: 'driver', event: 'item_folded', item: r.id, cycle: cyc, lane: row.runLabel || undefined, outcome: row.state || r.toState, attempts: row.attempts, attrs: { toState: r.toState, band: r.band || undefined, transitions: (r.transitions || []).slice(0, 12), gates: r.gates || {}, cost: r.cost || {}, infraSuspect: !!r.infraSuspect, verificationOnly: !!r.verificationOnly, note: String(r.note || '').slice(0, 240) } }); // KI-E23: band stamped so gate-value/cost split LIGHT vs FULL
    }
    temit({ source: 'driver', event: 'fold_summary', cycle: cyc, attrs: { file: basename(foldPath), applied: applied.length, rejected: rejected.length, skipped: skipped.length, overrides: overrides.length, infraRetries: infraApplied.length, escalated: escalated.length } });
    // KI-E23 (P6c): the run's token usage, returned by factory.js from the runtime budget counter —
    // cost analyses stop extrapolating from call counts. Observational only.
    if (results && results.usage && typeof results.usage.outputTokens === 'number') temit({ source: 'driver', event: 'usage', cycle: cyc, attrs: { outputTokens: results.usage.outputTokens, file: basename(foldPath) } });
  } catch { /* observational only — a telemetry defect must never block a fold */ }
  console.log(`fold: applied ${applied.length}, rejected ${rejected.length}, skipped ${skipped.length}`
    + (overrides.length ? `, deterministic-overrides ${overrides.length}` : '')
    + (bonuses.length ? `, convergence-bonuses ${bonuses.length}` : '')
    + (infraApplied.length ? `, infra-retry (attempt not counted) ${infraApplied.length}` : '')
    + (escalated.length ? `, auto-escalated ${escalated.length}` : ''));
  if (infraApplied.length) console.log('  INFRA-RETRY (KI-L50 — FAILED recorded, attempt NOT counted):', infraApplied.join(', '));
  for (const o of overrides) console.log(`  OVERRIDE ${o.id} -> FAILED (deterministic): ${o.reason}`);
  for (const b of bonuses) console.log(`  CONVERGENCE-BONUS ${b.id}: findings ${b.from ? b.from.findings : '?'}→${b.to.findings} (maxSevRank ${b.from ? b.from.maxRank : '?'}→${b.to.maxRank}) — +1 attempt (bonus ${b.retryBonus}/${typeof cfg.maxBonusRounds === 'number' ? cfg.maxBonusRounds : 1})`);
  if (escalated.length) console.log('  auto-escalated (retry-bound exhausted -> queue):', escalated.join(', '));
  if (skipped.length) console.log('  skipped (already folded, idempotent):', skipped.map((s) => s.resultId).join(', '));
  if (rejected.length) console.log('  rejected:', JSON.stringify(rejected));
}

function cmdResume(flags) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('no ledger — nothing to resume'); return; }
  const inflight = Object.values(ledger.items).filter((r) => ACTIVE.includes(r.state));
  console.log(`resume: cycle ${ledger.cycle}, ${inflight.length} in-flight item(s)`);
  // Current-cycle checkpoint check (same rule as reconstruct): a CLAIMED item whose run died BEFORE
  // checkpointing has no state/items/<id>/result.json with resultId "<id>#<cycle+1>".
  const cyc = ledger.cycle + 1;
  const hasCheckpoint = (id) => {
    const p = abs(join(cfg.paths.items, id, 'result.json'));
    if (!existsSync(p)) return false;
    try { return readJson(p).resultId === id + '#' + cyc; } catch { return false; }
  };
  let resetN = 0;
  const relaunch = new Map(); // runScript -> [ids] — CLAIMED, no checkpoint, script still on disk
  for (const r of inflight) {
    let wtState = '';
    if (r.worktree && existsSync(presolve(REPO_ROOT, r.worktree))) {
      try { wtState = ` [${changedFiles(presolve(REPO_ROOT, r.worktree)).length} changed file(s)]`; } catch { /* ignore */ }
    }
    const ck = hasCheckpoint(r.id);
    console.log(`  ${r.id}: ${r.state}${wtState}${r.runLabel ? ` [label=${r.runLabel}]` : ''}${ck ? ' [checkpointed #' + cyc + ' — reconstruct+fold will pick it up]' : ''}`);
    if (!ck && r.runScript && existsSync(presolve(REPO_ROOT, r.runScript))) {
      const k = r.runScript; if (!relaunch.has(k)) relaunch.set(k, []); relaunch.get(k).push(r.id);
    }
    // Check the transition RESULT — never report a reset that did not happen. The old code ignored
    // the return and always printed success even when the state machine refused (it lied about ITEM-M8).
    // KI-L51: restore the PRE-CLAIM state, not unconditionally READY — resetting a FAILED-before-claim
    // item to READY erased its reFix provenance (the next group would not stamp reFix=true, so the
    // fixer never saw feedback.md). prevState is recorded at claim (group/sweep); rows claimed before
    // KI-L51 have no prevState and keep the legacy READY behavior.
    if (flags['reset-stale']) {
      const back = r.prevState === 'FAILED' ? 'FAILED' : 'READY';
      if (transition(ledger, r.id, back, 'resume-reset-stale' + (back === 'FAILED' ? ' (restored FAILED — reFix provenance kept, KI-L51)' : ''))) { resetN++; temit({ source: 'driver', event: 'transition', item: r.id, cycle: ledger.cycle, outcome: back }); } // KI-E7 finding #12
      else console.log(`    ! could NOT reset ${r.id} from ${r.state}`);
    }
  }
  // KI-L52 — dead-session recovery guidance: a batch that was grouped+launched but died before ANY
  // checkpoint is best re-launched from its still-on-disk self-contained run-script (re-grouping would
  // rebuild worktrees/claims it already has — and, pre-KI-L51, lost reFix stamps). Print the exact lines.
  if (!flags['reset-stale'] && relaunch.size) {
    console.log('  relaunch candidates (CLAIMED, no cycle-' + cyc + ' checkpoint, launcher still on disk):');
    for (const [script, ids] of relaunch) console.log(`    Workflow({ scriptPath: "${abs(script)}" })   # ${ids.join(', ')}`);
    console.log('    (relaunch preserves claims/worktrees/reFix stamps; use --reset-stale ONLY when abandoning these runs instead.)');
  }
  if (flags['reset-stale']) { writeJsonAtomic(abs(cfg.paths.ledger), ledger); writeReports(cfg, ledger, graph); console.log(`  -> reset ${resetN}/${inflight.length} stale in-flight (FAILED-provenance rows back to FAILED, rest to READY)`); }
  console.log('counts:', JSON.stringify(countByState(ledger)));
}

// KI-L40 — kill-resilience recovery: rebuild a results-cycle file from the per-item result.json
// checkpoints factory.js persists the moment each item's lifecycle resolves. Before this, a
// session-killed run lost EVERY completed item (results lived only in the Workflow's memory) and
// the whole band re-ran — cycle 25 was launched 3× (~2 dead bands, ~10M tokens) for zero folds.
// Read-only on the ledger: it writes ONLY state/results-cycle-<N>.json; the normal `fold` then
// applies it (the deterministic override re-checks all machine evidence exactly as for a live run).
// Items with no checkpoint stay CLAIMED — `resume --reset-stale` + a re-`group` re-runs just those.
function cmdReconstruct(flags) {
  const cfg = loadConfig();
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('no ledger'); return; }
  // group emits the in-flight batch with cycle = ledger.cycle + 1; fold bumps ledger.cycle — so the
  // killed (unfolded) cycle is +1 by default. --cycle N overrides for unusual recoveries.
  // KI-L63: with PARALLEL LANES, the first sibling fold bumps ledger.cycle to the lanes' shared
  // cycle N — the blind +1 then guesses N+1 and misses every remaining lane's checkpoints. Derive
  // the default from the checkpoints themselves: the highest cycle among UNFOLDED result.json files;
  // fall back to ledger.cycle + 1 only when none exist. --cycle still overrides everything.
  const itemsRoot = abs(cfg.paths.items);
  let cyc;
  if (flags.cycle) {
    cyc = parseInt(flags.cycle, 10);
  } else {
    let best = 0;
    for (const id of (existsSync(itemsRoot) ? readdirSync(itemsRoot) : [])) {
      const p0 = join(itemsRoot, id, 'result.json');
      if (!existsSync(p0)) continue;
      let r0; try { r0 = readJson(p0); } catch { continue; }
      const m = r0 && typeof r0.resultId === 'string' ? r0.resultId.match(/#(\d+)(?:r\d*)?$/) : null;
      if (!m) continue;
      if (ledger.folded && ledger.folded[r0.resultId]) continue; // already folded — inert
      best = Math.max(best, parseInt(m[1], 10));
    }
    cyc = best || ledger.cycle + 1;
  }
  const results = [], stale = [], already = [];
  for (const id of (existsSync(itemsRoot) ? readdirSync(itemsRoot) : [])) {
    const p = join(itemsRoot, id, 'result.json');
    if (!existsSync(p)) continue;
    let r; try { r = readJson(p); } catch (e) { console.log(`  WARN: ${id}/result.json unparseable (${e && e.message}) — skipped; that item must re-run`); continue; }
    if (!r || r.id !== id) { console.log(`  WARN: ${id}/result.json carries id ${r && r.id} — mismatch, skipped`); continue; }
    if (r.resultId !== id + '#' + cyc) { stale.push(`${id} (${r.resultId})`); continue; } // an older cycle's checkpoint — inert, fold idempotency would skip it anyway
    if (ledger.folded && ledger.folded[r.resultId]) { already.push(id); continue; }
    results.push(r);
  }
  const claimed = Object.values(ledger.items).filter((r) => ACTIVE.includes(r.state)).map((r) => r.id);
  const missing = claimed.filter((id) => !results.some((r) => r.id === id) && !already.includes(id));
  const out = abs(join(String(cfg.root || '_bmad-output/ai-factory'), 'state', `results-cycle-${cyc}.json`));
  if (!results.length) {
    console.log(`reconstruct: NO cycle-${cyc} checkpoints found under ${cfg.paths.items} — nothing to fold`);
    if (missing.length) console.log(`  in-flight with no checkpoint (must re-run): ${missing.join(', ')}`);
    return;
  }
  writeJsonAtomic(out, { mode: 'reconstructed', cycle: cyc, results });
  console.log(`reconstruct: ${results.length} checkpointed result(s) for cycle ${cyc} -> ${out}`);
  for (const r of results) console.log(`  ${r.id}: ${r.toState} — ${String(r.note || '').slice(0, 110)}`);
  if (already.length) console.log(`  already folded (skipped): ${already.join(', ')}`);
  if (stale.length) console.log(`  stale checkpoints from other cycles (ignored): ${stale.join(', ')}`);
  if (missing.length) console.log(`  in-flight with NO checkpoint — re-run only these after \`resume --reset-stale\`: ${missing.join(', ')}`);
  console.log(`  next: node _bmad-output/ai-factory/_workflow/driver.mjs fold ${join(String(cfg.root || '_bmad-output/ai-factory'), 'state', `results-cycle-${cyc}.json`)}`);
}

// KI-L42 — deterministic graph lint for the KI-L38 realInfra over-classification class (3 of
// cycle-24's 8 bands burned on items whose flag demanded a Testcontainers test that cannot
// meaningfully exist). Criterion (KI-L38): realInfra = "the regression TEST needs a real
// container", never "the acceptance mentions production/cluster". Suspect shape: realInfra=true
// but files[] names NO .cs source (pure config/doc/k8s surfaces have no container-testable
// dimension). Report-only — the graph is hand-editable; flags are corrected by a human (or the
// session operator) with per-item justification, exactly as KI-L38 did for the first three.
function cmdRealinfraLint() {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  const suspects = [];
  for (const wi of graph.items || []) {
    if (wi.realInfra !== true) continue;
    const row = ledger && ledger.items[wi.id];
    if (row && ['CLOSED', 'BLOCKED', 'ESCALATED'].includes(row.state)) continue;
    const files = wi.files || [];
    const hasCs = files.some((f) => /\.cs$/i.test(f));
    if (!hasCs) suspects.push({ id: wi.id, theme: wi.theme, severity: wi.severity, state: row ? row.state : '(no row)', files: files.slice(0, 6) });
  }
  const date = now().slice(0, 10);
  const rep = abs(join(String(cfg.paths.reports), `realinfra-lint-${date}.md`));
  const body = [
    `# realInfra lint — ${date}`,
    '',
    '_KI-L42: actionable items flagged `realInfra: true` whose `files[]` contain no `.cs` source — the',
    'KI-L38 over-classification shape (a config/doc/k8s surface has no container-testable dimension,',
    'so the P2 floor demands a Testcontainers test that cannot exist → a guaranteed fail-loop).',
    'Report-only: correct each flag in `state/findings-graph.json` with a per-item justification in',
    'fixHint (criterion: realInfra = "the TEST needs a real container"), or confirm it is genuinely',
    'container-shaped (consumer/ProcessedEvent/idempotency paths stay `true`)._',
    '',
    suspects.length
      ? suspects.map((s) => `- **${s.id}** (${s.severity}/${s.theme}, ${s.state}) — files: ${s.files.join(', ') || '(none)'}`).join('\n')
      : '_No suspects — every actionable realInfra=true item names at least one .cs file._',
    '',
  ].join('\n');
  mkdirSync(dirname(rep), { recursive: true });
  writeFileSync(rep, body);
  console.log(`realinfra-lint: ${suspects.length} suspect(s) -> ${rep}`);
  for (const s of suspects) console.log(`  ${s.id} (${s.severity}/${s.theme}, ${s.state})`);
}

function cmdEscalationsSync(cfg, ledger, silent) {
  const queuePath = abs(cfg.paths.queue);
  const esc = Object.entries(ledger.items).filter(([, r]) => ['ESCALATED', 'BLOCKED'].includes(r.state));
  // KI-C6 defensive net (2026-07-12): escalateExhausted() already flips bound-exhausted FAILED ->
  // ESCALATED at every fold (the KI-C6 fix), so exhausted items normally appear above as ESCALATED.
  // This section catches the rows that MISS that hook — a sweep-fold writes FAILED via its own path,
  // a standalone `driver escalations` run, or a convergence-bonus revocation — so a parked item can
  // never sit FAILED invisible to the queue no matter which writer parked it.
  const exhausted = typeof cfg.maxItemRetries === 'number'
    ? Object.entries(ledger.items).filter(([, r]) => r.state === 'FAILED' && r.attempts > effectiveRetryBound(cfg.maxItemRetries, r))
    : [];
  const lastNote = (r) => { const h = (r.history || []).filter((x) => x.note); return h.length ? h[h.length - 1].note : '(no note)'; };
  const body = [
    '# Human decision queue',
    '',
    '_Items the factory cannot close autonomously: BLOCKED (owner ruling required) or ESCALATED (auth/money/crypto/cross-service — auto-drafted, needs human sign-off before integrate)._',
    `_Generated ${now()}._`,
    '',
    esc.length ? esc.map(([id, r]) => {
      // KI-C9: embed the decision-framer's framed choice (options + consequences + recommendation) when present.
      const decPath = abs(join(cfg.paths.items, id, 'decision.md'));
      const framed = existsSync(decPath) ? ('\n\n' + readFileSync(decPath, 'utf8').trim() + '\n') : '';
      return `## ${id} — ${r.state}\n\n- ${r.note || '(no note)'}${framed}\n`;
    }).join('\n') : '_No items awaiting a human decision._',
    '',
    ...(exhausted.length ? [
      '---',
      '',
      '## Retry-exhausted FAILED not yet escalated (KI-C6 net — need human triage: direct-recover, re-scope, or drop)',
      '',
      '_These items burned their full retry budget (attempts > maxItemRetries + convergence bonus) and are no longer scheduled, and the fold-time auto-escalation has not caught them yet. Read `state/items/<id>/feedback.md` + `last-failure.md` for the final round\'s findings._',
      '',
      ...exhausted.map(([id, r]) => `- **${id}** — attempts ${r.attempts} (bound ${effectiveRetryBound(cfg.maxItemRetries, r)}) — ${String(lastNote(r)).slice(0, 240)}`),
      '',
    ] : []),
  ].join('\n');
  mkdirSync(dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, body);
  if (!silent) console.log(`escalations: ${esc.length} item(s)${exhausted.length ? ` + ${exhausted.length} retry-exhausted FAILED (KI-C6)` : ''} -> ${cfg.paths.queue}`);
}

function cmdReport(which) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (which === 'progress') { writeFileSync(abs(cfg.paths.progress), progressMd(cfg, ledger, graph)); console.log('wrote', cfg.paths.progress); }
  else if (which === 'burndown') { writeFileSync(abs(cfg.paths.burndown), burndownMd(cfg, ledger, graph)); console.log('wrote', cfg.paths.burndown); }
  else if (which === 'cost') { recordCostSnapshot(cfg, ledger); const md = costMd(ledger, readCostHistory(cfg)); writeFileSync(join(abs(cfg.paths.reports), 'cost-latest.md'), md); console.log(md); }
}

// Per-cycle report (reports/cycle-NN.md) from the ledger + item artifacts.
function cycleMd(cfg, ledger, graph) {
  const items = byId(graph);
  const touched = Object.values(ledger.items).filter((r) => r.history.length > 1 || r.worktree || Object.keys(r.gates || {}).length);
  touched.sort((a, b) => (a.id).localeCompare(b.id));
  const lines = ['# Cycle ' + String(ledger.cycle).padStart(2, '0') + ' report', '', `_Generated ${now()} · ${touched.length} item(s) touched_`, ''];
  for (const r of touched) {
    const wi = items[r.id] || {};
    lines.push(`## ${r.id} — **${r.state}**  (${wi.severity || '?'} / ${wi.fixType || '?'} / ${wi.autonomyTier || '?'})`);
    lines.push('');
    if (wi.title) lines.push(`- ${wi.title}`);
    if (Object.keys(r.gates || {}).length) lines.push('- reviews: ' + Object.entries(r.gates).map(([k, v]) => `${k}=${v}`).join(', '));
    if (r.note) lines.push('- note: ' + r.note);
    if (r.worktree) lines.push('- handoff: `' + (r.branch || '') + '` @ ' + r.worktree);
    if (Object.keys(r.cost || {}).length) lines.push('- agent-calls by model: ' + Object.entries(r.cost).map(([m, c]) => `${m.replace('claude-', '')}×${c}`).join(', '));
    const arts = Object.values(r.artifacts || {}).filter(Boolean);
    if (arts.length) lines.push('- artifacts: ' + arts.join(', '));
    lines.push('');
  }
  if (!touched.length) lines.push('_no items touched this cycle_');
  return lines.join('\n');
}
function cmdReportCycle() {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  mkdirSync(abs(cfg.paths.reports), { recursive: true });
  const out = join(abs(cfg.paths.reports), 'cycle-' + String(ledger.cycle).padStart(2, '0') + '.md');
  writeFileSync(out, cycleMd(cfg, ledger, graph));
  console.log('wrote', out);
}

// Resolve a target's build solution (for multi-target groups). Reads scripts/services.json (dir->solution),
// falls back to the <Target>/<Target>.sln convention. Cached.
let _svcMap = null;
function solutionFor(target) {
  if (_svcMap === null) {
    _svcMap = {};
    try {
      const svcs = readJson(presolve(REPO_ROOT, 'scripts/services.json'));
      const arr = Array.isArray(svcs) ? svcs : (svcs.services || []);
      for (const s of arr) if (s && s.solution) _svcMap[String(s.solution).split('/')[0]] = s.solution;
    } catch { /* services.json optional */ }
  }
  return _svcMap[target] || (target + '/' + target + '.sln');
}

// Phase-4 scale-out scheduler: pick a batch of READY items (deps + locks + layer order), create a
// per-item worktree for each, claim them, and emit COMPACT run-args (no verbose per-stage routes —
// factory.js derives them; trimmed strings — agents read `source` for detail) so the batch fits the
// session Workflow arg-size limit. Run the factory Workflow on the result; items execute in PARALLEL,
// each isolated in its own worktree.
// `suggest` — similar-batch planning (owner directive 2026-07-04: "plan similar work in one batch
// so that the changes are identical / similar"). Joins the cluster.mjs similarity rule with the LIVE
// ledger: clusters the currently-schedulable items, drops within-cluster file collisions (same rule
// as group's within-batch lock — the collided ids stay READY for the NEXT wave of the same pattern),
// and prints a ready-made `group --ids` line per cluster. Read-only — claims nothing.
function cmdSuggest(flags) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('no ledger — run init'); return; }
  const max = flags.max ? parseInt(flags.max, 10) : 6;   // batch-size cap per suggestion
  const min = flags.min ? parseInt(flags.min, 10) : 2;   // smallest cluster worth batching
  let ready = computeReady(graph, ledger, {
    maxItemRetries: cfg.maxItemRetries, target: flags.target || null,
    themes: flags.themes ? String(flags.themes).split(',') : null, includeEscalate: !!flags['include-escalate'],
  });
  if (!flags['include-realinfra']) ready = ready.filter((w) => !w.realInfra);
  const sevRank = { CRITICAL: 3, HIGH: 2, MEDIUM: 1 };
  const clusters = clusterBySimilarity(ready)
    .filter((c) => c.length >= min)
    .sort((a, b) => b.length - a.length
      || b.filter((w) => w.severity === 'CRITICAL').length - a.filter((w) => w.severity === 'CRITICAL').length);
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };
  say(`suggest: ${ready.length} schedulable item(s) -> ${clusters.length} similarity cluster(s) of size >= ${min}`);
  let n = 0;
  for (const c of clusters) {
    n++;
    // severity-first order, then id, so the pick prefers the highest-value members
    const ordered = [...c].sort((a, b) => (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0) || String(a.id).localeCompare(String(b.id)));
    // Two-pass pick: PREFER an all-pairs-similar subset (a clique — the batch then earns the group
    // batch-pattern stamp, the whole point of similar batching); when a chained cluster (A~B~C but
    // A!~C) leaves fewer than `min` clique members, fall back to plain file-disjoint co-batching.
    const pick = (requireClique) => {
      const seen = new Set(); const batch = []; const batchSigs = []; const rest = [];
      for (const wi of ordered) {
        const fs = wi.files || []; const s = simSig(wi);
        if (batch.length >= max
          || fs.some((f) => seen.has(f))
          || (requireClique && !batchSigs.every((bs) => similarSigs(bs, s)))) { rest.push(wi.id); continue; }
        for (const f of fs) seen.add(f);
        batchSigs.push(s); batch.push(wi);
      }
      return { batch, rest };
    };
    let { batch, rest: collided } = pick(true);
    if (batch.length < min) ({ batch, rest: collided } = pick(false));
    say(`\n#${n} [${c[0].theme || '?'}] ${sharedLabel(c)} — ${c.length} item(s) across ${[...new Set(c.map((w) => w.target))].length} target(s)`);
    for (const wi of batch) say(`  ${wi.id} (${wi.severity}/${wi.fixType}) @ ${wi.target}`);
    if (collided.length) say(`  next-wave (file-collision, >max, or outside the clique — stay READY): ${collided.join(', ')}`);
    // KI-E21 (improvement-analysis P3): a LARGE homogeneous cluster is a SWEEP, not pair lanes —
    // the sweep band (design once + cheap applies + one pattern gate) closes measured ~4-10x
    // cheaper per finding than pair-lane actuals. Union-find clusters are CHAINED (A~B~C with
    // A!~C), so strict all-pairs cliqueness would never fire on the big clusters this lever
    // exists for; the proven sweep flow selects by DOMINANT KEYWORD instead (`cluster.mjs
    // --emit-pattern <kw>` — the homogeneous-family channel that ran the live doc sweep).
    // Recommend it when one signature keyword spans >= sweepMin members (default 6; --sweep-min
    // overrides) — emit-pattern then picks exactly that homogeneous family repo-wide.
    const sweepMin = flags['sweep-min'] ? parseInt(flags['sweep-min'], 10) : 6;
    let sweepKw = null, sweepKwN = 0;
    if (c.length >= sweepMin) {
      const kwCount = {};
      for (const it of c) for (const w of simSig(it)) kwCount[w] = (kwCount[w] || 0) + 1;
      const top = Object.entries(kwCount).filter(([, cnt]) => cnt >= sweepMin).sort((a, b) => b[1] - a[1])[0];
      if (top) { sweepKw = top[0]; sweepKwN = top[1]; }
    }
    if (sweepKw) {
      const slug = sweepKw.replace(/[^A-Za-z0-9-]/g, '').toLowerCase().slice(0, 24) || 'sweep';
      say(`  ** SWEEP CANDIDATE (KI-E21): keyword "${sweepKw}" spans ${sweepKwN}/${c.length} member(s) — route through the sweep band (~4-10x cheaper than pair lanes):`);
      say(`  -> node ${MOUNT_REL}/_workflow/cluster.mjs --emit-pattern "${sweepKw}" --slug ${slug}`);
      say(`  -> node ${MOUNT_REL}/_workflow/driver.mjs sweep ${slug} --max-sites 10   (then Workflow the emitted launcher; then: driver sweep-fold <results.json>)`);
    } else {
      const pattern = batchPatternFor(batch);
      say(`  batch-pattern: ${pattern ? 'AUTO (stamped by group)' : 'none (mixed shapes — group will not stamp)'}`);
      say(`  -> node ${MOUNT_REL}/_workflow/driver.mjs group --ids ${batch.map((w) => w.id).join(',')} --conc 3`);
    }
  }
  try {
    const rp = abs(join(dirname(cfg.paths.ledger), '..', 'reports', 'similar-batches.md'));
    mkdirSync(dirname(rp), { recursive: true });
    writeFileSync(rp, `# Similar-batch suggestions\n\n_Generated ${now()} · cycle ${ledger.cycle} · read-only (nothing claimed)_\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
    console.log(`\nreport -> ${rp}`);
  } catch { /* report is best-effort; stdout already has the plan */ }
}

// KI-C1 launcher emit, shared by group + sweep (KI-L52 — sweeps previously had NO script channel, so a
// sweep batch was capped by the ~2KB args transport at --max-sites 6 with 70-char titles): inline the
// batch into a self-contained run-script so any batch size launches via Workflow({scriptPath}) with NO
// args (512KB script cap). Returns the ABSOLUTE script path, or null when the emit failed (the args
// path stays valid as fallback).
function emitLauncherScript(cfg, runArgs, labelSlug) {
  try {
    const MARKER = '/*__FACTORY_BATCH_INJECT__*/';
    const factorySrc = readFileSync(join(HERE, 'factory.js'), 'utf8');
    if (!factorySrc.includes(MARKER)) throw new Error('factory.js missing ' + MARKER + ' marker');
    // Replace the post-meta marker (NOT prepend — `export const meta` must stay the first statement).
    // Function replacement so a `$` in the batch JSON is not interpreted as a String.replace pattern.
    const launcher = factorySrc.replace(MARKER, () => 'const __FACTORY_BATCH__ = ' + JSON.stringify(runArgs) + ';');
    const base = cfg.paths.runScript || '_bmad-output/ai-factory/state/run-script.js';
    const p = abs(labelSlug ? base.replace(/(\.[^.\/]+)$/, '-' + labelSlug + '$1') : base);
    writeFileSync(p, launcher);
    return p;
  } catch (e) { console.log('  WARN: launcher-script emit failed (' + (e && e.message) + ') — use the args path instead'); return null; }
}

function cmdGroup(flags) {
  const cfg = loadConfig();
  // Graceful-stop drain guard (session 17, 2026-07-16): while state/STOP_REQUESTED.md exists the
  // factory is draining its in-flight lanes and MUST NOT start new ones (deterministic "prevent new"
  // that survives a context summarization — not just operator discipline). `fold`/`reconstruct`/
  // `escalations` are unaffected: they COMPLETE already-running work, they do not launch it. Resuming
  // is a deliberate act — delete the marker, or pass --stop-override for a single bypass.
  const stopMarker = abs(join(dirname(cfg.paths.ledger), 'STOP_REQUESTED.md'));
  if (existsSync(stopMarker) && !flags['stop-override']) {
    console.log("refusing 'group': graceful-stop drain in effect — " + stopMarker + ' exists.');
    console.log('  In-flight lanes drain to completion; NO new lane may be launched. That file lists the deferred queue.');
    console.log('  To resume launching (deliberate): delete the marker, or pass --stop-override for a one-off bypass.');
    return;
  }
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('no ledger — run init'); return; }
  // KI-L26: the GRAPH is hand-editable (the ledger is not) — a hand-added graph item previously
  // needed a separate `driver init` before group could see it (it was silently dropped from an
  // --ids batch). Sync add-only here; persisted by the claim write below (--dry stays read-only).
  syncFromGraph(ledger, graph);
  const max = flags.max ? parseInt(flags.max, 10) : 2;
  let ready = computeReady(graph, ledger, {
    maxItemRetries: cfg.maxItemRetries, target: flags.target || null,
    themes: flags.themes ? String(flags.themes).split(',') : null, includeEscalate: !!flags['include-escalate'],
  });
  if (flags.layer) ready = ready.filter((w) => w.layer === flags.layer);
  if (!flags['include-realinfra']) ready = ready.filter((w) => !w.realInfra); // realInfra needs Docker+Testcontainers (Phase 3); opt-in
  else if (!dockerAvailable()) {
    // KI-E10 (2026-07-19): a realInfra band launched without Docker is deterministically DOOMED — the
    // fold-time FACTORY::REALINFRA:: marker grep will FAIL it after the full band ran (ITEM-C7B
    // cycle 39 burned ~15 agent calls incl. 8 opus exactly this way). HARD-EXCLUDE instead of warning
    // through; --force-realinfra keeps the old warn-through for the rare deliberate case.
    if (!flags['force-realinfra']) {
      const excluded = ready.filter((w) => w.realInfra).map((w) => w.id);
      ready = ready.filter((w) => !w.realInfra);
      if (excluded.length) console.log('  KI-E10: Docker ABSENT — realInfra item(s) EXCLUDED from this batch (a full band would deterministically FAIL at the fold marker grep): ' + excluded.join(', ') + '. Run them on a Docker-capable host, or pass --force-realinfra to override (they will PARK BLOCKED:needs-docker at best).');
    } else console.log('  WARN: --force-realinfra with Docker ABSENT — realInfra items will PARK (BLOCKED:needs-docker), never close on an in-memory green (KI-C5)');
  }
  let picked;
  if (flags.ids) {
    const want = String(flags.ids).split(',');
    const by = Object.fromEntries(ready.map((w) => [w.id, w]));
    picked = want.map((id) => by[id]).filter(Boolean);
    // KI-L26 companion: never drop a requested id silently — say WHY it isn't schedulable
    // (unknown id / not in a claimable state / deps unmet / realInfra without the flag / file-locked).
    const dropped = want.filter((id) => !by[id]);
    if (dropped.length) console.log('  WARN: requested id(s) NOT schedulable (unknown, non-claimable state, deps unmet, realInfra without --include-realinfra, or file-locked):', dropped.join(', '));
  } else picked = ready.slice(0, max);
  // KI-E14 (2026-07-20): worktrees are created from HEAD, so an item whose files[] intersect
  // UNCOMMITTED main-tree changes gets a band that reviews a tree silently MISSING that sibling
  // work — and on apply-back the operator copy would CLOBBER the uncommitted fix (live near-miss:
  // ITEM-M1's CommonConfiguration.cs vs the uncommitted ITEM-M2 fix, sessions 22/23;
  // previously only operator discipline — the handoff's "group AFTER the user commits" caveat).
  // HARD-EXCLUDE (items stay READY) mirroring KI-E10; file-level precision so same-service items
  // on disjoint files still group; --force-dirty-overlap for a deliberate accept-the-snapshot run.
  if (!flags['force-dirty-overlap'] && picked.length) {
    const dirty = dirtyMainPaths(REPO_ROOT);
    const overlapped = [];
    picked = picked.filter((wi) => {
      const hit = filesOverlapDirty(wi.files, dirty);
      if (hit.length) { overlapped.push(wi.id + ' [' + hit.join(', ') + ']'); return false; }
      return true;
    });
    if (overlapped.length) console.log('  KI-E14: UNCOMMITTED main-tree overlap — item(s) EXCLUDED (a worktree snapshots HEAD without the pending fix; apply-back would clobber it). Commit the pending surface first, or pass --force-dirty-overlap to accept the snapshot: ' + overlapped.join('; '));
  }
  // KI-E29: a picked item whose CLOSED dependency still has an unmerged factory/<dep> worktree will
  // build from HEAD WITHOUT that dependency's code — fixes are uncommitted on the dep's branch (KI-E1),
  // so a "CLOSED" dep in the ledger does not put its code in HEAD. The worktree then silently lacks work
  // it depends on (live: SF-LINK-1720-BF depended on CLOSED-but-uncommitted SF-LINK-1718 and the fixer
  // re-derived its fix outside the lock-set, tripping a false scope block). WARN, don't exclude — nothing
  // is clobbered; the owner decides whether to commit the dependency first for a clean base.
  if (picked.length) {
    // A dependency's worktree dir still present is the cwd-independent proxy for "its fix isn't in HEAD
    // yet" — a committed dependency is gc'd (driver gc). Checking the dir (not `git worktree list`) avoids
    // the nested-factory-repo cwd trap and needs no git, mirroring how KI-E14 passes REPO_ROOT explicitly.
    const wtDir = abs(cfg.paths.worktreesState);
    const depWarn = [];
    for (const wi of picked) for (const d of wi.dependsOn || []) {
      const dep = ledger.items[d];
      if (dep && dep.state === 'CLOSED' && existsSync(join(wtDir, d))) depWarn.push(wi.id + ' <- ' + d);
    }
    if (depWarn.length) console.log('  KI-E29: picked item(s) depend on a CLOSED item whose fix is still on an unmerged factory/<dep> worktree (uncommitted per KI-E1) — the new worktree branches from HEAD WITHOUT that code, so the fixer may re-derive it or build against a missing dependency. Commit the dependency first for a clean base: ' + depWarn.join('; '));
  }
  // Within-batch file-lock: computeReady only locks against ALREADY-active items, not against
  // siblings in THIS batch. Two un-started items touching the same file would both be claimed,
  // edit it in separate worktrees, and serial integration would copy one over the other —
  // silently dropping a fix. Keep the first item per file; defer the rest (they stay READY).
  const batchFiles = new Set();
  const deferred = [];
  picked = picked.filter((wi) => {
    const fs = wi.files || [];
    if (fs.some((f) => batchFiles.has(f))) { deferred.push(wi.id); return false; }
    for (const f of fs) batchFiles.add(f);
    return true;
  });
  if (deferred.length) console.log('group: deferred (same-file collision within batch — stay READY for a later batch):', deferred.join(', '));
  if (!picked.length) { console.log('group: no schedulable items for the filter'); return; }
  // KI-E22 (improvement-analysis P4) — advisory acceptance-surface check on the picked batch: warn
  // when an item's acceptance names a real repo file its files[] (the lock set) does not carry —
  // the fixer would be lock-forbidden from meeting acceptance (the ITEM-M7 controller-clause
  // class, cycle 46). Advisory only; costs one git ls-files per group.
  try {
    const tracked22 = execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd().split('\n');
    const byBase22 = buildBasenameIndex(tracked22);
    const exists22 = (p) => existsSync(presolve(REPO_ROOT, p));
    for (const wi of picked) {
      const gaps22 = acceptanceSurfaceGaps(wi, { existsOnDisk: exists22, byBasename: byBase22, targetDir: wi.target && exists22(wi.target) ? wi.target : null });
      if (gaps22.length) console.log('  KI-E22 WARN ' + wi.id + ': acceptance names repo file(s) absent from files[] (the lock set) — ' + gaps22.map((g) => g.token + ' -> ' + g.resolved).join(', ') + '. Hand-append to files[] before grouping if the fix must touch them.');
    }
  } catch { /* advisory only */ }
  // Similarity-batch stamp (owner directive 2026-07-04): when the whole batch is ONE similarity
  // cluster (strict all-pairs, same rule as cluster.mjs/suggest), stamp the shared pattern into every
  // item — factory.js briefs each agent to keep its change structurally IDENTICAL to its siblings'.
  // `--pattern "<text>"` forces a hand-written stamp (e.g. a curated sweep); `--no-pattern` suppresses.
  const batchPattern = flags['no-pattern'] ? null : (flags.pattern ? String(flags.pattern) : batchPatternFor(picked));
  if (batchPattern) console.log('group: batch-pattern stamped -> ' + batchPattern);
  // trim + ASCII-sanitize (a few normalizer strings carry → / em-dashes; keep args lean + plain)
  const trim = (s, n) => { s = (s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—→]/g, '-').replace(/[…]/g, '...'); return s.length > n ? s.slice(0, n - 1) + '...' : s; };
  const items = picked.map((wi) => {
    // ABSOLUTE worktree path — robust to the driver's CWD. A repo-relative path is resolved by `git worktree
    // add` (and by the factory's agents) against the CURRENT directory, so running `driver.mjs` from a subdir
    // (e.g. _workflow/) doubled the path to `_workflow/_bmad-output/.../worktrees/<id>` — the run then ran
    // consistently there, but the ledger pointed at the intended path and the fold-time diff checks silently
    // skipped. An absolute path flows correctly to addWorktree, the run-args, the agents, and the fold.
    const wtAbs = abs(join(cfg.paths.worktreesState, wi.id));
    // KI-L25: --dry is a plan-only smoke test — it must NOT create worktrees (nor claim; see below).
    // The emitted worktree paths are just strings; the factory's dry mode spawns 0 agents.
    if (!flags.dry) addWorktree(wtAbs, 'factory/' + wi.id); // per-item isolated worktree
    return { // compact: NO routes (factory derives), NO reviewFlows (factory derives from files), NO fixHint (agent reads source) — fits the session arg limit
      // KI-L30: the 80/90-char trims were sized for the ~2KB args cap (KI-C1). The script-channel
      // launcher (512KB) removed that pressure, and the trims caused REAL incompleteness: cycle-20
      // ITEM-C5's fixer never saw the acceptance's third clause ("links from CONTEXT.md and
      // AGENTS.md") — it was beyond char 90 — and delivered 2 of 3 clauses; three gates then
      // CHANGES_REQUIRED'd it. Full-fidelity strings, sanitized only. fixHint rides along too (it
      // was omitted entirely in the compact-args era — compose rendered "(none)" for every item).
      id: wi.id, target: wi.target, layer: wi.layer, title: trim(wi.title, 300), severity: wi.severity, theme: wi.theme,
      fixType: wi.fixType, files: wi.files, dependsOn: wi.dependsOn || [], acceptance: trim(wi.acceptance, 2000),
      regressionTest: trim(wi.regressionTest, 1200), fixHint: trim(wi.fixHint, 1500), realInfra: !!wi.realInfra, gateSet: wi.gateSet, autonomyTier: wi.autonomyTier,
      reFix: ['FAILED', 'CONFLICT'].includes(ledger.items[wi.id].state), // Phase-6: re-run feeds prior gate feedback to test-author+fixer
      batchPattern: batchPattern || undefined, // similarity batch: factory.js briefs agents to keep sibling changes structurally identical
      // KI-L32 — peer surface ownership: each item's brief names the files its batch siblings own,
      // so a fixer following gate findings cannot silently redo a sibling's work in its own worktree.
      peers: picked.filter((o) => o.id !== wi.id).map((o) => ({ id: o.id, files: (o.files || []).slice(0, 12) })),
      source: wi.source, solution: flags.solution ? undefined : solutionFor(wi.target), // per-item solution for multi-target groups; omitted when --solution sets config.solution
      // Cache-strategic prompts (2026-07-18): a section index of the target's reference docs
      // (data-flows / CONTEXT / AGENTS headings + line numbers) rides in the shared per-item
      // prompt prefix so agents Read targeted offsets instead of whole large docs.
      docMap: buildDocMap(REPO_ROOT, wi.target),
      worktree: { path: wtAbs, branch: 'factory/' + wi.id },
    };
  });
  // Parallel-instances (owner directive 2026-07-09): --label emits UNIQUELY-NAMED run-args/run-script
  // (run-args-<label>.json / run-script-<label>.js) so N disjoint batches can be grouped back-to-back
  // WITHOUT clobbering each other's launch script — each labeled batch then launches its own Workflow.
  // Disjointness across sequential groups is ALREADY guaranteed by the claim + file-lock (a CLAIMED item
  // and its files are excluded from every later group's computeReady — lockedFiles/conflictFor). No
  // label = the legacy single fixed paths (backward-compatible). The driver stays the single ledger
  // writer; only the batch's LAUNCH artifacts are parallelised, never the ledger.
  const labelSlug = flags.label ? String(flags.label).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) : null;
  const labelPath = (p) => labelSlug ? p.replace(/(\.[^.\/]+)$/, '-' + labelSlug + '$1') : p;
  const runScriptRel = labelPath(cfg.paths.runScript || '_bmad-output/ai-factory/state/run-script.js');
  if (!flags.dry) { // KI-L25: --dry claims nothing and writes no ledger — a re-run after a dry is a no-op-safe fresh group
    const claimFailed = [];
    for (const it of items) {
      // computeReady only returns READY/FAILED/CONFLICT (all claimable), so this should always succeed —
      // but check the return rather than assume the invariant; surface a violation instead of silently
      // emitting an item whose ledger row never moved to CLAIMED.
      const prev = ledger.items[it.id] ? ledger.items[it.id].state : null; // KI-L51: remember the pre-claim state
      if (!transition(ledger, it.id, 'CLAIMED', 'group-claim')) claimFailed.push(it.id);
      const row = ledger.items[it.id];
      // record AT CLAIM so a kill-before-fold leaves the worktree + launch artifacts discoverable for
      // resume: prevState lets `resume --reset-stale` restore FAILED (keeping reFix provenance, KI-L51);
      // runLabel/runScript let `resume` print exact relaunch lines after a dead session (KI-L52).
      if (row) { row.worktree = it.worktree.path; row.branch = it.worktree.branch; row.prevState = prev; row.runLabel = labelSlug; row.runScript = runScriptRel; }
      // KI-L65 — snapshot the item's files[] as they exist in the MAIN tree at claim time; the fold
      // re-hashes and warns on drift (an agent writing outside its worktree — witnessed twice, cycle 35).
      try {
        const snapDir = abs(join(cfg.paths.items, it.id));
        if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true });
        writeJsonAtomic(join(snapDir, 'main-snapshot.json'), { at: new Date().toISOString(), files: snapshotMainFiles(REPO_ROOT, it.files) });
      } catch { /* best-effort — detection aid, never blocks a claim */ }
    }
    if (claimFailed.length) console.log('  WARN: group-claim REFUSED for (unexpected — not in a claimable state):', claimFailed.join(', '));
    writeJsonAtomic(abs(cfg.paths.ledger), ledger);
  }
  const runArgs = {
    cycle: ledger.cycle + 1, concurrency: flags.conc ? parseInt(flags.conc, 10) : 2, attempts: cfg.attempts, repoRoot: REPO_ROOT,
    templatesDir: cfg.paths.agents,
    config: { solution: flags.solution || null },
    routing: injectedRouting(cfg), // KI-B1: config/model-routing.json is authoritative at launch
    // Cache-strategic prompts (2026-07-18): agents/*.md inlined ONCE per batch — compose() embeds
    // the role brief text (group-time snapshot; no per-agent Read, no mid-run brief drift).
    briefs: readRoleBriefs(abs(cfg.paths.agents)),
    budget: { reserve: (cfg.budget && cfg.budget.reserve) || 50000 }, // KI-C2: factory's graceful budget-stop reserve (binds ONLY when the launch turn set a token budget)
    dryRun: !!flags.dry, // --dry: factory returns the plan with ZERO agents (smoke-tests the launcher)
    items,
  };
  const runArgsRel = labelPath(cfg.paths.runArgs);
  writeJsonAtomic(abs(runArgsRel), runArgs);
  // KI-C1 fix: ALSO emit a self-contained LAUNCHER script that inlines the batch into the SCRIPT
  // channel (512KB cap), so a batch larger than the ~2KB `args` transport launches via
  // Workflow({scriptPath}) with NO args. factory.js prefers __FACTORY_BATCH__ over `args` (the args
  // path stays valid). Shared with cmdSweep via emitLauncherScript (KI-L52).
  const runScriptPath = emitLauncherScript(cfg, runArgs, labelSlug);
  writeReports(cfg, ledger, graph);
  // KI-E7 telemetry: the lane + per-item claims (spine AD-2 source:driver). A --dry group is a
  // plan-only smoke test — run_prepared records it (attrs.dry) but nothing was claimed.
  temit({ source: 'driver', event: 'run_prepared', cycle: runArgs.cycle, lane: labelSlug || undefined, attrs: { items: items.map((i) => i.id), concurrency: runArgs.concurrency, dry: !!flags.dry, batchPattern: !!batchPattern, runScript: runScriptPath || runScriptRel } });
  if (!flags.dry) for (const it of items) temit({ source: 'driver', event: 'item_claimed', item: it.id, cycle: runArgs.cycle, lane: labelSlug || undefined, attrs: { severity: it.severity, fixType: it.fixType, theme: it.theme, autonomyTier: it.autonomyTier, reFix: !!it.reFix, realInfra: !!it.realInfra, worktree: it.worktree.path } });
  const bytes = JSON.stringify(runArgs).length;
  console.log(`group${flags.dry ? ' (DRY — nothing claimed, no worktrees)' : ''}${labelSlug ? ' [label=' + labelSlug + ']' : ''}: ${items.length} item(s) ${flags.dry ? 'planned' : 'claimed + per-item worktrees'} -> ${runArgsRel} (${bytes} bytes)`);
  for (const it of items) console.log(`  ${it.id} (${it.severity}/${it.fixType}/${it.autonomyTier}) @ ${it.worktree.path}`);
  if (runScriptPath) console.log(`  launcher (KI-C1 — no arg-size limit): Workflow({scriptPath: "${runScriptPath}"})  <- preferred`);
  if (bytes > 1900) console.log(`  NOTE: run-args ${bytes} bytes exceeds the ~2KB args cap — launch via the scriptPath launcher above, NOT args.`);
  return items; // KI-C3: cmdCycle inspects the emitted batch to decide RUN vs STOP
}

// KI-C3 — closed-loop helper. The loop itself MUST live outside the two halves (the driver cannot invoke
// the Workflow; the Workflow cannot touch git), so an external driver — the main agent under /loop, or a
// scheduled routine — calls `cycle` to get the next batch + a STOP signal, runs the factory Workflow on the
// emitted run-args, folds the results, and calls `cycle` again. `--until critical|high|dry` sets the
// completion condition; this also makes the ~2 KB arg cap (KI-C1) a non-issue (the loop just iterates).
function cmdCycle(flags) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('CYCLE: STOP no-ledger (run init first)'); return; }
  const until = flags.until || 'dry';
  const themes = flags.themes ? String(flags.themes).split(',') : null;
  const DONE = new Set(['CLOSED', 'BLOCKED', 'ESCALATED']); // not autonomously actionable any more
  // Count remaining ACTIONABLE items, honouring the same --target/--themes filter the batch uses, so a
  // filtered cycle stops on ITS scope (not the whole graph).
  const remainingOf = (sevs) => (graph.items || []).filter((w) => sevs.includes(w.severity)
    && (!flags.target || w.target === flags.target)
    && (!themes || themes.includes(w.theme))
    && ledger.items[w.id] && !DONE.has(ledger.items[w.id].state)).length;
  const remCrit = remainingOf(['CRITICAL']);
  if (until === 'critical' && remCrit === 0) { console.log('CYCLE: STOP critical-zero — 0 actionable CRITICAL remain (rest CLOSED or in the human queue)'); return; }
  if (until === 'high' && remCrit === 0 && remainingOf(['HIGH']) === 0) { console.log('CYCLE: STOP high-zero — 0 actionable CRITICAL/HIGH remain'); return; }
  const items = cmdGroup(flags); // builds per-item worktrees + claims + writes run-args; returns the picked batch
  if (!items || !items.length) {
    const total = remainingOf(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
    if (total === 0) console.log('CYCLE: STOP dry — no actionable items remain (all CLOSED or queued)');
    else console.log(`CYCLE: STOP stalled — ${total} item(s) remain but none schedulable now (dep/lock-blocked); a human must unblock the queue`);
    return;
  }
  console.log(`CYCLE: RUN ${items.length} item(s) -> ${cfg.paths.runArgs}`);
  console.log("  next: invoke the factory Workflow with these run-args, then 'driver fold <results.json>', then 'driver cycle' again");
}

// KI-C5 — environment preflight: is this host able to close realInfra items (needs Docker) and build (dotnet)?
function cmdPreflight() {
  const env = preflight();
  console.log('preflight (environment readiness):');
  console.log(`  docker: ${env.docker ? 'available' : 'ABSENT'}` + (env.docker ? '' : ' — realInfra items (money/security/concurrency) cannot close; they park BLOCKED:needs-docker'));
  console.log(`  dotnet: ${env.dotnet ? 'available' : 'ABSENT'}` + (env.dotnet ? '' : ' — build/test verify cannot run on this host'));
  if (!env.docker) console.log('  -> run realInfra items only on a Docker-capable host (CI); a non-realInfra cycle is fine here.');
}

function cmdWorktree(sub, rest) {
  const cfg = loadConfig();
  if (sub === 'worktree-list') { console.log(JSON.stringify(listWorktrees(), null, 2)); return; }
  if (sub === 'worktree-add') {
    const id = rest[0];
    const path = abs(join(cfg.paths.worktreesState, id)); // ABSOLUTE (CWD-robust) — state/worktrees/<id> under the already-untracked factory dir
    const wt = addWorktree(path, 'factory/' + id);
    console.log(JSON.stringify(wt));
    return;
  }
  if (sub === 'worktree-remove') { removeWorktree(rest[0], true); console.log('removed', rest[0]); return; }
}

// KI-L27 — audit (and with --fix, repair) stale files[] paths in the findings graph. A stale path
// (audit-artifact-relative, renamed dir, bare basename) defeats the within-batch file-lock and
// misdirects the fixer + debris whitelist (KI-L23's root cause; ITEM-C0's audit-dir-relative
// paths). Only a SINGLE-candidate basename match (target-dir-unique wins) is auto-rewritten;
// ambiguous and creation-target entries are report-only. CLOSED items are skipped (history).
function cmdGraphAudit(flags) {
  const cfg = loadConfig();
  const graphPath = abs(cfg.paths.graph);
  const graph = loadGraph(graphPath);
  const ledger = loadLedger(abs(cfg.paths.ledger));
  const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd().split('\n');
  const byBasename = buildBasenameIndex(tracked);
  const existsOnDisk = (p) => existsSync(presolve(REPO_ROOT, p));
  const report = { ok: 0, creation: [], stale: [], ambiguous: [], sharedFileGap: [], surfaceGap: [] };
  const LEDGER_PATH = '_bmad-output/tech-debt/STANDARDS-LEDGER.md';
  for (const wi of graph.items) {
    const st = ledger && ledger.items[wi.id] ? ledger.items[wi.id].state : 'READY';
    if (st === 'CLOSED') continue; // history — its files[] served their purpose
    // KI-E16 (2026-07-20): shared-file acceptance lint. ITEM-H-A6's acceptance required a
    // STANDARDS-LEDGER entry while its files[] omitted the ledger path — so the
    // similarity clusterer paired it with ITEM-H17 ON the shared-ledger change-shape, the batch
    // file-lock could not serialize them (files[] disjoint on paper), the sibling held the real
    // lock, and the fixer had to STAGE its entry instead of appending — the acceptance became
    // structurally unmeetable in-band (cycle 46). Flag every open item whose acceptance names the
    // ledger but whose files[] lacks it, so the operator hand-appends the path BEFORE grouping
    // (KI-L54: the graph is hand-editable) and the file-lock can do its job.
    if (/STANDARDS-LEDGER|ledger entr(?:y|ies)|ledger anchor/i.test(wi.acceptance || '') && !(wi.files || []).includes(LEDGER_PATH)) {
      report.sharedFileGap.push({ id: wi.id, state: st });
    }
    const targetDir = wi.target && existsOnDisk(wi.target) ? wi.target : null;
    // KI-E22 (improvement-analysis P4) — the KI-E16 generalization: tokens the acceptance names
    // that resolve to real tracked files absent from files[] (the lock set silently forbids the
    // fixer from meeting acceptance — the ITEM-M7 controller-clause class). Advisory WARN only.
    for (const g of acceptanceSurfaceGaps(wi, { existsOnDisk, byBasename, targetDir })) {
      report.surfaceGap.push({ id: wi.id, state: st, token: g.token, resolved: g.resolved });
    }
    (wi.files || []).forEach((f, idx) => {
      const c = classifyFilesEntry(f, { existsOnDisk, byBasename, targetDir });
      if (c.status === 'ok') report.ok++;
      else if (c.status === 'creation-target') report.creation.push({ id: wi.id, state: st, file: f });
      else if (c.status === 'stale') {
        report.stale.push({ id: wi.id, state: st, file: f, rewrite: c.rewrite });
        if (flags.fix) wi.files[idx] = c.rewrite;
      } else if (c.status === 'ambiguous') report.ambiguous.push({ id: wi.id, state: st, file: f, candidates: c.candidates });
    });
  }
  console.log(`graph-audit: ${report.ok} ok · ${report.stale.length} stale${flags.fix ? ' (REWRITTEN)' : ' (rewrite proposed — pass --fix)'} · ${report.ambiguous.length} ambiguous (hand-triage) · ${report.creation.length} creation-target (fine) · ${report.sharedFileGap.length} shared-file gap (KI-E16${flags.fix ? ', APPENDED' : ''}) · ${report.surfaceGap.length} acceptance-surface gap (KI-E22, advisory)`);
  for (const s of report.stale) console.log(`  STALE ${s.id} (${s.state}): ${s.file}\n    -> ${s.rewrite}`);
  for (const a of report.ambiguous) console.log(`  AMBIG ${a.id} (${a.state}): ${a.file}\n    ?  ${a.candidates.join(' | ')}`);
  for (const g of report.sharedFileGap) console.log(`  SHARED-FILE-GAP ${g.id} (${g.state}): acceptance names the standards-divergence ledger but files[] lacks ${LEDGER_PATH} — ${flags.fix ? 'APPENDED by --fix' : 'hand-append it (or pass --fix)'} so the batch file-lock can serialize sibling items (KI-E16; the ITEM-H-A6 staged-not-appended class)`);
  for (const g of report.surfaceGap) console.log(`  ACCEPT-SURFACE ${g.id} (${g.state}): acceptance names \`${g.token}\` -> ${g.resolved} but files[] lacks it — the file-lock cannot serialize it and the fixer may be lock-forbidden from meeting acceptance (KI-E22, advisory; hand-append if the fix must touch it)`);
  // KI-E22/KI-E16 --fix: the ledger-path append IS the prescribed mechanical triage (KI-L54: the
  // graph is hand-editable; this automates exactly the hand-append the lint prescribes so the
  // flagged class stops re-surfacing at every audit). Acceptance-surface gaps stay report-only —
  // whether the fix must actually TOUCH a named surface is a judgment call, not mechanical.
  if (flags.fix && report.sharedFileGap.length) {
    const byIdWi = Object.fromEntries(graph.items.map((w) => [w.id, w]));
    for (const g of report.sharedFileGap) {
      const wi = byIdWi[g.id];
      if (wi && !(wi.files || []).includes(LEDGER_PATH)) { wi.files = wi.files || []; wi.files.push(LEDGER_PATH); }
    }
  }
  if (flags.fix && (report.stale.length || report.sharedFileGap.length)) {
    writeJsonAtomic(graphPath, graph);
    console.log(`graph-audit: ${report.stale.length} stale path(s) rewritten + ${report.sharedFileGap.length} ledger-path append(s) (KI-E16) -> ${cfg.paths.graph}`);
  }
  // durable report for the session record
  const day = new Date().toISOString().slice(0, 10);
  const rp = join(FACTORY_ROOT, 'reports', `graph-path-audit-${day}.md`);
  const md = [`# Graph files[] path audit — ${day}`, '',
    `ok: ${report.ok} · stale: ${report.stale.length}${flags.fix ? ' (rewritten)' : ''} · ambiguous: ${report.ambiguous.length} · creation-target: ${report.creation.length}`, '',
    '## Stale (auto-rewritable)', ...report.stale.map((s) => `- \`${s.id}\` (${s.state}): \`${s.file}\` -> \`${s.rewrite}\``), '',
    '## Ambiguous (hand-triage — NOT auto-rewritten)', ...report.ambiguous.map((a) => `- \`${a.id}\` (${a.state}): \`${a.file}\` — candidates: ${a.candidates.map((c) => '`' + c + '`').join(', ')}`), '',
    '## Shared-file gaps (KI-E16 — acceptance names the ledger, files[] lacks it; --fix appends)', ...report.sharedFileGap.map((g) => `- \`${g.id}\` (${g.state})`), '',
    '## Acceptance-surface gaps (KI-E22, advisory — acceptance names a repo file files[] lacks)', ...report.surfaceGap.map((g) => `- \`${g.id}\` (${g.state}): \`${g.token}\` -> \`${g.resolved}\``), '',
    '## Creation targets (no action — the fix creates them)', ...report.creation.map((c) => `- \`${c.id}\` (${c.state}): \`${c.file}\``), ''].join('\n');
  writeFileSync(rp, md);
  console.log(`graph-audit: report -> ${rp}`);
  return report;
}

// KI-C7 — worktrees accumulate (the factory never auto-removes them; it leaves changes for the human).
// `gc` lists worktrees for CLOSED items; removes them ONLY with --yes (the operator asserts the human has
// already committed/integrated those changes). `git worktree prune` is always safe (drops only dead refs).
function cmdGc(flags) {
  const cfg = loadConfig();
  const ledger = loadLedger(abs(cfg.paths.ledger));
  const closed = Object.entries(ledger.items).filter(([, r]) => r.state === 'CLOSED' && r.worktree);
  console.log(`gc: ${closed.length} CLOSED item(s) with a worktree` + (flags.yes ? '' : ' (dry-run — pass --yes to remove; the human must have committed first)'));
  for (const [id, r] of closed) console.log(`  ${id} @ ${r.worktree}`);
  if (flags.yes) {
    let removed = 0;
    for (const [id, r] of closed) {
      const wtAbs = presolve(REPO_ROOT, r.worktree);
      try { if (existsSync(wtAbs)) removeWorktree(wtAbs, true); r.worktree = null; r.branch = null; removed++; }
      catch (e) { console.log(`  ! could not remove ${id}: ${String((e && e.message) || e)}`); }
    }
    try { pruneWorktrees(); } catch { /* best effort */ }
    writeJsonAtomic(abs(cfg.paths.ledger), ledger);
    console.log(`gc: removed ${removed} worktree(s) + pruned`);
  } else {
    try { pruneWorktrees(); console.log('gc: pruned dead worktree admin refs (safe)'); } catch { /* ignore */ }
  }
}

// Sweep mode (root-cause fan-out): one factory run designs the canonical fix once + applies it to every
// site (LIGHT) + gates the pattern once. `sweep <N>` reads the cluster spec (cluster.mjs --emit N), claims
// the sites into ONE shared worktree, emits run-args. Big clusters CHUNK via --max-sites (design is reused).
function sweepsDir(cfg) { return abs(join(cfg.paths.items, '..', 'sweeps')); }
function cmdSweep(flags, rest) {
  const cfg = loadConfig();
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('no ledger — run init'); return; }
  const n = rest[0] != null ? String(rest[0]) : '0'; // numeric cluster index OR a pattern slug (--emit-pattern)
  const specPath = join(sweepsDir(cfg), 'sweep-' + n + '.json');
  if (!existsSync(specPath)) { console.log(`no sweep spec for ${n} — run: node _bmad-output/ai-factory/_workflow/cluster.mjs --emit ${n}`); return; }
  const spec = readJson(specPath);
  // KI-L52: the script-channel launcher (emitLauncherScript below) removed the ~2KB args cap that sized
  // the old defaults (--max-sites 6, 70-char titles). Default raised to 10 — the ceiling is now REVIEW
  // tractability (one gate reads the whole sweep diff), not transport; override per sweep as judgment says.
  const maxSites = flags['max-sites'] ? parseInt(flags['max-sites'], 10) : 10;
  const sites = spec.sites.filter((s) => { const r = ledger.items[s.findingId]; return r && r.state !== 'CLOSED'; }).slice(0, maxSites);
  if (!sites.length) { console.log(`sweep ${n}: all sites already CLOSED`); return; }
  const wtRel = abs(join(cfg.paths.worktreesState, 'sweep-' + n)); // ABSOLUTE (CWD-robust) — see the group call-site note
  addWorktree(wtRel, 'factory/sweep-' + n);
  const designExists = existsSync(join(sweepsDir(cfg), 'sweep-' + n + '-design.md'));
  const sweepSlug = 'sweep-' + n;
  const sweepScriptRel = (cfg.paths.runScript || '_bmad-output/ai-factory/state/run-script.js').replace(/(\.[^.\/]+)$/, '-' + sweepSlug + '$1');
  for (const s of sites) {
    const prev = ledger.items[s.findingId] ? ledger.items[s.findingId].state : null; // KI-L51
    if (transition(ledger, s.findingId, 'CLAIMED', 'sweep-claim')) temit({ source: 'driver', event: 'transition', item: s.findingId, cycle: ledger.cycle, outcome: 'CLAIMED' }); // KI-E7 finding #12
    const r = ledger.items[s.findingId];
    if (r) { r.worktree = wtRel; r.branch = 'factory/sweep-' + n; r.prevState = prev; r.runLabel = sweepSlug; r.runScript = sweepScriptRel; }
  }
  writeJsonAtomic(abs(cfg.paths.ledger), ledger);
  const compactSites = sites.map((s) => ({ findingId: s.findingId, target: s.target, files: s.files || [], title: (s.title || '').slice(0, 200), severity: s.severity }));
  const runArgs = {
    cycle: ledger.cycle + 1, concurrency: flags.conc ? parseInt(flags.conc, 10) : 3, attempts: cfg.attempts, repoRoot: REPO_ROOT, templatesDir: cfg.paths.agents,
    worktree: { path: wtRel, branch: 'factory/sweep-' + n },
    routing: injectedRouting(cfg), // KI-B1
    budget: { reserve: (cfg.budget && cfg.budget.reserve) || 50000 }, // KI-C2
    sweep: { index: n, label: spec.label, theme: spec.theme, skipDesign: designExists, sites: compactSites },
  };
  writeJsonAtomic(abs(cfg.paths.runArgs), runArgs);
  const sweepScriptPath = emitLauncherScript(cfg, runArgs, sweepSlug); // KI-L52 — sweeps get the same no-arg-limit launcher as group
  const bytes = JSON.stringify(runArgs).length;
  console.log(`sweep ${n} [${spec.label}]: claimed ${sites.length}/${spec.sites.length} site(s)` + (designExists ? ' (design exists -> skipDesign)' : ' (will design)') + ` @ ${wtRel} -> ${cfg.paths.runArgs} (${bytes} bytes)`);
  if (sweepScriptPath) console.log(`  launcher (KI-L52 — no arg-size limit): Workflow({scriptPath: "${sweepScriptPath}"})  <- preferred`);
  if (bytes > 1900) console.log(`  WARN: run-args ${bytes} bytes exceeds the ~2KB args cap — launch via the scriptPath launcher above, NOT args.`);
  console.log('  next: run the factory Workflow (launcher above), then: driver sweep-fold <results.json>');
}
function cmdSweepFold(file) {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  const result = readJson(presolve(REPO_ROOT, file));
  const sw = result.sweep || result;
  const sites = sw.sites || [];
  // PER-SITE close (KI-L8): a CHANGES_REQUIRED that flags only ONE site must NOT block the other GOOD sites.
  // A site closes if it APPLIED and was NOT gate-flagged by a blocking (CRITICAL/HIGH) finding. If the gate
  // is CHANGES_REQUIRED but NO site was flagged (a cross-cutting issue), be conservative -> re-queue all.
  const someFlagged = sites.some((s) => s.gateFlagged);
  const blockingFindings = (sw.findings || []).filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  // Re-queue ALL only when a HIGH/CRITICAL blocker maps to NO site (an unisolable cross-cutting issue). A
  // CHANGES_REQUIRED driven only by MEDIUM/LOW nits is NOT blocking — the applied sites close and the nits are
  // forwarded to the human (cycle-9: the architect itself called the 2 MEDIUM test-table issues "surgical").
  const unmappedBlocker = blockingFindings.length > 0 && !someFlagged;
  const perSite = !unmappedBlocker;
  // Deterministic per-site CONFORMANCE check — a DOC sweep has no build, so this is the per-site verification
  // (the gate reviews the diff in aggregate; this catches a bad apply per-site): grep each applied site's files
  // in the worktree for placeholder/TODO markers + confirm non-empty. A non-conforming site is NOT closed.
  let specSites = {}; try { for (const s of readJson(join(sweepsDir(cfg), 'sweep-' + sw.index + '.json')).sites) specSites[s.findingId] = s.files || []; } catch { /* no spec */ }
  const wtAbs = sw.worktree ? presolve(REPO_ROOT, sw.worktree) : null;
  const conformance = (findingId) => {
    if (!wtAbs || !existsSync(wtAbs)) return { ok: true };
    for (const f of (specSites[findingId] || [])) {
      const p = join(wtAbs, f); if (!existsSync(p)) continue;
      const txt = readFileSync(p, 'utf8');
      // Empty/near-empty = the apply failed. Do NOT grep for TODO/FIXME/REPLACE_WITH_/CHANGE_ME: a DOC
      // legitimately MENTIONS those tokens when describing the code (a "Known Issues / TODOs" heading; a
      // "fail-fast on a REPLACE_WITH_ placeholder" security note) — that grep false-flagged good docs (cycle-9 KI-L9).
      if (txt.trim().length < 80) return { ok: false, why: f + ' is empty/near-empty (apply likely failed)' };
    }
    return { ok: true };
  };
  let closed = 0, reverted = 0, nonconf = 0;
  for (const s of sites) {
    const row = ledger.items[s.findingId]; if (!row) continue;
    const conf = (s.applied && !s.gateFlagged) ? conformance(s.findingId) : { ok: true };
    if (perSite && s.applied && !s.gateFlagged && conf.ok) {
      const from = row.state; row.state = 'CLOSED';
      row.history.push({ from, to: 'CLOSED', at: now(), note: 'closed via sweep-' + sw.index + ' (designed + applied + conformance-checked + gated' + (sw.gateVerdict === 'APPROVED' ? ' APPROVED' : '; site not flagged') + ')' });
      row.updatedAt = now(); closed++;
      temit({ source: 'driver', event: 'transition', item: s.findingId, cycle: ledger.cycle, outcome: 'CLOSED' }); // KI-E7 finding #12
    } else {
      if (!conf.ok) nonconf++;
      if (transition(ledger, s.findingId, 'FAILED', 'sweep-' + sw.index + ': ' + (s.gateFlagged ? 'gate-flagged (re-fix needed)' : (!conf.ok ? 'conformance: ' + conf.why : (s.applied ? 'gate ' + sw.gateVerdict : 'not applied'))))) { reverted++; temit({ source: 'driver', event: 'transition', item: s.findingId, cycle: ledger.cycle, outcome: 'FAILED' }); } // KI-E7 finding #12
    }
  }
  if (sw.cost && sites[0]) { const r = ledger.items[sites[0].findingId]; if (r) { r.cost = r.cost || {}; for (const [m, c] of Object.entries(sw.cost)) r.cost[m] = (r.cost[m] || 0) + c; } }
  ledger.updatedAt = now();
  writeJsonAtomic(abs(cfg.paths.ledger), ledger);
  writeReports(cfg, ledger, graph);
  cmdEscalationsSync(cfg, ledger, true);
  // KI-E23 (P6c): a sweep run's usage event — same contract as cmdFold's (surfaced by the first
  // live KI-E21-routed sweep, whose result carried usage that the fold silently dropped).
  try { if (result && result.usage && typeof result.usage.outputTokens === 'number') temit({ source: 'driver', event: 'usage', cycle: result.cycle || ledger.cycle, attrs: { outputTokens: result.usage.outputTokens, file: basename(presolve(REPO_ROOT, file)) } }); } catch { /* observational only */ }
  console.log(`sweep-fold ${sw.index} [${sw.label || ''}]: gate ${sw.gateVerdict} -> CLOSED ${closed}, re-queued ${reverted}` + (nonconf ? `, ${nonconf} non-conforming (placeholder/empty)` : '') + (sw.findings && sw.findings.length ? ` · ${sw.findings.length} gate finding(s)` : ''));
  for (const f of (sw.findings || [])) console.log(`  [${f.severity}] ${f.file}: ${f.title}`);
}

// KI-E20 (improvement-analysis P2) — `recover <id>`: first-class scaffold for the DOMINANT close
// path. Evidence (07-18 + 07-20 analyses): 8 of the last 9 FAILED-item closes were §4
// direct-recoveries hand-rolled by the controller session (parse feedback by eye -> apply the
// reviewer-converged remedy -> hand-assemble delta re-gate prompts from agents/*.md -> hand-type
// the recovery fold), with live near-misses on the evidence contract (the
// mutation-proof-vs-integrate-raw footgun). This command PREPARES the whole path
// deterministically: (a) the dissent digest from the prior checkpoint's structured gateDetails
// (KI-L31 — returned verdicts, never prose), (b) one ready delta re-gate prompt per dissenting
// role with its agents/*.md brief inlined, (c) the evidence contract with exact tee targets,
// (d) the recovery-fold JSON skeleton (#<cycle>r, attemptsDelta:0, the KI-L47/L62 transition
// shape, machine-evidence flags carried from the prior checkpoint), and (e) a telemetry record so
// recoveries stop being invisible in the stream. The OPERATOR stays in the loop: this prepares;
// the operator applies the remedy in the worktree, runs the re-gate agents, fills the skeleton,
// folds. Ledger READ-ONLY (writes only item artifacts — no lock, no lease).
function cmdRecover(flags, rest) {
  const id = rest[0];
  if (!id) { console.log('usage: driver.mjs recover <id>'); return; }
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger || !ledger.items[id]) { console.error('recover: unknown item ' + id); process.exitCode = 1; return; }
  const row = ledger.items[id];
  const wi = byId(graph)[id] || {};
  if (!['FAILED', 'ESCALATED'].includes(row.state)) {
    console.log(`recover: ${id} is ${row.state} — recovery targets FAILED (apply the converged remedy) or ESCALATED (record the human sign-off). Nothing prepared.`);
    return;
  }
  const itemDir = abs(join(cfg.paths.items, id));
  let prior = null; try { prior = readJson(join(itemDir, 'result.json')); } catch { /* no checkpoint */ }
  if (prior && prior.id !== id) prior = null;
  const dissent = dissentersFrom((prior && prior.gateDetails) || {});
  const cyc = priorCycleOf(prior, ledger.cycle);
  const recDir = join(itemDir, 'recovery');
  mkdirSync(recDir, { recursive: true });
  const wtAbs = row.worktree ? presolve(REPO_ROOT, row.worktree) : null;
  const btAbs = join(FACTORY_ROOT, 'verify', 'build-test.sh');
  const briefs = readRoleBriefs(abs(cfg.paths.agents));
  const foldFile = join(recDir, 'recovery-fold.json');
  writeJsonAtomic(foldFile, { mode: 'recovery', cycle: cyc, results: [recoveryFoldSkeleton(id, row, prior, cyc)] });
  const prompts = [];
  for (const d of dissent) {
    const role = roleForGateKey(d.key);
    if (!role) continue;
    const pfile = join(recDir, `regate-${role}.md`);
    writeFileSync(pfile, [
      `# DELTA RE-GATE — ${d.key} — work item ${id}`,
      '',
      `Run this prompt as ONE separate agent (Agent tool); save its verdict prose to ${join(itemDir, role + '.md')}.`,
      '',
      '---',
      '',
      `TARGET: ${wi.target || '?'}   WORK ITEM: ${id}  (${wi.severity || '?'} / ${wi.fixType || '?'})`,
      `WORKTREE (judge THIS tree; NEVER run mutating git): ${wtAbs || '<worktree missing — set it before running>'}`,
      `ARTIFACTS DIR (absolute): ${itemDir}`,
      `REVIEW PACK: Read ${join(itemDir, 'review-pack.md')} FIRST; if missing or stale vs \`git -C <worktree> status\`, regenerate: \`bash ${btAbs} pack ${wtAbs || '<worktree>'} ${join(itemDir, 'review-pack.md')}\``,
      '',
      'WORK-ITEM SPEC:',
      `  title: ${wi.title || ''}`,
      `  acceptance: ${wi.acceptance || ''}`,
      `  regression-test: ${wi.regressionTest || ''}`,
      '',
      `YOUR PRIOR DISSENT (${d.key})${d.headline ? ' — ' + d.headline : ''}. A recovery has since applied a remedy. Your prior findings are HYPOTHESES to RE-VERIFY against the CURRENT worktree (KI-L35), never conclusions to copy forward:`,
      '```json',
      JSON.stringify(d.findings, null, 1),
      '```',
      '',
      'DELTA RE-GATE: verdict APPROVED only if EVERY prior finding is genuinely resolved in the current worktree (cite file:line evidence per finding); CHANGES_REQUIRED with exact findings otherwise.',
      '',
      `TELEMETRY (best-effort, never evidence): first Bash action \`node ${join(FACTORY_ROOT, '_workflow', 'telemetry-emit.mjs')} --event stage_start --item ${id} --role ${role}\`; last \`node ${join(FACTORY_ROOT, '_workflow', 'telemetry-emit.mjs')} --event stage_end --item ${id} --role ${role} --outcome ok --verdict <APPROVED|CHANGES_REQUIRED>\`. If either errors, ignore and continue.`,
      '',
      briefs[role] ? 'YOUR ROLE BRIEF (inlined — authoritative):\n\n' + briefs[role] : `YOUR ROLE BRIEF: read ${join(abs(cfg.paths.agents), role + '.md')}`,
      '',
    ].join('\n'));
    prompts.push({ key: d.key, role, file: pfile, findings: d.findings.length });
  }
  writeFileSync(join(recDir, 'README.md'), [
    `# Direct-recovery protocol — ${id} (from ${row.state}, fold as #${cyc}r)`,
    '',
    `1. READ the prior round: ${join(itemDir, 'feedback.md')} (the AUTHORITATIVE digest) + last-failure.md + the regate-*.md prompts here${dissent.length ? '' : ' (no structured dissent found — read last-failure.md for the fail reason)'}.`,
    `2. APPLY the reviewer-converged remedy IN THE WORKTREE (${wtAbs || '<none recorded>'}) — never the main tree; NO mutating git.`,
    '3. EVIDENCE CONTRACT (KI-E20 — the fold re-derives the verdict from these files, never from prose):',
    `   - machine green (code items): \`bash ${btAbs} build <solution> 2>&1 | tee -a ${join(itemDir, 'integrate-raw.txt')}\` then \`bash ${btAbs} suite <solution> 2>&1 | tee -a ${join(itemDir, 'integrate-raw.txt')}\` — the keyed FACTORY::SUMMARY markers (KI-E19) make append order safe.`,
    `   - probes / mutation evidence: tee to ${join(itemDir, 'mutation-proof.txt')} — NEVER into integrate-raw.txt or verify-raw.txt (keyed markers or not, keep transcripts clean).`,
    `   - a NEW red proof (only if a new regression test is part of the remedy): tee to ${join(itemDir, 'verify-red-raw.txt')} with its FACTORY::RED::<exit> marker; otherwise leave the prior round's red transcript untouched.`,
    '4. RE-GATE: run each regate-*.md as a SEPARATE agent; require APPROVED; save each verdict prose to state/items/<id>/<role>.md.',
    `5. FOLD: fill ${foldFile} (gates map = the re-gate verdicts; note = remedy + evidence pointers), then:`,
    `   node ${MOUNT_REL}/_workflow/driver.mjs fold ${foldFile}`,
    '   (attemptsDelta:0 — a recovery consumes no retry budget; resultId #' + cyc + 'r keeps fold idempotency; the deterministic fold override re-checks ALL machine evidence exactly as for a live run.)',
    '',
    row.state === 'ESCALATED' ? '_ESCALATED item: steps 2-4 may reduce to recording the human sign-off; the fold is the single CLOSED hop (KI-L62)._' : '',
  ].join('\n'));
  temit({ source: 'driver', event: 'recovery_prepared', item: id, cycle: cyc, attrs: { fromState: row.state, dissenters: prompts.map((p) => p.key), hasFeedback: existsSync(join(itemDir, 'feedback.md')), hasCheckpoint: !!prior } });
  console.log(`recover ${id} (${row.state}, cycle #${cyc}r): scaffold -> ${recDir}`);
  console.log(`  dissent digest: ${dissent.length ? dissent.map((d) => d.key + ' (' + d.findings.length + ' finding(s))').join(', ') : '(none in the checkpoint — verify/fold-stage fail; read last-failure.md)'}`);
  for (const p of prompts) console.log(`  re-gate prompt: ${p.file}`);
  console.log(`  fold skeleton:  ${foldFile}`);
  console.log(`  protocol:       ${join(recDir, 'README.md')}`);
}

// KI-E24 (improvement-analysis P7) — the owner-decision digest: ONE ranked page for the parked
// queue. Evidence: 30+ parked decisions at median age ~24 days with thorough per-item framings
// buried in a 500-line queue wall — rulings arrive only when a session hand-surfaces one. Ranking
// severity x age + a one-line reply format turns the queue into a five-minute sitting; bundles
// group same-target items so a related cluster is ruled in one pass. Read-only.
function cmdDecisionsDigest() {
  const cfg = loadConfig();
  const graph = loadGraph(abs(cfg.paths.graph));
  const ledger = loadLedger(abs(cfg.paths.ledger));
  if (!ledger) { console.log('no ledger — run init'); return; }
  const items = byId(graph);
  const sevRank = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
  const nowMs = Date.parse(now());
  const rows = [];
  for (const [id, r] of Object.entries(ledger.items)) {
    if (!['BLOCKED', 'ESCALATED'].includes(r.state)) continue;
    const wi = items[id] || {};
    const hist = (r.history || []).filter((h) => h.to === r.state);
    const enteredAt = hist.length ? hist[hist.length - 1].at : r.updatedAt;
    const ageDays = enteredAt ? Math.max(0, Math.round((nowMs - Date.parse(enteredAt)) / 86400000)) : 0;
    const decPath = abs(join(cfg.paths.items, id, 'decision.md'));
    let options = [];
    let question = wi.ownerDecision || '';
    if (existsSync(decPath)) {
      const txt = readFileSync(decPath, 'utf8');
      options = [...new Set([...txt.matchAll(/\bOption ([A-Z])\b/g)].map((m) => m[1]))];
      if (!question) { const line = txt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')); if (line) question = line; }
    }
    if (!question) question = (r.note || '').slice(0, 160);
    rows.push({ id, state: r.state, severity: wi.severity || '?', target: wi.target || '?', ageDays, question: String(question).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160), options });
  }
  rows.sort((a, b) => (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0) || b.ageDays - a.ageDays || a.id.localeCompare(b.id));
  const bySev = rows.reduce((acc, r) => { acc[r.severity] = (acc[r.severity] || 0) + 1; return acc; }, {});
  const ages = rows.map((r) => r.ageDays).sort((a, b) => a - b);
  const median = ages.length ? ages[Math.floor(ages.length / 2)] : 0;
  const byTarget = {};
  for (const r of rows) (byTarget[r.target] ||= []).push(r.id);
  const bundles = Object.entries(byTarget).filter(([, ids]) => ids.length >= 2).sort((a, b) => b[1].length - a[1].length);
  const md = [
    '# Owner-decision digest — ranked (severity x age)',
    '',
    `_Generated ${now()} · ${rows.length} parked decision(s) (${Object.entries(bySev).map(([s, n]) => n + ' ' + s).join(', ') || 'none'}) · median age ${median}d_`,
    '',
    '**Reply format — one line per ruling, paste several at once:** `<ID>: <option letter or short ruling>`' + (rows[0] ? ' (e.g. `' + rows[0].id + ': b`)' : '') + '. Full framings live in `queue/decisions.md` + `state/items/<id>/decision.md`.',
    '',
    '| # | id | sev | state | age d | target | decision (one line) | options |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | \`${r.id}\` | ${r.severity} | ${r.state} | ${r.ageDays} | ${r.target} | ${r.question} | ${r.options.join('/') || '—'} |`),
    '',
    '## Rule-together bundles (same target — one sitting)',
    '',
    bundles.length ? bundles.map(([t, ids]) => `- **${t}** (${ids.length}): ${ids.map((i) => '`' + i + '`').join(', ')}`).join('\n') : '_none_',
    '',
  ].join('\n');
  const out = abs(join(cfg.paths.reports, 'decisions-digest.md'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(`decisions-digest: ${rows.length} parked decision(s) (${Object.entries(bySev).map(([s, n]) => n + ' ' + s).join(', ') || 'none'}), median age ${median}d -> ${out}`);
  for (const r of rows.slice(0, 10)) console.log(`  ${r.severity} ${r.id} (${r.state}, ${r.ageDays}d, ${r.target})${r.options.length ? ' options ' + r.options.join('/') : ''}`);
  if (rows.length > 10) console.log(`  ... +${rows.length - 10} more in the digest`);
}

const SEV_OK = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const FIXTYPE_OK = ['mechanical', 'non-trivial', 'owner-decision', 'scope-stop'];
const TIER_OK = ['auto', 'escalate', 'blocked'];
const ID_RE = /^[A-Z0-9]+(-[A-Z0-9]+)+$/;

// KI-E27: pull work-items from an external source into state/normalized/<out>.json, which
// merge-graph then folds. Sources: --github <repo> (--issues csv | --label X [--state] [--limit]),
// --json <file> (gh-issue array OR ready work-item array, passthrough), --markdown <file> (checklist).
// I/O only — the mapping is the pure lib (ingest.mjs). Deliberately NON-mutating to the ledger: it
// writes only normalized/ (like producing a source file), so it needs no controller lease; the
// ledger-writing step stays the separately-guarded `merge-graph`. Ingested items are blocked/escalate,
// never auto (honest-acceptance invariant): ingestion seeds the queue, a human/bmad-spec authors the acceptance.
function cmdIngest(flags) {
  const cfg = loadConfig();
  const normDir = join(dirname(abs(cfg.paths.graph)), 'normalized');
  if (!existsSync(normDir)) mkdirSync(normDir, { recursive: true });

  const opts = {
    idPrefix: flags['id-prefix'] || undefined,
    target: flags.target || '',
    layer: flags.layer || undefined,
    theme: flags.theme || undefined,
    severity: flags.severity || undefined,
  };
  let items = [];
  let outName = flags.out || null;

  if (flags.github) {
    const repo = String(flags.github);
    opts.repo = repo;
    if (!opts.idPrefix) opts.idPrefix = 'GH';
    let issues = [];
    try {
      if (flags.issues) {
        for (const n of String(flags.issues).split(',').map((s) => s.trim()).filter(Boolean)) {
          const raw = execFileSync('gh', ['issue', 'view', n, '--repo', repo, '--json', 'number,title,body,labels,state'], { encoding: 'utf8' });
          issues.push(JSON.parse(raw));
        }
      } else {
        const args = ['issue', 'list', '--repo', repo, '--json', 'number,title,body,labels,state',
          '--state', String(flags.state || 'open'), '--limit', String(flags.limit || 30)];
        if (flags.label) args.push('--label', String(flags.label));
        issues = JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
      }
    } catch (e) {
      console.log(`ingest: gh failed — ${String(e.message || e).split('\n')[0]}. Is the GitHub CLI installed and authenticated (gh auth status)?`);
      return;
    }
    items = issues.map((iss) => githubIssueToItem(iss, opts));
    if (!outName) outName = 'github-' + repo.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  } else if (flags.json) {
    let arr;
    try { arr = readJson(abs(String(flags.json))); } catch (e) { console.log(`ingest: cannot read --json ${flags.json}: ${e.message}`); return; }
    if (!Array.isArray(arr)) { console.log('ingest: --json file must be a JSON array.'); return; }
    // Passthrough if the objects already carry an acceptance (ready work-items); else treat as gh issues.
    items = arr.map((o) => (o && o.acceptance ? o : githubIssueToItem(o, opts)));
    if (!outName) outName = basename(String(flags.json)).replace(/\.json$/i, '') || 'json';
  } else if (flags.markdown) {
    let md;
    try { md = readFileSync(abs(String(flags.markdown)), 'utf8'); } catch (e) { console.log(`ingest: cannot read --markdown ${flags.markdown}: ${e.message}`); return; }
    items = markdownChecklistToItems(md, { ...opts, sourceName: basename(String(flags.markdown)) });
    if (!outName) outName = basename(String(flags.markdown)).replace(/\.(md|markdown)$/i, '') || 'markdown';
  } else {
    console.log('ingest: pick a source — --github <owner/repo> [--issues 1,2 | --label bug --state open --limit N], --json <file>, or --markdown <file>. Optional: --out <name> --id-prefix P --target T --theme X --severity S.');
    return;
  }

  if (!items.length) { console.log('ingest: 0 item(s) produced (nothing matched the source).'); return; }
  const outPath = join(normDir, `${outName}.json`);
  writeJsonAtomic(outPath, items);
  const rep = ingestReport(items);
  console.log(`ingest: ${rep.total} item(s) -> ${toPosix(relative(REPO_ROOT, outPath))}`);
  console.log(`  by severity: ${JSON.stringify(rep.bySeverity)}`);
  console.log(`  ${rep.escalate} escalate (acceptance section found — review + confirm), ${rep.blocked} blocked-triage (author acceptance + regressionTest + files[] first). None are auto-runnable by design.`);
  console.log(`  next: node <mount>/_workflow/driver.mjs merge-graph   (the guarded, ledger-writing step — folds every normalized/*.json into the findings-graph)`);
}

// Merge state/normalized/*.json into findings-graph.json with validation + dedup.
function cmdMergeGraph(flags) {
  const cfg = loadConfig();
  const normDir = join(dirname(abs(cfg.paths.graph)), 'normalized');
  if (!existsSync(normDir)) { console.log('no normalized dir yet:', normDir); return; }
  const files = readdirSync(normDir).filter((f) => f.endsWith('.json'));
  const items = [];
  const seen = new Set();
  const problems = [];
  for (const f of files) {
    let arr;
    try { arr = readJson(join(normDir, f)); } catch (e) { problems.push(`${f}: invalid JSON (${e.message})`); continue; }
    if (!Array.isArray(arr)) { problems.push(`${f}: not a JSON array`); continue; }
    for (const wi of arr) {
      const errs = [];
      if (!wi.id || !ID_RE.test(wi.id)) errs.push('bad id');
      if (seen.has(wi.id)) errs.push('duplicate id');
      if (!SEV_OK.includes(wi.severity)) errs.push('bad severity');
      if (!FIXTYPE_OK.includes(wi.fixType)) errs.push('bad fixType');
      if (!Array.isArray(wi.files)) errs.push('files not array');
      if (!wi.acceptance) errs.push('no acceptance');
      if (!wi.regressionTest) errs.push('no regressionTest');
      if (errs.length) { problems.push(`${f}:${wi.id || '?'} — ${errs.join(', ')}`); continue; }
      seen.add(wi.id);
      items.push({
        id: wi.id, target: wi.target || f.replace(/\.json$/, ''), layer: wi.layer || 'service',
        title: wi.title || wi.id, severity: wi.severity, theme: wi.theme || 'doc-drift',
        fixType: wi.fixType, files: wi.files, dependsOn: Array.isArray(wi.dependsOn) ? wi.dependsOn : [],
        ownerDecision: wi.ownerDecision ?? null, ownerDecisionResolved: wi.ownerDecisionResolved === true ? true : undefined, // KI-L59: resolved-ruling flag survives merges (undefined → dropped by JSON.stringify)
        acceptance: wi.acceptance, regressionTest: wi.regressionTest,
        realInfra: !!wi.realInfra, gateSet: Array.isArray(wi.gateSet) && wi.gateSet.length ? wi.gateSet : cfg.gateSet,
        autonomyTier: TIER_OK.includes(wi.autonomyTier) ? wi.autonomyTier : 'auto',
        source: wi.source || '', fixHint: wi.fixHint || '', cascade: Array.isArray(wi.cascade) ? wi.cascade : [],
      });
    }
  }
  // Validate dependsOn references resolve (warn, don't drop).
  const ids = new Set(items.map((w) => w.id));
  for (const w of items) for (const d of w.dependsOn) if (!ids.has(d)) problems.push(`${w.id}: dangling dep ${d}`);
  // Detect dependsOn CYCLES — computeReady would never schedule a cycle (each item waits on another
  // forever) and the items would silently sit READY-but-blocked with no error. Surface them as problems.
  const adj = Object.fromEntries(items.map((w) => [w.id, (w.dependsOn || []).filter((d) => ids.has(d))]));
  const color = {}; // undefined=unvisited, 1=on-stack, 2=done
  const cycles = new Set();
  const dfs = (u, stack) => {
    color[u] = 1; stack.push(u);
    for (const v of adj[u] || []) {
      if (color[v] === 1) cycles.add(stack.slice(stack.indexOf(v)).concat(v).join(' -> '));
      else if (!color[v]) dfs(v, stack);
    }
    stack.pop(); color[u] = 2;
  };
  for (const id of Object.keys(adj)) if (!color[id]) dfs(id, []);
  for (const c of cycles) problems.push(`dependsOn CYCLE: ${c}`);
  const graph = { generatedAt: now(), source: cfg.auditRoot, count: items.length, items };
  writeJsonAtomic(abs(cfg.paths.graph), graph);
  const bySev = items.reduce((a, w) => { a[w.severity] = (a[w.severity] || 0) + 1; return a; }, {});
  console.log(`merge-graph: ${items.length} item(s) from ${files.length} file(s) -> ${cfg.paths.graph}`);
  console.log('by severity:', JSON.stringify(bySev));
  if (problems.length) { console.log(`problems (${problems.length}):`); for (const p of problems.slice(0, 40)) console.log('  -', p); }
  if (!flags['no-init']) {
    const ledger = loadLedger(abs(cfg.paths.ledger)) || emptyLedger(cfg.paths.graph);
    syncFromGraph(ledger, graph);
    writeJsonAtomic(abs(cfg.paths.ledger), ledger);
    writeReports(cfg, ledger, graph);
    console.log('ledger synced:', JSON.stringify(countByState(ledger)));
  }
}

// ---- KI-C11: session-controller lease --------------------------------------------------------
function controllerPath(cfg) { return abs((cfg.paths && cfg.paths.controller) || '_bmad-output/ai-factory/state/controller.json'); }
function controllerTtl(cfg) { return (cfg.controller && cfg.controller.ttlMinutes) || DEFAULT_TTL_MINUTES; }
function controllerToken(flags) {
  if (typeof flags.controller === 'string' && flags.controller) return flags.controller;
  if (process.env.FACTORY_CONTROLLER) return process.env.FACTORY_CONTROLLER;
  return null;
}

// The campaign lease gate for every mutating command (runs INSIDE the advisory file lock, so two
// simultaneous claims cannot race controller.json). Free/stale lease -> auto-claim and print the
// token ONCE; matching token -> heartbeat; FRESH foreign lease or bare command -> refuse loudly
// with recovery instructions. Returns true when the command may proceed.
function requireController(cmd, flags) {
  const cfg = loadConfig();
  const path = controllerPath(cfg);
  const ttl = controllerTtl(cfg);
  const token = controllerToken(flags);
  const v = verifyController(path, token, now(), ttl);
  if (v.ok) return true;
  if (v.reason === 'none' || v.reason === 'stale') {
    const c = claimController(path, { token, label: 'driver:' + cmd, nowIso: now(), ttlMinutes: ttl, force: true });
    console.log(`controller: lease ${v.reason === 'stale'
      ? `TAKEN OVER (previous '${v.holder && v.holder.label}' heartbeat ${v.holder && v.holder.heartbeatAt} is past the ${ttl}-min TTL)`
      : 'claimed'} — token ${c.controller.token}. Pass --controller ${c.controller.token} (or FACTORY_CONTROLLER=${c.controller.token}) on every subsequent mutating command this session (KI-C11: ONE session owns the factory).`);
    return true;
  }
  console.error(`refusing '${cmd}': the factory lease is held by another LIVE controller — label '${v.holder.label}', acquired ${v.holder.acquiredAt}, heartbeat ${v.holder.heartbeatAt} (TTL ${ttl}min). KI-C11: ONE session owns the factory — stand down and do read-only work.`);
  console.error(`  If that controller is THIS session: re-run with --controller <token> (printed at claim; recover it via 'driver.mjs controller status').`);
  console.error(`  If it is a zombie/foreign session: verify with 'ps aux | grep claude', have the USER kill it, then 'driver.mjs controller claim --force'.`);
  process.exitCode = 1;
  return false;
}

function cmdController(flags, rest) {
  const cfg = loadConfig();
  const path = controllerPath(cfg);
  const ttl = controllerTtl(cfg);
  const sub = rest[0] || 'status';
  if (sub === 'status') {
    const cur = loadController(path);
    if (!cur) { console.log('controller: FREE (no lease) — the next mutating driver command auto-claims it'); return; }
    const stale = controllerStale(cur, now(), ttl);
    console.log(`controller: ${stale ? 'STALE' : 'LIVE'} lease — label '${cur.label}', token ${cur.token}, acquired ${cur.acquiredAt}, heartbeat ${cur.heartbeatAt}${stale ? ` (past the ${ttl}-min TTL — the next mutating command takes over)` : ''}`);
    return;
  }
  if (sub === 'claim') {
    const token = controllerToken(flags);
    const label = typeof flags.label === 'string' ? flags.label : 'controller';
    const r = claimController(path, { token, label, nowIso: now(), ttlMinutes: ttl, force: !!flags.force });
    if (!r.ok) {
      console.error(`controller: claim REFUSED — LIVE lease held by '${r.holder.label}' (heartbeat ${r.holder.heartbeatAt}). Verify it is dead ('ps aux | grep claude', the USER kills it), then re-run with --force.`);
      process.exitCode = 1;
      return;
    }
    console.log(`controller: ${r.takeover ? 'TAKEN OVER' : 'claimed'} — token ${r.controller.token} (label '${r.controller.label}'). Pass --controller ${r.controller.token} on every mutating command this session.`);
    return;
  }
  if (sub === 'release') {
    const token = controllerToken(flags);
    if (!token) { console.error('controller: release requires --controller <token> (never release a lease you cannot prove you hold)'); process.exitCode = 1; return; }
    if (releaseController(path, token)) console.log('controller: lease released — the factory is FREE for the next session');
    else { console.error('controller: release no-op — no lease, or the token does not match the holder'); process.exitCode = 1; }
    return;
  }
  // AD-7 (ai-factory-observability spine): heartbeat = refresh-in-place for a LONG watch (the
  // orchestrator's checkpoint-watch spans hours with no mutating command; without this the lease
  // goes TTL-stale mid-campaign and a second session silently auto-claims). Requires the holder's
  // token; refresh via claimController's same-token path. A free/stale lease re-claims under the
  // presented token (the orchestrator re-establishes its own lease); a FRESH foreign lease refuses.
  if (sub === 'heartbeat') {
    const token = controllerToken(flags);
    if (!token) { console.error('controller: heartbeat requires --controller <token>'); process.exitCode = 1; return; }
    const r = claimController(path, { token, label: typeof flags.label === 'string' ? flags.label : 'orchestrator', nowIso: now(), ttlMinutes: ttl, force: false });
    if (!r.ok) { console.error(`controller: heartbeat REFUSED — LIVE lease held by '${r.holder.label}' (token mismatch). Stand down.`); process.exitCode = 1; return; }
    console.log(`controller: heartbeat ok — token ${r.controller.token}${r.takeover ? ' (re-claimed a free/stale lease)' : ''}`);
    return;
  }
  console.log('controller subcommands: status (default) | claim [--label X] [--force] | release --controller <token> | heartbeat --controller <token>');
}

// KI-E7 / spine AD-9: the evaluation path reads events.jsonl directly (full fidelity — never
// Prometheus aggregates) and renders reports/telemetry-latest.md. Read-only; no lock needed.
function cmdTelemetryReport(flags) {
  const cfg = loadConfig();
  const file = telemetryFile();
  const events = readEvents(file, { limit: flags.limit ? parseInt(flags.limit, 10) : 0 });
  const agg = aggregateEvents(events);
  const md = renderTelemetryReport(agg, { file, generatedAt: now() });
  const out = abs(join(cfg.paths.reports, 'telemetry-latest.md'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(`telemetry-report: ${events.length} event(s) from ${file}`);
  console.log(`  by source: ${JSON.stringify(agg.bySource)}`);
  console.log(`  outcomes:  ${JSON.stringify(agg.outcomes)}`);
  console.log(`  -> ${out}`);
}

function dispatch(cmd, flags, rest) {
  switch (cmd) {
    case 'init': return cmdInit(flags);
    case 'status': return cmdStatus();
    case 'select': return cmdSelect(flags);
    case 'claim': return cmdClaim(rest);
    case 'reset': return cmdReset(rest);
    case 'fold': return cmdFold(rest[0], flags);
    case 'reconstruct': return cmdReconstruct(flags); // KI-L40 — rebuild results-cycle-<N>.json from per-item checkpoints after a kill
    case 'recover': return cmdRecover(flags, rest); // KI-E20 — direct-recovery scaffold (dissent digest + re-gate prompts + evidence contract + fold skeleton)
    case 'decisions-digest': return cmdDecisionsDigest(); // KI-E24 — ranked owner-decision digest (severity x age + one-line reply format)
    case 'realinfra-lint': return cmdRealinfraLint(); // KI-L42 — report realInfra=true items with no .cs (KI-L38 false-fail shape)
    case 'resume': return cmdResume(flags);
    case 'progress': return cmdReport('progress');
    case 'burndown': return cmdReport('burndown');
    case 'cost': return cmdReport('cost');
    case 'escalations': { const cfg = loadConfig(); return cmdEscalationsSync(cfg, loadLedger(abs(cfg.paths.ledger))); }
    case 'ingest': return cmdIngest(flags); // KI-E27 — pull issues from github/json/markdown into state/normalized/
    case 'merge-graph': return cmdMergeGraph(flags);
    case 'group': return cmdGroup(flags);
    case 'suggest': return cmdSuggest(flags); // similar-batch planning (read-only; owner directive 2026-07-04)
    case 'cycle': return cmdCycle(flags);
    case 'gc': return cmdGc(flags);
    case 'graph-audit': return cmdGraphAudit(flags);
    case 'preflight': return cmdPreflight();
    case 'sweep': return cmdSweep(flags, rest);
    case 'sweep-fold': return cmdSweepFold(rest[0]);
    case 'report-cycle': return cmdReportCycle();
    case 'worktree-add': case 'worktree-remove': case 'worktree-list': return cmdWorktree(cmd, rest);
    case 'controller': return cmdController(flags, rest); // KI-C11 — lease management: status | claim | release | heartbeat
    case 'telemetry-report': return cmdTelemetryReport(flags); // KI-E7 / spine AD-9 — evaluation report from events.jsonl
    default:
      console.log('commands: init | status | select | claim | reset | fold | reconstruct | recover | resume | progress | burndown | cost | escalations | decisions-digest | group | suggest | cycle | sweep | sweep-fold | gc | preflight | graph-audit | realinfra-lint | report-cycle | ingest | merge-graph | controller | telemetry-report | worktree-add|remove|list');
  }
}

function main() {
  const [, , cmd, ...argv] = process.argv;
  const { flags, rest } = parseFlags(argv);
  // KI-B2/B3: a single advisory lock around every ledger-MUTATING command — a second concurrent driver
  // fails fast with a clear message instead of silently racing ledger.json. Read-only commands skip it.
  // 'controller' is lock-guarded too (its claim/release mutate controller.json under the same lock).
  const MUTATING = new Set(['init', 'claim', 'reset', 'fold', 'group', 'cycle', 'sweep', 'sweep-fold', 'merge-graph', 'gc', 'controller']);
  const needsLock = MUTATING.has(cmd) || (cmd === 'resume' && flags['reset-stale']);
  let lockPath = null;
  if (needsLock) {
    lockPath = abs(loadConfig().paths.ledger) + '.lock';
    const lock = acquireLock(lockPath, now());
    if (!lock.ok) {
      console.error(`refusing '${cmd}': ledger locked by pid ${lock.heldBy}${lock.since ? ' since ' + lock.since : ''} (another driver running?). If stale, delete ${lockPath}`);
      process.exitCode = 1;
      return;
    }
  }
  const t0 = Date.now();
  let cmdThrew = false;
  try {
    // KI-C11: every mutating command (except the lease manager itself) must hold the campaign lease —
    // the per-command lock above serializes single commands; the lease serializes the CAMPAIGN.
    if (needsLock && cmd !== 'controller' && !requireController(cmd, flags)) return;
    dispatch(cmd, flags, rest);
  }
  catch (e) { cmdThrew = true; throw e; }
  finally {
    if (lockPath) releaseLock(lockPath);
    // KI-E7: every driver action is a telemetry event (spine AD-2 source:driver — authoritative).
    // Review finding #4 / AD-3 content rule: the lease token must never land in the stream.
    if (cmd) temit({ source: 'driver', event: 'driver_cmd', durMs: Date.now() - t0, outcome: (cmdThrew || process.exitCode) ? 'error' : 'ok', attrs: { cmd, args: argv.slice(0, 10).join(' ').replace(/(--controller[= ])\S+/g, '$1<redacted>').slice(0, 300) } });
  }
}

main();
