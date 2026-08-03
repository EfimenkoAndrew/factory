#!/usr/bin/env bash
# AI Implementation Factory — maintainer release cut (KI-E52).
#
#   setup/release.sh <patch|minor|major|X.Y.Z> [--dry-run] [--no-push]
#
# What it does (in order, aborting on any failure):
#   1. Requires: a clean tree, the main branch, and a GREEN selftest (the same gate the
#      installer enforces on every developer upgrade — never release what upgrades reject).
#   2. Bumps VERSION (semver; `patch|minor|major` compute from the current value).
#   3. Prepends a CHANGELOG.md section from `git log <last-tag>..HEAD`.
#   4. Commits `release: vX.Y.Z`, tags `vX.Y.Z` (annotated).
#   5. Pushes main + the tag (`--no-push` to keep it local), and — when the `gh` CLI is
#      available — publishes a GitHub Release so `install.sh` clients resolve it as latest.
set -euo pipefail
log()  { printf '\033[1;34m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[release]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[release]\033[0m %s\n' "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUMP="${1:-}"; shift || true
DRY=0; PUSH=1
for a in "$@"; do case "$a" in --dry-run) DRY=1;; --no-push) PUSH=0;; *) die "unknown flag: $a";; esac; done
[ -n "$BUMP" ] || die "usage: setup/release.sh <patch|minor|major|X.Y.Z> [--dry-run] [--no-push]"

cd "$ROOT"
[ -f VERSION ] || die "no VERSION file at $ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "releases cut from main only (on '$BRANCH')"
[ -z "$(git status --porcelain)" ] || die "working tree not clean — commit or stash first"

# A stale local main publishes a stale tag (review find, demoed): a rejected branch push does
# NOT stop a --follow-tags tag push, and installers resolve releases via ls-remote tags alone —
# so a behind-origin cut goes live team-wide while the branch push "fails". The cut must sit
# exactly on origin/main BEFORE the bump commit exists. (--no-push cuts are exempt: publishing
# is then explicitly the human's step, and the guard would break offline/dry experimentation.)
if [ $PUSH = 1 ]; then
  git fetch --quiet origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
    || die "local main is not exactly origin/main — pull/rebase first (a behind/diverged cut would publish a stale tag)"
fi

CUR="$(cat VERSION)"
[[ "$CUR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION '$CUR' is not X.Y.Z"
IFS=. read -r MA MI PA <<< "$CUR"
case "$BUMP" in
  patch) NEXT="$MA.$MI.$((PA+1))";;
  minor) NEXT="$MA.$((MI+1)).0";;
  major) NEXT="$((MA+1)).0.0";;
  *) [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bump must be patch|minor|major|X.Y.Z"; NEXT="$BUMP";;
esac
TAG="v$NEXT"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"

log "selftest gate (the same one installer upgrades enforce)"
node _workflow/lib/_selftest.mjs >/dev/null || die "selftest FAILED — not releasable"

LAST="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
RANGE="${LAST:+$LAST..}HEAD"
NOTES="$(git log --oneline --no-decorate "$RANGE" | sed 's/^/- /')"
log "release $CUR -> $NEXT (${LAST:-first release}; $(printf '%s\n' "$NOTES" | grep -c .) commit(s))"
[ $DRY = 1 ] && { printf '%s\n' "$NOTES"; log "--dry-run: no files changed"; exit 0; }

printf '%s\n' "$NEXT" > VERSION
{ echo "## $TAG — $(date +%F)"; echo; printf '%s\n' "$NOTES"; echo; cat CHANGELOG.md 2>/dev/null; } > CHANGELOG.md.new
mv CHANGELOG.md.new CHANGELOG.md
git add VERSION CHANGELOG.md
git commit -m "release: $TAG"
git tag -a "$TAG" -m "factory $TAG"
if [ $PUSH = 1 ]; then
  # --atomic: main + tag land together or not at all — a ruleset rejection of main must not
  # half-publish the tag (the --follow-tags behavior the review demoed).
  if git push --atomic origin main "refs/tags/$TAG"; then :; else
    # A PR-only ruleset on main (no direct pushes) rejects the line above — the factory's own
    # public repo is configured exactly so. Publish WITHOUT touching main: push the tag (allowed —
    # branch rules do not govern refs/tags/*, and the push carries the release commit's objects),
    # push the bump commit as a release branch, and open the PR that lands VERSION/CHANGELOG on
    # main. Installers resolve the tag either way — the release is live the moment the tag lands.
    # Branch is feature/release-$TAG, not release/$TAG — live-caught cutting v1.1.0: a separate
    # "Check branch name" required status check (added after this script) rejects anything not
    # prefixed feature/, so the bookkeeping PR itself failed CI until this was renamed.
    warn "direct push to main REJECTED (PR-only ruleset?) — publishing via tag + release branch instead"
    git push origin "refs/tags/$TAG" || die "tag push failed — the release commit+tag exist LOCALLY; retry by hand: git push origin $TAG && git push origin HEAD:refs/heads/feature/release-$TAG"
    git push origin "HEAD:refs/heads/feature/release-$TAG" || die "release-branch push failed — tag $TAG IS already published; push the branch by hand: git push origin HEAD:refs/heads/feature/release-$TAG"
    if command -v gh >/dev/null; then
      gh pr create --base main --head "feature/release-$TAG" --title "release: $TAG" \
        --body "VERSION + CHANGELOG bump for $TAG, cut by setup/release.sh. The annotated tag \`$TAG\` already points at this commit, so installers resolve it now; merging lands the bump on main." || true
    fi
    log "tag $TAG is published — merge the feature/release-$TAG PR to land VERSION/CHANGELOG on main (local main is ahead until then)"
  fi
  if command -v gh >/dev/null; then gh release create "$TAG" --title "factory $TAG" --generate-notes || true
  else log "gh CLI not found — tag pushed; create the GitHub Release by hand if wanted (installers resolve tags either way)"; fi
else
  log "--no-push: commit + tag are local; push with: git push origin main --follow-tags (on a PR-only main: git push origin $TAG && git push origin HEAD:refs/heads/feature/release-$TAG, then PR the branch)"
fi
log "released $TAG — team upgrades via: <mount>/setup/install.sh upgrade"
