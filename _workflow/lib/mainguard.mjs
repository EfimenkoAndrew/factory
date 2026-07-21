// KI-L65 — MAIN-TREE contamination guard.
//
// Cycle 35 caught TWO lane agents writing to the MAIN repo working tree instead of (or in
// addition to) their isolated worktree, via the absolute "REPO ROOT (read-only reference)"
// path their brief names: the ITEM-H12 fixer edited
// deployment/k3s/infrastructure/prometheus/prometheus-config.yaml in main (an UNGATED superset
// of its gated worktree fix — the source of the "fabricated verify.json" the gates flagged:
// evidence honestly describing the WRONG TREE), and the ITEM-H5 fixer wrote a divergent stray
// saas/AuthService/deploy/BREAK-GLASS-RUNBOOK.md into main. The brief already forbids this
// (KI-L33 absolute-path discipline names the worktree as the ONLY edit surface), so this is
// agent non-compliance — the fix is deterministic DETECTION, not another prompt rule.
//
// Design: `group` snapshots a sha256 of each claimed item's files[] as they exist in the MAIN
// tree at claim time (state/items/<ID>/main-snapshot.json). `fold` re-hashes and warns LOUDLY
// on drift for every not-yet-folded result. Sibling-lane operator applies cannot false-positive
// this: batch file-locks make items' files[] disjoint, and an operator applies an item's own
// files only AFTER that item's first fold (already-folded results are excluded from the check).
// The check never blocks the fold — the ledger verdict concerns the WORKTREE; repairing main is
// operator judgment (restore from HEAD or apply the gated worktree copy).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** sha256 hex of a file, or null when missing/unreadable (null is a valid snapshot value: "absent"). */
export function hashFile(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex') } catch { return null }
}

/** Snapshot { relFile -> sha256|null } of files as they exist under repoRoot right now. */
export function snapshotMainFiles(repoRoot, files) {
  const snap = {}
  for (const f of files || []) snap[f] = hashFile(join(repoRoot, f))
  return snap
}

/** Compare the main tree against a snapshot; returns [{file, was, now}] for every drifted entry. */
export function driftAgainstSnapshot(repoRoot, snap) {
  const drifted = []
  for (const [f, h] of Object.entries(snap || {})) {
    const cur = hashFile(join(repoRoot, f))
    if (cur !== h) drifted.push({ file: f, was: h === null ? 'absent' : 'present', now: cur === null ? 'absent' : 'changed/present' })
  }
  return drifted
}

// KI-E14 (2026-07-20) — pre-claim complement to the KI-L65 post-hoc drift check above.
//
// A worktree is created from HEAD, so an item whose files[] intersect UNCOMMITTED main-tree
// changes gets a band that (a) reviews/verifies a tree silently missing that sibling work and
// (b) on apply-back has the operator copy CLOBBER the uncommitted fix (live near-miss:
// ITEM-M1's CommonConfiguration.cs vs the uncommitted ITEM-M2 fix, sessions 22/23).
// `group` hard-excludes such items until the user commits (file-level precision — same-service
// items on disjoint files still group). Pure helpers here; the driver owns the UX.

/** Uncommitted paths in the main tree: { paths: [file...], dirs: [dir.../] } (porcelain v1; rename sources included; untracked dirs listed with a trailing slash). */
export function dirtyMainPaths(repoRoot) {
  let out = ''
  try { out = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) } catch { return { paths: [], dirs: [] } }
  const paths = []; const dirs = []
  const push = (p) => {
    if (!p) return
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
    ;(p.endsWith('/') ? dirs : paths).push(p)
  }
  for (const raw of out.split('\n')) {
    if (!raw.trim()) continue
    const entry = raw.slice(3)
    const arrow = entry.indexOf(' -> ')
    if (arrow >= 0) { push(entry.slice(0, arrow)); push(entry.slice(arrow + 4)) } else push(entry)
  }
  return { paths, dirs }
}

/** The subset of an item's files[] that collide with dirty main-tree state (exact file or under a dirty untracked dir). */
export function filesOverlapDirty(files, dirty) {
  const d = dirty || { paths: [], dirs: [] }
  return (files || []).filter((f) => d.paths.includes(f) || d.dirs.some((dir) => f.startsWith(dir)))
}
