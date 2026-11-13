#!/usr/bin/env bash
# KI-E303 — open (or update) the ONE shared factory PR for a CLOSED item.
#
# ONE-PR RULE (enforced here):
#   - All closed items accumulate onto a SINGLE branch (default: factory/current).
#   - Exactly ONE PR is ever open at a time: factory/current → BASE.
#   - Only a human may merge it. The factory never pushes to BASE directly.
#   - Per-item backup branches (factory/<id>) are still created for forensics/rollback.
#
# The agent's fix lives UNCOMMITTED in the item's worktree (KI-E1). On a successful
# close (CLOSED = all 5 review gates + verify APPROVED) we:
#   1. Commit the fix to factory/<id> (per-item backup).
#   2. Apply the item's diff onto factory/current (the single shared accumulator).
#   3. Open ONE PR for factory/current, or update it if already open.
#
# Idempotent: if the single PR already exists (open or merged) it records the URL
# without creating a duplicate. Emits `pr_url=<url>` to stdout (and to $GITHUB_OUTPUT
# when set) and writes prUrl back into ledger.json.
#
# Usage: open-pr.sh <item-id> <base-branch> [<factory-root>] [<title>]
# Env:   GH_TOKEN (required by gh), GH_REPO (owner/name), GH_SERVER (https://github.com)
#        FACTORY_PR_BRANCH — the single accumulator branch (default: factory/current)
#        GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL — identity for the factory-authored commits this
#        script creates (step 1 + step 2 below). Falls back to this repo's own `git config
#        user.name`/`user.email` if already set, then to a generic bot identity — never hardcode
#        a specific person's identity here.
set -uo pipefail
ID="${1:?item-id required}"; BASE="${2:?base branch required}"; ROOT="${3:-_bmad-output/ai-factory}"; TITLE="${4:-}"
LEDGER="$ROOT/state/ledger.json"
GH_REPO="${GH_REPO:-}"; GH_SERVER="${GH_SERVER:-https://github.com}"
SINGLE_BRANCH="${FACTORY_PR_BRANCH:-factory/current}"
COMMIT_NAME="${GIT_AUTHOR_NAME:-$(git config user.name 2>/dev/null || true)}"
COMMIT_EMAIL="${GIT_AUTHOR_EMAIL:-$(git config user.email 2>/dev/null || true)}"
[ -n "$COMMIT_NAME" ] || COMMIT_NAME="AI Implementation Factory"
[ -n "$COMMIT_EMAIL" ] || COMMIT_EMAIL="factory@localhost"
emit() { echo "$1"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >> "$GITHUB_OUTPUT"; }

# Write prUrl into ledger.json atomically so the retry loop can skip already-PR'd items.
record_pr_url() {
  local url="$1"
  node -e "
    const fs = require('fs');
    const p = process.argv[1];
    const id = process.argv[2];
    const url = process.argv[3];
    try {
      const l = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (l.items && l.items[id]) {
        l.items[id].prUrl = url;
        fs.writeFileSync(p + '.tmp', JSON.stringify(l, null, 2) + '\n');
        fs.renameSync(p + '.tmp', p);
      }
    } catch (e) { process.stderr.write('open-pr: ledger patch failed: ' + e.message + '\n'); }
  " "$LEDGER" "$ID" "$url" 2>&1 || echo "open-pr: warning — could not update prUrl in ledger for $ID"
}

[ -f "$LEDGER" ] || { echo "open-pr: no ledger at $LEDGER"; exit 0; }
field() { node -e "const it=JSON.parse(require('fs').readFileSync('$LEDGER','utf8')).items['$ID']||{};process.stdout.write(String(it['$1']||''))" 2>/dev/null || echo ""; }
STATE="$(field state)"; WT="$(field worktree)"; BR="$(field branch)"
[ -n "$BR" ] || BR="factory/$ID"

