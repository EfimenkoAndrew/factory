#!/usr/bin/env bash
# AI Implementation Factory — versioned installer / upgrader / per-developer telemetry bootstrap
# (KI-E52). Team one-liner:
#
#   curl -fsSL https://raw.githubusercontent.com/EfimenkoAndrew/factory/main/setup/install.sh \
#     | bash -s -- install
#
# Commands
#   install         Clone the factory into a host repo at a release tag (default: the latest
#                   vX.Y.Z tag; falls back to `main` with a notice while the repo has no
#                   releases yet), run setup/init.mjs, GATE on the selftest, then bootstrap the
#                   per-developer telemetry stack (skip with --no-telemetry).
#   upgrade         Fetch + checkout the requested/latest version IN PLACE. Per-host state
#                   (state/, reports/, queue/, telemetry/data/, telemetry/.env, *.local.*
#                   overrides) is gitignored, so a checkout never touches it. GATED on the
#                   selftest — a red selftest ROLLS BACK to the previous version and exits 1.
#                   Unattended-safe: `install.sh upgrade --yes` is cron-able.
#   status          Installed version vs the latest published release.
#   telemetry-up    Per-developer observability infra: telemetry/.env + `docker compose up -d`
#                   + the session cost-telemetry env installed THREE ways (per-host env file,
#                   host .claude/settings.local.json `env` block, optional shell-profile block —
#                   some runtimes do not forward OTEL_* from settings env, so the shell profile
#                   is the reliable path; see KNOWN-ISSUES KI-E33) + a health check. Idempotent.
#   telemetry-down  Stop the stack. Volumes are preserved; --purge removes them.
#
# Options
#   --repo <url>       factory remote (default: https://github.com/EfimenkoAndrew/factory.git)
#   --dir <path>       mount path inside the host repo (default: _bmad-output/ai-factory)
#   --host <path>      host repo root (default: `git rev-parse --show-toplevel` from cwd,
#                      or the mount this script lives in)
#   --version <v>      vX.Y.Z tag or `main` (default: latest release tag, else main)
#   --submodule        install as a git submodule instead of a plain clone
#   --hooks            also install the pre-push audit gate (delegated to setup/init.mjs)
#   --no-telemetry     skip the telemetry bootstrap during install
#   --no-gitignore     do not add the mount dir to the host .gitignore (clone mode)
#   --shell-env        install the cost-telemetry env block into ~/.bashrc (+ ~/.zshrc);
#   --no-shell-env     never touch shell profiles (default: ask, or yes under --yes)
#   --purge            with telemetry-down: also remove the data volumes
#   --dry              with telemetry-up: write env files + print the plan, no docker calls
#   --force            with upgrade: proceed despite local modifications to tracked files
#   --yes              non-interactive (accept defaults for every prompt)
set -euo pipefail

DEFAULT_REPO="https://github.com/EfimenkoAndrew/factory.git"
DEFAULT_DIR="_bmad-output/ai-factory"
log()  { printf '\033[1;34m[factory]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[factory]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[factory]\033[0m %s\n' "$*" >&2; exit 1; }

CMD="${1:-}"; [ $# -gt 0 ] && shift || true
REPO="$DEFAULT_REPO"; DIR="$DEFAULT_DIR"; HOST=""; WANT_VERSION=""; SUBMODULE=0; HOOKS=0
NO_TELEMETRY=0; NO_GITIGNORE=0; SHELL_ENV=""; PURGE=0; DRY=0; FORCE=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --dir) DIR="$2"; shift 2;;
    --host) HOST="$2"; shift 2;;
    --version) WANT_VERSION="$2"; shift 2;;
    --submodule) SUBMODULE=1; shift;;
    --hooks) HOOKS=1; shift;;
    --no-telemetry) NO_TELEMETRY=1; shift;;
    --no-gitignore) NO_GITIGNORE=1; shift;;
    --shell-env) SHELL_ENV=1; shift;;
    --no-shell-env) SHELL_ENV=0; shift;;
    --purge) PURGE=1; shift;;
    --dry) DRY=1; shift;;
    --force) FORCE=1; shift;;
    --yes) YES=1; shift;;
    -h|--help) CMD="help"; shift;;
    *) die "unknown option: $1 (see --help)";;
  esac
