#!/usr/bin/env bash
# Hermetic end-to-end harness for setup/install.sh + setup/release.sh (KI-E52).
#
# No network, no host mutation: a throwaway fixture remote is built in a tmpdir FROM THE
# CURRENT TREE (tracked files at their working-tree content, so uncommitted script changes are
# what gets exercised), HOME is redirected into the tmpdir, and everything is removed on exit.
# Run it before cutting a release:
#
#   bash setup/_e2e.sh
#
# Scenarios: fresh install resolves the latest STRICT vX.Y.Z tag (an rc decoy never wins) and
# passes the selftest gate; re-install refuses; status reports; upgrade to a selftest-broken
# tag ROLLS BACK (with the downgrade warning); up-to-date short-circuit; a broken-tag INSTALL
# removes its own partial mount; unreachable-remote dies loudly; an unparseable host
# settings.local.json is refused, not clobbered; release.sh cuts locally with --no-push, falls
# back to tag + release-branch when the remote's main is push-protected (PR-only ruleset
# simulation via a pre-receive hook), and REFUSES a behind-origin cut before mutating anything.
set -euo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"   # shell-profile / settings writes stay in the sandbox
export GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_CONFIG_SYSTEM=/dev/null
git config --file "$WORK/gitconfig" user.email e2e@local
git config --file "$WORK/gitconfig" user.name e2e
git config --file "$WORK/gitconfig" init.defaultBranch main

