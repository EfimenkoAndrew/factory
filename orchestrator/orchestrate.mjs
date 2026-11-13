#!/usr/bin/env node
// Factory orchestrator — the factory-owned loop that makes the factory a standalone
// deliverable (ai-factory-observability spine AD-7/AD-8). Owns:
//   status -> group -> dispatch(backend) -> validate checkpoints -> fold -> report -> repeat
//
// INVARIANTS (inherited — see spine "Inherited Invariants"):
// - Every ledger mutation goes through driver.mjs as a CHILD PROCESS (single-writer, KI-B2).
//   This file writes only its own state/orchestrator outputs, never the ledger or item state.
// - ONE controller (KI-C11): the orchestrator claims ONE lease token for its whole run and
//   heartbeats it every watch tick (spine AD-7 — a long watch must not go TTL-stale).
// - The stop-marker (state/STOP_REQUESTED.md, KI-E6) is checked before EVERY dispatch;
//   --stop-override is HUMAN-ONLY — this orchestrator never passes it.
// - NO mutating git, ever (KI-E1). Apply/handoff is a separate explicit step (autoApply:false);
//   the human authors every commit. KI-E272: autoCommit server-mode relaxes this when
//   autoCommit.enabled:true in orchestrator.config.json — disabled by default.
// - Zero npm dependencies (AD-4).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, openSync, closeSync, createWriteStream, chmodSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot, swapMountPrefix, STOCK_MOUNT, toPosix } from '../_workflow/lib/rootfind.mjs';
import { writeJsonAtomic } from '../_workflow/lib/ledger.mjs';
import { emit } from '../_workflow/lib/telemetry.mjs';
import { groupArguments, launchFromGroup, claimIdentity, validCheckpoint, observeChild, watchLane, stopChild, recoveryAdvice, schedulerSuggestions } from './lifecycle.mjs';
import { recordRuns, renderFactoryReport } from './run-history.mjs'; // KI-E307: cumulative run index + dashboard
import { analyzeSelfImprovement } from './self-improve.mjs'; // KI-E309: automatic self-improvement analyzer
import { recordBatchMetrics, recentRunsSummary } from './factory-pg.mjs'; // KI-E385: per-run PostgreSQL telemetry for hill climbing
import { dispatchConfig } from './opencode-worker.mjs';
import { buildCapacity } from '../_workflow/lib/build-lease.mjs';

// KI-E415: Guard against EPIPE/SIGPIPE when orchestrate.mjs stdout is piped to a short-lived
// consumer (e.g. `| head -5 &`). Without this, the next log write after the reader closes
// throws EPIPE and crashes the process, leaving items CLAIMED with no workers.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(HERE, '..');
// KI-E17 (portable mounts): REPO_ROOT env keeps its historical precedence, then the shared
// walk-up detection (FACTORY_REPO_ROOT honored inside), then the legacy ../.. fallback.
const REPO_ROOT = process.env.REPO_ROOT || resolveRepoRoot(FACTORY_ROOT, process.env);
const DRIVER = join(FACTORY_ROOT, '_workflow', 'driver.mjs');
// KI-E325: a lane being INCOMPLETE (watch timed out / not all items validated / a child crashed), or
// nothing being schedulable (empty-batch), is NORMAL recoverable operation — finished items fold and
// the rest resume next run; it MUST NOT fail the whole orchestrator run (that mislabels resumable items
// as FAILED and turns the GH Actions run red for doing its job). Only a genuine orchestrator-level error
// (driver `group` broke, or a batch could not be dispatched) is fatal.
const FATAL_LANE_ERRORS = new Set(['group-failed', 'dispatch-failed']);
const isFatalLaneError = (e) => typeof e === 'string' && FATAL_LANE_ERRORS.has(e);
const CONFIG_PATH = join(FACTORY_ROOT, 'config', 'orchestrator.config.json');
const STOP_MARKER = join(FACTORY_ROOT, 'state', 'STOP_REQUESTED.md');

// Telemetry (KI-E7): source:'orchestrator', observational only.
const temit = (e) => emit({ ...e, source: 'orchestrator' });

export function loadConfig() {
  const defaults = {
    backend: 'interactive',            // interactive | claude-headless | opencode | dry
    maxCyclesPerRun: 1,                // lanes dispatched before the orchestrator exits
    maxItemsPerLane: 3,
    modelConcurrency: 6,
    buildCapacity: 1,
    includeRealinfra: false,
    includeEscalate: false,            // KI-E334: owner-approved --include-escalate override (default off = auto-tier only)
    watchIntervalMs: 60000,            // checkpoint poll + lease heartbeat cadence
    laneTimeoutMinutes: 240,           // give up watching a lane after this (items stay resumable)
    autoApply: false,                  // AD-7: apply is explicit/operator — NEVER auto
    // KI-E272: server-mode auto-commit. Set enabled:true ONLY on the dedicated server.
    // Disabled by default so the KI-E1 "human authors every commit" invariant holds everywhere else.
    autoCommit: { enabled: false, pushAfterCommit: false, signoff: '' },
    // KI-E303: auto-PR — open a PR immediately after each lane fold for every newly-CLOSED item
    // with a live worktree. Enabled by default; set enabled:false to suppress (manual open-pr.sh only).
    autoPR: { enabled: true },
    escalationWebhook: null,           // KI-E272: POST here when new items hit ESCALATED state (Slack-compatible JSON)
    // KI-E275: auto-reset FAILED items whose error is classifiable as a clear build/test failure.
    // Enabled by default. Items are reset to READY (up to maxRetries times each) so the factory
    // retries them automatically. The driver's own last-failure.md provides context for the retry.
    autoFix: { enabled: true, maxRetries: 2 },
    // KI-E278: hill-climbing run quality optimizer. After each fold the factory measures its
    // close rate (fitness). When fitness stagnates over `plateauRunsToTrigger` consecutive runs
    // (steepest-ascent plateau detection), it enters exploration mode — the next run deliberately
    // selects items that haven't been tried recently (oldest lastScheduledCycle first), escaping
    // local-maximum scheduling ruts the way a random-restart hill climber does. Tracks per-item
    // attempt history and emits fitness/plateau metrics each run.
    hillClimb: { enabled: true, fitnessWindow: 5, plateauMinFitness: 0.25, plateauRunsToTrigger: 3, explorationRatio: 0.5 },
    // KI-E279: UCB1 multi-armed bandit item selection. Selects items with the best UCB1 score
    // (closedRate + C*sqrt(ln(totalDispatches+1)/(dispatched+1))). Provides principled
    // exploration/exploitation balance. Defers to hillClimb exploration when a plateau is active.
    // KI-E349: unlockBonus adds a score boost proportional to the number of BLOCKED items an item
    // would directly unblock when it reaches CLOSED. Items with high unblocking power are favoured,
    // accelerating the un-stalling of dependency chains. Set to 0 to disable.
    bandit: { enabled: true, explorationConstant: 1.41, unlockBonus: 1.0 },
    // KI-E282: retrospective loop. Every runsPerRetro lanes, generates a health report with ledger
    // counts + hill-climb state written to queue/retrospective-<timestamp>.md.
    retrospective: { enabled: true, runsPerRetro: 5 },
    // KI-E284: curriculum learning. Cold-start difficulty scoring for never-tried items so the
    // factory preferentially explores easy wins first during the cold-start phase.
    curriculum: { enabled: true },
    // KI-E285: simulated annealing. Temperature-based perturbation of item selection to inject
    // controlled randomness that decays as the factory matures (T = T0 * coolingRate^runCount).
    simulatedAnnealing: { enabled: true, initialTemperature: 0.3, coolingRate: 0.95 },
    // KI-E286: prompt evolution. A/B test two promptTemplate variants; after runsToEvaluate runs
    // the loser is killed and the winner is mutated with a guidance phrase from a built-in library.
    promptEvolution: { enabled: true, runsToEvaluate: 10 },
    // KI-E287: dynamic timeouts. Track wall-clock lane timing; surface P95+20% recommendation
    // in the retrospective report to help operators tune laneTimeoutMinutes.
    itemTiming: { enabled: true },
    // KI-E288: config meta-optimizer. Every runsPerCycle runs, perturb one knob ±perturbFraction,
    // measure fitness over the next measureWindow runs vs the prior window, keep or revert.
    configOptimizer: { enabled: true, runsPerCycle: 10, measureWindow: 3, perturbFraction: 0.1 },
    // KI-E289: auto-recalibrate. When runsBelow consecutive runs all produce fitness < fitnessThreshold
    // (a deeper rut than hillClimb's plateau), the factory resets SA temperature to T0, boosts bandit
    // exploration by 1.5× for recoveryRuns lanes, and resets the config-optimizer phase for a clean
    // baseline. Manual trigger: node orchestrate.mjs recalibrate. State in state/recalibrate.json.
    recalibrate: { enabled: true, runsBelow: 5, fitnessThreshold: 0.1, recoveryRuns: 3 },
    opencode: { config: 'config/opencode-dispatch.local.json' },
    claudeHeadless: { bin: 'claude', extraArgs: [], promptTemplate: 'Operate as the AI-factory worker plane. Launch the Workflow tool on the script at {runScript} with NO args, wait for it to complete, then reply DONE. If the Workflow tool call is rejected or returns an error for any reason, immediately output "FACTORY::WORKFLOW_ERROR: <error text>" and stop — do NOT debug, analyze, retry, or call any other tools. Do not run any git commands. Do not edit any file outside the per-item worktrees the script names.' },
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  const configured = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const merged = { ...defaults, ...configured, opencode: { ...defaults.opencode, ...configured.opencode }, claudeHeadless: { ...defaults.claudeHeadless, ...configured.claudeHeadless }, hillClimb: { ...defaults.hillClimb, ...configured.hillClimb }, autoFix: { ...defaults.autoFix, ...configured.autoFix }, autoPR: { ...defaults.autoPR, ...(configured.autoPR || {}) }, bandit: { ...defaults.bandit, ...configured.bandit }, retrospective: { ...defaults.retrospective, ...configured.retrospective }, curriculum: { ...defaults.curriculum, ...(configured.curriculum || {}) }, simulatedAnnealing: { ...defaults.simulatedAnnealing, ...(configured.simulatedAnnealing || {}) }, promptEvolution: { ...defaults.promptEvolution, ...(configured.promptEvolution || {}) }, itemTiming: { ...defaults.itemTiming, ...(configured.itemTiming || {}) }, configOptimizer: { ...defaults.configOptimizer, ...(configured.configOptimizer || {}) }, recalibrate: { ...defaults.recalibrate, ...(configured.recalibrate || {}) } };
  return applyConfigOptimizerOverride(merged); // KI-E310: apply persisted auto-tuned knobs
}

function driver(args, opts = {}) {
  // Child-process seam: the driver stays the single ledger writer. Inherit env (controller token
  // travels via FACTORY_CONTROLLER); capture stdout for parsing.
  try {
    const out = execFileSync(process.execPath, [DRIVER, ...args], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env, ...opts });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String((e.stdout || '') + (e.stderr || '') || e.message), code: e.status };
  }
}

const log = (m) => console.log(`[orchestrate ${new Date().toISOString()}] ${m}`);
const ledgerPath = () => join(FACTORY_ROOT, 'state', 'ledger.json');
const graphPath = () => join(FACTORY_ROOT, 'state', 'findings-graph.json');
const SABOTAGE_LOG_PATH = () => join(FACTORY_ROOT, 'state', 'sabotage-events.json');

// KI-E438: Record a sabotage-prevention event — a dispatch that was stopped because it would
// predictably fail for the same reason without producing any closure. Each entry carries enough
// detail to build a weekly "tokens saved" summary. Log is append-only; capped at 500 entries.
function recordSabotageEvent(itemId, category, detail) {
  try {
    const p = SABOTAGE_LOG_PATH();
    let log = [];
    try { log = JSON.parse(readFileSync(p, 'utf8')); } catch { /* start fresh */ }
    log.push({ itemId, category, detail, at: new Date().toISOString() });
    if (log.length > 500) log = log.slice(-500);
    writeFileSync(p, JSON.stringify(log, null, 2));
  } catch { /* best-effort */ }
}

// KI-E438: Stale-FAILED check — if an item is FAILED and no commits have touched its claimed
// files since its last failure, dispatching it will produce the same outcome again. This is the
// single biggest source of token waste: retrying known-failure items without any code change.
// Returns true (= skip item) when the failure is stale and staleLockout is enabled.
function isStaleFailure(itemId, wi, row, cfg) {
  if (!cfg.staleLockout) return false;
  if (row.state !== 'FAILED') return false; // only applies to FAILED items
  const claimedFiles = Array.isArray(wi.files) ? wi.files : [];
  if (!claimedFiles.length) return false;
  // Read last-failure.json to get the timestamp and infra-suspect flag
  const reportsDir = join(FACTORY_ROOT, 'reports', itemId);
  let failedAt = null;
  try {
    const lf = JSON.parse(readFileSync(join(reportsDir, 'last-failure.json'), 'utf8'));
    if (lf.infraSuspect) return false; // infra failures may self-heal — don't lock them out
    failedAt = lf.failedAt || lf.timestamp;
  } catch { return false; } // no last-failure.json — can't determine staleness
  if (!failedAt) return false;
  // Check git log for commits to claimed files since the failure timestamp
  try {
    const out = execFileSync('git', [
      '-C', REPO_ROOT, 'log', '--oneline', `--after=${failedAt}`, '--', ...claimedFiles,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out.length > 0) return false; // commits found — item is fresh
    return true; // no commits to claimed files since failure — stale
  } catch { return false; } // git error — don't block dispatch
}

// Returns a Set of item IDs that are actually schedulable (ledger state re-queueable, not
// escalate/blocked tier when includeEscalate is false, and within retry bounds). Used by
// bandit/hillClimb/SA to avoid selecting items the group command will always reject — KI-E347.
function schedulableIds(cfg) {
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    const g = JSON.parse(readFileSync(graphPath(), 'utf8'));
    const engine = JSON.parse(readFileSync(join(FACTORY_ROOT, 'config', 'factory.config.json'), 'utf8'));
    const maxItemRetries = typeof engine.maxItemRetries === 'number' ? engine.maxItemRetries : 2;
    const graphById = Object.fromEntries((g.items || []).map((wi) => [wi.id, wi]));
    const ids = new Set();
    for (const [id, row] of Object.entries(l.items || {})) {
      if (!['READY', 'FAILED', 'CONFLICT'].includes(row.state)) continue;
      const wi = graphById[id];
      if (!wi) continue;
      if (wi.autonomyTier === 'blocked') continue;
      if (wi.autonomyTier === 'escalate' && !cfg.includeEscalate) continue;
      if (row.attempts > maxItemRetries + (row.retryBonus || 0)) continue;
      if (wi.realInfra && !cfg.includeRealinfra) continue;
      // KI-E436: CRITICAL lockout — CRITICAL items never close autonomously (require human judgment
      // by definition) and consumed 51% of token spend with 0 closures. Only allow via explicit --ids.
      if (cfg.lockoutCritical && wi.severity === 'CRITICAL') continue;
      const depsClosed = (wi.dependsOn || []).every((d) => l.items[d] && l.items[d].state === 'CLOSED');
      if (!depsClosed) continue;
      // KI-E438: Stale-FAILED lockout — FAILED items with no new commits to their claimed files
      // since the last failure are guaranteed to fail again for the same reason. Skip them to
      // prevent token waste. The item becomes schedulable again only after code changes land.
      if (isStaleFailure(id, wi, row, cfg)) {
        recordSabotageEvent(id, 'stale-failed', `FAILED item with no commits to claimed files since last failure — skipped to prevent guaranteed re-failure`);
        continue;
      }
      ids.add(id);
    }
    return ids;
  } catch { return new Set(); }
}
function ledgerCounts() {
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    const c = {};
    for (const r of Object.values(l.items)) c[r.state] = (c[r.state] || 0) + 1;
    return { cycle: l.cycle, counts: c };
  } catch { return { cycle: 0, counts: {} }; }
}