done

# ---- location helpers -----------------------------------------------------------------
# Mount resolution order: (a) this script's own mount when run from an installed copy,
# (b) --host + --dir, (c) cwd's git toplevel + --dir. curl|bash has no real BASH_SOURCE path.
self_mount() {
  local src="${BASH_SOURCE[0]:-}"
  [ -n "$src" ] && [ -f "$src" ] || return 1
  local d; d="$(cd "$(dirname "$src")/.." 2>/dev/null && pwd)" || return 1
  [ -f "$d/_workflow/driver.mjs" ] && printf '%s' "$d"
}
host_root() {
  if [ -n "$HOST" ]; then (cd "$HOST" && pwd); return; fi
  git rev-parse --show-toplevel 2>/dev/null || die "not inside a git repo — pass --host <host-repo-root>"
}
mount_path() {
  # An EXPLICIT --host always wins (self-location must never redirect a targeted command at
  # the copy of the factory this script happens to live in — E2E-caught). host_root failures
  # return 1 so the caller dies ONCE with host_root's message, not with a bogus half-empty path.
  local r
  if [ -n "$HOST" ]; then r="$(host_root)" || return 1; printf '%s/%s' "$r" "$DIR"; return; fi
  local m; m="$(self_mount)" && { printf '%s' "$m"; return; }
  r="$(host_root)" || return 1
  printf '%s/%s' "$r" "$DIR"
}
host_of_mount() { # the HOST repo root enclosing a mount
  git -C "$1/.." rev-parse --show-toplevel 2>/dev/null && return
  # git-less fallback: the host root sits depth(DIR) levels above the mount — walk, don't hardcode
  local up="$1" seg="$DIR"
  while [ "$seg" != "${seg%/*}" ]; do up="$up/.."; seg="${seg%/*}"; done
  (cd "$up/.." && pwd)
}

# Latest published release: highest vX.Y.Z tag on the remote; empty → main (no releases yet).
# An UNREACHABLE remote dies loudly here — before this guard, a network/DNS failure surfaced as
# a silent exit-1 (stderr was discarded and set -e killed the command substitution wordlessly).
resolve_latest() {
  local out
  out="$(git ls-remote --tags --refs "$REPO" 'refs/tags/v[0-9]*' 2>&1)" \
    || die "cannot reach $REPO (git ls-remote failed: $(printf '%s' "$out" | tail -1))"
  # Strict vX.Y.Z only (review fix): sort -V ranks v1.0.0-rc1 ABOVE v1.0.0 and a date-like
  # v20250101 above every real release — one hand-pushed experimental tag must not redirect
  # every install and cron upgrade. `|| true`: zero strict tags is the legitimate empty case.
  printf '%s' "$out" | sed -n 's|.*refs/tags/||p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true
}
resolve_target() {
  if [ -n "$WANT_VERSION" ]; then printf '%s' "$WANT_VERSION"; return; fi
  local t; t="$(resolve_latest)"
  if [ -n "$t" ]; then printf '%s' "$t"; else
    warn "no vX.Y.Z release tags published yet — tracking 'main' (pin with --version once releases exist)"
    printf 'main'
  fi
}

run_selftest() { # $1 = mount
  log "selftest gate: node _workflow/lib/_selftest.mjs"
  local out
  if out="$(node "$1/_workflow/lib/_selftest.mjs" 2>&1)"; then
    log "selftest: $(printf '%s' "$out" | tail -1 | sed 's/^ *//')"
  else
    printf '%s\n' "$out" | tail -15 >&2
    return 1
  fi
}

