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
//   the human authors every commit.
// - Zero npm dependencies (AD-4).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, openSync, closeSync, createWriteStream, chmodSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot, swapMountPrefix, STOCK_MOUNT, toPosix } from '../_workflow/lib/rootfind.mjs';
import { writeJsonAtomic } from '../_workflow/lib/ledger.mjs';
import { emit } from '../_workflow/lib/telemetry.mjs';
import { groupArguments, launchFromGroup, claimIdentity, validCheckpoint, observeChild, watchLane, stopChild, recoveryAdvice, schedulerSuggestions } from './lifecycle.mjs';
import { dispatchConfig } from './opencode-worker.mjs';
import { buildCapacity } from '../_workflow/lib/build-lease.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(HERE, '..');
// KI-E17 (portable mounts): REPO_ROOT env keeps its historical precedence, then the shared
// walk-up detection (FACTORY_REPO_ROOT honored inside), then the legacy ../.. fallback.
const REPO_ROOT = process.env.REPO_ROOT || resolveRepoRoot(FACTORY_ROOT, process.env);
const DRIVER = join(FACTORY_ROOT, '_workflow', 'driver.mjs');
const CONFIG_PATH = join(FACTORY_ROOT, 'config', 'orchestrator.config.json');
const STOP_MARKER = join(FACTORY_ROOT, 'state', 'STOP_REQUESTED.md');

// Telemetry (KI-E7): source:'orchestrator', observational only.
const temit = (e) => emit({ ...e, source: 'orchestrator' });

