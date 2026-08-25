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

// KI-E35 (review fix) — split drifted files into COMMITTED delivery vs DIRTY/untracked contamination.
// "Clean" means `git status --porcelain` reports NOTHING for the path — no staged/unstaged edit and
// not untracked — so the drift can only have arrived via commits (human delivery; the factory never
// commits). An UNTRACKED file is dirty here: `git diff HEAD` is blind to it (exit 0), which is exactly
// how an agent-created stray (the live ITEM-H5 shape above) must NOT read as a committed delivery.
// Any git failure classifies dirty — conservative: the ⚠ direction, same as the pre-split behavior.
export function splitDriftByStatus(repoRoot, drifted) {
  const committed = []
  const dirty = []
  for (const d of drifted || []) {
    let clean = false
    try { clean = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', d.file], { encoding: 'utf8' }).trim() === '' } catch { /* repo error -> dirty */ }
    const bucket = clean ? committed : dirty
    bucket.push(d)
  }
  return { committed, dirty }
}

// KI-E61 (2026-08-02) — auto-repair for the DIRTY-drift case. splitDriftByStatus's own reasoning
// already proves this is safe: the factory never commits (§ hard rule, PLAN.md/CLAUDE.md), so
// dirty/untracked drift on a snapshotted path can ONLY have arrived via an agent writing outside
// its worktree — there is no legitimate-human-action interpretation for it (that's the COMMITTED
// bucket, left untouched, still operator judgment per KI-E35). Every prior fold treated dirty
// drift as WARN-only ("repairing main is operator judgment") and left it for a human to notice —
// this run's ITEM-H18 contamination sat in the tree until manually caught. Repair each dirty
// entry to its pre-drift state: `was: 'present'` restores from HEAD (the file existed and was
// overwritten); `was: 'absent'` removes it (a stray new file HEAD never had — checkout can't
// restore what was never committed). Returns the entries it actually repaired; a repair failure
// on one file is reported, never thrown — a partial repair must not crash the fold.
export function repairDirtyDrift(repoRoot, dirty) {
  const repaired = []
  for (const d of dirty || []) {
    try {
      if (d.was === 'absent') {
        execFileSync('git', ['-C', repoRoot, 'clean', '-f', '--', d.file], { encoding: 'utf8' })
      } else {
        execFileSync('git', ['-C', repoRoot, 'checkout', '--quiet', 'HEAD', '--', d.file], { encoding: 'utf8' })
      }
      repaired.push(d)
    } catch (e) {
      d.repairError = String((e && e.message) || e)
    }
  }
  return repaired
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

// KI-E89 (2026-08-24, ported from a host-mount session) — the inverse gap from KI-E14/KI-L65 above:
// EVERY check on this page (the pre-claim overlap guard, the post-fold snapshot drift check,
// main-check's per-id sweep, incl. its KI-E82 --all widening) can only ever evaluate a path that is
// PART OF SOME ITEM'S declared files[]. A brand-new leaked path that no item ever claimed has no
// snapshot to diff against and is structurally invisible to all of them — live-caught on the host
// mount: a batch sweep found real leaked contamination (one tracked-file edit + two new untracked
// paths) sitting clean through both the closing item's own auto-repair AND a fresh `main-check --all`
// sweep; only a manual `git status --short` surfaced it.
//
// This is the missing net: given the raw dirty/untracked state of the main tree (`dirtyMainPaths`),
// the factory's own mount (repo-root-relative, e.g. `_bmad-output/ai-factory` — its bookkeeping,
// ledger/reports/queue/state, is ALWAYS legitimately dirty during active use and must never be
// reported here), and the union of every path any item has EVER claimed (regardless of drift
// status — the exact ceiling of what the snapshot-based checks above are even capable of seeing),
// return whatever main-tree dirt remains: content with no claim and no mount-bookkeeping excuse.
// This can NOT distinguish unclaimed factory-worktree contamination from a human's own unrelated
// work-in-progress sitting in the same tree — the caller (`main-check`, read-only/warn-only
// throughout) surfaces it as a nudge to eyeball, never a silent miss and never an auto-repair
// target (KI-E61's auto-repair stays scoped to the snapshot-confirmed case — an unclaimed path has
// no snapshot to prove what "repair" would even mean).
export function unclaimedMainDrift(dirty, mountRel, claimedPaths) {
  const d = dirty || { paths: [], dirs: [] }
  const claimed = claimedPaths || new Set()
  const underMount = (p) => p === mountRel || p.startsWith(mountRel + '/')
  const files = d.paths.filter((p) => !underMount(p) && !claimed.has(p))
  const dirs = d.dirs.filter((p) => !underMount(p))
  return [...files, ...dirs]
}