# ---- install --------------------------------------------------------------------------
# Transactional cleanup (review fix): a mid-install failure (bad --version tag, red selftest,
# init crash) must not strand a half-mount that blocks the corrective re-run at the "already
# installed" check with init never having run. Clone mode removes the mount THIS RUN created;
# submodule mode prints the exact undo. Disarmed the moment the engine install is complete —
# the (optional) telemetry bootstrap after that point is non-fatal by design.
INSTALL_CREATED=""; INSTALL_ROOT=""; INSTALL_UNDO_SUBMODULE=0
install_cleanup() {
  local rc="$1"; trap - EXIT
  [ "$rc" = 0 ] && return 0
  if [ -n "$INSTALL_CREATED" ] && [ -d "$INSTALL_CREATED" ]; then
    warn "install FAILED (exit $rc) — removing the partial mount $INSTALL_CREATED so a corrective re-run starts clean"
    rm -rf "$INSTALL_CREATED"
  elif [ "$INSTALL_UNDO_SUBMODULE" = 1 ]; then
    warn "install FAILED (exit $rc) mid-submodule — undo with: git -C '$INSTALL_ROOT' submodule deinit -f '$DIR'; git -C '$INSTALL_ROOT' rm -f '$DIR'; rm -rf '$INSTALL_ROOT/.git/modules/$DIR'"
  fi
  exit "$rc"
}
cmd_install() {
  command -v git >/dev/null || die "git is required"
  command -v node >/dev/null || die "node >= 20.11 is required"
  local root target mount
  root="$(host_root)"; target="$(resolve_target)"; mount="$root/$DIR"
  [ -e "$mount/_workflow/driver.mjs" ] && die "already installed at $mount — use: setup/install.sh upgrade"
  log "installing factory $target -> $mount (host: $root, mode: $([ $SUBMODULE = 1 ] && echo submodule || echo clone))"
  INSTALL_ROOT="$root"; trap 'install_cleanup $?' EXIT
  if [ $SUBMODULE = 1 ]; then
    git -C "$root" submodule add "$REPO" "$DIR"; INSTALL_UNDO_SUBMODULE=1
    [ "$target" != "main" ] && git -C "$mount" checkout --quiet "$target"
    log "submodule added — remember to COMMIT .gitmodules + the gitlink in the host repo"
  else
    git clone --quiet "$REPO" "$mount"; INSTALL_CREATED="$mount"
    [ "$target" != "main" ] && git -C "$mount" checkout --quiet "$target"
    if [ $NO_GITIGNORE = 0 ]; then
      if ! grep -qxF "$DIR/" "$root/.gitignore" 2>/dev/null; then
        # pad a newline first — appending to a no-trailing-newline .gitignore would glue the
        # comment onto its last entry (review fix)
        if [ -f "$root/.gitignore" ] && [ -n "$(tail -c1 "$root/.gitignore")" ]; then echo >> "$root/.gitignore"; fi
        { echo "# AI Implementation Factory mount (own git checkout; upgraded via setup/install.sh)"; echo "$DIR/"; } >> "$root/.gitignore"
        log "added '$DIR/' to host .gitignore (disable with --no-gitignore)"
      fi
    fi
  fi
  local initflags=(--repo-root "$root"); [ $HOOKS = 1 ] && initflags+=(--hooks)
  log "running setup/init.mjs ${initflags[*]}"
  node "$mount/setup/init.mjs" "${initflags[@]}"
  run_selftest "$mount" || die "selftest FAILED on a fresh install of $target — refusing to finish; report this version"
  trap - EXIT
  if [ $NO_TELEMETRY = 0 ]; then
    # non-fatal (review fix): a port collision / compose hiccup must not fail — or roll back —
    # a fully good engine install; the stack is re-runnable any time.
    cmd_telemetry_up "$mount" "$root" || warn "telemetry bootstrap FAILED — the engine itself installed fine; re-run later: setup/install.sh telemetry-up"
  else warn "telemetry bootstrap skipped (--no-telemetry) — run: setup/install.sh telemetry-up"; fi
  log "installed $(cat "$mount/VERSION" 2>/dev/null || echo "$target") at $mount — see SETUP.md § Feed it work"
}

