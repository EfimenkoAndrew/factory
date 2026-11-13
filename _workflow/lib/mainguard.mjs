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
//
// KI-E194 — every path comparison on this page (snapshot keys, dirty-overlap matching, unclaimed-
// drift filtering, worktree-debris matching) now goes through repo-path.mjs's canonical identity
// instead of raw string equality/`startsWith`/`join()`: separator ('\' vs '/'), './'/'../' aliasing,
// and (on Windows) case are normalized, and a path that would resolve outside `repoRoot` (a symlink
// escape, a `..` traversal) FAILS CLOSED with a thrown error instead of silently operating on
// whatever it resolved to. Lexical identity does not chase every filesystem hardlink/symlink alias by
// itself; `repoPathIdentity`'s own inode-keyed identity (when given a real `repoRoot`) is what closes
// that gap for a path that actually exists on disk.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { canonicalRepoPath, repoPathIdentity, repoPathOptions, repoPathsOverlap } from './repo-path.mjs'

/** sha256 hex of a file, or null when missing/unreadable (null is a valid snapshot value: "absent"). */
export function hashFile(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex') } catch { return null }
}

/** Snapshot { relFile -> sha256|null } of files as they exist under repoRoot right now.
 * Written via Object.defineProperty rather than `snap[f] = ...` — a claimed path that happens to be
 * literally named `__proto__`/`constructor`/etc. must become an OWN enumerable property of the
 * snapshot object, never silently reinterpreted as a prototype write (which a plain bracket
 * assignment on an object literal risks for exactly those key names). */
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
//
// Fix (ported from a host-mount session): previously ran a SEPARATE `git status --porcelain -- <file>`
// subprocess per drifted file. Now takes ONE whole-tree `dirtyMainPaths(repoRoot)` snapshot and
// reuses `filesOverlapDirty`'s own (now path-identity-aware) overlap check per file — fewer
// subprocesses, and the exact same overlap logic every other dirty-path check on this page uses,
// rather than a bespoke ad hoc git invocation. The conservative "any failure -> dirty" direction is
// unchanged: a failure to even LIST the tree's dirty state classifies every drifted file dirty; a
// failure to check one file's overlap against that state (an invalid/escaping path) classifies just
// that file dirty.
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

// KI-E61 (2026-08-02) introduced auto-repair for the dirty-drift case: `was: 'present'` restored the
// pre-drift file from HEAD, `was: 'absent'` removed a stray new one. **KI-E194 supersedes that
// mechanism — this is now diagnostic-only and performs NO git mutation.** The reasoning KI-E61 relied
// on ("the factory never commits, so dirty/untracked drift on a snapshotted path can only have
// arrived via an agent writing outside its worktree") proves the drift is UNEXPECTED; it does NOT
// prove the drift is DISPOSABLE. Dirty status is silent about WHOSE edit it is — the exact same
// git-porcelain signal an owner's own uncommitted work-in-progress produces sitting in the same tree
// while a fold runs. Checking out HEAD or `git clean -f`-ing a path on that basis risks destroying
// real, un-backed-up operator work on nothing stronger than "this file is dirty and an item's
// snapshot happened to name it" — a correlation, not an ownership proof. `main-check`/fold now only
// ever WARN (this function's own console.warn below) and hand the human the exact path + repoRoot to
// review; nothing on this page runs `git checkout`/`git clean` on the shared main tree anymore.
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

/** Uncommitted paths in the main tree: { paths: [file...], dirs: [dir.../] } (rename sources included;
 * untracked dirs listed with a trailing slash).
 *
 * Fix (ported from a host-mount session): the prior implementation used non-`-z` `git status
 * --porcelain` and hand-decoded git's C-quoting (`"caf\303\251.cs"`-style octal-escaped paths) to
 * recover the real bytes. `--porcelain=v1 -z` sidesteps the whole quoting question — with `-z`, git
 * NEVER C-quotes a path (regardless of `core.quotePath`) and emits raw bytes NUL-terminated instead,
 * and a rename/copy record's "from" path arrives as its OWN separate NUL-terminated entry rather than
 * joined into the same record by a `" -> "` separator a sufficiently strange real filename could
 * itself contain. Every parsed path is run through `canonicalRepoPath` (validates + canonicalizes; the
 * return value is discarded, this is a validation-only call) so a path git reports as escaping the
 * repository (or otherwise malformed) fails LOUD here rather than silently mismatching every later
 * overlap check that expects a well-formed repo-relative path. `git status` itself is invoked with
 * `--no-optional-locks` (never contends with a concurrent git operation for the index lock) and NO
 * surrounding try/catch — a git failure (not a repo, git missing, permission) now THROWS rather than
 * degrading to an empty dirty-set; callers that need the old fail-dirty posture (`splitDriftByStatus`)
 * catch it explicitly and classify conservatively themselves, rather than this shared primitive
 * silently hiding the failure from every caller including ones that need to know it happened. */
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

