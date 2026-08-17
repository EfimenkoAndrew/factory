#!/usr/bin/env node
// AI Implementation Factory — cross-platform installer / upgrader (KI-O5).
//
// The Node twin of setup/install.sh, for hosts with no usable bash (Windows without Git Bash /
// WSL, locked-down CI images). Same contracts: strict vX.Y.Z release resolution, a selftest gate
// on install AND upgrade, rollback on a red upgrade, transactional cleanup of a failed install.
// It delegates ALL host-side wiring to setup/init.mjs, so the three controller seams — Claude
// Code, GitHub Copilot, OpenCode — are installed by exactly one implementation, not two.
//
// Run it from a factory checkout (clone the engine anywhere, then point it at your host repo):
//   git clone https://github.com/EfimenkoAndrew/factory.git /tmp/factory
//   node /tmp/factory/setup/install.mjs install --host /path/to/host-repo
//
// Commands
//   install       Clone the factory into the host repo at a release tag (default: the latest
//                 vX.Y.Z tag; falls back to `main` with a notice while none are published),
//                 add the mount to the host .gitignore, run setup/init.mjs, GATE on the selftest.
//   upgrade       Fetch + check out the requested/latest version IN PLACE, re-run init.mjs to
//                 refresh host scaffolding, GATE on the selftest. A red selftest ROLLS BACK to
//                 the previous ref and exits 1. Unattended-safe.
//   controllers   Re-install ONLY the host controller assets (Claude skill, Copilot
//                 instructions, OpenCode AGENTS.md/.opencode/ + opencode.json merge). The fast
//                 path after an engine update, or to add a controller you skipped.
//   status        Installed version vs the latest published release.
//   help          This text.
//
// Options
//   --repo <url>        factory remote (default: https://github.com/EfimenkoAndrew/factory.git)
//   --dir <path>        mount path inside the host repo (default: _bmad-output/ai-factory)
//   --host <path>       host repo root (default: the git toplevel above cwd)
//   --version <v>       vX.Y.Z tag or `main` (default: latest release tag, else main)
//   --submodule         install as a git submodule instead of a plain clone
//   --hooks             also install the pre-push audit gate (delegated to setup/init.mjs)
//   --fresh --yes       reset factory state for a brand-new host (delegated to setup/init.mjs)
//   --no-claude         skip the host .claude/skills/ai-factory install
//   --no-copilot        skip the host .github/copilot-instructions.md install
//   --no-opencode       skip the host AGENTS.md / .opencode/ / opencode.json install
//   --no-gitignore      do not add the mount dir to the host .gitignore (clone mode)
//   --force             with upgrade: proceed despite local modifications to tracked files
//   --dry               print the plan; make no changes
//
// Telemetry is NOT bootstrapped here: that stack is docker + shell-profile work with no
// meaningful Windows story, and duplicating 90 lines of it in a second language is exactly the
// drift this repo avoids. Run `bash <mount>/setup/install.sh telemetry-up` on a POSIX host.
//
// Zero npm dependencies. The ONLY mutating git this runs targets the factory's OWN engine
// checkout (clone / submodule add / checkout of a release tag) — never the host's working tree,
// and never on behalf of a factory work item (KI-E1, lib/worktree.mjs's header states the rule).
import { existsSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPosix } from '../_workflow/lib/rootfind.mjs';
import { pickLatestReleaseTag, compareSemver } from '../_workflow/lib/hostinstall.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = resolve(HERE, '..');
const DEFAULT_REPO = 'https://github.com/EfimenkoAndrew/factory.git';
const DEFAULT_DIR = '_bmad-output/ai-factory';

// ---- tiny CLI plumbing --------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = (argv[0] && !argv[0].startsWith('--')) ? argv.shift() : 'help';
const VALUED = new Set(['repo', 'dir', 'host', 'version']);
const KNOWN = new Set([...VALUED, 'submodule', 'hooks', 'fresh', 'yes', 'no-claude', 'no-copilot',
  'no-opencode', 'no-gitignore', 'force', 'dry', 'help']);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) die('unexpected argument: ' + a + ' (see --help)');
  const k = a.slice(2);
  if (!KNOWN.has(k)) die('unknown option: --' + k + ' (see --help)');
  if (VALUED.has(k)) {
    if (i + 1 >= argv.length) die('--' + k + ' needs a value');
    flags[k] = argv[++i];
  } else flags[k] = true;
}

const say = (m) => console.log('[factory] ' + m);
const warn = (m) => console.error('[factory] WARN  ' + m);
function die(m) { console.error('[factory] FAIL  ' + m); process.exit(1); }