# ---- upgrade --------------------------------------------------------------------------
cmd_upgrade() {
  local mount target prev cur
  mount="$(mount_path)"; [ -f "$mount/_workflow/driver.mjs" ] || die "no factory mount at $mount (pass --host/--dir)"
  [ -e "$mount/.git" ] || die "this mount is VENDORED (no .git) — it is upgraded by your engine-sync ritual, not by this script; or reinstall as a clone/submodule"
  local dirty; dirty="$(git -C "$mount" status --porcelain)"
  if [ -n "$dirty" ] && [ $FORCE = 0 ]; then
    printf '%s\n' "$dirty" | head -10 >&2
    die "mount has local modifications to tracked engine files — commit/stash them upstream or re-run with --force (state/, reports/, queue/ are gitignored and never the cause)"
  fi
  target="$(resolve_target)"; prev="$(git -C "$mount" rev-parse HEAD)"
  cur="$(git -C "$mount" describe --tags --always 2>/dev/null || echo "$prev")"
  git -C "$mount" fetch --quiet --tags origin
  # up-to-date short-circuit + downgrade guard (review fix): cron `upgrade --yes` must not
  # re-churn an already-current mount, and a regressed "latest" (newest tag deleted upstream)
  # must announce itself before silently downgrading every host.
  local want=""
  if [ "$target" = "main" ]; then want="$(git -C "$mount" rev-parse origin/main 2>/dev/null || true)"
  else want="$(git -C "$mount" rev-parse "refs/tags/$target^{commit}" 2>/dev/null || true)"; fi
  if [ -n "$want" ] && [ "$want" = "$prev" ]; then log "already on $target — up to date (nothing fetched-out-of-date; selftest-verified install untouched)"; return 0; fi
  case "$cur:$target" in v[0-9]*:v[0-9]*)
    if [ "$cur" != "$target" ] && [ "$(printf '%s\n%s\n' "$cur" "$target" | sort -V | tail -1)" = "$cur" ]; then
      warn "target $target is OLDER than installed $cur — proceeding, but a downgrade is only right when deliberate (pin with --version to silence)"
    fi;;
  esac
  log "upgrade: $cur -> $target (state/, reports/, queue/, telemetry data + .env are untouched by design)"
  if [ "$target" = "main" ]; then git -C "$mount" checkout --quiet origin/main
  else git -C "$mount" checkout --quiet "$target" || die "version '$target' not found on the remote"; fi
  if run_selftest "$mount"; then
    # refresh host-side scaffolding (review fix): the /ai-factory controller skill + runtime
    # scaffolding are installed by init.mjs — an upgrade that skips it leaves every host running
    # the new engine with the old skill. init.mjs is idempotent and never overwrites locally
    # edited files (.factory-new siblings).
    node "$mount/setup/init.mjs" --repo-root "$(host_of_mount "$mount")" || warn "init refresh FAILED — the engine upgrade itself is green; run by hand: node $mount/setup/init.mjs --repo-root <host-root>"
    log "upgraded to $target. changes:"
    git -C "$mount" log --oneline "$prev..HEAD" | head -20 || true
  else
    warn "selftest FAILED on $target — ROLLING BACK to $cur"
    git -C "$mount" checkout --quiet "$prev" || die "ROLLBACK FAILED — the mount is LEFT ON $target; repair by hand: git -C $mount checkout $prev"
    die "rolled back to $cur; $target is not safe on this host (report it)"
  fi
}