function loadConfig() {
  const defaults = {
    backend: 'interactive',            // interactive | claude-headless | opencode | dry
    maxCyclesPerRun: 1,                // lanes dispatched before the orchestrator exits
    maxItemsPerLane: 3,
    modelConcurrency: 6,
    buildCapacity: 1,
    includeRealinfra: false,
    watchIntervalMs: 60000,            // checkpoint poll + lease heartbeat cadence
    laneTimeoutMinutes: 240,           // give up watching a lane after this (items stay resumable)
    autoApply: false,                  // AD-7: apply is explicit/operator — NEVER auto
    opencode: { config: 'config/opencode-dispatch.local.json' },
    claudeHeadless: { bin: 'claude', extraArgs: [], promptTemplate: 'Operate as the AI-factory worker plane. Launch the Workflow tool on the script at {runScript} with NO args, wait for it to complete, then reply DONE. Do not run any git commands. Do not edit any file outside the per-item worktrees the script names.' },
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  const configured = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return { ...defaults, ...configured, opencode: { ...defaults.opencode, ...configured.opencode }, claudeHeadless: { ...defaults.claudeHeadless, ...configured.claudeHeadless } };
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
      const prompt = cfg.claudeHeadless.promptTemplate.replace('{runScript}', runScript);
      log(`claude-headless: spawning ${cfg.claudeHeadless.bin} -p (workflow ${runScript})`);
      const help = execFileSync(cfg.claudeHeadless.bin, ['--help'], { encoding: 'utf8' });
      const runtimeVersion = execFileSync(cfg.claudeHeadless.bin, ['--version'], { encoding: 'utf8' }).trim();
      const structured = /--output-format/.test(help) && /--verbose/.test(help);
      const args = ['-p', prompt, ...cfg.claudeHeadless.extraArgs, ...(structured ? ['--output-format', 'stream-json', '--verbose'] : [])];
      const stderr = openSync(join(outputDir, 'stderr.log'), 'a');
      let child;
      try { child = spawn(cfg.claudeHeadless.bin, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', stderr], env: process.env }); }
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
  if (w.leaseLost) return { error: 'lease-lost', ids };
  if (!w.complete) {
    log(`lane ${label} INCOMPLETE (${w.done.length}/${ids.length}${w.timedOut ? ', timed out' : ''}) — ${cfg.backend === 'opencode' ? 'resume the entire OpenCode batch/config before folding' : 'folding what finished; inspect driver.mjs resume for the rest'}`);
  }
  if (cfg.backend === 'opencode' && (!w.complete || w.childFailed)) return { error: 'opencode-batch-unsettled', ids };
  const results = checkpoints(launch, claims, t0, cfg.backend);
  if (!results.length) return { ids, folded: false, error: 'no-valid-checkpoints' };
  const resultFile = join(outputDir, 'results.json');
  writeJsonAtomic(resultFile, { mode: 'run', cycle: batch.cycle, results });
  const f = driver(['fold', resultFile, '--controller', token]);
  console.log(f.out.trim());
  writeJsonAtomic(join(outputDir, 'fold.json'), { version: 1, ok: f.ok, code: f.code ?? 0, resultsFile: resultFile, ids: results.map((r) => r.id), completedAt: new Date().toISOString(), recovery: recoveryAdvice(ids, results.map((r) => r.id)) });
  temit({ event: 'orchestrator_lane', lane: label, outcome: !f.ok ? 'fold-failed' : w.complete ? 'folded' : 'partial-fold', durMs: Date.now() - t0, attrs: { items: ids, checkpoints: results.length } });
  driver(['telemetry-report']);
  return { ids, folded: f.ok, complete: w.complete, ...(!f.ok || !w.complete || w.childFailed ? { error: 'lane-incomplete-or-failed' } : {}) };
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
  if (!backends[cfg.backend]) { log(`unknown backend '${cfg.backend}' (interactive | claude-headless | opencode | dry)`); process.exit(1); }
  for (const key of ['modelConcurrency', 'buildCapacity', 'maxItemsPerLane', 'maxCyclesPerRun', 'watchIntervalMs', 'laneTimeoutMinutes']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] <= 0) throw new Error('invalid config ' + key);
  }
  for (const key of ['modelConcurrency', 'buildCapacity', 'maxItemsPerLane', 'maxCyclesPerRun']) if (!Number.isInteger(cfg[key])) throw new Error('config must be an integer: ' + key);
  if (!Array.isArray(cfg.claudeHeadless.extraArgs) || cfg.claudeHeadless.extraArgs.some((arg) => typeof arg !== 'string')) throw new Error('headless extraArgs must be a string array');
  if (cfg.backend === 'dry') {
    const res = await runLane(cfg, null, 1, flags.ids ? String(flags.ids) : null);
    process.exitCode = res.error ? 1 : 0;
  } else {
  if (cfg.claudeHeadless.extraArgs.some((arg) => /^(?:--output-format|--session-id|--resume|--continue|--no-session-persistence|--verbose)(?:=|$)|^-[rc]$/.test(arg))) throw new Error('headless extraArgs must not override output/session lifecycle flags');
  if (!doctor(cfg)) { log('doctor found blocking problems — fix them first'); process.exit(1); }
  const token = claimLease();
  if (!token) { log('could not claim the controller lease — another LIVE session owns the factory (KI-C11). Standing down.'); process.exit(1); }
  log(`lease claimed: ${token} (heartbeats every watch tick)`);
  temit({ event: 'orchestrator_run', outcome: 'started', attrs: { backend: cfg.backend, maxLanes: cfg.maxCyclesPerRun } });
  try {
    for (let lane = 1; lane <= cfg.maxCyclesPerRun; lane++) {
      const res = await runLane(cfg, token, lane, flags.ids ? String(flags.ids) : null);
       if (res.stopped || res.error) { if (res.error) process.exitCode = 1; break; }
      if (res.dry || (cfg.backend === 'interactive' && !res.folded && !res.complete)) break; // interactive: one lane per invocation unless checkpoints landed
    }
  } finally {
    driver(['controller', 'release', '--controller', token]);
    temit({ event: 'orchestrator_run', outcome: 'finished' });
    log('lease released — factory FREE');
  }
  }
} else {
  console.log('usage: node orchestrator/orchestrate.mjs <doctor|status|run|apply> [--backend interactive|claude-headless|opencode|dry] [--ids A,B] [--max-lanes N]');
}
