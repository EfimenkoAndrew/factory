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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { canonicalRepoPath, repoPathIdentity, repoPathOptions, repoPathsOverlap } from './repo-path.mjs'

/** sha256 hex of a file, or null when missing/unreadable (null is a valid snapshot value: "absent"). */
export function hashFile(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex') } catch { return null }
}

/** Snapshot { relFile -> sha256|null } of files as they exist under repoRoot right now. */
export function snapshotMainFiles(repoRoot, files) {
  const snap = {}
  for (const f of files || []) Object.defineProperty(snap, f, { value: hashFile(repoPathIdentity(f, { repoRoot }).absolute), enumerable: true, configurable: true, writable: true })
  return snap
}

/** Compare the main tree against a snapshot; returns [{file, was, now}] for every drifted entry. */
export function driftAgainstSnapshot(repoRoot, snap) {
  const drifted = []
  for (const [f, h] of Object.entries(snap || {})) {
    const cur = hashFile(repoPathIdentity(f, { repoRoot }).absolute)
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
export function splitDriftByStatus(repoRoot, drifted, options = {}) {
  const committed = []
  const dirty = []
  let status
  try { status = dirtyMainPaths(repoRoot) } catch { return { committed, dirty: [...(drifted || [])] } }
  for (const d of drifted || []) {
    let clean = false
    try { clean = filesOverlapDirty([d.file], status, options).length === 0 } catch { /* invalid path -> dirty */ }
    const bucket = clean ? committed : dirty
    bucket.push(d)
  }
  return { committed, dirty }
}

// Compatibility diagnostic only: dirty drift can be uncommitted owner work. Never repair it.
export function repairDirtyDrift(repoRoot, dirty) {
  for (const d of dirty || []) {
    console.warn('MAIN-DRIFT: owner review required for ' + JSON.stringify(d.file) + ' in ' + JSON.stringify(repoRoot) + '; compare the current content with the claim snapshot and intended worktree changes. No repair performed.')
  }
  return []
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
  const out = execFileSync('git', ['--no-optional-locks', '-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=normal', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const paths = []; const dirs = []
  const push = (p) => {
    canonicalRepoPath(p)
    ;(p.endsWith('/') ? dirs : paths).push(p)
  }
  const entries = out.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i]
    if (!raw) continue
    if (raw.length < 4 || raw[2] !== ' ' || !/^[ MTADRCU?!]{2}$/.test(raw.slice(0, 2))) throw new Error('Invalid git status record')
    push(raw.slice(3))
    if (/[RC]/.test(raw.slice(0, 2))) push(entries[++i])
  }
  return { paths, dirs }
}

/** The subset of an item's files[] that collide with dirty main-tree state (exact file or under a dirty untracked dir). */
export function filesOverlapDirty(files, dirty, platform = process.platform, repoRoot) {
  const options = repoPathOptions(platform, repoRoot)
  const d = dirty || { paths: [], dirs: [] }
  const paths = d.paths.map((p) => repoPathIdentity(p, options))
  const dirs = d.dirs.map((p) => ({ ...repoPathIdentity(p, options), directory: true }))
  return (files || []).filter((f) => {
    const key = repoPathIdentity(f, options)
    return [...paths, ...dirs].some((dirtyPath) => repoPathsOverlap(key, dirtyPath))
  })
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
// target. Claimed and unclaimed dirty paths can both contain owner work.
// Fix (multi-lens review, 2026-08-25, ported from the origin host-mount session): the `dirs` branch
// below used to filter ONLY on `underMount`, never consulting `claimed` at all — so a directory an
// item legitimately declared in its own files[] (e.g. a new test-project subfolder, which `git
// status --porcelain` reports at the DIRECTORY level when the whole thing is untracked, per git's
// own shallowest-untracked-boundary convention — see the live-repo fixture test) was unconditionally,
// permanently reported as unclaimed drift on every future main-check run, directly contradicting
// this function's own header comment ("the union of every path any item has EVER claimed").
// `dirClaimed` mirrors the pre-existing `filesOverlapDirty` helper's reversed direction: a claimed
// FILE path starting with a dirty DIR path means that dir is accounted for.
export function unclaimedMainDrift(dirty, mountRel, claimedPaths, platform = process.platform, repoRoot) {
  const options = repoPathOptions(platform, repoRoot)
  const d = dirty || { paths: [], dirs: [] }
  const claimedArr = [...(claimedPaths || [])].map((p) => repoPathIdentity(p, options))
  const mount = mountRel === null || mountRel === '' || mountRel === '.' ? null : repoPathIdentity(mountRel, options)
  const underMount = (p) => mount !== null && (p.path === mount.path || p.path.startsWith(mount.path + '/'))
  const files = d.paths.filter((p) => {
    const key = repoPathIdentity(p, options)
    return !underMount(key) && !claimedArr.some((c) => repoPathsOverlap(c, key))
  })
  const dirs = d.dirs.filter((p) => {
    const key = { ...repoPathIdentity(p, options), directory: true }
    return !underMount(key) && !claimedArr.some((c) => repoPathsOverlap(c, key))
  })
  return [...files, ...dirs]
}

// KI-E177 (ported from a host-mount session) — an UNCLAIMED main-tree path (KI-E89's own blind
// spot: no item's snapshot ever declared it, so the snapshot-based checks above cannot even look)
// is not equally likely to be leaked write-isolation contamination (KI-E149-class) vs the
// operator's own unrelated work-in-progress — KI-E89's header comment treats the two as
// indistinguishable, but a real, checkable signal exists: does the SAME relative path, with
// BYTE-IDENTICAL content, already exist inside one of the just-folded items' OWN worktree? An
// operator's genuine new file would have to coincidentally match both the exact path AND the exact
// bytes of some item's worktree copy for that to happen by chance — it does not. Deliberately
// still returns a SIGNAL only — KI-E89's own "never auto-repair an unclaimed path" posture is
// UNCHANGED (an unclaimed path still has no snapshot to prove what "repair" would even mean, and a
// human still confirms before anything is deleted from the shared main tree) — this only makes
// the signal strong enough that a human does not have to manually re-derive the diff-check by hand.
function listFilesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? listFilesUnder(join(dir, entry.name)).map((p) => entry.name + '/' + p)
    : entry.isFile() || entry.isSymbolicLink() ? [entry.name] : [])
}
export function matchWorktreeDebris(repoRoot, unclaimedPaths, itemIds, worktreesRoot) {
  return (unclaimedPaths || []).map((p) => {
    const identity = repoPathIdentity(p, { repoRoot })
    const key = identity.path
    const isDir = /[\\/]$/.test(p)
    const relFiles = isDir ? listFilesUnder(identity.absolute).map((f) => canonicalRepoPath(key + '/' + f)) : [key]
    for (const f of relFiles) {
      const mainHash = hashFile(repoPathIdentity(f, { repoRoot }).absolute)
      if (mainHash === null) continue
      for (const id of itemIds || []) {
        const worktree = repoPathIdentity(id, { repoRoot: worktreesRoot })
        if (!worktree.exists || !worktree.directory) continue
        if (hashFile(repoPathIdentity(f, { repoRoot: worktree.absolute }).absolute) === mainHash) return { path: p, matchedItem: id, matchedFile: f }
      }
    }
    return { path: p, matchedItem: null, matchedFile: null }
  })
}
