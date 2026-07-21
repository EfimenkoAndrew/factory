// Host-repo root detection + mount-path normalization (KI-E17 — portable mounts, SETUP.md).
// The factory historically assumed it lives at <repo>/_bmad-output/ai-factory: REPO_ROOT was a
// fixed `../..` off the factory root, and the committed config carries that stock prefix on every
// path. These helpers make ANY mount (submodule or plain clone, any depth) work:
//   - resolveRepoRoot: FACTORY_REPO_ROOT env override, else walk UP from the mount's PARENT to the
//     first `.git` (dir or file — a submodule's .git is a FILE; starting at the parent guarantees
//     the factory's OWN .git never wins), else the legacy `../..` fallback so a git-less scratch
//     layout keeps working.
//   - swapMountPrefix: rewrite the committed config's stock-prefixed root/paths onto the real
//     mount at load time, so the checked-in config stays pristine in every host.
// Pure path math + injectable io (selftest-covered).
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export const STOCK_MOUNT = '_bmad-output/ai-factory';

export function toPosix(p) { return String(p).split(sep).join('/'); }

// Walk up from the factory mount's PARENT until a directory containing `.git` is found.
// Returns the absolute host-repo root, or null when no enclosing git repo exists (standalone
// factory-development checkout).
export function findRepoRoot(factoryRoot, io) {
  const ex = (io && io.existsSync) || existsSync;
  let dir = dirname(resolve(factoryRoot));
  for (;;) {
    if (ex(resolve(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null; // filesystem root reached
    dir = up;
  }
}

// The REPO_ROOT every factory entrypoint should use. Order: explicit env override ->
// detected enclosing repo -> legacy fixed ../.. (pre-KI-E17 behaviour, kept as the fallback).
export function resolveRepoRoot(factoryRoot, env, io) {
  const override = env && env.FACTORY_REPO_ROOT;
  if (override) return resolve(String(override));
  return findRepoRoot(factoryRoot, io) || resolve(factoryRoot, '..', '..');
}

// Rewrite cfg.root + every cfg.paths[*] whose value is the stock mount (or lives under it) onto
// the actual mount. Identity when the mount IS the stock path — the host project's layout is untouched.
// Mutates and returns cfg (the driver's loadConfig owns the object).
export function swapMountPrefix(cfg, stock, mount) {
  if (!cfg || !mount || mount === stock) return cfg;
  const swap = (v) => (typeof v === 'string' && (v === stock || v.startsWith(stock + '/')))
    ? mount + v.slice(stock.length) : v;
  cfg.root = swap(cfg.root);
  if (cfg.paths) for (const k of Object.keys(cfg.paths)) cfg.paths[k] = swap(cfg.paths[k]);
  return cfg;
}
