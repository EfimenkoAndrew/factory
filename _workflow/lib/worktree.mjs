// Git worktree management — the ONLY git this factory runs, and only the
// non-WIP-touching verbs. HARD RULE (PLAN.md 6, memory feedback-no-commits-from-claude /
// feedback-subagents-no-mutating-git): the factory NEVER runs commit / add / checkout /
// restore / stash / reset / clean against the user's working tree. `git worktree add`
// creates an ISOLATED checkout on its own throwaway branch — it does not touch the
// user's index, WIP, or branch — so it is the one safe mechanism (it is exactly what
// the runtime's own isolation:'worktree' uses). Integration copies files into the main
// tree as UNSTAGED changes for the human to review and commit; it never stages.
import { execFileSync } from 'node:child_process';

function git(args, opts) {
  // trimEnd (NOT trim): `git status --porcelain` encodes the status in the first 2 columns, so an
  // unstaged-modified line begins with a SPACE (" M path"). A full .trim() would strip that leading
  // space off the first line, shifting changedFiles' slice(3) and corrupting the first path (it ate the
  // 'k' of 'k8s/...' → false debris, cycle-6 bug). trimEnd drops only the trailing newline.
  return execFileSync('git', args, { encoding: 'utf8', ...(opts || {}) }).trimEnd();
}

// KI-L67 — strip the repo's git-tracked `.claude/` from the worktree working tree so a factory
// subagent operating INSIDE the worktree does not re-inject the ~55k-token `.claude/rules/*.md` a
// SECOND time. Root cause (investigations/factory-subagent-context-ceiling-investigation.md,
// High confidence): the harness surfaces a directory's rules as system-reminders on ANY file
// read/edit under it, and the factory briefs MANDATE worktree-internal file access — so every
// fixer/runner/test-author pays the rules baseline twice (session claudeMd + worktree copy),
// reaching the measured ~120k first-turn context that overflows haiku's 200k window. The rules
// STILL reach agents as the session's project claudeMd and are enforced as acceptance criteria —
// no capability is lost (agents are told to read briefs/docs from the REPO ROOT, never the
// worktree `.claude`). `sparse-checkout set '/*' '!/.claude/'` removes `.claude` from the working
// tree while leaving `git status` CLEAN (verified: no phantom deletions — sparse entries are not
// "deletions"), so the fold's changedFiles / debris / P9-root-cause / apply logic is unaffected
// and agent edits stay fully visible to `status`/`diff HEAD`. Best-effort: any failure (old git,
// odd config) degrades to a normal full checkout (rules present, the pre-KI-L67 behaviour) — it
// NEVER blocks worktree creation, and the KI-L64 runner→sonnet routing pin remains as
// defence-in-depth.
function stripClaudeFromWorktree(path) {
  try {
    git(['-C', path, 'sparse-checkout', 'init', '--no-cone']);
    git(['-C', path, 'sparse-checkout', 'set', '/*', '!/.claude/']);
    return true;
  } catch (_) {
    // Never leave a half-applied sparse state that hides real source; fall back to a full checkout.
    try { git(['-C', path, 'sparse-checkout', 'disable']); } catch (__) { /* ignore */ }
    return false;
  }
}

// Create an isolated worktree on a fresh branch off `base` (default: current HEAD).
// Returns { path, branch }. Idempotent-ish: if the path exists it is returned as-is.
export function addWorktree(path, branch, base) {
  const args = ['worktree', 'add', '-b', branch, path];
  if (base) args.push(base);
  try {
    git(args);
  } catch (e) {
    // If the branch already exists, attach without -b; if the path exists, reuse it.
    const msg = String(e.stderr || e.message || '');
    if (/already exists|already used by worktree/.test(msg)) {
      try { git(['worktree', 'add', path, branch]); } catch (_) { /* reuse existing */ }
    } else {
      throw e;
    }
  }
  // KI-L67 — strip `.claude/` on BOTH the create and reuse paths (retrofit an existing worktree in
  // place; sparse-checkout `set` updates the working tree to match, cleanly removing the copy).
  stripClaudeFromWorktree(path);
  return { path, branch };
}

// KI-L60 — is `p` inside a factory ITEM WORKTREE checkout? Worktrees live at
// <factory>/state/worktrees/<ID>/ and each contains a full shadow copy of the repo (including this
// library and the driver). Pure string check so the shadow-driver guard is selftest-able.
export function isFactoryWorktreePath(p) {
  return /[\\/]state[\\/]worktrees[\\/][^\\/]+[\\/]/.test(String(p) + '/');
}