if [ "$STATE" != "CLOSED" ]; then echo "open-pr: $ID is '$STATE' (not CLOSED) — no PR"; exit 0; fi
if [ -z "$WT" ] || [ ! -d "$WT" ]; then echo "open-pr: $ID has no live worktree ('$WT') — cannot build a PR (gc'd?)"; exit 0; fi

# ── Step 1: Commit the worktree fix onto factory/<id> (per-item backup branch) ──
git -C "$WT" add -A
git -C "$WT" diff --cached --quiet || git -C "$WT" \
  -c user.name="$COMMIT_NAME" -c user.email="$COMMIT_EMAIL" \
  commit -m "fix($ID): factory-authored fix — human review required" \
          -m "Auto-opened by the AI Implementation Factory on a CLOSED run (all review gates + verify APPROVED)." \
          -m "The code was written by the factory; nothing reaches $BASE without a human merge (KI-E1/KI-E303)." >/dev/null

# Skip if the branch is content-identical to base (verification-only close, no code change).
git -C "$WT" fetch origin "$BASE" -q 2>/dev/null || true
if git -C "$WT" diff --quiet "origin/$BASE" HEAD 2>/dev/null; then
  echo "open-pr: $ID worktree matches origin/$BASE — no code change to PR"; exit 0
fi

# Push per-item backup branch (for forensics/rollback; not the live PR branch).
git -C "$WT" push origin "HEAD:refs/heads/$BR" --force 2>&1 || echo "open-pr: warn — could not push backup branch $BR (non-fatal)"

# ── Step 2: Accumulate this item's diff onto factory/current ──
# Get the full diff this item adds vs base.
PATCH="$(git -C "$WT" diff "origin/$BASE"...HEAD -- . 2>/dev/null)"

if [ -n "$PATCH" ]; then
  ACC_WT="$(mktemp -d -t factory-acc-XXXX)"
  # Try to use the existing factory/current branch; create from BASE if it doesn't exist.
  git fetch origin "$SINGLE_BRANCH" -q 2>/dev/null && HAS_REMOTE=1 || HAS_REMOTE=0

  if [ "$HAS_REMOTE" = "1" ]; then
    git worktree add "$ACC_WT" "origin/$SINGLE_BRANCH" -b "${SINGLE_BRANCH}-acc-$$" 2>/dev/null \
      || git worktree add "$ACC_WT" "origin/$SINGLE_BRANCH" 2>/dev/null \
      || { git fetch origin "$BASE" -q; git worktree add -b "${SINGLE_BRANCH}-acc-$$" "$ACC_WT" "origin/$BASE" 2>/dev/null; }
    # Reset the local branch to origin/SINGLE_BRANCH to accumulate on top.
    git -C "$ACC_WT" reset --hard "origin/$SINGLE_BRANCH" 2>/dev/null || true
  else
    # Branch doesn't exist on remote yet — start from BASE.
    git fetch origin "$BASE" -q 2>/dev/null || true
    git worktree add -b "${SINGLE_BRANCH}-acc-$$" "$ACC_WT" "origin/$BASE" 2>/dev/null \
      || git worktree add "$ACC_WT" "origin/$BASE" 2>/dev/null
  fi

  # Apply the patch with 3-way merge fallback.
  APPLIED=0
  if echo "$PATCH" | git -C "$ACC_WT" apply --3way - 2>/dev/null; then
    APPLIED=1
  else
    # 3-way failed — try a straight apply (ignores whitespace issues).
    echo "$PATCH" | git -C "$ACC_WT" apply --whitespace=nowarn - 2>/dev/null && APPLIED=1 || true
  fi

  if [ "$APPLIED" = "1" ]; then
    git -C "$ACC_WT" add -A
    if ! git -C "$ACC_WT" diff --cached --quiet; then
      git -C "$ACC_WT" \
        -c user.name="$COMMIT_NAME" -c user.email="$COMMIT_EMAIL" \
        commit -m "fix($ID): factory-authored fix — human review required" >/dev/null
    fi
    # Push to the single accumulator branch (force-with-lease for safety; retry with force if needed).
    git -C "$ACC_WT" push origin "HEAD:refs/heads/$SINGLE_BRANCH" --force-with-lease 2>&1 \
      || git -C "$ACC_WT" push origin "HEAD:refs/heads/$SINGLE_BRANCH" --force 2>&1 \
      || echo "open-pr: warn — could not push $SINGLE_BRANCH (will still try to open/update PR)"
  else
    echo "open-pr: warn — patch for $ID had conflicts on $SINGLE_BRANCH; manual merge may be needed"
  fi

  # Clean up temp accumulator worktree.
  git worktree remove "$ACC_WT" --force 2>/dev/null || rm -rf "$ACC_WT"
  # Prune the temp local branch reference.
  git branch -D "${SINGLE_BRANCH}-acc-$$" 2>/dev/null || true