/** The subset of an item's files[] that collide with dirty main-tree state (exact file or under a dirty
 * untracked dir). Cross-platform-safe: pass `repoRoot` (bare, or inside an options object, as the
 * trailing arg(s)) to compare via real filesystem identity (inode/symlink-aware, and fails closed on
 * an escaping path); omitted, comparison stays a cheap lexical (case/separator-normalized) match — the
 * shape every EXISTING 2-arg call site keeps getting, unchanged in outcome for a well-formed path. */
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
// target — per KI-E194, NOTHING on this page auto-repairs a dirty path anymore (claimed or
// unclaimed alike; see repairDirtyDrift above), so this was never a narrower guarantee than the
// claimed-path checks, only a differently-worded one.
// Fix (multi-lens review, 2026-08-25, ported from the origin host-mount session): the `dirs` branch
// below used to filter ONLY on `underMount`, never consulting `claimed` at all — so a directory an
// item legitimately declared in its own files[] (e.g. a new test-project subfolder, which `git
// status --porcelain` reports at the DIRECTORY level when the whole thing is untracked, per git's
// own shallowest-untracked-boundary convention — see the live-repo fixture test) was unconditionally,
// permanently reported as unclaimed drift on every future main-check run, directly contradicting
// this function's own header comment ("the union of every path any item has EVER claimed").
// `dirClaimed` mirrors the pre-existing `filesOverlapDirty` helper's reversed direction: a claimed
// FILE path starting with a dirty DIR path means that dir is accounted for.
//
// Fix (ported from a host-mount session): the FILES branch had the exact same asymmetry in the OTHER
// direction — it only ever checked exact-match against `claimed`, never "is this dirty file inside a
// claimed DIRECTORY". `repoPathsOverlap` now checks both directions uniformly for files and dirs
// alike, so a claimed `NewFeature/` entry correctly accounts for a dirty `NewFeature/Foo.cs` git
// reports as an individual file (not collapsed to the directory line) — the reverse of the dirs-branch
// fix immediately above, closing the same class of false-positive symmetrically.
export function unclaimedMainDrift(dirty, mountRel, claimedPaths, platform = process.platform, repoRoot) {
  const options = repoPathOptions(platform, repoRoot)
  const d = dirty || { paths: [], dirs: [] }
  const claimedArr = [...(claimedPaths || [])].map((p) => repoPathIdentity(p, options))
  const mount = mountRel === null || mountRel === undefined || mountRel === '' || mountRel === '.' ? null : repoPathIdentity(mountRel, options)
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

// KI-E177 (2026-09-15, a prior item cycle 105 incident) — an UNCLAIMED main-tree path (KI-E89's own
// blind spot: no item's snapshot ever declared it, so the snapshot-based checks above cannot even
// look) is not equally likely to be leaked write-isolation contamination (KI-E149/E170-class) vs the
// operator's own unrelated work-in-progress — KI-E89's header comment treats the two as
// indistinguishable, but a real, checkable signal exists: does the SAME relative path, with
// BYTE-IDENTICAL content, already exist inside one of the just-folded items' OWN worktree? An
// operator's genuine new file would have to coincidentally match both the exact path AND the exact
// bytes of some item's worktree copy for that to happen by chance — it does not. Live incident: a
// fixer/consolidation agent's Edit/Write calls were refused for its assigned worktree path (a
// Claude-Code-tooling-level restriction, not an ai-factory bug — filed as separate product feedback)
// and it worked around this with a Python script; the workaround wrote the SAME correct content to
// BOTH the item's real worktree (correct) and, for at least one call, the shared MAIN tree (the
// contamination this function targets). Deliberately still returns a SIGNAL only — KI-E89's own
// "never auto-repair an unclaimed path" posture is UNCHANGED (an unclaimed path still has no
// snapshot to prove what "repair" would even mean, and a human still confirms before anything is
// deleted from the shared main tree; per KI-E194, claimed and unclaimed dirty paths can both
// legitimately contain owner work, which is exactly why NEITHER is ever auto-repaired now) — this
// only makes the signal strong enough that a human does not have to manually re-derive the
// diff-check by hand, which is exactly what this incident required.
// Files under `dir`, as plain paths RELATIVE TO `dir` (POSIX-separated) — regardless of whether
// `dir` itself was passed in as absolute or relative, since node:fs's recursive mode always returns
// paths relative to the directory argument, never resolved. Deliberately re-stats each entry rather
// than trusting Dirent.isFile() from withFileTypes — Node versions differ on whether a RECURSIVE
// withFileTypes listing's Dirent.parentPath is relative-as-passed or resolved-absolute, and getting
// that wrong silently produces garbage offsets; a plain recursive listing + statSync has no such
// ambiguity to get wrong.
function listFilesUnder(dir) {
  try { return readdirSync(dir, { recursive: true }).map((p) => p.split(sep).join('/')).filter((p) => { try { return statSync(join(dir, p)).isFile() } catch { return false } }) }
  catch { return [] }
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