# ---- status ---------------------------------------------------------------------------
cmd_status() {
  local mount; mount="$(mount_path)"
  [ -f "$mount/_workflow/driver.mjs" ] || die "no factory mount at $mount"
  local v="(unknown)"; [ -f "$mount/VERSION" ] && v="$(cat "$mount/VERSION")"
  local g=""; [ -e "$mount/.git" ] && g="$(git -C "$mount" describe --tags --always --dirty 2>/dev/null || true)"
  local latest; latest="$(resolve_latest)"; [ -n "$latest" ] || latest="(no releases published — main)"
  log "installed: VERSION=$v${g:+  git=$g}   mount=$mount"
  log "latest:    $latest"
}

# ---- telemetry (per-developer infra) --------------------------------------------------
ensure_env_files() { # $1 = mount
  local tdir="$1/telemetry"
  if [ ! -f "$tdir/.env" ]; then
    cp "$tdir/.env.example" "$tdir/.env"
    log "wrote telemetry/.env (stock ports + stack identity; per-host, gitignored — KI-E25: second host repo on one machine changes FACTORY_COMPOSE_PROJECT/FACTORY_CONTAINER_PREFIX + ports)"
  fi
  # `|| true`: a hand-trimmed .env may drop a key — grep's no-match exit must not kill the
  # script under `set -euo pipefail` (the ${var:-default} fallbacks below are the intended path).
  local port; port="$(grep -E '^FACTORY_OTLP_HTTP_PORT=' "$tdir/.env" | tail -1 | cut -d= -f2 || true)"; port="${port:-4318}"
  if [ ! -f "$tdir/claude-code-telemetry.env" ]; then
    sed "s|http://localhost:4318|http://localhost:$port|" "$tdir/claude-code-telemetry.env.example" > "$tdir/claude-code-telemetry.env"
    log "wrote telemetry/claude-code-telemetry.env (OTLP endpoint http://localhost:$port; per-host, gitignored)"
  elif ! grep -q "localhost:$port" "$tdir/claude-code-telemetry.env"; then
    # reconcile check (review fix): the file is create-once (user edits are never overwritten),
    # so a later port change in telemetry/.env silently strands sessions on a dead endpoint.
    warn "telemetry/claude-code-telemetry.env does not point at the current OTLP port ($port per telemetry/.env) — sessions may export to a dead endpoint; delete the file and re-run telemetry-up to regenerate"
  fi
}
merge_settings_env() { # $1 = mount, $2 = host root — .claude/settings.local.json env block
  node -e '
    const fs = require("fs"), path = require("path");
    const [settingsPath, envFile] = process.argv.slice(1);
    const kv = {};
    for (const l of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) kv[m[1]] = m[2];
    }
    let s = {};
    if (fs.existsSync(settingsPath)) {
      // An EXISTING but unparseable settings file is never clobbered — a blind rewrite here
      // would silently destroy any existing permissions/hooks blocks. Warn + skip; the
      // shell-profile block (the KI-E33-reliable path) still carries the session env.
      try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
      catch (e) {
        console.error("[factory] REFUSING to touch " + settingsPath + " — existing file is not valid JSON (" + e.message + "); fix it or merge the env block from " + envFile + " by hand");
        process.exit(0);
      }
    }
    s.env = { ...(s.env || {}), ...kv };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
    console.log("[factory] merged " + Object.keys(kv).length + " env var(s) into " + settingsPath);
  ' "$2/.claude/settings.local.json" "$1/telemetry/claude-code-telemetry.env"
}
shell_env_install() { # $1 = mount — the RELIABLE session-env path (KI-E33: some runtimes do not forward OTEL_* from settings env)
  # marker is MOUNT-SCOPED (review fix): on a KI-E25 machine (second host repo, second stack,
  # remapped ports) an unscoped marker would make host B skip its block and keep exporting
  # host A's endpoint.
  local marker="# >>> ai-factory cost telemetry ($1) >>>" endmark="# <<< ai-factory cost telemetry ($1) <<<" f
  for f in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ "$f" = "$HOME/.zshrc" ] && [ ! -f "$f" ] && continue
    grep -qF "$marker" "$f" 2>/dev/null && { log "shell env already installed in $f"; continue; }
    { echo ""; echo "$marker"; echo "set -a; . \"$1/telemetry/claude-code-telemetry.env\"; set +a"; echo "$endmark"; } >> "$f"
    log "installed cost-telemetry env block in $f (takes effect in NEW shells)"
  done
}
cmd_telemetry_up() { # [$1 = mount, $2 = host root] — also callable directly
  local mount root
  mount="${1:-$(mount_path)}"; [ -f "$mount/telemetry/docker-compose.yml" ] || die "no telemetry stack at $mount/telemetry"
  root="${2:-$(host_of_mount "$mount")}"
  ensure_env_files "$mount"
  merge_settings_env "$mount" "$root"
  local want_shell="$SHELL_ENV"
  if [ -z "$want_shell" ]; then
    if [ $YES = 1 ]; then want_shell=1
    elif [ -t 0 ]; then read -r -p "[factory] install session cost-telemetry env into your shell profile? (recommended — settings env is not forwarded on every runtime) [Y/n] " a; [ "${a:-Y}" = "n" ] || [ "${a:-Y}" = "N" ] && want_shell=0 || want_shell=1
    else want_shell=0; warn "non-interactive and no --shell-env/--yes: shell profile untouched — session cost telemetry needs 'set -a; . $mount/telemetry/claude-code-telemetry.env; set +a' in the launching shell"
    fi
  fi
  [ "$want_shell" = 1 ] && shell_env_install "$mount"
  if [ $DRY = 1 ]; then log "telemetry-up --dry: env files ready; would run: docker compose --project-directory $mount/telemetry up -d"; return 0; fi
  command -v docker >/dev/null || { warn "docker not found — telemetry stack NOT started (env files are ready; run telemetry-up after installing docker)"; return 0; }
  log "starting telemetry stack (docker compose up -d)"
  docker compose --project-directory "$mount/telemetry" up -d
  local prom; prom="$(grep -E '^FACTORY_PROM_PORT=' "$mount/telemetry/.env" | tail -1 | cut -d= -f2 || true)"; prom="${prom:-9090}"
  local graf; graf="$(grep -E '^FACTORY_GRAFANA_PORT=' "$mount/telemetry/.env" | tail -1 | cut -d= -f2 || true)"; graf="${graf:-3000}"
  local i=0; until curl -fsS -m 2 "http://localhost:$prom/-/ready" >/dev/null 2>&1; do
    i=$((i+1)); [ $i -ge 15 ] && { warn "prometheus not ready after 30s — check: docker compose --project-directory $mount/telemetry ps"; return 0; }
    sleep 2
  done
  log "telemetry up: grafana http://localhost:$graf  prometheus http://localhost:$prom (ready)"
  log "session cost telemetry activates in NEW shells/sessions — verify with: node $mount/_workflow/driver.mjs preflight"
}
cmd_telemetry_down() {
  local mount; mount="$(mount_path)"
  command -v docker >/dev/null || die "docker not found — nothing to stop"
  local flags=(); [ $PURGE = 1 ] && flags+=(-v)
  docker compose --project-directory "$mount/telemetry" down "${flags[@]+"${flags[@]}"}"
  log "telemetry stack stopped$([ $PURGE = 1 ] && echo ' (volumes purged)')"
}

case "$CMD" in
  install)        cmd_install;;
  upgrade)        cmd_upgrade;;
  status)         cmd_status;;
  telemetry-up)   cmd_telemetry_up;;
  telemetry-down) cmd_telemetry_down;;
  help|"")        if [ -f "${BASH_SOURCE[0]:-}" ]; then sed -n '2,41p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
                  else echo "ai-factory installer — commands: install | upgrade | status | telemetry-up | telemetry-down (full header help needs a saved copy; see SETUP.md §0)"; fi; exit 0;;
  *) die "unknown command: $CMD (install | upgrade | status | telemetry-up | telemetry-down)";;
esac