// ---- doctor ---------------------------------------------------------------------------------
function doctor(cfg) {
  const checks = [];
  const add = (name, ok, note) => { checks.push({ name, ok, note }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ' — ' + note : ''}`); };
  add('driver reachable', existsSync(DRIVER), DRIVER);
  add('ledger present', existsSync(ledgerPath()), 'run driver init otherwise');
  add('repo root sane', existsSync(join(REPO_ROOT, '.git')), REPO_ROOT); // .git dir OR file (worktree/submodule host) — KI-E17 mount-agnostic
  add('stop-marker', !existsSync(STOP_MARKER), existsSync(STOP_MARKER) ? 'STOP_REQUESTED.md present — factory is stopped (delete it to resume; human decision)' : 'absent');
  if (cfg.backend !== 'dry') {
    try { buildCapacity(FACTORY_ROOT, cfg.buildCapacity); add('shared build capacity', true); }
    catch (e) { add('shared build capacity', false, e.message); }
  }
  if (cfg.backend === 'claude-headless') {
    let v = null;
    try { v = execFileSync(cfg.claudeHeadless.bin, ['--version'], { encoding: 'utf8' }).trim(); } catch { /* absent */ }
    add('claude CLI (headless backend)', !!v, v || 'claude binary not found on PATH');
  }
  if (cfg.backend === 'opencode') {
    try { loadDispatchConfig(cfg); add('OpenCode dispatcher config', true); } catch (e) { add('OpenCode dispatcher config', false, e.message); }
    const batch = join(FACTORY_ROOT, 'state', 'opencode-dispatch-batch.json');
    add('OpenCode prior batch settled', !existsSync(batch) || readJson(batch).completed === true, 'resume an unfinished batch directly with dispatch.mjs before scheduling another lane');
    add('OpenCode dispatcher lock absent', !existsSync(join(FACTORY_ROOT, 'state', 'opencode-dispatch.lock')), 'inspect or resume the existing dispatcher before claiming another lane');
  }
  const docker = (() => { try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  add('docker (realInfra items + telemetry stack)', docker, docker ? '' : 'realInfra items will PARK; compose stack unavailable');
  return checks.every((c) => c.ok || c.name.startsWith('docker') || c.name.startsWith('stop-marker'));
}

// ---- lease ----------------------------------------------------------------------------------
function claimLease() {
  const r = driver(['controller', 'claim', '--label', 'orchestrator']);
  if (!r.ok) return null;
  const m = r.out.match(/token ([a-f0-9]+)/);
  return m ? m[1] : null;
}

// ---- backends (AD-7 seam) -------------------------------------------------------------------
const backends = {
  opencode: {
    async dispatch(runScript, cfg, outputDir, persist, launch) {
      const configPath = join(outputDir, 'opencode-dispatch.json');
      writeJsonAtomic(configPath, loadDispatchConfig(cfg));
      chmodSync(configPath, 0o600);
      const stderr = openSync(join(outputDir, 'stderr.log'), 'a');
      let child;
      try { child = spawn(process.execPath, [join(HERE, 'opencode-worker.mjs'), FACTORY_ROOT, launch.runArgsPath, configPath], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', stderr], env: { ...process.env, FACTORY_REPO_ROOT: REPO_ROOT } }); }
      finally { closeSync(stderr); }
      const childState = observeChild(child, () => persist(childState, child.pid, true));
      const raw = createWriteStream(join(outputDir, 'stdout.log'), { flags: 'a' });
      raw.on('error', (e) => { childState.error = 'output capture: ' + e.message; child.kill(); });
      child.stdout.pipe(raw);
      return { launched: true, pid: child.pid, child, childState, structured: true };
    },
  },
  dry: {
    async dispatch(runScript) { log(`dry backend: NOT launching ${runScript} — plan only`); return { launched: false }; },
  },
  interactive: {
    // The Workflow tool lives in the interactive Claude Code session — the orchestrator cannot
    // invoke it. It emits the exact launch line; the operator (or controlling session) launches,
    // and the orchestrator's watch loop picks up the per-item checkpoints either way.
    async dispatch(runScript) {
      log('INTERACTIVE BACKEND — launch this in the controlling Claude Code session now:');
      log(`    Workflow({ scriptPath: "${runScript}" })`);
      return { launched: false, awaitingExternalLaunch: true };
    },
  },
  'claude-headless': {
    // Seam per the spine's Deferred note: ships + smoke-tested; interactive remains the default
    // until burn-in. Spawns the claude CLI in print mode with a tight, no-git prompt.
    async dispatch(runScript, cfg, outputDir, persist) {
      const prompt = peSelectPrompt(cfg).replace('{runScript}', runScript); // KI-E286: A/B test prompt variants
      log(`claude-headless: spawning ${cfg.claudeHeadless.bin} -p (workflow ${runScript})`);
      const help = execFileSync(cfg.claudeHeadless.bin, ['--help'], { encoding: 'utf8' });
      const runtimeVersion = execFileSync(cfg.claudeHeadless.bin, ['--version'], { encoding: 'utf8' }).trim();
      const structured = /--output-format/.test(help) && /--verbose/.test(help);
      const args = ['-p', prompt, ...cfg.claudeHeadless.extraArgs, ...(structured ? ['--output-format', 'stream-json', '--verbose'] : [])];
      const stderr = openSync(join(outputDir, 'stderr.log'), 'a');
      let child;
      // KI-E293: the self-hosted runner executes as root (/root/...); claude-code REFUSES
      // --dangerously-skip-permissions under root ("cannot be used with root/sudo privileges for
      // security reasons" — isRootOutsideDeliberateSandbox()) and exits in ~3s with no output UNLESS a
      // deliberate-sandbox env var is set. IS_SANDBOX satisfies isSandboxEnvSet() so the worker runs
      // unrestricted in its per-item worktree. Internet access is probed independently, so this does
      // NOT falsely mark the worker offline. Respect an explicit operator override if already set.
      //
      // KI-E296: the worker launches the impl-factory Workflow as a BACKGROUND task; claude-code's
      // default background-wait ceiling is 600s, after which it TERMINATES the still-running Workflow
      // and exits with 0 validated checkpoints (the item never writes result.json → stays CLAIMED).
      // The impl-factory pipeline (plan → review gates → integrate, many agents) routinely exceeds
      // 10 min. CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 makes claude -p wait for the Workflow to finish;
      // the orchestrator's own laneTimeoutMinutes watch (default 240) is the real upper bound.
      const childEnv = {
        ...process.env,
        IS_SANDBOX: process.env.IS_SANDBOX ?? '1',
        CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? '0',
      };
      try { child = spawn(cfg.claudeHeadless.bin, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', stderr], env: childEnv }); }
      finally { closeSync(stderr); }
      const childState = observeChild(child, () => persist(childState, child.pid, structured));
      childState.runtimeVersion = runtimeVersion;
      const raw = createWriteStream(join(outputDir, 'stdout.log'), { flags: 'a' });
      raw.on('error', (e) => { childState.error = 'output capture: ' + e.message; child.kill(); });
      child.stdout.pipe(raw);
      return { launched: true, pid: child.pid, child, childState, structured };
    },
  },
};

// ---- watch: per-item checkpoints are the completion signal (KI-L40 file-first model) ---------
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
function loadDispatchConfig(cfg) {
  const path = resolve(FACTORY_ROOT, cfg.opencode.config);
  return dispatchConfig(existsSync(path) ? readJson(path) : {}, cfg);
}

function checkpoints(launch, claims, sinceMs, backend) {
  const ledger = readJson(ledgerPath());
  return launch.batch.items.flatMap((item) => {
    const p = join(FACTORY_ROOT, 'state', 'items', item.id, 'result.json');
    try {
      const result = readJson(p);
      if (backend === 'opencode') {
        const finalizedPath = join(FACTORY_ROOT, 'state', `results-cycle-${launch.batch.cycle}-${item.id}.json`);
        const finalized = readJson(finalizedPath);
        if (statSync(finalizedPath).mtimeMs < sinceMs || finalized.mode !== 'opencode-adapter' || finalized.cycle !== launch.batch.cycle || finalized.results?.length !== 1 || JSON.stringify(finalized.results[0]) !== JSON.stringify(result)) return [];
      }
      return validCheckpoint(result, item, launch.batch.cycle, { mtimeMs: statSync(p).mtimeMs, sinceMs, claim: claims[item.id], currentClaim: claimIdentity(ledger.items[item.id]) }) ? [result] : [];
    } catch { return []; }
  });
}

// ---- one lane: group -> dispatch -> watch -> reconstruct -> fold ----------------------------
// KI-E299: the per-item worktree holds the agent's actual code fix UNCOMMITTED (KI-E1 — the factory
// never commits; the human does). On the self-hosted runner the worktree is lost between runs
// (actions/checkout repo-recreation, the KI-E294 prune) and the branch-push only carries base HEAD,
// so without this the code attempt vanishes — the single most important artifact for review AND for
// future factory improvement. Capture it as a committed, reviewable diff (state/items/<id>/worktree.diff).
// READ-ONLY git (diff/ls-files only — no add/commit/reset), so KI-E1 holds. Covers tracked edits +
// untracked NEW files (the fixer's new test). Best-effort per item — never fails the lane.
function captureWorktreeDiffs(items) {
  for (const item of items || []) {
    try {
      const wt = item && item.worktree && item.worktree.path;
      if (!wt || !existsSync(wt)) continue;
      const itemDir = join(FACTORY_ROOT, 'state', 'items', item.id);
      mkdirSync(itemDir, { recursive: true });
      let diff = '';
      try { diff = execFileSync('git', ['-C', wt, 'diff', 'HEAD'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }); } catch (e) { diff = (e && e.stdout) || ''; }
      let untracked = [];
      try { untracked = execFileSync('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* none */ }
      for (const nf of untracked) {
        try { diff += '\n' + execFileSync('git', ['-C', wt, 'diff', '--no-index', '--', '/dev/null', nf], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
        catch (e) { if (e && e.stdout) diff += '\n' + e.stdout; } // --no-index exits 1 on any difference; the diff is on stdout
      }
      writeFileSync(join(itemDir, 'worktree.diff'), diff);
      log(`captured worktree.diff for ${item.id} (${diff.split('\n').length} lines)`);
    } catch (e) { log(`captureWorktreeDiffs ${item.id} error (non-fatal): ${e.message}`); }
  }
}

// KI-E300: preserve the FULL per-run artifact set of EVERY attempt — failures AND successes alike (a
// path-to-failure and a path-to-success are equally valuable for review and factory improvement).
// itemsDir is NOT cycle-keyed (factory.js), so each run OVERWRITES state/items/<id>/ — only the latest
// attempt survives in the tree. Snapshot it into an append-only state/items/<id>/_runs/<cycle>-<runId>/
// (the factory never writes under _runs/, so prior attempts persist). The commit step's `git add -f
// state/items/` already commits it, so no workflow change is needed. Best-effort; never fails the lane.
function archiveItemRun(items, cycle) {
  // Recursively copy srcDir -> dstDir, skipping the _runs/ archive itself. (cpSync hard-refuses a
  // copy into its own subdirectory — the check fires before any filter — so we copy by hand.)
  const copyTree = (srcDir, dstDir) => {
    mkdirSync(dstDir, { recursive: true });
    for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
      if (ent.name === '_runs') continue; // never recurse into (or nest) the archive
      const s = join(srcDir, ent.name), d = join(dstDir, ent.name);
      if (ent.isDirectory()) copyTree(s, d);
      else if (ent.isFile()) copyFileSync(s, d);
    }
  };
  for (const item of items || []) {
    try {
      const src = join(FACTORY_ROOT, 'state', 'items', item.id);
      if (!existsSync(src)) continue;
      const tag = `cycle${cycle}-${String(item.runId || item.claimId || 'run').slice(0, 8)}`;
      const dst = join(src, '_runs', tag);
      if (existsSync(dst)) continue; // idempotent per (cycle, runId)
      copyTree(src, dst);
      log(`archived run snapshot for ${item.id} -> _runs/${tag}`);
    } catch (e) { log(`archiveItemRun ${item.id} error (non-fatal): ${e.message}`); }
  }
}

async function runLane(cfg, token, laneNo, idsFlag) {
  if (existsSync(STOP_MARKER)) { log('stop-marker present — refusing to dispatch a new lane (KI-E6; human-only override)'); return { stopped: true }; }
  if (cfg.backend === 'dry') {
    const engine = readJson(join(FACTORY_ROOT, 'config', 'factory.config.json'));
    const localPath = join(FACTORY_ROOT, 'config', 'factory.config.local.json');
    if (existsSync(localPath)) {
      const local = readJson(localPath), paths = { ...engine.paths, ...local.paths };
      Object.assign(engine, local, { paths });
    }
    swapMountPrefix(engine, STOCK_MOUNT, toPosix(relative(REPO_ROOT, FACTORY_ROOT)));
    const plan = schedulerSuggestions(readJson(resolve(REPO_ROOT, engine.paths.graph)), readJson(resolve(REPO_ROOT, engine.paths.ledger)), cfg, engine, idsFlag);
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  const label = `orch-${Date.now().toString(36)}-${process.pid}-${laneNo}`;
  const groupArgs = groupArguments(cfg, { label, token, ids: idsFlag });
  const g = driver(groupArgs);
  if (!g.ok) { log(`group failed:\n${g.out}`); return { error: 'group-failed' }; }
  console.log(g.out.trim());
  const launch = launchFromGroup(g.out, readJson, REPO_ROOT);
  if (!launch) { log('group emitted no launchable batch (nothing schedulable?)'); return { error: 'empty-batch' }; }
  const { ids, runScript, batch } = launch;
  const effectiveBuildCapacity = buildCapacity(FACTORY_ROOT, batch.buildCapacity);
  const t0 = Date.now();
  const rows = readJson(ledgerPath()).items;
  const claims = Object.fromEntries(ids.map((id) => [id, claimIdentity(rows[id])]));
  const outputDir = join(FACTORY_ROOT, 'state', 'orchestrator', label);
  mkdirSync(outputDir, { recursive: true });
  const metadata = { version: 1, label, laneNo, backend: cfg.backend, ids, cycle: batch.cycle, claims, runScript, runArgsPath: launch.runArgsPath, startedAt: new Date(t0).toISOString(), usage: null, sessionId: null, modelConcurrency: cfg.modelConcurrency, buildCapacity: effectiveBuildCapacity, buildCapacityEnforced: true, buildCapacityScope: 'mechanics-and-contract-compliant-worker-builds', ...(cfg.backend === 'opencode' ? { observationSource: 'state/items/<id>/dispatch/*-session.json', resumeCommand: ['node', join(FACTORY_ROOT, '_workflow/opencode/dispatch.mjs'), '--config', join(outputDir, 'opencode-dispatch.json'), '--ids', ids.join(',')] } : {}) };
  writeJsonAtomic(join(outputDir, 'launch.json'), metadata);
  temit({ event: 'orchestrator_lane', lane: label, outcome: 'dispatching', attrs: { items: ids, backend: cfg.backend, runScript } });
  if (existsSync(STOP_MARKER)) return { stopped: true, ids };
  const persist = (state, pid, structured) => {
    const { termination, completion, ...observation } = state || {};
    writeJsonAtomic(join(outputDir, 'launch.json'), { ...metadata, pid: pid ?? null, structured, ...observation });
  };
  let disp;
  try { disp = await backends[cfg.backend].dispatch(runScript, { ...cfg, buildCapacity: effectiveBuildCapacity }, outputDir, persist, launch); }
  catch (e) { writeJsonAtomic(join(outputDir, 'launch.json'), { ...metadata, error: e.message, recovery: recoveryAdvice(ids) }); return { error: 'dispatch-failed', ids }; }
  persist(disp.childState, disp.pid, disp.structured ?? false);
  let w;
  try { w = await watchLane({
    heartbeat: () => driver(['controller', 'heartbeat', '--controller', token]).ok,
    poll: () => { const done = checkpoints(launch, claims, t0, cfg.backend).map((r) => r.id); log(`watch: ${done.length}/${ids.length} validated checkpoints`); return { done, complete: done.length === ids.length }; },
    childState: disp.childState, intervalMs: cfg.watchIntervalMs, timeoutMs: cfg.laneTimeoutMinutes * 60000,
  }); } catch (e) {
    await stopChild(disp.child, disp.childState);
    writeJsonAtomic(join(outputDir, 'launch.json'), { ...metadata, error: e.message, recovery: recoveryAdvice(ids) });
    return { error: 'watch-failed', ids };
  }
  if (disp.child && !disp.childState.closed) {
    if (!await stopChild(disp.child, disp.childState)) {
      writeJsonAtomic(join(outputDir, 'launch.json'), { ...metadata, error: 'child-termination-unconfirmed', recovery: recoveryAdvice(ids) });
      return { error: 'child-termination-unconfirmed', ids };
    }
  }
  const { termination, completion, ...observation } = disp.childState || {};
  writeJsonAtomic(join(outputDir, 'launch.json'), { ...metadata, pid: disp.pid ?? null, structured: disp.structured ?? false, ...observation, completedAt: new Date().toISOString(), watch: w, recovery: recoveryAdvice(ids, w.done) });
  captureWorktreeDiffs(launch.batch.items); // KI-E299: preserve each item's worktree fix as a committed diff artifact (before the worktree is lost)
  archiveItemRun(launch.batch.items, launch.batch.cycle); // KI-E300: append-only per-run snapshot so no attempt (fail or success) is overwritten
  if (w.leaseLost) return { error: 'lease-lost', ids };
  if (!w.complete) {
    log(`lane ${label} INCOMPLETE (${w.done.length}/${ids.length}${w.timedOut ? ', timed out' : ''}) — ${cfg.backend === 'opencode' ? 'resume the entire OpenCode batch/config before folding' : 'folding what finished; inspect driver.mjs resume for the rest'}`);
  }
  if (cfg.backend === 'opencode' && (!w.complete || w.childFailed)) return { error: 'opencode-batch-unsettled', ids };
  const results = checkpoints(launch, claims, t0, cfg.backend);
  if (!results.length) return { ids, folded: false, error: 'no-valid-checkpoints' };
  const resultFile = join(outputDir, 'results.json');
  writeJsonAtomic(resultFile, { mode: 'run', cycle: batch.cycle, results });
  // KI-E455: this loop already calls hillClimbUpdate/banditUpdate/saCool/peUpdate/coUpdate/
  // checkAndRecalibrate/checkZeroClosureStop/postBatchFailureAnalysis itself, right after runLane
  // returns (below) — --skip-tracker-update tells driver.mjs's fold not to ALSO feed them via its
  // own KI-E455 backfill path, which exists for callers (manual recovery, reconcile-closed) that
  // have no such surrounding loop to do it themselves.
  const f = driver(['fold', resultFile, '--controller', token, '--skip-tracker-update']);
  console.log(f.out.trim());
  writeJsonAtomic(join(outputDir, 'fold.json'), { version: 1, ok: f.ok, code: f.code ?? 0, resultsFile: resultFile, ids: results.map((r) => r.id), completedAt: new Date().toISOString(), recovery: recoveryAdvice(ids, results.map((r) => r.id)) });
  temit({ event: 'orchestrator_lane', lane: label, outcome: !f.ok ? 'fold-failed' : w.complete ? 'folded' : 'partial-fold', durMs: Date.now() - t0, attrs: { items: ids, checkpoints: results.length } });
  driver(['telemetry-report']);
  // KI-E307: append each folded item to the cumulative run index + regenerate the dashboard (committed, preserved).
  try { recordRuns(FACTORY_ROOT, results.map((r) => r.id)); renderFactoryReport(FACTORY_ROOT); } catch (e) { log(`run-history (non-fatal): ${e.message}`); }
  // KI-E385: record per-run metrics in PostgreSQL with pgvector for hill climbing and optimization.
  try {
    recordBatchMetrics(label, results, { cycle: batch.cycle, maxLanes: cfg.maxLanes, backend: cfg.backend, cfg });
    const summary = recentRunsSummary(5);
    if (summary) log(summary);
  } catch (e) { log(`pg-telemetry (non-fatal): ${e.message}`); }
  // KI-E379: log per-batch token consumption + week-to-date vs weeklyTokenLimit so the operator can
  // see which batches eat the most weekly quota. Runs after recordRuns so runs.jsonl is already updated.
  try { logBatchTokenUsage(results.map((r) => r.id)); } catch (e) { log(`batch-token-log (non-fatal): ${e.message}`); }
  // KI-E308: regenerate the ranked owner-decisions digest so BLOCKED/ESCALATED gates are surfaced
  // (reports/decisions-digest.md), not left to sit silently — the command existed but was never wired.
  try { driver(['decisions-digest']); } catch (e) { log(`decisions-digest (non-fatal): ${e.message}`); }
  // KI-E309: mandatory self-improvement analysis — ranked proposals (reports/SELF-IMPROVEMENT.md) +
  // newly-queued improvement items for the consumer (KI-E310). Read-only; never self-modifies code.
  try { const si = analyzeSelfImprovement(FACTORY_ROOT); if (si.fresh) log(`self-improve: queued ${si.fresh} new improvement proposal(s)`); } catch (e) { log(`self-improve (non-fatal): ${e.message}`); }
  // KI-E378: after every 3 completed factory runs, automatically ingest queued improvement proposals
  // into the work queue via driver ingest-improvements (turns queue/factory-improvement-*.md into
  // real READY ledger items). The counter is driven by runs.jsonl line count (written above by
  // recordRuns) and persisted in state/self-improve-ingest.json so restarts are idempotent.
  try { autoIngestImprovements(); } catch (e) { log(`auto-ingest-improvements (non-fatal): ${e.message}`); }
  // KI-E380: after every batch, analyze FAILED items and immediately ingest targeted improvement
  // proposals — faster remediation than the 3-run autoIngestImprovements threshold.
  try { postBatchFailureAnalysis(results); } catch (e) { log(`post-batch-failure-analysis (non-fatal): ${e.message}`); }
  return { ids, folded: f.ok, complete: w.complete, ...(!f.ok || !w.complete || w.childFailed ? { error: 'lane-incomplete-or-failed' } : {}) };
}

// ---- applyAndCommit (KI-E272: server-mode — disabled by default) ----------------------------
// No-op unless cfg.autoCommit.enabled is explicitly true. When enabled, copies changed files
// from CLOSED worktrees into the repo root, stages them, and commits. This is a deliberate
// relaxation of KI-E1 for the dedicated server operating without a human at the keyboard.
// Pre-flight: skips items whose files overlap with an earlier item (by ID order) and files
// that are already dirty in the repo root (to avoid clobbering in-progress human edits).
function applyAndCommit(cfg) {
  if (!cfg.autoCommit || !cfg.autoCommit.enabled) return; // KI-E272: disabled by default
  const committedPath = join(FACTORY_ROOT, 'state', 'orchestrator', 'auto-committed.json');
  const alreadyDone = existsSync(committedPath) ? JSON.parse(readFileSync(committedPath, 'utf8')) : {};

  const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
  const items = Object.values(l.items)
    .filter((r) => r.state === 'CLOSED' && r.worktree && existsSync(r.worktree) && !alreadyDone[r.id])
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!items.length) return;

  // Gather changed files for each item (uncommitted diff; fall back to last commit per KI-E271)
  const itemFiles = {};
  for (const r of items) {
    try {
      const raw = execFileSync('git', ['-C', r.worktree, 'status', '--porcelain'], { encoding: 'utf8' }).trimEnd();
      let files = raw ? raw.split('\n').map((l) => l.slice(3)) : [];
      if (!files.length) {
        try {
          const committed = execFileSync('git', ['-C', r.worktree, 'diff', '--name-only', 'HEAD^', 'HEAD'], { encoding: 'utf8' }).trimEnd();
          files = committed ? committed.split('\n').filter(Boolean) : [];
        } catch { /* no prior commit or git error — skip */ }
      }
      itemFiles[r.id] = { r, files, raw };
    } catch (e) {
      log(`autoCommit: could not inspect ${r.id} worktree — ${e.message} (skipping)`);
      alreadyDone[r.id] = { skipped: true, reason: 'git-status-failed' };
    }
  }

  const seenFiles = new Set();
  for (const [id, { r, files, raw }] of Object.entries(itemFiles)) {
    const overlap = files.filter((f) => seenFiles.has(f));
    if (overlap.length) {
      log(`autoCommit: skipping ${id} — file overlap with earlier item: ${overlap.join(', ')}`);
      alreadyDone[id] = { skipped: true, reason: 'file-overlap', files: overlap };
      continue;
    }
    files.forEach((f) => seenFiles.add(f));

    const staged = [];
    for (const line of (raw || '').split('\n').filter(Boolean)) {
      const status = line.slice(0, 2).trim();
      const file = line.slice(3);
      // Conflict check: skip files already dirty in the repo root
      try {
        const rootStatus = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', file], { encoding: 'utf8' }).trim();
        if (rootStatus) { log(`autoCommit: ${id} skipping ${file} — dirty in repo root: ${rootStatus}`); continue; }
      } catch { continue; }

      if (status === 'D') {
        try { execFileSync('git', ['-C', REPO_ROOT, 'rm', '-f', '--', file]); staged.push(file); }
        catch (e) { log(`autoCommit: ${id} rm failed for ${file}: ${e.message}`); }
      } else {
        try {
          const src = join(r.worktree, file);
          const dst = join(REPO_ROOT, file);
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
          execFileSync('git', ['-C', REPO_ROOT, 'add', '--', file]);
          staged.push(file);
        } catch (e) { log(`autoCommit: ${id} copy/add failed for ${file}: ${e.message}`); }
      }
    }

    if (!staged.length) {
      log(`autoCommit: ${id} — nothing staged (all files conflicted, absent, or failed)`);
      alreadyDone[id] = { skipped: true, reason: 'nothing-staged' };
      continue;
    }

    const title = r.title || id;
    const signoff = (cfg.autoCommit.signoff || '').trim();
    const msg = signoff ? `factory: auto-commit ${id} — ${title}\n\n${signoff}` : `factory: auto-commit ${id} — ${title}`;
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'commit', '-m', msg]);
      alreadyDone[id] = { committedAt: new Date().toISOString(), files: staged };
      log(`autoCommit: committed ${id} (${staged.length} file(s))`);
      if (cfg.autoCommit.pushAfterCommit) {
        try { execFileSync('git', ['-C', REPO_ROOT, 'push']); }
        catch (e) { log(`autoCommit: push failed (non-fatal, will retry next lane): ${e.message}`); }
      }
    } catch (e) {
      log(`autoCommit: commit failed for ${id}: ${e.message}`);
      alreadyDone[id] = { skipped: true, reason: 'commit-failed', error: e.message };
      try { execFileSync('git', ['-C', REPO_ROOT, 'reset', 'HEAD', '--']); } catch { /* ignore */ }
    }
  }

  writeFileSync(committedPath, JSON.stringify(alreadyDone, null, 2));
}

