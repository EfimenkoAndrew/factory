#!/usr/bin/env node
// Factory orchestrator — the factory-owned loop that makes the factory a standalone
// deliverable (ai-factory-observability spine AD-7/AD-8). Owns:
//   status -> suggest -> group -> dispatch(backend) -> watch checkpoints -> reconstruct -> fold -> report -> repeat
//
// INVARIANTS (inherited — see spine "Inherited Invariants"):
// - Every ledger mutation goes through driver.mjs as a CHILD PROCESS (single-writer, KI-B2).
//   This file NEVER writes ledger/state; it reads them read-only.
// - ONE controller (KI-C11): the orchestrator claims ONE lease token for its whole run and
//   heartbeats it every watch tick (spine AD-7 — a long watch must not go TTL-stale).
// - The stop-marker (state/STOP_REQUESTED.md, KI-E6) is checked before EVERY dispatch;
//   --stop-override is HUMAN-ONLY — this orchestrator never passes it.
// - NO mutating git, ever (KI-E1). Apply/handoff is a separate explicit step (autoApply:false);
//   the human authors every commit.
// - Zero npm dependencies (AD-4).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from '../_workflow/lib/rootfind.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(HERE, '..');
// KI-E17 (portable mounts): REPO_ROOT env keeps its historical precedence, then the shared
// walk-up detection (FACTORY_REPO_ROOT honored inside), then the legacy ../.. fallback.
const REPO_ROOT = process.env.REPO_ROOT || resolveRepoRoot(FACTORY_ROOT, process.env);
const DRIVER = join(FACTORY_ROOT, '_workflow', 'driver.mjs');
const CONFIG_PATH = join(FACTORY_ROOT, 'config', 'orchestrator.config.json');
const STOP_MARKER = join(FACTORY_ROOT, 'state', 'STOP_REQUESTED.md');

// Telemetry (KI-E7): source:'orchestrator', observational only.
const { emit } = await import(join(FACTORY_ROOT, '_workflow', 'lib', 'telemetry.mjs'));
const temit = (e) => emit({ ...e, source: 'orchestrator' });