PASS=0; FAIL=0
ok() { # $1 = label, $2 = 0/1 truth (pass when 1)
  if [ "$2" = 1 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "E2E FAIL: $1" >&2; fi
}
say() { printf '\033[1;36m[e2e]\033[0m %s\n' "$*"; }

# ---- fixture remote: current tree -> src repo -> tags -> bare remote -------------------
say "building fixture remote from the current tree"
mkdir -p "$WORK/src"
# -co --exclude-standard: tracked + untracked-but-not-ignored, at WORKING-TREE content — the
# harness must exercise exactly the scripts as they are now, including not-yet-committed ones.
(cd "$SELF" && git ls-files -c -o -z --exclude-standard | tar --null -T - -cf -) | tar -xf - -C "$WORK/src"
git -C "$WORK/src" init -q
git -C "$WORK/src" add -A
git -C "$WORK/src" commit -qm "e2e base"
git -C "$WORK/src" tag v0.0.1
sed -i 's/^process.exit(fail ? 1 : 0);$/process.exit(1);/' "$WORK/src/_workflow/lib/_selftest.mjs"
git -C "$WORK/src" commit -qam "e2e broken selftest"
git -C "$WORK/src" tag v0.0.2                                     # the rollback target
git -C "$WORK/src" tag v0.0.4-rc1                                 # strict-filter decoy (newer, broken)
git -C "$WORK/src" revert -n --no-edit HEAD >/dev/null 2>&1 || { git -C "$WORK/src" checkout v0.0.1 -- _workflow/lib/_selftest.mjs; }
git -C "$WORK/src" commit -qam "e2e good tip"
git -C "$WORK/src" tag v0.0.3                                     # the real latest
git clone -q --bare "$WORK/src" "$WORK/remote.git"
INSTALL="$WORK/src/setup/install.sh"

# ---- install: strict latest tag + selftest gate ----------------------------------------
say "install (expect v0.0.3 — the rc decoy must not win)"
git -C "$WORK" init -q host1; ( cd "$WORK/host1" && echo x > f && git add f && git commit -qm h )
rc=0; bash "$INSTALL" install --repo "$WORK/remote.git" --host "$WORK/host1" --no-telemetry --yes >"$WORK/install1.log" 2>&1 || rc=$?
MOUNT="$WORK/host1/_bmad-output/ai-factory"
ok "install exits 0" "$([ $rc = 0 ] && echo 1 || echo 0)"
ok "install checked out the strict latest tag v0.0.3" "$([ "$(git -C "$MOUNT" describe --tags 2>/dev/null)" = v0.0.3 ] && echo 1 || echo 0)"
ok "host .gitignore carries the mount entry" "$(grep -qx '_bmad-output/ai-factory/' "$WORK/host1/.gitignore" && echo 1 || echo 0)"
ok "re-install refuses (already installed)" "$(bash "$INSTALL" install --repo "$WORK/remote.git" --host "$WORK/host1" --no-telemetry --yes >/dev/null 2>&1 && echo 0 || echo 1)"
ok "status reports the latest release" "$(bash "$INSTALL" status --repo "$WORK/remote.git" --host "$WORK/host1" 2>&1 | grep -q v0.0.3 && echo 1 || echo 0)"

# ---- upgrade to a broken tag: downgrade warn + rollback --------------------------------
say "upgrade to the selftest-broken v0.0.2 (expect warn + rollback)"
prev="$(git -C "$MOUNT" rev-parse HEAD)"
rc=0; bash "$INSTALL" upgrade --repo "$WORK/remote.git" --host "$WORK/host1" --version v0.0.2 --yes >"$WORK/up1.log" 2>&1 || rc=$?
ok "broken upgrade exits non-zero" "$([ $rc != 0 ] && echo 1 || echo 0)"
ok "downgrade warning fired" "$(grep -q 'OLDER than installed' "$WORK/up1.log" && echo 1 || echo 0)"
ok "rollback restored the previous ref" "$([ "$(git -C "$MOUNT" rev-parse HEAD)" = "$prev" ] && echo 1 || echo 0)"
ok "up-to-date short-circuit" "$(bash "$INSTALL" upgrade --repo "$WORK/remote.git" --host "$WORK/host1" --yes 2>&1 | grep -q 'up to date' && echo 1 || echo 0)"

# ---- transactional install: a failed install removes its own mount ---------------------
say "install pinned to the broken tag (expect cleanup of the partial mount)"
git -C "$WORK" init -q host2; ( cd "$WORK/host2" && echo x > f && git add f && git commit -qm h )
rc=0; bash "$INSTALL" install --repo "$WORK/remote.git" --host "$WORK/host2" --version v0.0.2 --no-telemetry --yes >"$WORK/install2.log" 2>&1 || rc=$?
ok "broken install exits non-zero" "$([ $rc != 0 ] && echo 1 || echo 0)"
ok "partial mount was removed (re-run not blocked)" "$([ ! -d "$WORK/host2/_bmad-output/ai-factory" ] && echo 1 || echo 0)"

# ---- unreachable remote dies loudly ----------------------------------------------------
# (capture-then-assert — piping the deliberately-failing command straight into grep would let
# THIS script's pipefail fold the expected exit 1 into the assertion itself)
rc=0; bash "$INSTALL" status --repo "$WORK/nope.git" --host "$WORK/host1" >"$WORK/unreach.log" 2>&1 || rc=$?
ok "unreachable remote dies loudly (no silent main fallback)" "$([ $rc != 0 ] && grep -q 'cannot reach' "$WORK/unreach.log" && echo 1 || echo 0)"

# ---- settings merge: unparseable file refused, valid file merged -----------------------
say "telemetry-up --dry: settings.local.json guard"
mkdir -p "$WORK/host1/.claude"; printf '{ definitely not json' > "$WORK/host1/.claude/settings.local.json"
rc=0; bash "$INSTALL" telemetry-up --repo "$WORK/remote.git" --host "$WORK/host1" --dry --no-shell-env >"$WORK/tup1.log" 2>&1 || rc=$?
ok "unparseable settings refused, not clobbered" "$(grep -q 'REFUSING to touch' "$WORK/tup1.log" && [ "$(cat "$WORK/host1/.claude/settings.local.json")" = '{ definitely not json' ] && echo 1 || echo 0)"
printf '{"model":"keep-me"}\n' > "$WORK/host1/.claude/settings.local.json"
bash "$INSTALL" telemetry-up --repo "$WORK/remote.git" --host "$WORK/host1" --dry --no-shell-env >"$WORK/tup2.log" 2>&1 || true
ok "valid settings merged, existing keys preserved" "$(grep -q '"model": "keep-me"' "$WORK/host1/.claude/settings.local.json" && grep -q 'CLAUDE_CODE_ENABLE_TELEMETRY' "$WORK/host1/.claude/settings.local.json" && echo 1 || echo 0)"
sed -i '/^FACTORY_OTLP_HTTP_PORT=/d' "$MOUNT/telemetry/.env"
ok "hand-trimmed .env key falls back to default instead of dying" "$(bash "$INSTALL" telemetry-up --repo "$WORK/remote.git" --host "$WORK/host1" --dry --no-shell-env >/dev/null 2>&1 && echo 1 || echo 0)"

# ---- release.sh: local cut, PR-only-main fallback, stale-cut guard ---------------------
say "release --no-push (local bump/changelog/tag)"
git clone -q "$WORK/remote.git" "$WORK/rel1"
rc=0; ( cd "$WORK/rel1" && bash setup/release.sh 0.1.0 --no-push ) >"$WORK/rel1.log" 2>&1 || rc=$?
ok "release --no-push exits 0" "$([ $rc = 0 ] && echo 1 || echo 0)"
ok "VERSION bumped + tag minted locally" "$([ "$(cat "$WORK/rel1/VERSION")" = 0.1.0 ] && git -C "$WORK/rel1" rev-parse -q --verify refs/tags/v0.1.0 >/dev/null && echo 1 || echo 0)"
ok "CHANGELOG section prepended" "$(head -1 "$WORK/rel1/CHANGELOG.md" | grep -q '^## v0.1.0' && echo 1 || echo 0)"

say "release against a PR-only main (pre-receive hook rejects main; expect tag + release-branch fallback)"
cat > "$WORK/remote.git/hooks/pre-receive" <<'EOF'
#!/usr/bin/env bash
while read -r _old _new ref; do [ "$ref" = "refs/heads/main" ] && { echo "main is PR-only" >&2; exit 1; }; done
exit 0
EOF
chmod +x "$WORK/remote.git/hooks/pre-receive"
git clone -q "$WORK/remote.git" "$WORK/rel2"
rc=0; ( cd "$WORK/rel2" && bash setup/release.sh 0.2.0 ) >"$WORK/rel2.log" 2>&1 || rc=$?
ok "PR-only release exits 0 via the fallback" "$([ $rc = 0 ] && echo 1 || echo 0)"
ok "fallback announced itself" "$(grep -q 'publishing via tag + release branch' "$WORK/rel2.log" && echo 1 || echo 0)"
ok "tag v0.2.0 published on the remote" "$(git ls-remote --tags --refs "$WORK/remote.git" | grep -q refs/tags/v0.2.0 && echo 1 || echo 0)"
ok "release/v0.2.0 branch published" "$(git ls-remote --heads "$WORK/remote.git" | grep -q refs/heads/release/v0.2.0 && echo 1 || echo 0)"
ok "remote main untouched by the fallback" "$([ "$(git ls-remote "$WORK/remote.git" refs/heads/main | cut -f1)" = "$(git -C "$WORK/rel2" rev-parse origin/main)" ] && echo 1 || echo 0)"
ok "installers now resolve the fallback-published release" "$(bash "$INSTALL" status --repo "$WORK/remote.git" --host "$WORK/host1" 2>&1 | grep -q v0.2.0 && echo 1 || echo 0)"

say "behind-origin cut refused BEFORE mutating (stale-tag guard)"
git clone -q "$WORK/remote.git" "$WORK/rel3"
mv "$WORK/remote.git/hooks/pre-receive" "$WORK/remote.git/hooks/pre-receive.off"
( cd "$WORK/rel2" && git push -q origin main )    # advance remote main past rel3's clone
mv "$WORK/remote.git/hooks/pre-receive.off" "$WORK/remote.git/hooks/pre-receive"
rc=0; ( cd "$WORK/rel3" && bash setup/release.sh 0.3.0 ) >"$WORK/rel3.log" 2>&1 || rc=$?
ok "stale cut refused (exit non-zero)" "$([ $rc != 0 ] && echo 1 || echo 0)"
ok "guard fired before any mutation (no local tag, VERSION untouched)" "$(! git -C "$WORK/rel3" rev-parse -q --verify refs/tags/v0.3.0 >/dev/null && [ "$(cat "$WORK/rel3/VERSION")" != 0.3.0 ] && echo 1 || echo 0)"
ok "guard names the remedy" "$(grep -q 'pull/rebase first' "$WORK/rel3.log" && echo 1 || echo 0)"

echo
echo "e2e: $PASS passed, $FAIL failed"
exit "$([ $FAIL = 0 ] && echo 0 || echo 1)"