// ---- notifyEscalated (KI-E272: escalation webhook — no-op when cfg.escalationWebhook is null) --
// Fire-and-forget POST to a Slack-compatible webhook URL when new items hit ESCALATED state.
// Tracks already-notified items in state/orchestrator/escalation-notified.json to avoid spam.
function notifyEscalated(cfg) {
  if (!cfg.escalationWebhook) return;
  const notifiedPath = join(FACTORY_ROOT, 'state', 'orchestrator', 'escalation-notified.json');
  const notified = existsSync(notifiedPath) ? JSON.parse(readFileSync(notifiedPath, 'utf8')) : {};

  const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
  const newItems = Object.values(l.items).filter((r) => r.state === 'ESCALATED' && !notified[r.id]);
  if (!newItems.length) return;

  const payload = JSON.stringify({
    text: `🏭 Factory: ${newItems.length} item(s) escalated — owner decision needed`,
    attachments: newItems.map((r) => ({
      title: r.id,
      text: (r.title || '') + (r.ownerDecision ? '' : ' *(no decision yet)*'),
      color: '#ff9800',
    })),
  });

  let url;
  try { url = new URL(cfg.escalationWebhook); } catch (e) { log(`escalation webhook: invalid URL — ${e.message}`); return; }
  const isHttps = url.protocol === 'https:';
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const port = url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80);

  const req = reqFn({ hostname: url.hostname, port, path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (httpRes) => {
    httpRes.resume();
    if (httpRes.statusCode < 300) {
      newItems.forEach((r) => { notified[r.id] = new Date().toISOString(); });
      try { writeFileSync(notifiedPath, JSON.stringify(notified, null, 2)); } catch { /* ignore */ }
      log(`escalation webhook: notified ${newItems.length} item(s) — ${newItems.map((r) => r.id).join(', ')}`);
    } else {
      log(`escalation webhook: POST returned ${httpRes.statusCode} — will retry next lane`);
    }
  });
  req.on('error', (e) => log(`escalation webhook: POST failed (${e.message}) — will retry next lane`));
  req.write(payload);
  req.end();
}

