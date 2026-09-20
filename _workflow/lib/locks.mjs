// File locks — prevent two in-flight items from editing the same file in parallel
// worktrees (which would thrash serial integration). An item claims its files[]; a
// second item touching any of the same files waits (CONFLICT -> re-queue).
import { ACTIVE } from './ledger.mjs';
import { repoPathIdentity, repoPathOptions, repoPathsOverlap } from './repo-path.mjs';

const lockOptions = new WeakMap();

// Files currently locked by in-flight (active) items, mapped to the locking item id.
export function lockedFiles(graph, ledger, platform = process.platform, repoRoot) {
  const options = repoPathOptions(platform, repoRoot);
  const byId = Object.fromEntries((graph.items || []).map((w) => [w.id, w]));
  const locks = new Map();
  for (const [id, row] of Object.entries(ledger.items)) {
    if (!ACTIVE.includes(row.state)) continue;
    const wi = byId[id];
    if (!wi) continue;
    for (const f of wi.files || []) {
      repoPathIdentity(f, options);
      locks.set(f, id);
    }
  }
  lockOptions.set(locks, options);
  return locks;
}

// Does this work item conflict with the current in-flight lock set?
// Returns the conflicting file + holder, or null if clear.
export function conflictFor(wi, locks, platform, repoRoot) {
  const options = platform === undefined ? (lockOptions.get(locks) || repoPathOptions()) : repoPathOptions(platform, repoRoot);
  const keys = (wi.files || []).map((f) => repoPathIdentity(f, options));
  const canonicalLocks = [...locks].map(([f, id]) => [repoPathIdentity(f, options), id]);
  for (let i = 0; i < keys.length; i++) {
    const conflict = canonicalLocks.find(([key]) => repoPathsOverlap(keys[i], key));
    if (conflict) return { file: wi.files[i], heldBy: conflict[1] };
  }
  return null;
}