function run(cmdName, args, opts) {
  return execFileSync(cmdName, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function tryRun(cmdName, args, opts) {
  try { return run(cmdName, args, opts).trim(); } catch { return null; }
}
const git = (args, opts) => run('git', args, opts).trim();
const tryGit = (args, opts) => tryRun('git', args, opts);

const REPO = flags.repo || DEFAULT_REPO;
const DIR = toPosix(flags.dir || DEFAULT_DIR).replace(/^\/+|\/+$/g, '');
const DRY = !!flags.dry;

// ---- location -----------------------------------------------------------------------
// The host repo root: --host wins, else the git toplevel above cwd. Deliberately NOT derived
// from this script's own location — an installer run from a checkout in /tmp must target the
// repo the operator named, never the tree it happens to live in (the E2E-caught redirect bug
// install.sh:88-96 documents).
function hostRoot() {
  if (flags.host) {
    const r = resolve(String(flags.host));
    if (!existsSync(r)) die('--host path does not exist: ' + r);
    return r;
  }
  const top = tryGit(['rev-parse', '--show-toplevel']);
  if (!top) die('not inside a git repo — pass --host <host-repo-root>');
  return resolve(top);
}
const mountOf = (root) => join(root, ...DIR.split('/'));
// The HOST repo root enclosing an existing mount: git first, else walk up depth(DIR) levels.
function hostOfMount(mount) {
  const top = tryGit(['-C', join(mount, '..'), 'rev-parse', '--show-toplevel']);
  if (top) return resolve(top);
  return resolve(mount, ...DIR.split('/').map(() => '..'));
}
// An existing mount to operate on (upgrade/status/controllers): --host+--dir when given, else
// this script's own tree when it IS a mount, else cwd's git toplevel + --dir.
function existingMount() {
  if (flags.host) return mountOf(hostRoot());
  if (existsSync(join(SELF_ROOT, '_workflow', 'driver.mjs')) && existsSync(join(SELF_ROOT, '.git'))) return SELF_ROOT;
  return mountOf(hostRoot());
}

// ---- prerequisites ------------------------------------------------------------------
function requirePrereqs() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (!(maj > 20 || (maj === 20 && min >= 11))) die('node >= 20.11 required; found v' + process.versions.node);
  if (!tryRun('git', ['--version'])) die('git not found on PATH');
}

// ---- release resolution -------------------------------------------------------------
function resolveTarget() {
  if (flags.version) return String(flags.version);
  let out;
  try {
    out = run('git', ['ls-remote', '--tags', '--refs', REPO, 'refs/tags/v*']);
  } catch (e) {
    die('cannot reach ' + REPO + ' (git ls-remote failed: ' + String(e.message || e).split('\n').pop().trim() + ')');
  }
  const latest = pickLatestReleaseTag(out);
  if (latest) return latest;
  warn("no vX.Y.Z release tags published yet — tracking 'main' (pin with --version once releases exist)");
  return 'main';
}

function runSelftest(mount) {
  say('selftest gate: node _workflow/lib/_selftest.mjs');
  try {
    const out = run(process.execPath, [join(mount, '_workflow', 'lib', '_selftest.mjs')]);
    say('selftest: ' + (out.split('\n').filter(Boolean).pop() || '').trim());
    return true;
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || '') || e.message);
    console.error(out.split('\n').filter(Boolean).slice(-15).join('\n'));
    return false;
  }
}