fi

# ── Step 3: Open the ONE shared PR (or record the existing one) ──
# Check if there is already an open PR for factory/current → BASE.
EXIST_OPEN="$(gh pr list --head "$SINGLE_BRANCH" --base "$BASE" --state open --json url --jq '.[0].url' 2>/dev/null || true)"
EXIST_ANY="$(gh pr list --head "$SINGLE_BRANCH" --state all --json url --jq '.[0].url' 2>/dev/null || true)"

if [ -n "$EXIST_OPEN" ]; then
  echo "open-pr: single PR already open, branch updated with $ID → $EXIST_OPEN"
  emit "pr_url=$EXIST_OPEN"
  record_pr_url "$EXIST_OPEN"
  exit 0
fi
if [ -n "$EXIST_ANY" ]; then
  echo "open-pr: single PR already exists (merged/closed) → $EXIST_ANY — re-creating for new items"
  # Fall through to create a new PR for the next batch.
fi

# Build the PR body listing ALL closed items accumulated on this branch.
CLOSED_ITEMS="$(node -e "
  const fs = require('fs');
  try {
    const l = JSON.parse(fs.readFileSync('$LEDGER','utf8'));
    const items = Object.values(l.items||{})
      .filter(i => i.state === 'CLOSED')
      .map(i => '- \`' + i.id + '\`' + (i.title ? ': ' + i.title : ''))
      .join('\n');
    process.stdout.write(items || '- \`$ID\`');
  } catch(e) { process.stdout.write('- \`$ID\`'); }
" 2>/dev/null || echo "- \`$ID\`")"

[ -n "$TITLE" ] || TITLE="Factory batch — human review + merge required"
BODY_FILE="$(mktemp)"
{
  printf '## Factory-authored fixes — human review required\n\n'
  printf 'This PR accumulates **all CLOSED factory items** onto a single branch for your review.\n'
  printf 'Only YOU can merge this. The factory never pushes to `%s` directly (KI-E1/KI-E303).\n\n' "$BASE"
  printf '### Items in this batch\n\n%s\n\n' "$CLOSED_ITEMS"
  printf '---\n'
  printf 'Each item reached **CLOSED** (all 5 review gates + build/test verify APPROVED) before being\n'
  printf 'added here. Per-item backup branches (`factory/<id>`) are preserved for forensics/rollback.\n\n'
  printf '⚠️ **Review the diff carefully before merging.** The code was written by the AI factory.\n\n'
  printf '🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
} >> "$BODY_FILE"

URL="$(gh pr create --base "$BASE" --head "$SINGLE_BRANCH" --title "$TITLE" --body-file "$BODY_FILE" 2>&1)" \
  || { echo "::error::open-pr: gh pr create failed for $ID: $URL"; rm -f "$BODY_FILE"; exit 1; }
rm -f "$BODY_FILE"
echo "open-pr: opened single factory PR → $URL"
emit "pr_url=$URL"
record_pr_url "$URL"