function loadConfig() {
  const defaults = {
    backend: 'interactive',            // interactive | claude-headless | dry
    maxCyclesPerRun: 1,                // lanes dispatched before the orchestrator exits
    maxItemsPerLane: 3,
    includeRealinfra: false,
    watchIntervalMs: 60000,            // checkpoint poll + lease heartbeat cadence
    laneTimeoutMinutes: 240,           // give up watching a lane after this (items stay resumable)
    autoApply: false,                  // AD-7: apply is explicit/operator — NEVER auto
    claudeHeadless: { bin: 'claude', extraArgs: [], promptTemplate: 'Operate as the AI-factory worker plane. Launch the Workflow tool on the script at {runScript} with NO args, wait for it to complete, then reply DONE. Do not run any git commands. Do not edit any file outside the per-item worktrees the script names.' },
  };
  try { return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }; } catch { return defaults; }
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
  if (cfg.backend === 'claude-headless') {
    let v = null;
    try { v = execFileSync(cfg.claudeHeadless.bin, ['--version'], { encoding: 'utf8' }).trim(); } catch { /* absent */ }
    add('claude CLI (headless backend)', !!v, v || 'claude binary not found on PATH');
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
    async dispatch(runScript, cfg) {
      const prompt = cfg.claudeHeadless.promptTemplate.replace('{runScript}', runScript);
      log(`claude-headless: spawning ${cfg.claudeHeadless.bin} -p (workflow ${runScript})`);
      const child = spawn(cfg.claudeHeadless.bin, ['-p', prompt, ...cfg.claudeHeadless.extraArgs], { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
      child.on('error', (e) => log(`claude-headless spawn error: ${e.message} — the lane's items stay CLAIMED/resumable (driver.mjs resume)`));
      return { launched: true, pid: child.pid, child };
    },
  },
};

// ---- watch: per-item checkpoints are the completion signal (KI-L40 file-first model) ---------
function checkpointsPresent(ids) {
  const done = [];
  for (const id of ids) {
    const p = join(FACTORY_ROOT, 'state', 'items', id, 'result.json');
    try { if (existsSync(p) && statSync(p).size > 2) done.push(id); } catch { /* keep watching */ }
  }
  return done;
}

async function watch(ids, token, cfg, sinceMs) {
  const deadline = Date.now() + cfg.laneTimeoutMinutes * 60000;
  for (;;) {
    // Heartbeat every tick (spine AD-7) — a multi-hour watch must never let the lease go stale.
    // Review finding #5 (KI-C11): a REFUSED heartbeat means a foreign controller force-claimed —
    // stand down NOW; polling on (and later folding) with a dead token would race the new owner.
    const hb = driver(['controller', 'heartbeat', '--controller', token]);
    if (!hb.ok) { log('lease LOST (heartbeat refused — foreign LIVE controller). Standing down; items stay resumable.'); return { complete: false, done: [], leaseLost: true }; }
    const done = checkpointsPresent(ids).filter((id) => {
      try { return statSync(join(FACTORY_ROOT, 'state', 'items', id, 'result.json')).mtimeMs >= sinceMs; } catch { return false; }
    });
    log(`watch: ${done.length}/${ids.length} checkpoints [${done.join(', ') || '-'}]`);
    if (done.length === ids.length) return { complete: true, done };
    if (Date.now() > deadline) return { complete: false, done, timedOut: true };
    await new Promise((r) => setTimeout(r, cfg.watchIntervalMs));
  }
}

// ---- one lane: group -> dispatch -> watch -> reconstruct -> fold ----------------------------
async function runLane(cfg, token, laneNo, idsFlag) {
  if (existsSync(STOP_MARKER)) { log('stop-marker present — refusing to dispatch a new lane (KI-E6; human-only override)'); return { stopped: true }; }
  const label = `orch-${Date.now().toString(36)}`;
  const groupArgs = ['group', '--label', label, '--controller', token, '--max', String(cfg.maxItemsPerLane)];
  if (idsFlag) groupArgs.push('--ids', idsFlag);
  if (cfg.includeRealinfra) groupArgs.push('--include-realinfra');
  const g = driver(groupArgs);
  if (!g.ok) { log(`group failed:\n${g.out}`); return { error: 'group-failed' }; }
  console.log(g.out.trim());
  const ids = [...g.out.matchAll(/^ {2}([A-Z0-9][A-Za-z0-9._-]+) \(/gm)].map((m) => m[1]);
  const scriptM = g.out.match(/scriptPath: "([^"]+)"/);
  if (!ids.length || !scriptM) { log('group emitted no launchable batch (nothing schedulable?)'); return { error: 'empty-batch' }; }
  const runScript = scriptM[1];
  const t0 = Date.now();
  temit({ event: 'orchestrator_lane', lane: label, outcome: 'dispatching', attrs: { items: ids, backend: cfg.backend, runScript } });
  const disp = await backends[cfg.backend].dispatch(runScript, cfg);
  if (cfg.backend === 'dry') return { dry: true, ids, runScript };
  const w = await watch(ids, token, cfg, t0);
  if (w.leaseLost) { if (disp.child) try { disp.child.kill(); } catch { /* already gone */ } return { error: 'lease-lost', ids }; }
  if (!w.complete) {
    log(`lane ${label} INCOMPLETE (${w.done.length}/${ids.length}${w.timedOut ? ', timed out' : ''}) — folding what finished; the rest resume via driver.mjs resume (KI-L52)`);
    if (w.timedOut && disp.child) { log('killing the timed-out headless child (its items stay CLAIMED/resumable)'); try { disp.child.kill(); } catch { /* already gone */ } }
  }
  const rec = driver(['reconstruct', '--controller', token]);
  console.log(rec.out.trim());
  const fileM = rec.out.match(/(state\/results-cycle-\d+[^\s]*\.json)/);
  if (!fileM) { log('reconstruct emitted no results file — nothing to fold yet'); return { ids, folded: false }; }
  const f = driver(['fold', fileM[1], '--controller', token]);
  console.log(f.out.trim());
  temit({ event: 'orchestrator_lane', lane: label, outcome: w.complete ? 'folded' : 'partial-fold', durMs: Date.now() - t0, attrs: { items: ids, checkpoints: w.done.length } });
  driver(['telemetry-report']);
  return { ids, folded: f.ok, complete: w.complete };
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
const cfg = { ...loadConfig(), ...(flags.backend ? { backend: String(flags.backend) } : {}), ...(flags['max-lanes'] ? { maxCyclesPerRun: parseInt(flags['max-lanes'], 10) } : {}) };

if (cmd === 'doctor') { process.exit(doctor(cfg) ? 0 : 1); }
else if (cmd === 'status') {
  const { cycle, counts } = ledgerCounts();
  log(`ledger cycle ${cycle} · counts ${JSON.stringify(counts)} · stop-marker ${existsSync(STOP_MARKER) ? 'PRESENT (stopped)' : 'absent'}`);
  const r = driver(['controller', 'status']); console.log(r.out.trim());
} else if (cmd === 'apply') { applyPlan(); }
else if (cmd === 'run') {
  if (!backends[cfg.backend]) { log(`unknown backend '${cfg.backend}' (interactive | claude-headless | dry)`); process.exit(1); }
  if (!doctor(cfg)) { log('doctor found blocking problems — fix them first'); process.exit(1); }
  const token = claimLease();
  if (!token) { log('could not claim the controller lease — another LIVE session owns the factory (KI-C11). Standing down.'); process.exit(1); }
  log(`lease claimed: ${token} (heartbeats every watch tick)`);
  temit({ event: 'orchestrator_run', outcome: 'started', attrs: { backend: cfg.backend, maxLanes: cfg.maxCyclesPerRun } });
  try {
    for (let lane = 1; lane <= cfg.maxCyclesPerRun; lane++) {
      const res = await runLane(cfg, token, lane, flags.ids ? String(flags.ids) : null);
      if (res.stopped || res.error) break; // review finding #10: ANY lane error ends the run (no blind retry loop; lease-lost especially must stop everything)
      if (res.dry || (cfg.backend === 'interactive' && !res.folded && !res.complete)) break; // interactive: one lane per invocation unless checkpoints landed
    }
  } finally {
    driver(['controller', 'release', '--controller', token]);
    temit({ event: 'orchestrator_run', outcome: 'finished' });
    log('lease released — factory FREE');
  }
} else {
  console.log('usage: node orchestrator/orchestrate.mjs <doctor|status|run|apply> [--backend interactive|claude-headless|dry] [--ids A,B] [--max-lanes N]');
}
