// File locks — prevent two in-flight items from editing the same file in parallel
// worktrees (which would thrash serial integration). An item claims its files[]; a
// second item touching any of the same files waits (CONFLICT -> re-queue).
import { ACTIVE } from './ledger.mjs';

// Files currently locked by in-flight (active) items, mapped to the locking item id.
export function lockedFiles(graph, ledger) {
  const byId = Object.fromEntries((graph.items || []).map((w) => [w.id, w]));
  const locks = new Map();
  for (const [id, row] of Object.entries(ledger.items)) {
    if (!ACTIVE.includes(row.state)) continue;
    const wi = byId[id];
    if (!wi) continue;
    for (const f of wi.files || []) locks.set(f, id);
  }
  return locks;
}

// Does this work item conflict with the current in-flight lock set?
// Returns the conflicting file + holder, or null if clear.
export function conflictFor(wi, locks) {
  for (const f of wi.files || []) {
    if (locks.has(f)) return { file: f, heldBy: locks.get(f) };
  }
  return null;
}