// KI-E37 (review fix) — `docker compose ls --format json` output normalization: docker versions emit
// a JSON array OR NDJSON (one object per line); a lone object is wrapped. Blank input -> [].
export function parseComposeLs(raw) {
  const t = String(raw || '').trim();
  if (!t) return [];
  let out;
  try { out = JSON.parse(t); } catch { out = t.split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  return Array.isArray(out) ? out : [out];
}

// KI-E37 (review fix) — the gc sweep filter: a compose project is a stray ONLY when EVERY config file
// in its comma-joined ConfigFiles sits UNDER the worktrees root, separator-anchored. `every` (not
// `some`) keeps hybrid projects (host compose + a worktree override -f) out of the destructive
// `down -v` path, and the anchor keeps sibling dirs (`state/worktrees-archive/…`) structurally out.
export function strayComposeProjects(projects, wtRoot) {
  const list = Array.isArray(projects) ? projects : (projects ? [projects] : []);
  const root = String(wtRoot || '').replace(/[\\/]+$/, '');
  if (!root) return [];
  const under = (f) => f.startsWith(root + '/') || f.startsWith(root + '\\');
  return list.filter((p) => {
    const files = String((p && p.ConfigFiles) || '').split(',').map((s) => s.trim()).filter(Boolean);
    return files.length > 0 && files.every(under);
  });
}

export function removeWorktree(path, force) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  git(args);
}

// Ported from a host-mount session (2026-08-29) — `removeWorktree` above drops the worktree
// directory + git's worktree-admin entry, but leaves the `factory/<id>` branch ref standing at its
// stale creation commit. Origin evidence: refreshing worktrees that had drifted far behind HEAD
// required a MANUAL `git branch -D factory/<id>` after `worktree-remove` before a subsequent
// `addWorktree` call actually started fresh — because addWorktree's OWN fallback path above (`git
// worktree add -b` failing "already exists" -> falls back to plain `git worktree add <path>
// <existing-branch>`) silently attaches the new worktree to the OLD branch tip instead of cutting a
// new one from current HEAD. That is the exact staleness trap this function closes: call it right
// after `removeWorktree` and the branch this worktree used is gone too, so the next `addWorktree` for
// the same id takes the `-b` (fresh-from-HEAD) path instead of the silent-stale fallback.
//
// Deletion is gated on the same check the operator ran by hand: per this file's header invariant (the
// factory NEVER commits — PLAN.md 6), a `factory/<id>` branch has, by construction, zero commits
// beyond whatever base it was cut from; all real fix content lives only as UNSTAGED changes in the
// worktree's working tree, which `removeWorktree` has already discarded by the time this runs — so a
// branch with no unique commits carries no value once its worktree is gone. `git merge-base
// --is-ancestor <branch> HEAD` (exit 0 = branch tip already reachable from HEAD = nothing exclusive to
// lose) verifies that BEFORE deleting. If the branch is NOT an ancestor of HEAD — an unexpected commit
// landed on it, which the hard rule forbids but this function must not blindly trust — it is left
// standing and the reason is returned so the caller can warn a human, rather than either silently
// discarding history or silently leaving the staleness trap live.
export function pruneStaleBranch(branch, repoRoot) {
  if (!branch) return { deleted: false, reason: 'no-branch-given' };
  const root = repoRoot || '.';
  const name = branch.replace(/^refs\/heads\//, '');
  try {
    git(['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  } catch (_) {
    return { deleted: false, reason: `${name} does not exist (already removed?)` };
  }
  try {
    git(['-C', root, 'merge-base', '--is-ancestor', name, 'HEAD']);
  } catch (_) {
    return { deleted: false, reason: `${name} has commits not reachable from HEAD — left standing for manual review` };
  }
  try {
    git(['-C', root, 'branch', '-D', name]);
    return { deleted: true, branch: name };
  } catch (e) {
    return { deleted: false, reason: String((e && e.message) || e) };
  }
}

export function listWorktrees() {
  const out = git(['worktree', 'list', '--porcelain']);
  const blocks = out.split('\n\n').filter(Boolean);
  return blocks.map((b) => {
    const o = {};
    for (const line of b.split('\n')) {
      const [k, ...rest] = line.split(' ');
      o[k] = rest.join(' ');
    }
    return o;
  });
}

// Read-only change inspection of a worktree (no mutation).
export function changedFiles(path) {
  const out = git(['-C', path, 'status', '--porcelain']);
  return out ? out.split('\n').map((l) => l.slice(3)) : [];
}

// Prune the worktree admin list (drops bookkeeping for worktrees whose directory is already gone).
// Safe: it removes no live worktree and touches no working tree — pure git-internal housekeeping.
export function pruneWorktrees() {
  return git(['worktree', 'prune']);
}