// The init flags this run implies — the single place the three controller seams are toggled.
function initFlags(root) {
  const a = ['--repo-root', root];
  if (flags.hooks) a.push('--hooks');
  if (flags.fresh) a.push('--fresh');
  if (flags.yes) a.push('--yes');
  if (flags['no-claude']) a.push('--no-claude-assets');
  if (flags['no-copilot']) a.push('--no-copilot-assets');
  if (flags['no-opencode']) a.push('--no-opencode-assets');
  return a;
}
function runInit(mount, root) {
  const a = initFlags(root);
  say('running setup/init.mjs ' + a.join(' '));
  if (DRY) return true;
  try {
    run(process.execPath, [join(mount, 'setup', 'init.mjs'), ...a], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    return true;
  } catch { return false; }
}

// ---- install ------------------------------------------------------------------------
function addGitignoreEntry(root) {
  const gi = join(root, '.gitignore');
  const entry = DIR + '/';
  const body = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (body.split(/\r?\n/).includes(entry)) return;
  // Pad a newline first — appending to a .gitignore with no trailing newline would glue the
  // comment onto its last entry (the same review fix as install.sh:172-174).
  const pad = body && !/\n$/.test(body) ? '\n' : '';
  appendFileSync(gi, pad + '# AI Implementation Factory mount (own git checkout; upgraded via setup/install.mjs)\n' + entry + '\n');
  say("added '" + entry + "' to the host .gitignore (disable with --no-gitignore)");
}

function cmdInstall() {
  requirePrereqs();
  const root = hostRoot();
  const mount = mountOf(root);
  const target = resolveTarget();
  if (existsSync(join(mount, '_workflow', 'driver.mjs'))) {
    die('already installed at ' + mount + ' — use: node setup/install.mjs upgrade');
  }
  say('installing factory ' + target + ' -> ' + mount + ' (host: ' + root + ', mode: ' + (flags.submodule ? 'submodule' : 'clone') + ')');
  if (DRY) { say('--dry: would clone, gitignore, then run setup/init.mjs ' + initFlags(root).join(' ')); return; }

  // Transactional: a mid-install failure (bad --version, red selftest, init crash) must not
  // strand a half-mount that then blocks the corrective re-run at the "already installed" check.
  let created = null;
  let submoduleAdded = false;
  const cleanup = (why) => {
    if (created && existsSync(created)) {
      warn('install FAILED (' + why + ') — removing the partial mount ' + created + ' so a corrective re-run starts clean');
      try { rmSync(created, { recursive: true, force: true }); } catch { /* best-effort */ }
    } else if (submoduleAdded) {
      warn('install FAILED (' + why + ') mid-submodule — undo with: git -C "' + root + '" submodule deinit -f "' + DIR + '" && git -C "' + root + '" rm -f "' + DIR + '" && rm -rf "' + join(root, '.git', 'modules', ...DIR.split('/')) + '"');
    }
    die(why);
  };

  try {
    if (flags.submodule) {
      git(['-C', root, 'submodule', 'add', REPO, DIR]);
      submoduleAdded = true;
      if (target !== 'main') git(['-C', mount, 'checkout', '--quiet', target]);
      say('submodule added — remember to COMMIT .gitmodules + the gitlink in the host repo');
    } else {
      mkdirSync(dirname(mount), { recursive: true });
      git(['clone', '--quiet', REPO, mount]);
      created = mount;
      if (target !== 'main') git(['-C', mount, 'checkout', '--quiet', target]);
      if (!flags['no-gitignore']) addGitignoreEntry(root);
    }
  } catch (e) {
    cleanup('git failed: ' + String(e.message || e).split('\n').filter(Boolean).pop());
  }

  if (!runInit(mount, root)) cleanup('setup/init.mjs reported failures');
  if (!runSelftest(mount)) cleanup('selftest FAILED on a fresh install of ' + target + ' — refusing to finish; report this version');

  const v = existsSync(join(mount, 'VERSION')) ? readFileSync(join(mount, 'VERSION'), 'utf8').trim() : target;
  say('installed ' + v + ' at ' + mount);
  say('controllers wired: ' + describeControllers().join(', '));
  say('telemetry is separate — on a POSIX host: bash ' + toPosix(relative(root, mount)) + '/setup/install.sh telemetry-up');
}

function describeControllers() {
  const out = [];
  if (!flags['no-claude']) out.push('Claude Code (.claude/skills/ai-factory)');
  if (!flags['no-copilot']) out.push('Copilot (.github/copilot-instructions.md)');
  if (!flags['no-opencode']) out.push('OpenCode (AGENTS.md, .opencode/, opencode.json)');
  return out.length ? out : ['(none — every controller was skipped)'];
}

// ---- upgrade ------------------------------------------------------------------------
function cmdUpgrade() {
  requirePrereqs();
  const mount = existingMount();
  if (!existsSync(join(mount, '_workflow', 'driver.mjs'))) die('no factory mount at ' + mount + ' (pass --host/--dir)');
  if (!existsSync(join(mount, '.git'))) {
    die('this mount is VENDORED (no .git) — it is upgraded by your engine-sync ritual, not by this script; or reinstall as a clone/submodule');
  }
  const dirty = git(['-C', mount, 'status', '--porcelain']);
  if (dirty && !flags.force) {
    console.error(dirty.split('\n').slice(0, 10).join('\n'));
    die('mount has local modifications to tracked engine files — commit/stash them upstream or re-run with --force (state/, reports/, queue/ are gitignored and never the cause)');
  }
  const target = resolveTarget();
  const prev = git(['-C', mount, 'rev-parse', 'HEAD']);
  const cur = tryGit(['-C', mount, 'describe', '--tags', '--always']) || prev;
  if (DRY) { say('--dry: would upgrade ' + cur + ' -> ' + target + ' at ' + mount); return; }
  git(['-C', mount, 'fetch', '--quiet', '--tags', 'origin']);

  // Up-to-date short-circuit + downgrade guard: an unattended `upgrade` must not re-churn an
  // already-current mount, and a regressed "latest" must announce itself before it silently
  // downgrades every host.
  const want = target === 'main'
    ? tryGit(['-C', mount, 'rev-parse', 'origin/main'])
    : tryGit(['-C', mount, 'rev-parse', 'refs/tags/' + target + '^{commit}']);
  if (want && want === prev) { say('already on ' + target + ' — up to date (selftest-verified install untouched)'); return; }
  if (/^v\d+\.\d+\.\d+$/.test(cur) && /^v\d+\.\d+\.\d+$/.test(target) && compareSemver(target, cur) < 0) {
    warn('target ' + target + ' is OLDER than installed ' + cur + ' — proceeding, but a downgrade is only right when deliberate (pin with --version to silence)');
  }

  say('upgrade: ' + cur + ' -> ' + target + ' (state/, reports/, queue/, telemetry data + .env are untouched by design)');
  try {
    git(['-C', mount, 'checkout', '--quiet', target === 'main' ? 'origin/main' : target]);
  } catch { die("version '" + target + "' not found on the remote"); }

  if (runSelftest(mount)) {
    // Refresh host-side scaffolding: the controller assets are installed by init.mjs, so an
    // upgrade that skips it leaves the host running a new engine behind old controller pointers.
    if (!runInit(mount, hostOfMount(mount))) {
      warn('init refresh FAILED — the engine upgrade itself is green; run by hand: node ' + join(mount, 'setup', 'init.mjs') + ' --repo-root <host-root>');
    }
    say('upgraded to ' + target + '. changes:');
    const log = tryGit(['-C', mount, 'log', '--oneline', prev + '..HEAD']);
    if (log) console.log(log.split('\n').slice(0, 20).join('\n'));
  } else {
    warn('selftest FAILED on ' + target + ' — ROLLING BACK to ' + cur);
    try { git(['-C', mount, 'checkout', '--quiet', prev]); }
    catch { die('ROLLBACK FAILED — the mount is LEFT ON ' + target + '; repair by hand: git -C ' + mount + ' checkout ' + prev); }
    die('rolled back to ' + cur + '; ' + target + ' is not safe on this host (report it)');
  }
}

// ---- controllers --------------------------------------------------------------------
// Host assets only: no clone, no fetch, no checkout, no selftest gate. init.mjs is idempotent
// and never clobbers a locally-edited asset, so this is safe to re-run at any time.
function cmdControllers() {
  const mount = existingMount();
  if (!existsSync(join(mount, 'setup', 'init.mjs'))) die('no factory mount at ' + mount + ' (pass --host/--dir)');
  const root = flags.host ? hostRoot() : hostOfMount(mount);
  say('re-installing controller assets into ' + root + ': ' + describeControllers().join(', '));
  if (!runInit(mount, root)) die('setup/init.mjs reported failures (see above)');
}

// ---- status -------------------------------------------------------------------------
function cmdStatus() {
  const mount = existingMount();
  if (!existsSync(join(mount, '_workflow', 'driver.mjs'))) die('no factory mount at ' + mount);
  const v = existsSync(join(mount, 'VERSION')) ? readFileSync(join(mount, 'VERSION'), 'utf8').trim() : '(unknown)';
  const g = existsSync(join(mount, '.git')) ? tryGit(['-C', mount, 'describe', '--tags', '--always', '--dirty']) : null;
  say('installed: VERSION=' + v + (g ? '  git=' + g : '') + '   mount=' + mount);
  let latest = null;
  try { latest = pickLatestReleaseTag(run('git', ['ls-remote', '--tags', '--refs', REPO, 'refs/tags/v*'])); }
  catch { warn('cannot reach ' + REPO + ' — latest-release check skipped'); }
  say('latest:    ' + (latest || '(no releases published — main)'));
  const root = flags.host ? hostRoot() : hostOfMount(mount);
  for (const [label, p] of [
    ['claude  ', join(root, '.claude', 'skills', 'ai-factory', 'SKILL.md')],
    ['copilot ', join(root, '.github', 'copilot-instructions.md')],
    ['opencode', join(root, '.opencode', 'skill', 'ai-factory', 'SKILL.md')],
  ]) say('  ' + label + ': ' + (existsSync(p) ? 'installed' : 'MISSING — run: node setup/install.mjs controllers'));
}

// ---- dispatch -----------------------------------------------------------------------
function cmdHelp() {
  // The header block above IS the help text — one source, no drift (install.sh:344 precedent).
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const body = [];
  for (const l of src.slice(1)) { if (!l.startsWith('//')) break; body.push(l.replace(/^\/\/ ?/, '')); }
  console.log(body.join('\n'));
}

if (flags.help) { cmdHelp(); process.exit(0); }
switch (cmd) {
  case 'install': cmdInstall(); break;
  case 'upgrade': cmdUpgrade(); break;
  case 'controllers': cmdControllers(); break;
  case 'status': cmdStatus(); break;
  case 'help': cmdHelp(); break;
  default: die('unknown command: ' + cmd + ' (install | upgrade | controllers | status | help)');
}
