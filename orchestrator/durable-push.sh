#!/usr/bin/env bash
# KI-E305 — durable fold push, extracted to ONE shared script (was inline-copied into all three
# factory workflows, which drifted). Persists the local ref for <base> to origin/<base>, surviving:
#   * origin advancing since our last update-ref — fetch + push retry loop (KI-E301).
#   * a concurrent writer winning the race — back off and retry up to 5 times.
# A persistent failure is LOUD (exit 1 + ::error::), never swallowed. Nothing is force-pushed.
#
# TWO push modes (selected by whether the checked-out branch matches <base>):
#
#   SAME-BRANCH (checked out to <base>): uses `git rebase --autostash "origin/${base}"` so
#   that (a) the working-tree dirty state is stashed/restored, and (b) remote advances are
#   properly merged via a real rebase (not just re-parented). This is the normal case for
#   operator push and the mode exercised by the KI-E304 regression test.
#
#   CROSS-BRANCH (checked out to a DIFFERENT branch, e.g. master pushing factory/current):
#   pushes refs/heads/<base> directly WITHOUT touching the checked-out branch. On race loss,
#   re-parents refs/heads/<base> onto the new remote tip via commit-tree. The factory state
#   files are always additive (JSON/ledger), so re-parenting without a 3-way merge is safe.
#   This mode was introduced to fix the KI-E304 contamination: the old rebase rebased
#   `master` onto `origin/factory/current`, corrupting the main branch history.
#
# Usage: durable-push.sh [<target-branch>]   (defaults to checked-out branch, else $FACTORY_BASE_BRANCH, else master)
set -uo pipefail

base="${1:-}"
if [ -z "${base}" ]; then
  base="$(git rev-parse --abbrev-ref HEAD)"
  if [ "${base}" = "HEAD" ]; then base="${FACTORY_BASE_BRANCH:-master}"; fi
fi

# KI-E369: never push directly to master — all changes reach master via the factory/current PR.
# Pushing machine-state (ledger, PROGRESS) to master AND product-code fixes to factory/current
# caused merge conflicts when the PR was merged. Machine state must go to factory/current too.
if [ "${base}" = "master" ] || [ "${base}" = "main" ]; then
  echo "::error::durable-push BLOCKED: direct push to '${base}' is forbidden (KI-E369)."
  echo "::error::All changes — including machine state — reach master only via the factory/current PR."
  echo "::error::Commit machine state to factory/current instead, then push factory/current."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")"

pushed=""

if [ "${CURRENT_BRANCH}" = "${base}" ]; then
  # ── SAME-BRANCH MODE: rebase + autostash ──────────────────────────────────────────────
  for attempt in 1 2 3 4 5; do
    git fetch origin "${base}" 2>&1 || true
    git rebase --autostash "origin/${base}" 2>&1 || true
    if git push origin "HEAD:${base}" 2>&1; then
      pushed=1
      echo "durable-push: pushed to ${base} (attempt ${attempt})"
      break
    fi
    echo "::warning::durable-push attempt ${attempt} lost the race on ${base}; backing off"
    sleep "$((attempt * 3))"
  done
else
  # ── CROSS-BRANCH MODE: push refs/heads/<base> directly ────────────────────────────────
  # Never touches the checked-out branch. On race loss, re-parents our commit-tree onto
  # the new remote tip so the push becomes fast-forwardable again.
  for attempt in 1 2 3 4 5; do
    git fetch origin "${base}" 2>&1 || true
    if git push origin "refs/heads/${base}:refs/heads/${base}" 2>&1; then
      pushed=1
      echo "durable-push: pushed to ${base} (attempt ${attempt})"
      break
    fi
    echo "::warning::durable-push attempt ${attempt} lost the race on ${base}; backing off"
    git fetch origin "${base}" 2>&1 || true
    LOCAL_TIP=$(git rev-parse "refs/heads/${base}" 2>/dev/null || echo "")
    REMOTE_TIP=$(git rev-parse "origin/${base}" 2>/dev/null || echo "")
    if [ -n "$LOCAL_TIP" ] && [ -n "$REMOTE_TIP" ] && [ "$LOCAL_TIP" != "$REMOTE_TIP" ]; then
      COMMIT_TREE=$(git rev-parse "${LOCAL_TIP}^{tree}")
      COMMIT_MSG=$(git log -1 --format=%B "$LOCAL_TIP")
      NEW_COMMIT=$(GIT_AUTHOR_NAME="$(git log -1 --format=%an "$LOCAL_TIP")" \
        GIT_AUTHOR_EMAIL="$(git log -1 --format=%ae "$LOCAL_TIP")" \
        GIT_COMMITTER_NAME="$(git log -1 --format=%cn "$LOCAL_TIP")" \
        GIT_COMMITTER_EMAIL="$(git log -1 --format=%ce "$LOCAL_TIP")" \
        GIT_AUTHOR_DATE="$(git log -1 --format=%aI "$LOCAL_TIP")" \
        GIT_COMMITTER_DATE="$(git log -1 --format=%cI "$LOCAL_TIP")" \
        git commit-tree "$COMMIT_TREE" -p "$REMOTE_TIP" -m "$COMMIT_MSG" 2>/dev/null || echo "")
      if [ -n "$NEW_COMMIT" ]; then
        git update-ref "refs/heads/${base}" "$NEW_COMMIT"
      fi
    fi
    sleep "$((attempt * 3))"
  done
fi

if [ -z "${pushed}" ]; then
  echo "::error::durable-push FAILED to persist to ${base} after 5 attempts — ledger/feedback NOT pushed; investigate"
  exit 1
fi
