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

export function removeWorktree(path, force) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  git(args);
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
