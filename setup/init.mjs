#!/usr/bin/env node
// AI Implementation Factory — host-repo initializer (KI-E17, SETUP.md).
//
// Run this ONCE after mounting the factory in a host repo (submodule or clone, any path):
//   node <mount>/setup/init.mjs [--fresh [--yes]] [--hooks] [--no-claude-assets] [--repo-root <path>]
//
// What it does:
//   1. Detects the host repo root + the factory's mount path (walk-up; --repo-root overrides).
//   2. Checks prerequisites (node >= 20.11, git; claude CLI / dotnet / docker are advisory).
//   3. Scaffolds runtime state dirs (state/, state/items, state/normalized, state/worktrees,
//      telemetry/data, reports/, queue/).
//   4. Installs the /ai-factory controller skill into the host's .claude/skills/ (the agent
//      briefs in agents/ need NO host install — the driver inlines them at group time).
//   5. --fresh: resets factory state (empty findings-graph, rebuilt
//      ledger, emptied decision queue) so a NEW host starts from zero. Guarded by --yes.
//   6. --hooks: installs the pre-push build-time audit gate (ci/install-hooks.sh).
//   7. Smoke: runs the lib selftest + driver preflight/status.
//
// Zero npm dependencies. Never runs mutating git (KI-E1). Idempotent — safe to re-run.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot, STOCK_MOUNT, toPosix } from '../_workflow/lib/rootfind.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(HERE, '..');
const DRIVER = join(FACTORY_ROOT, '_workflow', 'driver.mjs');

// ---- tiny CLI plumbing --------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  if (k === 'repo-root' && i + 1 < argv.length) { flags[k] = argv[++i]; } else { flags[k] = true; }
}
if (flags.help) {
  console.log('usage: node setup/init.mjs [--fresh [--yes]] [--hooks] [--no-claude-assets] [--repo-root <path>]');
  process.exit(0);
}
const say = (m) => console.log('[init] ' + m);
const warn = (m) => console.log('[init] WARN  ' + m);
let hardFail = false;
const fail = (m) => { console.error('[init] FAIL  ' + m); hardFail = true; };

