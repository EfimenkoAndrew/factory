#!/usr/bin/env bash
# Opt-in installer for the local build-time audit gate (the pre-push hook). Run once:
#   bash <factory-mount>/ci/install-hooks.sh          (from anywhere inside the HOST repo)
# It symlinks the host repo's pre-push hook to this dir's pre-push. Uninstall by deleting
# .git/hooks/pre-push. Self-locating (KI-E17) — works at any factory mount path.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-push"
HOOK="$REPO_ROOT/.git/hooks/pre-push"

[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }
chmod +x "$SRC"

if [ -e "$HOOK" ] && [ ! -L "$HOOK" ]; then
  echo "WARNING: $HOOK already exists and is not a symlink — backing it up to pre-push.bak"
  mv "$HOOK" "$HOOK.bak"
fi
ln -sf "$SRC" "$HOOK"
echo "installed: .git/hooks/pre-push -> ci/pre-push"
echo "the audit gate now runs on every 'git push' (bypass once with --no-verify)."