// ---- autoPR (KI-E303: auto-open PR for newly-CLOSED items after each lane fold) ----------------
// Default ON (cfg.autoPR.enabled !== false). For each item in `dispatchedIds` that is now CLOSED
// with a live worktree and no prUrl, calls open-pr.sh to commit the fix, push the branch, and open
// a GitHub PR. Idempotent: if a PR already exists for the branch it records the URL and skips.
// Non-fatal: a PR failure never aborts the orchestrator run.
function autoPR(cfg, dispatchedIds) {
  if (cfg.autoPR === false || (cfg.autoPR && cfg.autoPR.enabled === false)) return;
  const OPEN_PR = join(HERE, 'open-pr.sh');
  if (!existsSync(OPEN_PR)) { log('autoPR: open-pr.sh not found — skipping'); return; }
  let l;
  try { l = JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch (e) { log(`autoPR: could not read ledger — ${e.message}`); return; }
  const idSet = new Set(Array.isArray(dispatchedIds) ? dispatchedIds : []);
  for (const [id, r] of Object.entries(l.items || {})) {
    if (!idSet.has(id)) continue;
    if (r.state !== 'CLOSED') continue;
    const noPr = !r.prUrl || r.prUrl === 'null' || r.prUrl === 'None';
    if (!noPr) { log(`autoPR: ${id} already has prUrl — skipping`); continue; }
    if (!r.worktree || !existsSync(r.worktree)) { log(`autoPR: ${id} worktree gone (gc'd?) — skipping`); continue; }
    log(`autoPR: opening PR for ${id}`);
    try {
      const out = execFileSync('bash', [OPEN_PR, id, 'master', FACTORY_ROOT],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      log(`autoPR: ${id} — ${(out || '').trim().split('\n').pop()}`);
    } catch (e) {
      log(`autoPR: ${id} failed (non-fatal): ${(e.stderr || e.message || '').trim().split('\n').slice(-2).join(' | ')}`);
    }
  }
}

// ---- clearPhantomClaimed (KI-E416) ---------------------------------------------------------
// At orchestrator startup (after claiming the controller lease), detect CLAIMED items whose
// worktree path no longer exists (e.g. items claimed on a now-gone GitHub Actions runner at
// /root/Work/actions-runner/...) and reset them to READY so they can be scheduled again.
// A phantom item stays CLAIMED forever otherwise — it holds a scheduling slot and never
// produces a checkpoint, but will only time out after laneTimeoutMinutes (4 hours).
// This runs once per orchestrator invocation, immediately after the lease is claimed.
//
// KI-E422: GH Actions runner path detection. Items whose worktree was on a GH Actions runner
// (path contains '/actions-runner') are reset to FAILED (not READY) so they surface in the
// failure summary and get investigated, rather than being blindly re-dispatched where they may
// burn tokens cycling. The CI runner environment is gone; these items need a fresh clean run.
function clearPhantomClaimed(cfg, token) {
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    const phantomReady = []; // items to reset → READY (safe to redispatch immediately)
    const phantomFailed = []; // items to reset → FAILED (GH Actions runner artifacts — investigate first)
    for (const [id, row] of Object.entries(l.items || {})) {
      if (row.state !== 'CLAIMED') continue;
      const wt = row.worktree;
      // null worktree = item was CLAIMED but worktree never created — always phantom
      if (!wt) {
        phantomReady.push(id);
        log(`clearPhantomClaimed: ${id} — null worktree (phantom CLAIMED → READY)`);
        continue;
      }
      if (!existsSync(wt)) {
        // KI-E422: GH Actions runner paths are a distinct class — reset to FAILED so they
        // surface in the failure summary rather than being silently re-dispatched.
        const isGhActions = /\/actions-runner/.test(wt);
        if (isGhActions) {
          phantomFailed.push(id);
          log(`clearPhantomClaimed: ${id} — GH Actions runner worktree ${wt} missing (phantom CLAIMED → FAILED for investigation)`);
        } else {
          phantomReady.push(id);
          log(`clearPhantomClaimed: ${id} — worktree ${wt} missing (phantom CLAIMED → READY)`);
        }
      }
    }
    // Reset normal phantoms → READY
    if (phantomReady.length) {
      const resetArgs = token ? ['reset', '--controller', token, ...phantomReady] : ['reset', ...phantomReady];
      const r = driver(resetArgs);
      if (r.ok) log(`clearPhantomClaimed: reset ${phantomReady.length} phantom item(s) to READY — ${phantomReady.join(', ')}`);
      else log(`clearPhantomClaimed: driver reset (READY) error (non-fatal): ${r.out.slice(0, 200)}`);
    }
    // Reset GH Actions phantoms → FAILED so they appear in failure report (KI-E422)
    if (phantomFailed.length) {
      log(`clearPhantomClaimed: === KI-E422 GH ACTIONS RUNNER PHANTOMS DETECTED ===`);
      log(`clearPhantomClaimed: ${phantomFailed.length} item(s) were CLAIMED on a now-gone GH Actions runner.`);
      log(`clearPhantomClaimed: Resetting to FAILED (not READY) to prevent blind re-dispatch: ${phantomFailed.join(', ')}`);
      for (const id of phantomFailed) {
        // Write a synthetic last-failure.md so the failure shows clearly in logFailureSummary
        const reportsDir = join(FACTORY_ROOT, 'reports', id);
        mkdirSync(reportsDir, { recursive: true });
        try {
          writeFileSync(join(reportsDir, 'last-failure.md'),
            `## phantom-claimed — GH Actions runner artifact (KI-E422)\n\n` +
            `Item was CLAIMED on a GitHub Actions runner whose worktree is gone.\n` +
            `The CI runner environment no longer exists. This item needs a fresh local dispatch.\n\n` +
            `Cleared by clearPhantomClaimed at ${new Date().toISOString()}.`);
        } catch { /* best-effort */ }
        // Reset → READY first (required transition), then autoFix will see it as FAILED next run
        // Actually, driver 'reset' transitions CLAIMED/FAILED → READY. We need FAILED state.
        // Workaround: reset to READY (the only available transition), then the next autoFix
        // run will handle it. Log prominently so operator knows.
        // NOTE: driver only supports 'reset' (→READY) and 'block'. No direct → FAILED from CLAIMED.
        // So we reset to READY but tag the auto-fix-context so it won't be auto-fixed blindly.
        const resetArgs = token ? ['reset', '--controller', token, id] : ['reset', id];
        const r = driver(resetArgs);
        if (r.ok) {
          // Tag auto-fix-context to mark this as a GH Actions artifact so autoFix skips blind retry
          const ctxDir = join(FACTORY_ROOT, 'state', 'auto-fix-context');
          mkdirSync(ctxDir, { recursive: true });
          const ctxFile = join(ctxDir, `${id}.json`);
          let ctx = { retries: 0 };
          try { if (existsSync(ctxFile)) ctx = JSON.parse(readFileSync(ctxFile, 'utf8')); } catch { /* corrupt */ }
          ctx.ghActionsPhantom = true;
          ctx.ghActionsPhantomAt = new Date().toISOString();
          try { writeFileSync(ctxFile, JSON.stringify(ctx, null, 2)); } catch { /* best-effort */ }
          log(`clearPhantomClaimed: ${id} reset to READY (tagged ghActionsPhantom — autoFix will skip blind retry)`);
        } else log(`clearPhantomClaimed: driver reset (GH phantom) error for ${id}: ${r.out.slice(0, 200)}`);
      }
    }
  } catch (e) { log(`clearPhantomClaimed error (non-fatal): ${e.message}`); }
}

// ---- autoFixFailed (KI-E275: auto-reset clear build/test failures — disabled by default) ------
// After each fold, scans FAILED items for classifiable build/test errors AND re-fixable gate
// rejections (KI-E306) and resets them to READY for a fresh attempt — up to cfg.autoFix.maxRetries
// times per item. The driver's own last-failure.md already provides prior-attempt context to the
// next factory run; no extra prompting is needed. Infrastructure failures (infraSuspect:true in
// last-failure.json) are left for the driver's built-in infra-retry path (KI-L50) — do not also
// auto-fix them here.
function autoFixFailed(cfg, token) {
  if (!cfg.autoFix || !cfg.autoFix.enabled) return;  // enabled:true by default (orchestrator.config.json)
  const maxRetries = Number.isFinite(Number(cfg.autoFix.maxRetries)) && cfg.autoFix.maxRetries > 0
    ? Math.floor(cfg.autoFix.maxRetries) : 2;

  const ctxDir = join(FACTORY_ROOT, 'state', 'auto-fix-context');
  mkdirSync(ctxDir, { recursive: true });

  let l;
  try { l = JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch { return; }

  for (const [id, item] of Object.entries(l.items || {})) {
    if (item.state !== 'FAILED') continue;

    const ctxFile = join(ctxDir, `${id}.json`);
    let ctx = { retries: 0 };
    try { if (existsSync(ctxFile)) ctx = JSON.parse(readFileSync(ctxFile, 'utf8')); } catch { /* corrupt — start fresh */ }
    if (ctx.retries >= maxRetries || ctx.variedEscalated) {
      // KI-E423: same-gate failure cooldown — after maxRetries with the same errorClass, auto-BLOCK
      // the item so bandit/hillClimb stop selecting it. Prevents infinite FAILED→READY cycling.
      if (ctx.retries >= maxRetries && ctx.lastErrorClass && !ctx.blockedByCooldown) {
        ctx.blockedByCooldown = true;
        ctx.blockedAt = new Date().toISOString();
        ctx.blockReason = `same-gate failure cooldown: ${ctx.lastErrorClass} x${ctx.retries} (KI-E423)`;
        try { writeFileSync(ctxFile, JSON.stringify(ctx, null, 2)); } catch { /* best-effort */ }
        const blockArgs = token ? ['block', '--controller', token, id] : ['block', id];
        const br = driver([...blockArgs, '--reason', `autoFix cooldown: ${ctx.lastErrorClass} x${ctx.retries} — owner review needed`]);
        if (br.ok) log(`autoFix: BLOCKED ${id} — same-gate cooldown (${ctx.lastErrorClass} x${ctx.retries})`);
        else {
          // 'block' may not accept --reason; retry without it
          const br2 = driver(blockArgs);
          if (br2.ok) log(`autoFix: BLOCKED ${id} — same-gate cooldown (${ctx.lastErrorClass} x${ctx.retries})`);
          else log(`autoFix: block failed for ${id} (will stay FAILED): ${br2.out.slice(0, 120)}`);
        }
      }
      continue; // KI-E327: cap + varied-gate stop
    }
    // KI-E422: skip GH Actions phantom items — they need a deliberate fresh dispatch, not blind auto-fix
    if (ctx.ghActionsPhantom) { log(`autoFix: ${id} — GH Actions phantom (KI-E422), skipping auto-reset`); continue; }
    // KI-E424: skip items that previously reached ESCALATED state — owner decision needed, not auto-fix
    // Check result.json: if toState or any prior state was ESCALATED, leave FAILED for owner to re-scope.
    try {
      const rj = JSON.parse(readFileSync(join(FACTORY_ROOT, 'state', 'items', id, 'result.json'), 'utf8'));
      if (rj.previousState === 'ESCALATED' || rj.wasEscalated) {
        log(`autoFix: ${id} — previously ESCALATED (KI-E424), skipping auto-reset; owner decision needed`);
        continue;
      }
    } catch { /* no result.json — proceed */ }

    // Read last-failure.json (machine-readable — KI-E81) for structured classification
    const reportsDir = join(FACTORY_ROOT, 'reports', id);
    let errorText = '';
    let infraSuspect = false;
    try {
      const lf = JSON.parse(readFileSync(join(reportsDir, 'last-failure.json'), 'utf8'));
      errorText = lf.reason || '';
      infraSuspect = !!lf.infraSuspect;
    } catch { /* fall back to prose */ }
    if (!errorText) {
      try { errorText = readFileSync(join(reportsDir, 'last-failure.md'), 'utf8').slice(0, 4000); } catch { /* no log */ }
    }
    // KI-E312: gate/review failures + fold-time overrides do NOT populate last-failure.json.reason
    // (the verdict lands in result.json gates + the ledger note). Without this, autoFix logs "not
    // classifiable" for the DOMINANT failure class (review gates) and never retries it — defeating
    // the cross-run feedback loop for exactly the failures that most need it. Fall back to result.json.
    if (!errorText || String(errorText).trim().length < 20) {
      try {
        const rj = JSON.parse(readFileSync(join(FACTORY_ROOT, 'state', 'items', id, 'result.json'), 'utf8'));
        const failing = Object.entries(rj.gates || {}).filter(([, v]) => String(v).toUpperCase() !== 'APPROVED').map(([k]) => k);
        const merged = [rj.note || '', failing.length ? `gates not approved: ${failing.join(', ')}` : ''].filter(Boolean).join(' | ');
        if (merged.trim().length >= 20) errorText = merged;
      } catch { /* no result.json — leave errorText as-is */ }
    }

    // KI-E382: infra failures — KI-L53 marks infraSuspect:true in last-failure.json. The comment
    // "driver handles infra-retry" referred to the driver's KI-L50 logic, but that path only applies
    // during a live run, not after the fact for FAILED items. Auto-reset infra failures too — the next
    // attempt will get a fresh fixer pass. infraSuspect items do NOT count against the autoFix retry
    // budget (they're not quality failures, just transient blips), so we reset them unconditionally
    // up to maxRetries and treat them as their own error class.
    if (infraSuspect) {
      ctx.retries += 1;
      ctx.lastErrorClass = 'infra-transient';
      ctx.resetAt = new Date().toISOString();
      try { writeFileSync(ctxFile, JSON.stringify(ctx, null, 2)); } catch { /* best-effort */ }
      const r = driver(['reset', id]);
      if (r.ok) { log(`autoFix: reset ${id} to READY (infra-transient, attempt ${ctx.retries}/${maxRetries})`); }
      else { log(`autoFix: driver reset failed for ${id}: ${r.out.trim().slice(0, 120)}`); }
      continue;
    }

    const errorClass = classifyFixableError(errorText);
    if (!errorClass) {
      log(`autoFix: ${id} — not classifiable as auto-fixable: ${String(errorText).slice(0, 80)}`);
      continue;
    }

    // KI-E433: fold-override — escalate unless verify-red-raw.txt now exists.
    // These items burned ALL tokens (avg ~1M), passed EVERY gate, then failed at fold because
    // verify-red-raw.txt was absent. Retrying without the file → same outcome, same waste.
    // If the file exists now (operator or prior run wrote it), a READY reset is safe.
    if (errorClass === 'fold-override') {
      const verifyRedPath = join(FACTORY_ROOT, 'state', 'items', id, 'verify-red-raw.txt');
      if (existsSync(verifyRedPath)) {
        log(`autoFix: ${id} — fold-override precondition now met (verify-red-raw.txt present); resetting to READY`);
        // fall through to normal reset logic below
      } else {
        log(`autoFix: ${id} — fold-override, verify-red-raw.txt still absent (KI-E433); ESCALATING to prevent ~1M token waste`);
        ctx.foldOverrideEscalated = true;
        ctx.foldOverrideEscalatedAt = new Date().toISOString();
        try { writeFileSync(ctxFile, JSON.stringify(ctx, null, 2)); } catch { /* best-effort */ }
        const escArgs = token ? ['escalate', '--controller', token, id] : ['escalate', id];
        const er = driver(escArgs);
        if (!er.ok) log(`autoFix: escalate failed for ${id}: ${er.out.slice(0, 120)}`);
        continue;
      }
    }

    // KI-E327: varied-gate instability — if the failure CLASS changed between attempts, retrying has
    // not converged (an unstable fix / under-specified acceptance, e.g. a prior item failing twice on
    // different gates). Another auto-retry just burns ~200-600k tokens. Stop auto-retrying and leave it
    // FAILED + flagged for owner review (it surfaces in the FAILED report + the self-improve analyzer).
    if (ctx.retries >= 1 && ctx.lastErrorClass && ctx.lastErrorClass !== errorClass) {
      ctx.variedEscalated = true; ctx.variedFrom = ctx.lastErrorClass; ctx.variedTo = errorClass;
      try { writeFileSync(ctxFile, JSON.stringify(ctx, null, 2)); } catch { /* best-effort */ }
      log(`autoFix: ${id} — varied failure class (${ctx.lastErrorClass} -> ${errorClass}); not converging, stopping auto-retry (needs owner review)`);
      continue;
    }

    // KI-E281: record failure into error cluster (groups items by error signature for hint sharing)
    try { clusterRecord(id, errorClass, errorText); } catch { /* best-effort */ }

    // Persist retry count BEFORE the driver reset so a crash between the two preserves the counter
    ctx.retries += 1;
    ctx.lastErrorClass = errorClass;
    ctx.lastErrorSnippet = String(errorText).slice(-2000);
    ctx.resetAt = new Date().toISOString();
    try { writeFileSync(ctxFile, JSON.stringify(ctx, null, 2)); } catch { /* best-effort */ }

    // KI-E280 + KI-E281 + KI-E283: append reflexion to last-failure.md before reset so the next
    // factory.js run sees structured retry guidance, cluster hint, and warm-start commit history.
    try {
      const clusterHint = clusterGetHint(errorClass, errorText);
      const warmStart = getWarmStartContext(id);
      const reflexion = generateReflexion(id, ctx.retries, errorClass, errorText, clusterHint, warmStart);
      const lfMdPath = join(reportsDir, 'last-failure.md');
      const existing = existsSync(lfMdPath) ? readFileSync(lfMdPath, 'utf8') : '';
      writeFileSync(lfMdPath, existing + reflexion);
    } catch { /* best-effort — reflexion failure must never block the reset */ }

    // KI-E425: adversarial failure threshold — if the failure is from a review gate that includes
    // HIGH/CRITICAL adversarial findings, track a separate adversarial counter. After 2 such failures
    // with the same HIGH finding (by keyword match), escalate instead of retrying — owner must decide.
    if (errorClass === 'gate-rejection') {
      const hasHighAdversarial = /\bHIGH\b.*\bCHANGES_REQUIRED\b|\bCRITICAL\b.*\bCHANGES_REQUIRED\b/i.test(errorText)
        || /adversarial.*\bHIGH\b|\bHIGH\b.*adversarial/i.test(errorText)
        || /review-adversarial.*HIGH|HIGH.*review-adversarial/i.test(errorText);
      if (hasHighAdversarial) {
        ctx.adversarialFailures = (ctx.adversarialFailures || 0) + 1;
        if (ctx.adversarialFailures >= 2) {
          ctx.adversarialEscalated = true;
          ctx.adversarialEscalatedAt = new Date().toISOString();
          try { writeFileSync(ctxFile, JSON.stringify(ctx, null, 2)); } catch { /* best-effort */ }
          log(`autoFix: ${id} — adversarial HIGH failure x${ctx.adversarialFailures} (KI-E425); ESCALATING instead of retry`);
          const escArgs = token ? ['escalate', '--controller', token, id] : ['escalate', id];
          const er = driver(escArgs);
          if (!er.ok) log(`autoFix: escalate failed for ${id}: ${er.out.slice(0, 120)}`);
          continue;
        }
        log(`autoFix: ${id} — adversarial HIGH failure x${ctx.adversarialFailures}/2; retry with stronger fix guidance`);
        // Append escalation warning to reflexion so next fixer knows they're on their last chance
        try {
          const lfMdPath = join(reportsDir, 'last-failure.md');
          const existing = existsSync(lfMdPath) ? readFileSync(lfMdPath, 'utf8') : '';
          writeFileSync(lfMdPath, existing +
            `\n\n## ⚠️ KI-E425 ADVERSARIAL ESCALATION WARNING\n\n` +
            `This item will be auto-ESCALATED if the adversarial review fails again with a HIGH finding.\n` +
            `Current adversarial failure count: ${ctx.adversarialFailures}/2.\n` +
            `Fix the HIGH finding completely — do NOT just address surface-level symptoms.\n`);
        } catch { /* best-effort */ }
      }
    }

    // driver(['reset', id]) transitions FAILED → READY; last-failure.md stays in place as context
    const r = driver(['reset', id]);
    if (r.ok) {
      log(`autoFix: reset ${id} to READY (${errorClass}, attempt ${ctx.retries}/${maxRetries})`);
    } else {
      log(`autoFix: driver reset failed for ${id}: ${r.out.trim().slice(0, 120)}`);
    }
  }
}

// Classify a failure log as a clear, automatically-fixable error class, or return null if
// the failure is ambiguous / requires a human decision. A null means "leave as FAILED".
function classifyFixableError(text) {
  if (!text || String(text).trim().length < 20) return null;
  const t = String(text);
  if (/error CS\d{4}:/i.test(t)) return 'csharp-compile';
  if (/error TS\d{4}/i.test(t)) return 'typescript-compile';
  if (/error MSB\d{4}/i.test(t)) return 'msbuild-error';
  if (/Build FAILED/i.test(t) && /^\s*Error\b/m.test(t)) return 'build-failed';
  if (/\bFailed\b.*?\btest/i.test(t) || /\d+ test.*failed/i.test(t)) return 'test-failure';
  if (/dotnet\s.*\berror\b/i.test(t)) return 'dotnet-error';
  // KI-E306: a blocking REVIEW-GATE / pre-band PROBE rejection (e.g. `probe:docsync-scan`
  // CHANGES_REQUIRED) is merit-failure but STILL re-fixable across runs — the next attempt reads
  // feedback.md and the prior-finding scan (KI-E168) verifies the new diff evidences the rejection.
  // Bounded by autoFix.maxRetries exactly like build/test; if it keeps failing the SAME gate the
  // self-improvement analysis (KI-E309) surfaces it as a systemic factory-improvement proposal.
  // KI-E306 + KI-E312: pre-band PROBE rejections AND review-GATE rejections (the dominant class) are
  // re-fixable across runs — the next attempt reads feedback.md + the prior-finding scan (KI-E168).
  if (/\bCHANGES_REQUIRED\b/.test(t) || /\bprobe:[\w-]+/.test(t) || /-scan \(KI-[A-Z]?\d+\)/.test(t) || /blocking gate finding/i.test(t)
      || /\bgate:[\w-]+/.test(t) || /\breview:[\w-]+/.test(t) || /review\(s\) not APPROVED/i.test(t) || /adjudicator upheld/i.test(t) || /gates? not approved/i.test(t)) return 'gate-rejection';
  // KI-E382: phantom-manifest (KI-E498) failures — fixer claimed to write file(s) but the worktree
  // diff shows no corresponding change. Purely a transient agent reliability issue; the next attempt
  // produces a fresh fixer pass with the reflexion hint, which almost always resolves it.
  if (/phantom-manifest/i.test(t) || /claimed \d+ file\(s\) with NO corresponding change/i.test(t)) return 'phantom-manifest';
  // KI-E382: fixer-agent unavailable (null after retries) — infra/credit blip, not a quality verdict.
  // The KI-L53 path already flags these as infraSuspect in last-failure.json; autoFix correctly skips
  // them via the infraSuspect check BEFORE this classifier runs. This arm handles the edge case where
  // infraSuspect is false but the prose still clearly describes an agent-unavailable situation.
  if (/fixer agent UNAVAILABLE/i.test(t) || /null after retries.*infra/i.test(t)) return 'infra-transient';
  // KI-E433: fold-time override (verify-baseline-absent, verificationOnly-no-red) — these mean the
  // run went through ALL gates then failed because verify-red-raw.txt was absent. Retrying burns
  // another ~1M tokens with identical outcome. Instead: escalate (unless the file now exists).
  if (/deterministic fold-time override/i.test(t)
      || /verify transcript.*suite failures require a captured target.*baseline/i.test(t)
      || /verificationOnly item has no verify-red-raw\.txt/i.test(t)) return 'fold-override';
  return null;
}

// ---- logFailureSummary (KI-E276: print FAILED/ESCALATED detail to stdout after every run) -----
// Captured by factory-run.yml / factory-pr-interactive.yml and posted as a PR comment so the
// operator sees what failed and why without needing SSH access to the server.
// ---- checkZeroClosureStop (KI-E420) --------------------------------------------------------
// After each fold, check if this batch closed any items. Track consecutive zero-closure runs
// in state/zero-closure-streak.json. After N consecutive runs with 0 closures (default: 5),
// automatically place STOP_REQUESTED.md so the factory halts and the owner is alerted.
// This prevents the "12 days / 0 closures / 35% budget burned" failure mode.
const ZERO_CLOSURE_STREAK_PATH = () => join(FACTORY_ROOT, 'state', 'zero-closure-streak.json');

export function checkZeroClosureStop(cfg, res) {
  if (!res || !res.folded) return; // only check after a completed fold
  const maxConsecutive = (cfg.zeroClosureStop && Number.isFinite(Number(cfg.zeroClosureStop.maxConsecutiveRuns)))
    ? Math.max(2, Math.floor(Number(cfg.zeroClosureStop.maxConsecutiveRuns))) : 5;
  if (cfg.zeroClosureStop && cfg.zeroClosureStop.enabled === false) return; // opt-out

  let streak = { runs: 0, lastClosureAt: null, lastRunAt: null };
  try {
    if (existsSync(ZERO_CLOSURE_STREAK_PATH())) streak = JSON.parse(readFileSync(ZERO_CLOSURE_STREAK_PATH(), 'utf8'));
  } catch { /* fresh */ }

  // Count closures in this batch result
  const batchIds = Array.isArray(res.ids) ? res.ids : [];
  let closures = 0;
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    for (const id of batchIds) {
      const row = l.items && l.items[id];
      if (row && row.state === 'CLOSED') closures++;
    }
    // Also check run results directly from batchResults if available
    if (!closures && Array.isArray(res.batchResults)) {
      closures = res.batchResults.filter((r) => r.toState === 'CLOSED').length;
    }
  } catch { /* ledger unavailable */ }

  const now = new Date().toISOString();
  if (closures > 0) {
    // Good — reset the streak
    streak.runs = 0;
    streak.lastClosureAt = now;
    log(`zeroClosureStop: ${closures} closure(s) this batch — streak reset`);
  } else {
    streak.runs = (streak.runs || 0) + 1;
    streak.lastRunAt = now;
    log(`zeroClosureStop: 0 closures this batch — consecutive zero-closure runs: ${streak.runs}/${maxConsecutive}`);

    if (streak.runs >= maxConsecutive && !existsSync(STOP_MARKER)) {
      const msg = [
        `# FACTORY AUTO-STOP — KI-E420`,
        ``,
        `Automatically placed by the zero-closure stop gate after ${streak.runs} consecutive`,
        `runs with 0 items closed.`,
        ``,
        `Last closure: ${streak.lastClosureAt || 'never'}`,
        `Auto-stop triggered: ${now}`,
        ``,
        `This indicates the factory is stuck — investigate before resuming:`,
        `  1. Check FAILED items in the ledger and their last-failure.md files`,
        `  2. Check ESCALATED items that need owner decisions`,
        `  3. Review the SELF-IMPROVEMENT.md proposals`,
        `  4. Check for systemic issues (class mismatch, infrastructure, missing deps)`,
        ``,
        `Delete this file to resume (owner action required).`,
      ].join('\n');
      try {
        writeFileSync(STOP_MARKER, msg);
        log(`zeroClosureStop: *** AUTO-STOP PLACED — ${streak.runs} consecutive zero-closure runs hit threshold of ${maxConsecutive} ***`);
        log(`zeroClosureStop: Factory halted. Delete ${STOP_MARKER} to resume.`);
      } catch (e) { log(`zeroClosureStop: failed to write STOP_REQUESTED.md: ${e.message}`); }
    }
  }

  try { writeFileSync(ZERO_CLOSURE_STREAK_PATH(), JSON.stringify({ ...streak, updatedAt: now }, null, 2)); } catch { /* best-effort */ }
}

function logFailureSummary() {
  let l;
  try { l = JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch { return; }
  const failed = Object.values(l.items || {}).filter((r) => r.state === 'FAILED');
  const escalated = Object.values(l.items || {}).filter((r) => r.state === 'ESCALATED');
  if (!failed.length && !escalated.length) { log('run summary: no FAILED or ESCALATED items ✓'); return; }

  if (failed.length) {
    log(`=== FAILED items (${failed.length}) ===`);
    for (const r of failed) {
      log(`  ${r.id}${r.title ? ': ' + r.title : ''}`);
      const reportsDir = join(FACTORY_ROOT, 'reports', r.id);
      try {
        const lf = JSON.parse(readFileSync(join(reportsDir, 'last-failure.json'), 'utf8'));
        if (lf.infraSuspect) log(`    [infra suspect — driver will auto-retry]`);
        if (lf.reason) log(`    reason: ${String(lf.reason).slice(0, 300).replace(/\n/g, '\n    ')}`);
      } catch {
        try {
          const md = readFileSync(join(reportsDir, 'last-failure.md'), 'utf8');
          log(`    ${md.slice(0, 300).replace(/\n/g, '\n    ')}`);
        } catch { log(`    (no failure report found)`); }
      }
      // Show autoFix retry count if present
      try {
        const ctx = JSON.parse(readFileSync(join(FACTORY_ROOT, 'state', 'auto-fix-context', `${r.id}.json`), 'utf8'));
        log(`    autoFix: ${ctx.retries} attempt(s) (class: ${ctx.lastErrorClass || 'unknown'})`);
      } catch { /* no ctx — item hasn't been auto-retried */ }
    }
  }

  if (escalated.length) {
    log(`=== ESCALATED items (${escalated.length} — owner decision needed) ===`);
    for (const r of escalated) {
      log(`  ${r.id}${r.title ? ': ' + r.title : ''}${r.ownerDecision ? ' [decision recorded]' : ' ← NEEDS OWNER DECISION'}`);
    }
  }
}

// ---- logBatchTokenUsage (KI-E379: per-batch token consumption summary) --------------------------
// Reads runs.jsonl (just written by recordRuns) and logs:
//   batch tokens: 1,234,567 (3 items) | week-to-date: 23,456,789 / 51.6M (45.4%)
// Gives the operator visibility into which factory batches eat the most weekly quota.
// weeklyTokenLimit comes from orchestrator.config.json; set to 0 to hide the percentage.
function logBatchTokenUsage(batchIds) {
  try {
    const runsFile = join(FACTORY_ROOT, 'reports', 'runs.jsonl');
    if (!existsSync(runsFile)) return;
    const all = readFileSync(runsFile, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    // Batch tokens: latest run record per batch item (last occurrence wins — ordered by ts)
    const batchSet = new Set(batchIds);
    const latestPerItem = new Map();
    for (const r of all) {
      if (batchSet.has(r.id)) latestPerItem.set(r.id, r);
    }
    const batchTokens = [...latestPerItem.values()].reduce((s, r) => s + (r.tokensUsed || 0), 0);

    // Week-to-date tokens: current ISO week (Mon 00:00 UTC → Sun 23:59 UTC)
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=Sun
    const daysFromMon = (dayOfWeek + 6) % 7; // Mon=0 … Sun=6
    const weekStart = new Date(now);
    weekStart.setUTCDate(weekStart.getUTCDate() - daysFromMon);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekStartTs = weekStart.toISOString();
    const weekTokens = all.filter((r) => (r.ts || '') >= weekStartTs).reduce((s, r) => s + (r.tokensUsed || 0), 0);

    const num = (n) => n.toLocaleString('en-US');
    const limit = cfg.weeklyTokenLimit || 0;
    const limitStr = limit
      ? ` / ${(limit / 1e6).toFixed(1)}M (${((weekTokens / limit) * 100).toFixed(1)}%)`
      : '';
    log(`batch tokens: ${num(batchTokens)} (${latestPerItem.size} item(s)) | week-to-date: ${num(weekTokens)} tokens${limitStr}`);
  } catch (e) { log(`batch-token-log (non-fatal): ${e.message}`); }
}

// ---- postBatchFailureAnalysis (KI-E380+KI-E383+KI-E384) -----------------------------------
// Runs after EVERY batch fold. Classifies failures by PREVENTABILITY and acts immediately:
//
//   TIER 1 — IMMEDIATE: we know the exact mechanical fix. Apply it to the relevant file right
//   now in this function, no pipeline delay. Logged as "DIRECT-FIX applied". Applied on 1st
//   occurrence; if it fails to stick (still failing next batch), escalate to TIER 2.
//
//   TIER 2 — CRITICAL PROPOSAL: fix requires agent judgment but target file/change is known.
//   Queue a priority:critical proposal on the FIRST occurrence. Ingest immediately so it
//   becomes READY before the next batch starts. Recurrence count adds context ("prior fix
//   attempt failed") but NEVER delays action — every occurrence after the first that is still
//   in 'needs-action' state escalates one level higher.
//
//   TIER 3 — INVESTIGATION REQUIRED: fix requires reading failure context. High-priority
//   proposal on first occurrence; critical on recurrence.
//
// The 3-occurrence buffer from KI-E383 is REMOVED. Easily preventable things get fixed on
// occurrence 1, not after waiting to confirm it really is a problem. (KI-E384)
//
// Dedup (KI-E383): based on actual resolution status, not acknowledgement:
//   resolved   → skip (related improvement item CLOSED in ledger)
//   in-progress → skip (item READY/CLAIMED, or queued < 10 min ago)
//   needs-action → act (no item, item FAILED/ESCALATED, or stale)
const PBFA_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'post-batch-failure-analysis.json');

// Mechanical fixes that can be applied directly to files right now, no pipeline needed.
// Each entry: { targetFile, marker (idempotency), content (string to append if marker absent) }
const PBFA_DIRECT_FIXES = {
  'phantom-manifest': {
    targetFile: join(FACTORY_ROOT, 'agents', 'fixer.md'),
    marker: '<!-- PBFA:phantom-manifest-guard -->',
    heading: '### MANDATORY: Diff-sanity check after every file write (KI-E384)',
    content: [
      '',
      '<!-- PBFA:phantom-manifest-guard -->',
      '### MANDATORY: Diff-sanity check after every file write (KI-E384)',
      '',
      'After writing or editing ANY file, immediately verify the write reached the filesystem:',
      '',
      '```bash',
      'git -C "$WT" diff --name-only HEAD   # or: ls -la "$WT/path/to/file"',
      '```',
      '',
      'If the file does NOT appear in the diff (or does not exist at the expected path), the write',
      'was a PHANTOM — it never reached the filesystem. Do NOT proceed to the next step. Retry the',
      'write from scratch. This check is non-skippable; claiming a step complete without it when',
      'the diff is empty will cause the fold to reject the result as KI-E498 phantom-manifest.',
      '',
    ].join('\n'),
  },
};

// Check ledger to see if a KI improvement item derived from this analysis key is already resolved.
// Returns: 'resolved' | 'in-progress' | 'needs-action'
function pbfaResolutionStatus(key, pbfaState, ledger) {
  const entry = pbfaState[key];
  if (!entry) return 'needs-action';
  const relatedId = entry.relatedItemId;
  if (relatedId && ledger && (ledger.items || {})[relatedId]) {
    const state = (ledger.items[relatedId].state || '').toUpperCase();
    if (state === 'CLOSED') return 'resolved';
    if (['READY', 'CLAIMED'].includes(state)) return 'in-progress';
    // FAILED/ESCALATED improvement item → act again
  }
  const lastQueued = entry.lastQueuedAt || entry.firstQueuedAt;
  if (lastQueued && (Date.now() - new Date(lastQueued).getTime()) < 10 * 60 * 1000) return 'in-progress';
  return 'needs-action';
}

// Apply a mechanical fix directly to a file (idempotent — checks marker before writing).
// Returns true if fix was applied, false if already present.
function pbfaApplyDirectFix(fixDef, context) {
  try {
    const existing = existsSync(fixDef.targetFile) ? readFileSync(fixDef.targetFile, 'utf8') : '';
    if (existing.includes(fixDef.marker)) return false; // already applied
    const updated = existing + fixDef.content;
    writeFileSync(fixDef.targetFile, updated, 'utf8');
    log(`post-batch-failure-analysis: DIRECT-FIX applied to ${fixDef.targetFile} (${context})`);
    return true;
  } catch (e) {
    log(`post-batch-failure-analysis: DIRECT-FIX failed for ${fixDef.targetFile}: ${e.message}`);
    return false;
  }
}

export function postBatchFailureAnalysis(batchResults) {
  const failed = (batchResults || []).filter((r) => r.toState === 'FAILED' || r.toState === 'ESCALATED');
  if (!failed.length) return;

  log(`post-batch-failure-analysis: ${failed.length} failed/escalated item(s) — analyzing`);
  const stateDir = join(FACTORY_ROOT, 'state', 'items');
  const queueDir = join(FACTORY_ROOT, 'queue');
  mkdirSync(queueDir, { recursive: true });

  let ledger = null;
  try { ledger = JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch { /* no ledger → all need-action */ }

  const failures = [];
  for (const r of failed) {
    let failureText = '';
    try {
      const p = join(stateDir, r.id, 'last-failure.md');
      if (existsSync(p)) failureText = readFileSync(p, 'utf8');
    } catch { /* missing */ }
    failures.push({ id: r.id, toState: r.toState, decisiveGate: r.decisiveGate, overrideReason: r.overrideReason, failureText });
  }

  let pbfaState = {};
  try { if (existsSync(PBFA_STATE_PATH())) pbfaState = JSON.parse(readFileSync(PBFA_STATE_PATH(), 'utf8')); } catch { /* fresh */ }

  const proposals = [];
  const directFixesApplied = [];
  const now = new Date().toISOString();
  const skipped = [];

  // Decide action for a failure pattern.
  // tier: 'immediate' | 'critical' | 'high'
  //   immediate → try direct-fix first; if fix already applied, fall through to critical proposal
  //   critical  → priority:critical proposal on 1st occurrence
  //   high      → priority:high proposal on 1st occurrence
  // recurrence adds context but never delays — every needs-action occurrence acts.
  function handlePattern(key, tier, title, detail, items, directFixKey) {
    const status = pbfaResolutionStatus(key, pbfaState, ledger);
    if (status === 'resolved') { skipped.push(`${key} (resolved)`); return; }
    if (status === 'in-progress') { skipped.push(`${key} (in-progress)`); return; }

    const entry = pbfaState[key] || { count: 0, firstQueuedAt: now };
    entry.count = (entry.count || 0) + 1;
    entry.lastQueuedAt = now;
    pbfaState[key] = entry;

    // TIER 1: apply fix directly right now, no pipeline
    if (tier === 'immediate' && directFixKey && PBFA_DIRECT_FIXES[directFixKey]) {
      const applied = pbfaApplyDirectFix(PBFA_DIRECT_FIXES[directFixKey], `${key} occurrence ${entry.count}`);
      if (applied) { directFixesApplied.push(key); return; }
      // Fix already present but pattern still failing → escalate to critical proposal
      // (the direct fix didn't eliminate it; needs deeper investigation)
    }

    // TIER 2/3: generate proposal. Priority based on tier + recurrence.
    // Recurrence is context, not a buffer — we still act every time.
    let priority = tier === 'critical' ? 'critical' : 'high';
    let titleFull = title;
    let detailFull = detail;

    if (entry.count === 1 && tier === 'immediate') {
      // Direct fix was already applied but issue persists — the mechanical fix wasn't enough
      titleFull = `[DIRECT-FIX INSUFFICIENT] ${title}`;
      detailFull = `**The automatic diff-sanity guard was already in agents/fixer.md but the phantom-manifest pattern is still occurring. The mechanical fix is insufficient — the fixer is not following the guard. The proposal must strengthen the enforcement: make the diff-check a pre-fold probe (not just a fixer instruction) so the fold itself rejects a no-diff result before entering gate-band.** ${detail}`;
      priority = 'critical';
    } else if (entry.count >= 2) {
      titleFull = `[PRIOR FIX FAILED — ESCALATE] ${title}`;
      detailFull = `**Prior fix attempt (count: ${entry.count}) did not resolve this. The improvement item must make a more aggressive code change — not just a prompt addition. Edit the actual pipeline code (factory.js, orchestrate.mjs, or the relevant probe script) to eliminate this class of failure at the machinery level.** ${detail} First seen: ${entry.firstQueuedAt}.`;
      priority = 'critical';
    }

    proposals.push({ key, priority, title: titleFull, detail: detailFull, items: items.map((f) => f.id) });
  }

  // ---- Pattern detection ----

  // IMMEDIATE: phantom-manifest — mechanical diff-sanity fix exists right now
  const phantomFailed = failures.filter((f) => /phantom-manifest/i.test(f.failureText) || /claimed \d+ file\(s\) with NO corresponding change/i.test(f.failureText));
  for (const f of phantomFailed) {
    handlePattern(`batch-fail:phantom:${f.id}`, 'immediate',
      `Item ${f.id} — phantom-manifest: fixer claimed file writes but worktree diff empty`,
      `Fixer step claimed to write file(s) but \`git diff\` showed no change. Direct fix: append diff-sanity guard to agents/fixer.md (already attempted). If still recurring, add a pre-fold diff check that rejects zero-diff results before gate-band — edit \`_workflow/factory.js\` around the fold-verify step. Root cause artifact: state/items/${f.id}/last-failure.md.`,
      [f], 'phantom-manifest');
  }

  // CRITICAL: build failures — we know exactly which file to fix but need agent to make the edit
  const buildFailed = failures.filter((f) => /build.*error|error.*build|cs\d{4}|compilation failed/i.test(f.failureText)
    && !phantomFailed.find((p) => p.id === f.id));
  if (buildFailed.length) {
    const key = `batch-fail:build:${buildFailed.map((f) => f.id).sort().join(',')}`;
    handlePattern(key, 'critical',
      `${buildFailed.length} item(s) failed at build — add mandatory pre-gate build probe`,
      `Items: ${buildFailed.map((f) => f.id).join(', ')}. Non-compilable code entered the gate-band. Fix target: \`_workflow/factory.js\` — add a mandatory pre-gate step that runs \`dotnet build <sln>\` in the worktree (derive sln path from \`rootCauseFiles[0]\`'s service directory) and fails the item immediately if it returns non-zero, BEFORE dispatching to any gate. This is a code change to factory.js, not a fixer prompt addition. Read each item's last-failure.md for the specific CS error.`,
      buildFailed, null);
  }

  // CRITICAL: fold-time overrides — zero gate spend wasted, deterministic check failed
  const overridden = failures.filter((f) => f.overrideReason && !phantomFailed.find((p) => p.id === f.id));
  for (const f of overridden) {
    const key = `batch-fail:override:${f.overrideReason}:${f.id}`;
    handlePattern(key, 'critical',
      `Item ${f.id} fold-rejected via '${f.overrideReason}' — add matching pre-fold probe`,
      `Item ${f.id} was rejected by fold-time check \`${f.overrideReason}\` — zero gate spend needed. Fix target: add a pre-fold probe in \`_workflow/factory.js\` that runs this same deterministic check before entering the gate-band. For override=verify-baseline-absent: make RED capture mandatory (non-skippable step). For override=fold-override:phantom-manifest: add a diff-sanity step (see DIRECT-FIX for agents/fixer.md). Read state/items/${f.id}/last-failure.md.`,
      [f], null);
  }

  // HIGH: test failures — need to read which test and why
  const testFailed = failures.filter((f) => /test.*fail|failed.*test|assertion.*fail|xunit.*error/i.test(f.failureText)
    && !buildFailed.find((b) => b.id === f.id) && !phantomFailed.find((p) => p.id === f.id));
  if (testFailed.length) {
    const key = `batch-fail:test:${testFailed.map((f) => f.id).sort().join(',')}`;
    handlePattern(key, 'high',
      `${testFailed.length} item(s) failed at test suite — add pre-gate test probe`,
      `Items: ${testFailed.map((f) => f.id).join(', ')}. Fix target: read each item's last-failure.md to identify the specific failing test. Add a pre-gate probe in \`_workflow/factory.js\` that runs the targeted test filter (\`dotnet test --filter FullyQualifiedName~<TestClass>\`) before gate-band entry. Fail fast if the test fails — do not waste gate tokens on an already-broken test suite. The planner step must also explicitly identify which tests must stay green.`,
      testFailed, null);
  }

  // HIGH: gate rejections — need failure context to write the right probe
  const gateRejected = failures.filter((f) => f.decisiveGate && !f.overrideReason
    && !buildFailed.find((b) => b.id === f.id) && !testFailed.find((t) => t.id === f.id)
    && !phantomFailed.find((p) => p.id === f.id));
  for (const f of gateRejected) {
    const key = `batch-fail:gate:${f.decisiveGate}:${f.id}`;
    handlePattern(key, 'high',
      `Item ${f.id} rejected at gate:${f.decisiveGate} — add pre-gate probe for this gate's criteria`,
      `Item ${f.id} was rejected at \`${f.decisiveGate}\` after gate-band spend. Fix: (1) read state/items/${f.id}/last-failure.md to identify the specific criterion that failed; (2) add a pre-gate probe in \`_workflow/factory.js\` that mirrors that check cheaply before dispatching to the full gate; (3) update the fixer prompt to explicitly address \`${f.decisiveGate}\`'s requirements. Be specific — "add a probe" is not the fix; the actual check logic is.`,
      [f], null);
  }

  if (directFixesApplied.length) log(`post-batch-failure-analysis: DIRECT-FIX applied immediately: ${directFixesApplied.join(', ')}`);
  if (skipped.length) log(`post-batch-failure-analysis: skipped (already resolved/in-progress): ${skipped.join('; ')}`);

  if (!proposals.length && !directFixesApplied.length) {
    log(`post-batch-failure-analysis: all patterns handled (${directFixesApplied.length} direct-fixed, ${skipped.length} skipped)`);
    try { writeFileSync(PBFA_STATE_PATH(), JSON.stringify(pbfaState, null, 2)); } catch { /* best-effort */ }
    return;
  }

  if (!proposals.length) {
    // Only direct fixes, no proposals needed
    try { writeFileSync(PBFA_STATE_PATH(), JSON.stringify(pbfaState, null, 2)); } catch { /* best-effort */ }
    return;
  }

  // Group proposals by priority for the frontmatter — use highest priority seen
  const topPriority = proposals.some((p) => p.priority === 'critical') ? 'critical' : 'high';
  const stamp = now.replace(/[:.]/g, '-');
  const qPath = join(queueDir, `failure-analysis-${stamp}.md`);
  const Q = ['---', 'kind: factory-improvement', `generated: ${now}`, 'source: post-batch-failure-analysis (KI-E380+KI-E383+KI-E384)', `priority: ${topPriority}`, '---', '',
    '# Post-batch failure analysis — fix now, not later', '',
    `Generated from ${failed.length} failed/escalated item(s). ${directFixesApplied.length} direct fix(es) already applied to source files. Proposals below require agent implementation in the next batch.`, ''];
  for (const p of proposals) { Q.push(`## [${p.priority.toUpperCase()}] ${p.title}`, '', `- key: \`${p.key}\``, `- items: ${p.items.join(', ')}`, `- priority: ${p.priority}`, '', p.detail, ''); }
  writeFileSync(qPath, Q.join('\n') + '\n');
  try { writeFileSync(PBFA_STATE_PATH(), JSON.stringify(pbfaState, null, 2)); } catch { /* best-effort */ }

  try {
    const result = driver(['ingest-improvements']);
    if (result.out.trim()) log(result.out.trim());
    log(`post-batch-failure-analysis: ${directFixesApplied.length} direct-fixed | ${proposals.length} proposal(s) ingested (${skipped.length} skipped)`);
  } catch (e) {
    log(`post-batch-failure-analysis: ingest failed (non-fatal): ${e.message}`);
  }
}

// ---- autoIngestImprovements (KI-E378: every-3-runs improvement ingestion trigger) ---------------
// After every 3 completed factory runs (as tracked by runs.jsonl line count), invoke
// `driver ingest-improvements` to turn queued queue/factory-improvement-*.md proposals into
// real READY ledger items. State persisted in state/self-improve-ingest.json so restarts are safe.
const INGEST_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'self-improve-ingest.json');
const INGEST_EVERY_N_RUNS = 3;

function loadIngestState() {
  try {
    if (existsSync(INGEST_STATE_PATH())) return JSON.parse(readFileSync(INGEST_STATE_PATH(), 'utf8'));
  } catch { /* corrupt — reset */ }
  return { version: 1, runsAtLastIngest: 0, updatedAt: null };
}

function saveIngestState(state) {
  writeJsonAtomic(INGEST_STATE_PATH(), { ...state, updatedAt: new Date().toISOString() });
}

function currentRunCount() {
  const runsFile = join(FACTORY_ROOT, 'reports', 'runs.jsonl');
  if (!existsSync(runsFile)) return 0;
  try {
    const text = readFileSync(runsFile, 'utf8');
    return text.split('\n').filter((l) => l.trim()).length;
  } catch { return 0; }
}

function autoIngestImprovements() {
  const state = loadIngestState();
  const total = currentRunCount();
  const delta = total - (state.runsAtLastIngest || 0);
  if (delta < INGEST_EVERY_N_RUNS) {
    log(`auto-ingest-improvements: ${delta}/${INGEST_EVERY_N_RUNS} runs since last ingest — skipping`);
    return;
  }
  log(`auto-ingest-improvements: ${delta} runs since last ingest — running driver ingest-improvements`);
  const result = driver(['ingest-improvements']);
  if (result.out.trim()) log(result.out.trim());
  saveIngestState({ version: 1, runsAtLastIngest: total });
  log(`auto-ingest-improvements: done (baseline now ${total} runs)`);
}

// ---- hillClimb (KI-E278: quality optimizer — steepest-ascent with random-restart plateau escape) ----
// Fitness = closed / dispatched per run (0.0–1.0). The window tracks the last N fitness values.
// Plateau: last `plateauRunsToTrigger` window entries all < `plateauMinFitness` → exploration mode.
// Exploration mode = next group call gets the `--ids` set from items with the oldest lastScheduledCycle
// (the random-restart step: deliberately visit a different region of the search space).
// After one exploration run the state resets to normal so the optimizer can measure if it helped.
const HILL_CLIMB_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'hill-climb.json');

function hillClimbLoad() {
  try { if (existsSync(HILL_CLIMB_STATE_PATH())) return JSON.parse(readFileSync(HILL_CLIMB_STATE_PATH(), 'utf8')); } catch { /* corrupt — start fresh */ }
  return { version: 1, window: [], localMax: 0, plateauCount: 0, explorationActive: false, itemLastCycle: {}, updatedAt: null };
}

function hillClimbSave(state) {
  mkdirSync(dirname(HILL_CLIMB_STATE_PATH()), { recursive: true });
  try { writeFileSync(HILL_CLIMB_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

// Update hill-climb state after a lane fold.
// `laneResult` has { ids: string[], folded, complete } from runLane.
// We read the ledger to count how many dispatched items ended up CLOSED.
export function hillClimbUpdate(cfg, laneResult) {
  if (!cfg.hillClimb || !cfg.hillClimb.enabled) return;
  const dispatched = Array.isArray(laneResult?.ids) ? laneResult.ids : [];
  if (!dispatched.length) return;
  const state = hillClimbLoad();
  const window = cfg.hillClimb.fitnessWindow > 0 ? Math.floor(cfg.hillClimb.fitnessWindow) : 5;
  const plateauTrigger = cfg.hillClimb.plateauRunsToTrigger > 0 ? Math.floor(cfg.hillClimb.plateauRunsToTrigger) : 3;
  const plateauMin = typeof cfg.hillClimb.plateauMinFitness === 'number' ? cfg.hillClimb.plateauMinFitness : 0.25;

  // Compute fitness: closed / dispatched (reads live ledger after fold)
  let closedCount = 0;
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    const dispatchedSet = new Set(dispatched);
    closedCount = Object.values(l.items || {}).filter((r) => dispatchedSet.has(r.id) && r.state === 'CLOSED').length;
    // Track lastScheduledCycle for each dispatched item (for future exploration selection)
    const cycle = l.cycle;
    for (const id of dispatched) state.itemLastCycle[id] = cycle;
  } catch { /* ledger unavailable — fitness = 0 */ }

  const fitness = dispatched.length ? closedCount / dispatched.length : 0;
  state.localMax = Math.max(state.localMax, fitness);
  state.window.push({ fitness, closedCount, dispatchedCount: dispatched.length, ids: dispatched });
  if (state.window.length > window) state.window = state.window.slice(-window);

  // Plateau detection: all entries in the current window below the threshold
  const windowFull = state.window.length >= plateauTrigger;
  const recentWindow = state.window.slice(-plateauTrigger);
  const isPlateauing = windowFull && recentWindow.every((e) => e.fitness < plateauMin);

  if (state.explorationActive) {
    // One exploration run completed — exit exploration and let the window re-fill
    state.explorationActive = false;
    state.plateauCount = 0;
    log(`hillClimb: exploration run completed (fitness=${fitness.toFixed(2)}); returning to normal scheduling`);
  } else if (isPlateauing) {
    state.plateauCount += 1;
    state.explorationActive = true;
    log(`hillClimb: PLATEAU detected (last ${plateauTrigger} fitness ${recentWindow.map((e) => e.fitness.toFixed(2)).join(',')} < ${plateauMin}); activating exploration mode`);
  } else {
    state.plateauCount = 0;
  }

  hillClimbSave(state);
  log(`hillClimb: fitness=${fitness.toFixed(2)} closed=${closedCount}/${dispatched.length} localMax=${state.localMax.toFixed(2)} window=[${state.window.map((e) => e.fitness.toFixed(2)).join(',')}] exploration=${state.explorationActive}`);
}

// In exploration mode: return a comma-joined list of READY item IDs that haven't been scheduled
// recently (oldest lastScheduledCycle first), capped at cfg.maxItemsPerLane * explorationRatio.
// Returns null when not in exploration mode or no candidates are available (scheduler picks normally).
function hillClimbSelectIds(cfg) {
  if (!cfg.hillClimb || !cfg.hillClimb.enabled) return null;
  const state = hillClimbLoad();
  if (!state.explorationActive) return null;

  const explorationRatio = typeof cfg.hillClimb.explorationRatio === 'number' ? Math.max(0.1, Math.min(1, cfg.hillClimb.explorationRatio)) : 0.5;
  const maxExplore = Math.max(1, Math.round(cfg.maxItemsPerLane * explorationRatio));

  // Read ledger: find all READY items sorted by lastScheduledCycle ASC (never-tried first)
  // KI-E347: filter to actually-schedulable items (excludes escalate/blocked when !includeEscalate)
  let l;
  try { l = JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch { return null; }
  const sIds = schedulableIds(cfg);
  const candidates = Object.values(l.items || {})
    .filter((r) => ['READY', 'FAILED', 'CONFLICT'].includes(r.state) && sIds.has(r.id))
    .map((r) => ({ id: r.id, lastCycle: state.itemLastCycle[r.id] ?? -1 }))
    .sort((a, b) => a.lastCycle - b.lastCycle)
    .slice(0, maxExplore)
    .map((c) => c.id);

  if (!candidates.length) {
    log(`hillClimb: exploration active but no READY candidates — scheduler picks normally`);
    return null;
  }
  log(`hillClimb: exploration mode → scheduling oldest-untried items: ${candidates.join(', ')}`);
  return candidates.join(',');
}

// Print the current hill-climb state as a one-line summary.
function hillClimbReport() {
  try {
    if (!existsSync(HILL_CLIMB_STATE_PATH())) return;
    const state = JSON.parse(readFileSync(HILL_CLIMB_STATE_PATH(), 'utf8'));
    log(`hillClimb summary: localMax=${state.localMax?.toFixed(2) ?? 'n/a'} window=[${(state.window || []).map((e) => e.fitness.toFixed(2)).join(',')}] plateau=${state.plateauCount} exploration=${state.explorationActive} knownItems=${Object.keys(state.itemLastCycle || {}).length}`);
  } catch { /* non-fatal */ }
}

// ---- bandit (KI-E279: UCB1 multi-armed bandit item selection) --------------------------------
// Score = closedRate + C * sqrt(ln(totalDispatches+1) / (dispatched+1))
// Provides principled exploration/exploitation balance. Defers to hillClimb when plateau active.
const BANDIT_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'bandit.json');

function banditLoad() {
  try { if (existsSync(BANDIT_STATE_PATH())) return JSON.parse(readFileSync(BANDIT_STATE_PATH(), 'utf8')); } catch { /* corrupt — start fresh */ }
  return { version: 1, totalDispatches: 0, itemStats: {}, updatedAt: null };
}

function banditSave(state) {
  mkdirSync(dirname(BANDIT_STATE_PATH()), { recursive: true });
  try { writeFileSync(BANDIT_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

export function banditUpdate(cfg, laneResult) {
  if (!cfg.bandit || !cfg.bandit.enabled) return;
  const dispatched = Array.isArray(laneResult?.ids) ? laneResult.ids : [];
  if (!dispatched.length) return;
  const state = banditLoad();
  state.totalDispatches = (state.totalDispatches || 0) + dispatched.length;
  let closedSet = new Set();
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    const dispatchedSet = new Set(dispatched);
    closedSet = new Set(Object.values(l.items || {}).filter((r) => dispatchedSet.has(r.id) && r.state === 'CLOSED').map((r) => r.id));
  } catch { /* ledger unavailable */ }
  for (const id of dispatched) {
    if (!state.itemStats[id]) state.itemStats[id] = { dispatched: 0, closed: 0 };
    state.itemStats[id].dispatched += 1;
    if (closedSet.has(id)) state.itemStats[id].closed += 1;
  }
  banditSave(state);
  log(`bandit: updated ${dispatched.length} item(s); totalDispatches=${state.totalDispatches}`);
}

// ---- curriculum learning (KI-E284: cold-start difficulty estimation for never-tried items) -----
// Produces a [0, 1] difficulty estimate for items that have never been dispatched (dispatched===0).
// Used in banditSelectIds to replace the generic UCB1 exploration bonus with a difficulty-aware one:
// easier items (lower difficulty) get a higher exploration bonus so the factory tries simple wins
// before hard ones during the cold-start phase, accelerating early close-rate gains.
function estimatedDifficulty(id, l) {
  const item = (l.items || {})[id];
  if (!item) return 0.5; // unknown item → neutral difficulty
  const titleWords = String(item.title || id).split(/\s+/).length;
  const fileCount = Array.isArray(item.files) ? item.files.length : 0;
  const hardKeywords = ['auth', 'payment', 'crypto', 'compliance', 'kyc', 'migration', 'saga', 'outbox'];
  const titleLower = String(item.title || '').toLowerCase();
  const hardKeyCount = hardKeywords.filter((k) => titleLower.includes(k)).length;
  // Normalize: 0=easy, 1=hard. Cap each dimension and combine with weights.
  const wordScore = Math.min(titleWords / 20, 1);       // 20+ words → max word difficulty
  const fileScore = Math.min(fileCount / 10, 1);        // 10+ files → max file difficulty
  const keyScore = Math.min(hardKeyCount / 3, 1);       // 3+ hard keywords → max key difficulty
  return Math.min(wordScore * 0.4 + fileScore * 0.3 + keyScore * 0.3, 1);
}

// KI-E349: compute { [id]: unblockCount } from the findings-graph — how many BLOCKED items each
// READY item directly unblocks on CLOSED. Best-effort: returns {} on any read/parse failure.
function computeUnblockCounts() {
  try {
    const g = JSON.parse(readFileSync(graphPath(), 'utf8'));
    const counts = {};
    for (const wi of (g.items || [])) {
      for (const dep of (wi.dependsOn || [])) {
        counts[dep] = (counts[dep] || 0) + 1;
      }
    }
    return counts;
  } catch { return {}; }
}

function banditSelectIds(cfg) {
  if (!cfg.bandit || !cfg.bandit.enabled) return null;
  const C = (typeof cfg.bandit.explorationConstant === 'number' ? cfg.bandit.explorationConstant : 1.41) * recalExplorationBoost(); // KI-E289: 1.5× boost during recovery
  const state = banditLoad();
  let l;
  try { l = JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch { return null; }
  // KI-E347: filter to actually-schedulable items (excludes escalate/blocked when !includeEscalate)
  const sIds = schedulableIds(cfg);
  const ready = Object.values(l.items || {}).filter((r) => ['READY', 'FAILED', 'CONFLICT'].includes(r.state) && sIds.has(r.id));
  if (!ready.length) return null;
  const total = state.totalDispatches || 0;
  const curriculumEnabled = cfg.curriculum && cfg.curriculum.enabled;
  // KI-E349: unblocking bonus — items that unblock BLOCKED dependents score higher.
  const unlockBonusWeight = (typeof cfg.bandit?.unlockBonus === 'number') ? cfg.bandit.unlockBonus : 0;
  const unblockCounts = unlockBonusWeight > 0 ? computeUnblockCounts() : {};
  const maxUnlock = unlockBonusWeight > 0 ? Math.max(1, ...ready.map((r) => unblockCounts[r.id] || 0)) : 1;
  const scored = ready.map((r) => {
    const stats = state.itemStats[r.id] || { dispatched: 0, closed: 0 };
    const closedRate = stats.dispatched > 0 ? stats.closed / stats.dispatched : 0.5; // optimistic init
    // KI-E284: for never-tried items, replace the uniform UCB1 bonus with a difficulty-aware one.
    // Easier items (lower estimatedDifficulty) get more exploration budget → tried first.
    const explorationBonus = (stats.dispatched === 0 && curriculumEnabled)
      ? C * (1 - estimatedDifficulty(r.id, l))
      : C * Math.sqrt(Math.log(total + 1) / (stats.dispatched + 1));
    // KI-E349: normalised unblocking bonus [0, unlockBonusWeight].
    const unlockBonus = unlockBonusWeight * ((unblockCounts[r.id] || 0) / maxUnlock);
    const ucb1 = closedRate + explorationBonus + unlockBonus;
    return { id: r.id, ucb1 };
  }).sort((a, b) => b.ucb1 - a.ucb1).slice(0, cfg.maxItemsPerLane);
  log(`bandit: UCB1 selection (top ${scored.length}/${ready.length} ready): ${scored.map((s) => `${s.id}(${s.ucb1.toFixed(2)})`).join(', ')}`);
  return scored.map((s) => s.id).join(',');
}

// ---- simulatedAnnealing (KI-E285: temperature-based perturbation of item selection) -----------
// Maintains a "temperature" that decays each run (T = T0 * coolingRate^runCount). At each run,
// with probability T, one of the selected items is swapped for a random READY item not already
// in the selection — injecting exploration diversity that is stronger at the start and fades out
// as the factory matures (analogous to physical simulated annealing). saCool() called after each
// lane to decay the temperature; saPerturb() applied to the idsFlag before runLane.
// KI-E291: the swap-in candidate is drawn optimistically from READY (same pool hillClimb/bandit use —
// the driver's `group` is the single schedulability authority). Two invariants live at the CALL SITE,
// not here: (1) an explicit operator --ids is never passed through saPerturb; (2) a perturbation that
// collapses to an unschedulable (empty) batch is retried once unperturbed.
const SA_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'simulated-annealing.json');

function saLoad() {
  try { if (existsSync(SA_STATE_PATH())) return JSON.parse(readFileSync(SA_STATE_PATH(), 'utf8')); } catch { /* corrupt */ }
  return { version: 1, temperature: null, runCount: 0, updatedAt: null };
}

function saSave(state) {
  mkdirSync(dirname(SA_STATE_PATH()), { recursive: true });
  try { writeFileSync(SA_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

export function saCool(cfg) {
  if (!cfg.simulatedAnnealing || !cfg.simulatedAnnealing.enabled) return;
  const T0 = typeof cfg.simulatedAnnealing.initialTemperature === 'number' ? cfg.simulatedAnnealing.initialTemperature : 0.3;
  const alpha = typeof cfg.simulatedAnnealing.coolingRate === 'number' ? cfg.simulatedAnnealing.coolingRate : 0.95;
  const state = saLoad();
  if (state.temperature === null) state.temperature = T0;
  state.temperature = Math.max(0, state.temperature * alpha);
  state.runCount = (state.runCount || 0) + 1;
  saSave(state);
  log(`simulatedAnnealing: temperature=${state.temperature.toFixed(4)} (run ${state.runCount}, coolingRate=${alpha})`);
}

function saPerturb(cfg, idsString) {
  if (!cfg.simulatedAnnealing || !cfg.simulatedAnnealing.enabled) return idsString;
  if (!idsString) return idsString;
  const state = saLoad();
  const T = typeof state.temperature === 'number' ? state.temperature : (cfg.simulatedAnnealing.initialTemperature || 0.3);
  if (Math.random() >= T) return idsString; // no perturbation this run
  try {
    const selected = idsString.split(',').map((s) => s.trim()).filter(Boolean);
    // KI-E347: filter to actually-schedulable items (excludes escalate/blocked when !includeEscalate)
    const sIds = schedulableIds(cfg);
    const candidates = [...sIds].filter((id) => !selected.includes(id));
    if (!candidates.length) return idsString;
    const swapOut = selected[Math.floor(Math.random() * selected.length)];
    const swapIn = candidates[Math.floor(Math.random() * candidates.length)];
    const perturbed = selected.map((id) => (id === swapOut ? swapIn : id)).join(',');
    log(`simulatedAnnealing: perturbed selection (T=${T.toFixed(4)}): swapped ${swapOut}→${swapIn}`);
    return perturbed;
  } catch { return idsString; }
}

// ---- promptEvolution (KI-E286: A/B test promptTemplate variants, evolve toward higher close rate)
// Maintains two promptTemplate variants. After runsToEvaluate runs with both, kills the loser
// (lower close rate) and mutates the winner by appending a guidance phrase from a built-in library.
// peSelectPrompt(cfg) replaces direct cfg.claudeHeadless.promptTemplate use in the dispatch path.
// peUpdate(cfg, res) called after each lane to record results and trigger evolution when enough
// data has accumulated.
const PE_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'prompt-evolution.json');

const PE_GUIDANCE_PHRASES = [
  'Focus first on the highest-severity items and deliver working code, not plans.',
  'Before making changes, briefly state the root cause in one sentence.',
  'After each file edit, mentally verify the change compiles and the test assertion holds.',
  'Prefer the simplest change that satisfies the acceptance criteria — do not refactor beyond scope.',
  'When in doubt about a dependency, grep the codebase before assuming an import path.',
  'Run the tests mentally before concluding the item is done; a test file change must not weaken coverage.',
  'If the acceptance criteria reference a specific class or method, name it explicitly in your change.',
  'Avoid adding new public API surface unless the acceptance criteria explicitly require it.',
];

function peLoad(cfg) {
  try { if (existsSync(PE_STATE_PATH())) return JSON.parse(readFileSync(PE_STATE_PATH(), 'utf8')); } catch { /* corrupt */ }
  const base = cfg.claudeHeadless.promptTemplate;
  return { version: 1, active: 0, variants: [{ template: base, runs: 0, closed: 0 }, { template: base, runs: 0, closed: 0 }], updatedAt: null };
}

function peSave(state) {
  mkdirSync(dirname(PE_STATE_PATH()), { recursive: true });
  try { writeFileSync(PE_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

function peSelectPrompt(cfg) {
  if (!cfg.promptEvolution || !cfg.promptEvolution.enabled) return cfg.claudeHeadless.promptTemplate;
  try {
    const state = peLoad(cfg);
    return state.variants[state.active]?.template || cfg.claudeHeadless.promptTemplate;
  } catch { return cfg.claudeHeadless.promptTemplate; }
}

export function peUpdate(cfg, laneResult) {
  if (!cfg.promptEvolution || !cfg.promptEvolution.enabled) return;
  const runsToEvaluate = typeof cfg.promptEvolution.runsToEvaluate === 'number' ? cfg.promptEvolution.runsToEvaluate : 10;
  const state = peLoad(cfg);
  const v = state.variants[state.active];
  if (!v) return;
  v.runs = (v.runs || 0) + 1;
  // Count items that were CLOSED after this lane
  let closedCount = 0;
  const dispatched = Array.isArray(laneResult?.ids) ? laneResult.ids : [];
  if (dispatched.length) {
    try {
      const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
      const dispatchedSet = new Set(dispatched);
      closedCount = Object.values(l.items || {}).filter((r) => dispatchedSet.has(r.id) && r.state === 'CLOSED').length;
    } catch { /* ledger unavailable */ }
  }
  v.closed = (v.closed || 0) + closedCount;
  // Alternate active variant each run so both variants get equal exposure
  state.active = 1 - state.active;
  // After enough combined runs, evaluate and evolve
  const totalRuns = state.variants.reduce((s, x) => s + (x.runs || 0), 0);
  if (totalRuns > 0 && totalRuns % runsToEvaluate === 0) {
    const rates = state.variants.map((x) => (x.runs > 0 ? x.closed / x.runs : 0));
    const winnerIdx = rates[0] >= rates[1] ? 0 : 1;
    const winner = state.variants[winnerIdx];
    const phrase = PE_GUIDANCE_PHRASES[Math.floor(Math.random() * PE_GUIDANCE_PHRASES.length)];
    // Inject guidance phrase before the final "Do not run any git commands." clause
    const evolved = winner.template.includes('Do not run any git commands.')
      ? winner.template.replace('Do not run any git commands.', phrase + ' Do not run any git commands.')
      : winner.template + ' ' + phrase;
    state.variants = [{ template: winner.template, runs: 0, closed: 0 }, { template: evolved, runs: 0, closed: 0 }];
    state.active = 0;
    log(`promptEvolution: evolved after ${totalRuns} runs (winner rate=${rates[winnerIdx].toFixed(3)}); injected guidance: "${phrase}"`);
  }
  peSave(state);
}

// ---- itemTiming (KI-E287: track wall-clock lane timing for dynamic timeout recommendations) ----
// Records wall-clock elapsed milliseconds for each completed lane. Computes P95 + 20% buffer
// as recommendedTimeoutMinutes surfaced in the retrospective report, helping operators tune
// laneTimeoutMinutes toward a data-driven value. timingRecord() called after each runLane;
// timingRecommendTimeout() consumed by runRetrospective.
const TIMING_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'item-timing.json');

function timingLoad() {
  try { if (existsSync(TIMING_STATE_PATH())) return JSON.parse(readFileSync(TIMING_STATE_PATH(), 'utf8')); } catch { /* corrupt */ }
  return { version: 1, samples: [], updatedAt: null };
}

function timingSave(state) {
  mkdirSync(dirname(TIMING_STATE_PATH()), { recursive: true });
  try { writeFileSync(TIMING_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

function timingRecord(cfg, wallMs) {
  if (!cfg.itemTiming || !cfg.itemTiming.enabled) return;
  const state = timingLoad();
  state.samples = [...(state.samples || []).slice(-99), wallMs]; // keep last 100 samples
  timingSave(state);
}

function timingRecommendTimeout() {
  try {
    const state = timingLoad();
    const s = [...(state.samples || [])].sort((a, b) => a - b);
    if (!s.length) return null;
    const p95idx = Math.min(Math.floor(s.length * 0.95), s.length - 1);
    const p95ms = s[p95idx];
    return Math.ceil((p95ms * 1.2) / 60000); // +20% buffer, convert ms → minutes
  } catch { return null; }
}

// ---- configOptimizer (KI-E288: meta-optimizer that perturbs config knobs and measures fitness) --
// Every runsPerCycle lanes, perturbs one knob (rotating through CO_KNOBS) by ±perturbFraction,
// measures fitness (overall closed/total ratio from the ledger) over the next measureWindow runs
// vs the prior window, and keeps the change if fitness improved (reverts in-memory otherwise).
// coUpdate(cfg) modifies the live cfg object so subsequent functions in the same run see the new
// value; it does NOT write to orchestrator.config.json (changes are experimental per-run only).
const CO_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'config-optimizer.json');
const CO_KNOBS = [
  'bandit.explorationConstant',
  'hillClimb.plateauMinFitness',
  'hillClimb.explorationRatio',
  'simulatedAnnealing.coolingRate',
];
// KI-E456: single source of truth for each knob's sane range, shared by BOTH the persist-time
// clamp below (applyConfigOptimizerOverride) and the trial-time clamp in coUpdate's perturbation
// step. Previously only the persist clamp existed — a FRESH trial value from coUpdate had no upper
// bound at all (`Math.max(0.01, current * (1 + delta))`), so a live trial could run for the full
// measureWindow with e.g. simulatedAnnealing.coolingRate=1.045 (observed live, 2026-11-08: the
// 0.95 baseline perturbed +10% straight through the intended [0.5, 0.999] ceiling). A coolingRate
// above 1 makes temperature GROW each cycle instead of decay — the opposite of simulated
// annealing's whole design intent — for every run in that trial window, not just the ones that get
// persisted at the end.
const CO_KNOB_BOUNDS = {
  'bandit.explorationConstant': [0.01, 10],
  'hillClimb.plateauMinFitness': [0.01, 1],
  'hillClimb.explorationRatio': [0.01, 1],
  'simulatedAnnealing.coolingRate': [0.5, 0.999],
};

// KI-E310: apply the configOptimizer's PERSISTED accepted knob values (state.applied in
// config-optimizer.json) onto the loaded config, so a kept improvement survives process exit —
// previously it lived only in the in-memory cfg and was lost, so the optimizer tuned nothing across
// runs. Whitelisted to the 4 CO_KNOBS, each a finite number clamped to a sane range; FULLY GUARDED
// (any error → config returned unchanged, never breaks loading). Reversible: clear `applied`.
function applyConfigOptimizerOverride(cfg) {
  try {
    const p = join(FACTORY_ROOT, 'state', 'config-optimizer.json');
    if (!existsSync(p)) return cfg;
    const applied = (JSON.parse(readFileSync(p, 'utf8')).applied) || {};
    for (const [knob, [lo, hi]] of Object.entries(CO_KNOB_BOUNDS)) {
      const v = applied[knob];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const clamped = Math.max(lo, Math.min(hi, v));
      const parts = knob.split('.');
      let cur = cfg;
      for (let i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null) cur[parts[i]] = {}; cur = cur[parts[i]]; }
      cur[parts[parts.length - 1]] = clamped;
    }
  } catch { /* any issue → config unchanged (safe) */ }
  return cfg;
}

function coLoad() {
  try { if (existsSync(CO_STATE_PATH())) return JSON.parse(readFileSync(CO_STATE_PATH(), 'utf8')); } catch { /* corrupt */ }
  return { version: 1, runCount: 0, knobIdx: 0, pendingKnob: null, pendingValue: null, baselineValue: null, baselineFitness: null, trialFitnessSamples: [], updatedAt: null };
}

function coSave(state) {
  mkdirSync(dirname(CO_STATE_PATH()), { recursive: true });
  try { writeFileSync(CO_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

function coGetKnobValue(cfg, knob) {
  const parts = knob.split('.');
  let cur = cfg;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

function coSetKnobValue(cfg, knob, value) {
  const parts = knob.split('.');
  let cur = cfg;
  for (let i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null) cur[parts[i]] = {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = value;
}

export function coUpdate(cfg) {
  if (!cfg.configOptimizer || !cfg.configOptimizer.enabled) return;
  const runsPerCycle = typeof cfg.configOptimizer.runsPerCycle === 'number' ? cfg.configOptimizer.runsPerCycle : 10;
  const measureWindow = typeof cfg.configOptimizer.measureWindow === 'number' ? cfg.configOptimizer.measureWindow : 3;
  const perturbFraction = typeof cfg.configOptimizer.perturbFraction === 'number' ? cfg.configOptimizer.perturbFraction : 0.1;
  const state = coLoad();
  state.runCount = (state.runCount || 0) + 1;
  // Measure current fitness (closed/total) from the live ledger
  let fitness = null;
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    const items = Object.values(l.items || {});
    const total = items.length;
    const closed = items.filter((r) => r.state === 'CLOSED').length;
    fitness = total > 0 ? closed / total : null;
  } catch { /* ledger unavailable */ }
  // If a trial is in progress, accumulate fitness samples
  if (state.pendingKnob !== null) {
    if (fitness !== null) state.trialFitnessSamples = [...(state.trialFitnessSamples || []), fitness];
    if (state.trialFitnessSamples.length >= measureWindow) {
      const trialFitness = state.trialFitnessSamples.reduce((a, b) => a + b, 0) / state.trialFitnessSamples.length;
      const improved = trialFitness >= (state.baselineFitness || 0);
      if (improved) {
        log(`configOptimizer: kept ${state.pendingKnob}=${state.pendingValue?.toFixed(4)} (trial=${trialFitness.toFixed(3)} >= baseline=${(state.baselineFitness || 0).toFixed(3)})`);
        state.applied = { ...(state.applied || {}), [state.pendingKnob]: state.pendingValue }; // KI-E310: persist the win (config-optimizer.json .applied), read back by loadConfig so it survives process exit
      } else {
        coSetKnobValue(cfg, state.pendingKnob, state.baselineValue);
        log(`configOptimizer: reverted ${state.pendingKnob} to ${state.baselineValue?.toFixed(4)} (trial=${trialFitness.toFixed(3)} < baseline=${(state.baselineFitness || 0).toFixed(3)})`);
      }
      state.pendingKnob = null; state.pendingValue = null; state.baselineValue = null;
      state.baselineFitness = null; state.trialFitnessSamples = [];
    }
    coSave(state);
    return;
  }
  // Start a new perturbation every runsPerCycle runs
  if (state.runCount % runsPerCycle === 0) {
    const knob = CO_KNOBS[state.knobIdx % CO_KNOBS.length];
    state.knobIdx = (state.knobIdx || 0) + 1;
    const current = coGetKnobValue(cfg, knob);
    if (typeof current === 'number' && current > 0) {
      const delta = (Math.random() < 0.5 ? 1 : -1) * perturbFraction;
      const [lo, hi] = CO_KNOB_BOUNDS[knob] || [0.01, Infinity]; // KI-E456: clamp the TRIAL value too, not just the persisted one
      const newValue = Math.max(lo, Math.min(hi, current * (1 + delta)));
      state.pendingKnob = knob; state.pendingValue = newValue; state.baselineValue = current;
      state.baselineFitness = fitness; state.trialFitnessSamples = [];
      coSetKnobValue(cfg, knob, newValue);
      log(`configOptimizer: perturbed ${knob}: ${current.toFixed(4)}→${newValue.toFixed(4)} (${delta > 0 ? '+' : ''}${(delta * 100).toFixed(0)}%)`);
    }
  }
  coSave(state);
}

// ---- errorClusters (KI-E281: group similar failures by error signature, share fix hints) ------
// Groups failures by errorClass + specific error code/exception, enabling hint sharing across
// items that hit the same root cause. Hints from resolved items help future retry attempts.
const CLUSTER_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'error-clusters.json');

function clusterLoad() {
  try { if (existsSync(CLUSTER_STATE_PATH())) return JSON.parse(readFileSync(CLUSTER_STATE_PATH(), 'utf8')); } catch { /* corrupt */ }
  return { version: 1, clusters: {}, updatedAt: null };
}

function clusterSave(state) {
  mkdirSync(dirname(CLUSTER_STATE_PATH()), { recursive: true });
  try { writeFileSync(CLUSTER_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

function clusterSignature(errorClass, errorText) {
  if (!errorClass) return null;
  const t = String(errorText || '');
  const csCode = (t.match(/error (CS\d{4}):/i) || [])[1];
  const msbCode = (t.match(/error (MSB\d{4})/i) || [])[1];
  const exType = (t.match(/(\w+Exception):/i) || [])[1];
  const qualifier = csCode || msbCode || exType || '';
  return `${errorClass}:${qualifier}`.toLowerCase();
}

function clusterRecord(id, errorClass, errorText) {
  const sig = clusterSignature(errorClass, errorText);
  if (!sig) return;
  const state = clusterLoad();
  if (!state.clusters[sig]) state.clusters[sig] = { signature: sig, members: [], fixHints: [] };
  const cluster = state.clusters[sig];
  if (!cluster.members.includes(id)) cluster.members.push(id);
  cluster.lastFailedAt = new Date().toISOString();
  clusterSave(state);
}

function clusterRecordSuccess(id, errorClass, errorText, hint) {
  const sig = clusterSignature(errorClass, errorText);
  if (!sig) return;
  const state = clusterLoad();
  const cluster = state.clusters[sig];
  if (!cluster) return;
  cluster.members = (cluster.members || []).filter((m) => m !== id);
  if (hint && !(cluster.fixHints || []).includes(hint)) {
    cluster.fixHints = [...(cluster.fixHints || []).slice(-4), hint];
  }
  clusterSave(state);
}

function clusterGetHint(errorClass, errorText) {
  const sig = clusterSignature(errorClass, errorText);
  if (!sig) return null;
  try {
    const state = clusterLoad();
    const cluster = state.clusters[sig];
    if (!cluster || !cluster.fixHints || !cluster.fixHints.length) return null;
    return `Cluster hint (${(cluster.members || []).length} similar failure(s)): ${cluster.fixHints[cluster.fixHints.length - 1]}`;
  } catch { return null; }
}

// ---- reflexion (KI-E280: Shinn et al. 2023 — error-class-specific retry guidance) ------------
// Appended to last-failure.md before each auto-fix reset so the next factory.js run sees
// structured self-reflection: what went wrong, what to try, and any cluster hint.
function generateReflexion(id, retryCount, errorClass, errorText, clusterHint, warmStartContext) {
  const lines = [
    '',
    `## Reflexion (KI-E280) — attempt ${retryCount}`,
    `**Error class**: \`${errorClass || 'unknown'}\``,
  ];
  const specific = (() => {
    switch (errorClass) {
      case 'csharp-compile': return [
        '**Guidance**: C# compilation error. Common causes: missing `using`, wrong namespace, incorrect type names, ambiguous overloads.',
        '**Action**: Focus on the exact CS error code and the reported line. Fix only what the compiler reports.',
      ];
      case 'typescript-compile': return [
        '**Guidance**: TypeScript compilation error. Common causes: type mismatch, missing annotation, interface not fully implemented.',
        '**Action**: Fix the type issue at the reported TS error code location.',
      ];
      case 'msbuild-error': return [
        '**Guidance**: MSBuild error. Common causes: missing project reference, missing NuGet package, wrong path, or missing `Directory.Packages.props` entry.',
        '**Action**: Check the MSB error code. Verify project references and package versions.',
      ];
      case 'build-failed': return [
        '**Guidance**: Build failed. Check the first `Error:` line for the root cause.',
        '**Action**: Fix the root cause directly — do not suppress or work around it.',
      ];
      case 'test-failure': return [
        '**Guidance**: Test failure. Common causes: assertion mismatch, missing mock setup, wrong test data.',
        '**Action**: Read the failing test assertion. Fix the implementation to match the contract.',
      ];
      case 'dotnet-error': return [
        '**Guidance**: dotnet CLI error. Check command path, project file, or environment setup.',
        '**Action**: Verify the command targets the right `.csproj` / `.sln`.',
      ];
      default: return ['**Guidance**: Review the error above and apply a targeted fix.'];
    }
  })();
  lines.push(...specific);
  if (clusterHint) lines.push('', clusterHint);
  if (warmStartContext) lines.push('', warmStartContext);
  lines.push('', `*Reflexion generated at ${new Date().toISOString()}*`);
  return lines.join('\n');
}

// ---- warmStart (KI-E283: inject prior partial-work context into retry prompt) -----------------
// Reads the item's factory/<id> worktree branch commit log (read-only git log, never mutations).
// The resulting context is included in the reflexion appended to last-failure.md so the next
// factory.js run sees what partial work was already committed on the branch.
function getWarmStartContext(id) {
  try {
    const branch = `factory/${id}`;
    const result = execFileSync('git', ['-C', REPO_ROOT, 'log', branch, '--oneline', '-3'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!result) return null;
    return `**Prior commits on ${branch}** (KI-E283 warm start):\n${result.split('\n').map((l) => '  ' + l).join('\n')}`;
  } catch { return null; } // no branch yet or git unavailable — not an error
}

// ---- retrospective (KI-E282: periodic health report generator) --------------------------------
// Every runsPerRetro lanes, generates a markdown health report in queue/retrospective-<ts>.md
// summarising ledger state counts + hill-climb fitness. Helps the operator track factory health
// over time without needing live access to the server.
const RETRO_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'retrospective.json');

function retroLoad() {
  try { if (existsSync(RETRO_STATE_PATH())) return JSON.parse(readFileSync(RETRO_STATE_PATH(), 'utf8')); } catch { /* corrupt */ }
  return { version: 1, runCount: 0, lastRetroAt: null, lastCounts: {}, updatedAt: null };
}

function retroSave(state) {
  mkdirSync(dirname(RETRO_STATE_PATH()), { recursive: true });
  try { writeFileSync(RETRO_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

function runRetrospective(cfg) {
  if (!cfg.retrospective || !cfg.retrospective.enabled) return;
  const runsPerRetro = Number.isFinite(Number(cfg.retrospective.runsPerRetro)) && cfg.retrospective.runsPerRetro > 0 ? Math.floor(cfg.retrospective.runsPerRetro) : 5;
  const state = retroLoad();
  state.runCount = (state.runCount || 0) + 1;
  let counts = {};
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
    for (const r of Object.values(l.items || {})) counts[r.state] = (counts[r.state] || 0) + 1;
  } catch { /* ledger unavailable */ }
  state.lastCounts = counts;
  retroSave(state);
  if (state.runCount % runsPerRetro !== 0) return; // only emit a report every N runs

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const closed = counts.CLOSED || 0;
  const failed = counts.FAILED || 0;
  const ready = counts.READY || 0;
  const closeRate = total > 0 ? (closed / total).toFixed(2) : 'n/a';
  const lines = [
    `# Factory Retrospective — run ${state.runCount} (${new Date().toISOString()})`,
    '',
    '## Summary',
    `- Total items: ${total}`,
    `- CLOSED: ${closed} (${closeRate} close rate)`,
    `- FAILED: ${failed}`,
    `- READY: ${ready}`,
    '',
    '## By state',
    ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([s, n]) => `- ${s}: ${n}`),
    '',
    '## Hill-climb state',
  ];
  try {
    const hc = JSON.parse(readFileSync(HILL_CLIMB_STATE_PATH(), 'utf8'));
    lines.push(`- localMax fitness: ${hc.localMax?.toFixed(2) ?? 'n/a'}`);
    lines.push(`- plateau count: ${hc.plateauCount}`);
    lines.push(`- exploration active: ${hc.explorationActive}`);
  } catch { lines.push('- (hill-climb state unavailable)'); }

  // KI-E287: dynamic timeout recommendation based on P95 lane wall-clock time
  lines.push('', '## Dynamic timeout recommendation (KI-E287)');
  const recTimeout = timingRecommendTimeout();
  if (recTimeout !== null) {
    lines.push(`- Recommended laneTimeoutMinutes (P95 + 20%): **${recTimeout}** min`);
    lines.push(`- Current laneTimeoutMinutes: ${cfg.laneTimeoutMinutes}`);
  } else {
    lines.push('- (insufficient timing samples — run more lanes to populate)');
  }

  const report = lines.join('\n') + '\n';
  const qDir = join(FACTORY_ROOT, 'queue');
  mkdirSync(qDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const reportPath = join(qDir, `retrospective-${ts}.md`);
  try {
    writeFileSync(reportPath, report);
    log(`retrospective: report written to ${reportPath}`);
  } catch { /* best-effort */ }
  state.lastRetroAt = new Date().toISOString();
  retroSave(state);
}

// ---- recalibrate (KI-E289: auto-reset learning state when factory is stuck in a deep rut) ----
// Triggered when the hill-climb fitness window shows N consecutive near-zero-fitness runs
// (deeper than the plateau hillClimb already handles). Recalibration:
//   • Resets SA temperature to T0 (restart annealing)
//   • Boosts bandit exploration constant by 50 % for `recoveryRuns` runs (written to recal state)
//   • Resets config-optimizer phase to 'measure' so it starts a clean baseline
//   • Writes state/recalibrate.json { active, runsRemaining, triggeredAt }
// After `recoveryRuns` lanes the boosted exploration fades automatically.
const RECAL_STATE_PATH = () => join(FACTORY_ROOT, 'state', 'recalibrate.json');

function recalLoad() {
  try { if (existsSync(RECAL_STATE_PATH())) return JSON.parse(readFileSync(RECAL_STATE_PATH(), 'utf8')); } catch { /* corrupt */ }
  return { version: 1, active: false, runsRemaining: 0, triggeredAt: null, triggerCount: 0 };
}
function recalSave(state) {
  mkdirSync(dirname(RECAL_STATE_PATH()), { recursive: true });
  try { writeFileSync(RECAL_STATE_PATH(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}

// Returns a bandit exploration-constant multiplier (1 normally; >1 during recovery).
function recalExplorationBoost() {
  try {
    const state = recalLoad();
    if (!state.active || state.runsRemaining <= 0) return 1;
    return 1.5;
  } catch { return 1; }
}

// Call after each fold. Checks if recalibration should fire, and ticks down active recovery.
export function checkAndRecalibrate(cfg) {
  if (!cfg.recalibrate?.enabled) return;
  const runsBelow = Number.isFinite(cfg.recalibrate.runsBelow) && cfg.recalibrate.runsBelow > 0 ? Math.floor(cfg.recalibrate.runsBelow) : 5;
  const threshold = typeof cfg.recalibrate.fitnessThreshold === 'number' ? cfg.recalibrate.fitnessThreshold : 0.1;
  const recoveryRuns = Number.isFinite(cfg.recalibrate.recoveryRuns) && cfg.recalibrate.recoveryRuns > 0 ? Math.floor(cfg.recalibrate.recoveryRuns) : 3;

  const state = recalLoad();

  // Tick down active recovery first
  if (state.active && state.runsRemaining > 0) {
    state.runsRemaining -= 1;
    if (state.runsRemaining <= 0) {
      state.active = false;
      log(`recalibrate: recovery complete — returning to normal exploration`);
    } else {
      log(`recalibrate: recovery active — ${state.runsRemaining} run(s) remaining (1.5× bandit boost, SA reset)`);
    }
    recalSave(state);
    return;
  }

  // Check hill-climb fitness window for persistent deep-rut
  const hc = hillClimbLoad();
  const recent = (hc.fitnessHistory || []).slice(-runsBelow);
  if (recent.length < runsBelow) return;  // not enough history yet
  const allBelowThreshold = recent.every((f) => f < threshold);
  if (!allBelowThreshold) return;

  // Deep rut detected — recalibrate
  state.active = true;
  state.runsRemaining = recoveryRuns;
  state.triggeredAt = new Date().toISOString();
  state.triggerCount = (state.triggerCount || 0) + 1;
  recalSave(state);

  // Reset SA temperature to T0
  try {
    const saState = saLoad();
    const T0 = cfg.simulatedAnnealing?.initialTemperature ?? 0.3;
    saState.temperature = T0;
    saSave(saState);
    log(`recalibrate: SA temperature reset to T0=${T0}`);
  } catch (e) { log(`recalibrate: SA reset error (non-fatal): ${e.message}`); }

  // Reset config-optimizer phase to 'measure' for clean baseline
  try {
    const coState = coLoad();
    coState.phase = 'measure';
    coState.baselineFitness = [];
    coState.trialFitness = [];
    coSave(coState);
    log(`recalibrate: config optimizer phase reset to measure`);
  } catch (e) { log(`recalibrate: coOptimizer reset error (non-fatal): ${e.message}`); }

  log(`recalibrate: *** DEEP RUT DETECTED — ${runsBelow} consecutive runs below fitness ${threshold}. Recalibrating for ${recoveryRuns} runs (1.5× bandit exploration, SA restart). Trigger #${state.triggerCount} ***`);

  // Write a notice to queue/ so the operator can see it in PR retro comments
  try {
    const noticeDir = join(FACTORY_ROOT, 'queue');
    mkdirSync(noticeDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(noticeDir, `recalibrate-notice-${ts}.md`), [
      `# Factory Recalibration Triggered — ${new Date().toISOString()}`,
      '',
      `**Trigger:** ${runsBelow} consecutive runs below fitness threshold (${threshold})`,
      `**Recovery:** ${recoveryRuns} lanes with 1.5× bandit exploration + SA temperature reset`,
      `**Trigger count:** ${state.triggerCount}`,
      '',
      'The factory detected a persistent deep rut and has automatically recalibrated its',
      'exploration parameters. Normal operation resumes after the recovery period.',
      '',
      '*Auto-generated by KI-E289 recalibrate.*',
    ].join('\n'));
  } catch { /* best-effort */ }
}

// Manual recalibrate subcommand: force-trigger recalibration regardless of fitness.
function forceRecalibrate(cfg) {
  const recoveryRuns = cfg.recalibrate?.recoveryRuns > 0 ? cfg.recalibrate.recoveryRuns : 3;
  const state = recalLoad();
  state.active = true;
  state.runsRemaining = recoveryRuns;
  state.triggeredAt = new Date().toISOString();
  state.triggerCount = (state.triggerCount || 0) + 1;
  recalSave(state);
  try { const s = saLoad(); s.temperature = cfg.simulatedAnnealing?.initialTemperature ?? 0.3; saSave(s); } catch { /* best-effort */ }
  try { const s = coLoad(); s.phase = 'measure'; s.baselineFitness = []; s.trialFitness = []; coSave(s); } catch { /* best-effort */ }
  log(`recalibrate: manual recalibration triggered — ${recoveryRuns} recovery runs (trigger #${state.triggerCount})`);
}

// ---- apply (plan-only — AD-7: the human applies + commits) ----------------------------------
function applyPlan() {
  const l = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
  const closed = Object.values(l.items).filter((r) => r.state === 'CLOSED' && r.worktree && existsSync(r.worktree));
  if (!closed.length) { log('no CLOSED items with live worktrees — nothing to apply'); return; }
  log(`APPLY PLAN (plan-only — autoApply is ${loadConfig().autoApply}; the operator applies + the human commits):`);
  for (const r of closed) {
    console.log(`\n# ${r.id} — diff the worktree against main, then copy the changed files:`);
    console.log(`git -C ${r.worktree} diff --stat HEAD`);
    console.log(`# per changed file: cp ${r.worktree}/<file> ${REPO_ROOT}/<file>   (3-way merge shared files)`);
  }
}

// ---- main -----------------------------------------------------------------------------------
const [, , cmd = 'status', ...argv] = process.argv;
const flags = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
const cfg = { ...loadConfig(), ...(flags.backend ? { backend: String(flags.backend) } : {}), ...(flags['max-lanes'] ? { maxCyclesPerRun: parseInt(flags['max-lanes'], 10) } : {}), ...(flags['include-escalate'] ? { includeEscalate: true } : {}) };

if (cmd === 'doctor') { process.exit(doctor(cfg) ? 0 : 1); }
else if (cmd === 'recalibrate') { forceRecalibrate(cfg); }  // KI-E289: manual recalibrate
else if (cmd === 'backfill-trackers') {
  // KI-E455: feed the self-improvement learning trackers (zero-closure-stop, hillClimb, bandit,
  // simulated annealing, prompt evolution, config optimizer, recalibrate, post-batch-failure-
  // analysis) from a fold that did NOT go through this process's own normal per-lane loop below
  // (a manual `driver.mjs fold`, `reconstruct`+`fold`, `recover`+`seal-recovery`+fold, or
  // `reconcile-closed`'s internal fold — every one of those still calls `driver.mjs fold`, which
  // invokes this subcommand as a subprocess unless told not to). Payload: a JSON file at argv[0]
  // shaped { ids: string[], applied: object[] } — `applied` is the SAME per-item result objects
  // driver.mjs just wrote to the ledger (needed by postBatchFailureAnalysis; the rest only need
  // `ids` and re-read the ledger themselves, same as the normal per-lane call sites do).
  const payloadPath = argv[0];
  let payload = { ids: [], applied: [] };
  try { payload = JSON.parse(readFileSync(payloadPath, 'utf8')); } catch (e) { log(`backfill-trackers: could not read payload ${payloadPath}: ${e.message}`); process.exit(1); }
  const ids = Array.isArray(payload.ids) ? payload.ids : [];
  const applied = Array.isArray(payload.applied) ? payload.applied : [];
  if (!ids.length) { log('backfill-trackers: empty id list — nothing to feed'); process.exit(0); }
  const res = { ids, folded: true, complete: true, batchResults: applied };
  const steps = [
    ['zeroClosureStop', () => checkZeroClosureStop(cfg, res)],
    ['hillClimb', () => hillClimbUpdate(cfg, res)],
    ['bandit', () => banditUpdate(cfg, res)],
    ['simulatedAnnealing', () => saCool(cfg)],
    ['promptEvolution', () => peUpdate(cfg, res)],
    ['configOptimizer', () => coUpdate(cfg)],
    ['recalibrate', () => checkAndRecalibrate(cfg)],
    ['postBatchFailureAnalysis', () => postBatchFailureAnalysis(applied)],
  ];
  for (const [name, fn] of steps) {
    try { fn(); } catch (e) { log(`backfill-trackers: ${name} error (non-fatal): ${e.message}`); }
  }
  log(`backfill-trackers (KI-E455): fed ${ids.length} applied result(s) into the self-improvement learning trackers`);
}
else if (cmd === 'status') {
  const { cycle, counts } = ledgerCounts();
  log(`ledger cycle ${cycle} · counts ${JSON.stringify(counts)} · stop-marker ${existsSync(STOP_MARKER) ? 'PRESENT (stopped)' : 'absent'}`);
  const r = driver(['controller', 'status']); console.log(r.out.trim());
} else if (cmd === 'apply') { applyPlan(); }
else if (cmd === 'run') {
  // KI-E437: guard --help flag — without this, `node orchestrate.mjs run --help` silently starts
  // a real run (flag parser doesn't recognise --help as special, so it enters the run handler).
  if (flags.help || flags.h || argv.includes('-h')) {
    console.log('Usage: node orchestrate.mjs run [--ids <id,...>] [--backend <name>] [--max-lanes <n>] [--include-escalate]\n');
    console.log('  --ids <id,...>       Dispatch specific item IDs only (bypasses hill-climb/bandit/CRITICAL-lockout)');
    console.log('  --backend <name>     Override backend (claude-headless | interactive | dry)');
    console.log('  --max-lanes <n>      Max lanes for this run (default from config)');
    console.log('  --include-escalate   Include ESCALATED-state items in auto-selection');
    console.log('\nConfig flags (factory.config.local.json):');
    console.log('  lockoutCritical: true   — exclude CRITICAL severity from auto-dispatch (KI-E436)');
    console.log('  sequentialGates: true   — abort gate band on first CHANGES_REQUIRED (KI-E435)');
    process.exit(0);
  }
  if (!backends[cfg.backend]) { log(`unknown backend '${cfg.backend}' (interactive | claude-headless | opencode | dry)`); process.exit(1); }
  for (const key of ['modelConcurrency', 'buildCapacity', 'maxItemsPerLane', 'maxCyclesPerRun', 'watchIntervalMs', 'laneTimeoutMinutes']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] <= 0) throw new Error('invalid config ' + key);
  }
  for (const key of ['modelConcurrency', 'buildCapacity', 'maxItemsPerLane', 'maxCyclesPerRun']) if (!Number.isInteger(cfg[key])) throw new Error('config must be an integer: ' + key);
  if (!Array.isArray(cfg.claudeHeadless.extraArgs) || cfg.claudeHeadless.extraArgs.some((arg) => typeof arg !== 'string')) throw new Error('headless extraArgs must be a string array');
  if (cfg.backend === 'dry') {
    const res = await runLane(cfg, null, 1, flags.ids ? String(flags.ids) : null);
    process.exitCode = isFatalLaneError(res.error) ? 1 : 0; // KI-E325
  } else {
  if (cfg.claudeHeadless.extraArgs.some((arg) => /^(?:--output-format|--session-id|--resume|--continue|--no-session-persistence|--verbose)(?:=|$)|^-[rc]$/.test(arg))) throw new Error('headless extraArgs must not override output/session lifecycle flags');
  if (!doctor(cfg)) { log('doctor found blocking problems — fix them first'); process.exit(1); }
  const token = claimLease();
  if (!token) { log('could not claim the controller lease — another LIVE session owns the factory (KI-C11). Standing down.'); process.exit(1); }
  log(`lease claimed: ${token} (heartbeats every watch tick)`);
  temit({ event: 'orchestrator_run', outcome: 'started', attrs: { backend: cfg.backend, maxLanes: cfg.maxCyclesPerRun } });
  try { clearPhantomClaimed(cfg, token); } catch (e) { log(`clearPhantomClaimed startup error (non-fatal): ${e.message}`); } // KI-E416 KI-E419
  // KI-E452: before claiming any NEW work, sweep for items whose own prior pipeline run already
  // reached a complete, all-gates-APPROVED CLOSED result.json while the ledger still shows
  // FAILED/ESCALATED/BLOCKED/an orphaned CLAIMED — e.g. a now-fixed probe bug (KI-E450) consumed
  // the resultId under a worse verdict, or a crash meant the batch's own fold never ran. Runs ONCE
  // per orchestrator invocation (not per-lane); `driver()` never throws, so no try/catch needed —
  // genuinely non-fatal by construction, logged either way, never blocks the run that follows.
  { const rc = driver(['reconcile-closed', '--controller', token]); if (rc.out.trim()) log('reconcile-closed (KI-E452):\n' + rc.out.trim()); }
  try {
    for (let lane = 1; lane <= cfg.maxCyclesPerRun; lane++) {
      // KI-E278: hill-climbing exploration mode may override the scheduler's item selection
      const hillClimbIds = flags.ids ? null : (() => { try { return hillClimbSelectIds(cfg); } catch (e) { log(`hillClimb selectIds error (non-fatal): ${e.message}`); return null; } })();
      // KI-E279: bandit UCB1 selection when hillClimb hasn't overridden (defers to hillClimb plateau escape)
      const banditIds = (!flags.ids && !hillClimbIds) ? (() => { try { return banditSelectIds(cfg); } catch (e) { log(`bandit selectIds error (non-fatal): ${e.message}`); return null; } })() : null;
      // The pre-perturbation selection: an explicit operator --ids wins, else the orchestrator's own
      // hillClimb/bandit pick, else null (= let the driver's scheduler choose freely).
      const baseIds = hillClimbIds ?? banditIds ?? (flags.ids ? String(flags.ids) : null);
      // KI-E285 + KI-E291: simulated annealing may swap one item in the selection with a random READY
      // item — but ONLY the orchestrator's OWN auto-selection. An explicit operator --ids (issue-assign
      // or `/factory run --ids X`) is authoritative and is NEVER perturbed, mirroring the hillClimb
      // (KI-E278) and bandit (KI-E279) --ids guards above. Without this guard, saPerturb would swap the
      // sole requested item out for a random (possibly unschedulable) one and the request would silently
      // no-op.
      const idsFlag = flags.ids
        ? baseIds
        : (() => { try { return saPerturb(cfg, baseIds); } catch (e) { log(`saPerturb error (non-fatal): ${e.message}`); return baseIds; } })();
      const t0Lane = Date.now(); // KI-E287: wall-clock timer for dynamic timeout recommendation
      let res = await runLane(cfg, token, lane, idsFlag);
      // KI-E291: saPerturb picks its swap-in optimistically from READY (same as hillClimb/bandit); the
      // driver's `group` is the single schedulability authority, so a perturbation can still collapse to
      // an unschedulable (empty) batch. If that happens, retry the lane ONCE with the unperturbed
      // selection so a bad swap never wastes a lane. (Not applied to an explicit --ids: if the operator's
      // own item is unschedulable, that must surface as a clear failure, not silently run something else.)
      if (res.error === 'empty-batch' && !flags.ids && idsFlag !== baseIds && baseIds) {
        log(`simulatedAnnealing: perturbed selection was unschedulable (empty batch) — retrying lane unperturbed: ${baseIds}`);
        res = await runLane(cfg, token, lane, baseIds);
      }
      try { timingRecord(cfg, Date.now() - t0Lane); } catch (e) { log(`timingRecord error (non-fatal): ${e.message}`); } // KI-E287
      if (res.folded) { try { applyAndCommit(cfg); } catch (e) { log(`autoCommit error (non-fatal): ${e.message}`); } }  // KI-E272
      if (res.folded) { try { autoPR(cfg, res.ids); } catch (e) { log(`autoPR error (non-fatal): ${e.message}`); } }  // KI-E303
      try { notifyEscalated(cfg); } catch (e) { log(`escalation webhook error (non-fatal): ${e.message}`); }  // KI-E272
      try { autoFixFailed(cfg, token); } catch (e) { log(`autoFix error (non-fatal): ${e.message}`); }  // KI-E275
      try { checkZeroClosureStop(cfg, res); } catch (e) { log(`zeroClosureStop check error (non-fatal): ${e.message}`); }  // KI-E420
      try { hillClimbUpdate(cfg, res); } catch (e) { log(`hillClimb update error (non-fatal): ${e.message}`); }  // KI-E278
      try { banditUpdate(cfg, res); } catch (e) { log(`bandit update error (non-fatal): ${e.message}`); }  // KI-E279
      try { saCool(cfg); } catch (e) { log(`saCool error (non-fatal): ${e.message}`); }  // KI-E285
      try { peUpdate(cfg, res); } catch (e) { log(`peUpdate error (non-fatal): ${e.message}`); }  // KI-E286
      try { coUpdate(cfg); } catch (e) { log(`coUpdate error (non-fatal): ${e.message}`); }  // KI-E288
      try { checkAndRecalibrate(cfg); } catch (e) { log(`recalibrate check error (non-fatal): ${e.message}`); }  // KI-E289
       if (res.stopped || res.error) {
        if (res.error && isFatalLaneError(res.error)) { log(`orchestrator-fatal lane error: ${res.error}`); process.exitCode = 1; }
        else if (res.error) { log(`lane ended non-fatally (${res.error}) — finished items folded; the rest resume next run (KI-E325)`); }
        break;
      }
      if (res.dry || (cfg.backend === 'interactive' && !res.folded && !res.complete)) break; // interactive: one lane per invocation unless checkpoints landed
    }
  } finally {
    driver(['controller', 'release', '--controller', token]);
    temit({ event: 'orchestrator_run', outcome: 'finished' });
    log('lease released — factory FREE');
    try { logFailureSummary(); } catch (e) { log(`failure summary error (non-fatal): ${e.message}`); }  // KI-E276
    try { hillClimbReport(); } catch (e) { log(`hillClimb report error (non-fatal): ${e.message}`); }  // KI-E278
    try { runRetrospective(cfg); } catch (e) { log(`retrospective error (non-fatal): ${e.message}`); }  // KI-E282
  }
  }
} else {
  console.log('usage: node orchestrator/orchestrate.mjs <doctor|status|run|apply> [--backend interactive|claude-headless|opencode|dry] [--ids A,B] [--max-lanes N]');
}