function run(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function tryRun(cmd, args, opts) {
  try { return run(cmd, args, opts).trim(); } catch { return null; }
}

// ---- 1. locate host repo + mount ----------------------------------------------------
const repoRoot = flags['repo-root'] ? resolve(String(flags['repo-root'])) : findRepoRoot(FACTORY_ROOT);
const standalone = !repoRoot;
const mountRel = standalone ? null : toPosix(relative(repoRoot, FACTORY_ROOT));
say('factory root : ' + FACTORY_ROOT);
if (standalone) {
  warn('no enclosing git repository above the factory — standalone (factory-development) checkout.');
  warn('host-repo steps (skill install, hooks, fresh reset) are skipped; state scaffolding still runs.');
} else {
  say('host repo    : ' + repoRoot);
  say('mount path   : ' + mountRel + (mountRel === STOCK_MOUNT ? ' (stock — config used as committed)' : ' (non-stock — driver auto-rewrites config paths onto this mount)'));
}

// ---- 2. prerequisites ---------------------------------------------------------------
const [nMaj, nMin] = process.versions.node.split('.').map(Number);
if (nMaj > 20 || (nMaj === 20 && nMin >= 11)) say('node         : v' + process.versions.node);
else fail('node >= 20.11 required (import.meta.dirname in the selftest); found v' + process.versions.node);
const gitV = tryRun('git', ['--version']);
if (gitV) say('git          : ' + gitV); else fail('git not found on PATH — the factory cannot run without it');
const claudeV = tryRun('claude', ['--version']);
if (claudeV) say('claude CLI   : ' + claudeV);
else warn('claude CLI not on PATH — the worker plane launches from a Claude Code session (the CLI is only needed for the headless orchestrator backend)');
const dotnetV = tryRun('dotnet', ['--version']);
if (dotnetV) say('dotnet SDK   : ' + dotnetV + ' (default verify runner)');
else warn('dotnet SDK not found — verify/build-test.sh defaults to .NET; a non-.NET host must provide verify/build-test.local.sh (see SETUP.md § Host adaptation)');
const dockerV = tryRun('docker', ['--version']);
if (dockerV) say('docker       : ' + dockerV + ' (realInfra items closable)');
else warn('docker not found — realInfra-gated items (money/security/concurrency) cannot be CLOSED without Testcontainers (driver preflight reports the same)');
if (hardFail) { console.error('[init] aborting: fix the FAIL items above and re-run.'); process.exit(1); }

// ---- 3. runtime scaffolding ---------------------------------------------------------
for (const d of ['state', 'state/items', 'state/normalized', 'state/worktrees', 'telemetry/data', 'reports', 'queue']) {
  mkdirSync(join(FACTORY_ROOT, d), { recursive: true });
}
const gk = join(FACTORY_ROOT, 'telemetry', 'data', '.gitkeep');
if (!existsSync(gk)) writeFileSync(gk, '');
say('runtime dirs : state/{,items,normalized,worktrees} telemetry/data reports queue — present');

// ---- 4. Claude Code assets (host .claude/skills) ------------------------------------
function copyTree(src, dst) {
  const copied = [];
  for (const name of readdirSync(src)) {
    const s = join(src, name); const d = join(dst, name);
    if (statSync(s).isDirectory()) { mkdirSync(d, { recursive: true }); copied.push(...copyTree(s, d)); continue; }
    const body = readFileSync(s);
    if (existsSync(d)) {
      if (readFileSync(d).equals(body)) { continue; }
      writeFileSync(d + '.factory-new', body);
      warn(toPosix(relative(dst, d)) + ' exists with local edits — new version written alongside as *.factory-new (merge by hand)');
      continue;
    }
    mkdirSync(dirname(d), { recursive: true });
    writeFileSync(d, body);
    copied.push(d);
  }
  return copied;
}
if (!standalone && !flags['no-claude-assets']) {
  const src = join(FACTORY_ROOT, 'claude-assets', 'skills');
  const dst = join(repoRoot, '.claude', 'skills');
  mkdirSync(dst, { recursive: true });
  const copied = copyTree(src, dst);
  say('claude skill : ' + (copied.length ? copied.map((p) => toPosix(relative(repoRoot, p))).join(', ') + ' installed' : '.claude/skills/ai-factory up to date'));
  say('agents       : agents/*.md need no host install (inlined into every batch at group time)');
}

// ---- 5. --fresh: reset factory state ----------------------------------
const graphPath = join(FACTORY_ROOT, 'state', 'findings-graph.json');
const ledgerPath = join(FACTORY_ROOT, 'state', 'ledger.json');
if (flags.fresh) {
  if (standalone) { warn('--fresh skipped in a standalone checkout'); }
  else {
    let itemCount = 0;
    try { itemCount = (JSON.parse(readFileSync(graphPath, 'utf8')).items || []).length; } catch { /* absent/corrupt -> 0 */ }
    if (itemCount > 0 && !flags.yes) {
      fail('--fresh would reset a findings-graph holding ' + itemCount + ' item(s) (your live factory state). Re-run with --fresh --yes to confirm.');
      process.exit(1);
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    for (const p of [graphPath, ledgerPath]) {
      if (existsSync(p)) writeFileSync(p + '.pre-fresh-' + ts, readFileSync(p));
    }
    writeFileSync(graphPath, JSON.stringify({ generatedAt: new Date().toISOString(), source: '(fresh init — author items per schema/work-item.schema.json; see templates/findings-graph.example.json)', count: 0, items: [] }, null, 1) + '\n');
    writeFileSync(join(FACTORY_ROOT, 'queue', 'decisions.md'), '# Human decision queue\n\n_Items the factory cannot close autonomously: BLOCKED (owner ruling required) or ESCALATED (auth/money/crypto/cross-service — auto-drafted, needs human sign-off before integrate)._\n_Fresh host — empty._\n');
    const token = 'setup-init-' + process.pid;
    const env = { ...process.env, FACTORY_CONTROLLER: token };
    try {
      run(process.execPath, [DRIVER, 'init', '--force'], { cwd: repoRoot, env, stdio: ['ignore', 'inherit', 'inherit'] });
      run(process.execPath, [DRIVER, 'progress'], { cwd: repoRoot, env, stdio: ['ignore', 'ignore', 'inherit'] });
      run(process.execPath, [DRIVER, 'burndown'], { cwd: repoRoot, env, stdio: ['ignore', 'ignore', 'inherit'] });
      tryRun(process.execPath, [DRIVER, 'controller', 'release'], { cwd: repoRoot, env });
    } finally {
      // never leave the init's advisory lease behind — the operator session claims its own
      const lease = join(FACTORY_ROOT, 'state', 'controller.json');
      try {
        if (existsSync(lease) && readFileSync(lease, 'utf8').includes(token)) rmSync(lease);
      } catch { /* best-effort */ }
    }
    say('fresh state  : findings-graph emptied (backup *.pre-fresh-' + ts + '), ledger rebuilt, decision queue reset');
  }
}

// ---- 6. --hooks: pre-push audit gate ------------------------------------------------
if (flags.hooks) {
  if (standalone) warn('--hooks skipped in a standalone checkout');
  else {
    try {
      run('bash', [join(FACTORY_ROOT, 'ci', 'install-hooks.sh')], { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] });
    } catch { warn('hook install failed (see above) — install later with: bash ' + (mountRel || STOCK_MOUNT) + '/ci/install-hooks.sh'); }
  }
}

// ---- 7. smoke -----------------------------------------------------------------------
const st = tryRun(process.execPath, [join(FACTORY_ROOT, '_workflow', 'lib', '_selftest.mjs')]);
const stLine = st && st.split('\n').filter(Boolean).pop();
if (stLine && /(\d+) passed, 0 failed/.test(stLine)) say('selftest     : ' + stLine.trim());
else fail('lib selftest did not pass cleanly: ' + (stLine || '(no output)'));
if (!standalone) {
  const pf = tryRun(process.execPath, [DRIVER, 'preflight'], { cwd: repoRoot });
  if (pf) console.log(pf.split('\n').map((l) => '[init]   ' + l).join('\n'));
  const status = tryRun(process.execPath, [DRIVER, 'status'], { cwd: repoRoot });
  if (status) console.log(status.split('\n').map((l) => '[init]   ' + l).join('\n'));
}

// ---- next steps ---------------------------------------------------------------------
const m = mountRel || STOCK_MOUNT;
console.log(`
[init] ${hardFail ? 'DONE WITH FAILURES — fix the FAIL items above.' : 'done.'}
[init] Next steps (full guide: ${m}/SETUP.md):
[init]   1. Feed it work: author ${m}/state/findings-graph.json per schema/work-item.schema.json
[init]      (templates/findings-graph.example.json is a working 3-item example), then:
[init]        node ${m}/_workflow/driver.mjs init
[init]   2. Drive it from a Claude Code session opened at the HOST repo root — say "run the factory"
[init]      (the /ai-factory skill installed above knows the loop), or mechanize with
[init]        node ${m}/orchestrator/orchestrate.mjs run
[init]   3. The factory NEVER commits: finished fixes wait on factory/<id> worktree branches;
[init]      review + commit them yourself (queue/decisions.md holds what needs a human ruling).`);
process.exit(hardFail ? 1 : 0);
