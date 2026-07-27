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
  # the copy of the factory this script happens to live in — E2E-caught).
  if [ -n "$HOST" ]; then printf '%s/%s' "$(host_root)" "$DIR"; return; fi
  local m; m="$(self_mount)" && { printf '%s' "$m"; return; }
  printf '%s/%s' "$(host_root)" "$DIR"
}
host_of_mount() { # the HOST repo root enclosing a mount (mount/.. sits inside the host repo)
  git -C "$1/.." rev-parse --show-toplevel 2>/dev/null || (cd "$1/../.." && pwd)
}

# Latest published release: highest vX.Y.Z tag on the remote; empty → main (no releases yet).
resolve_latest() {
  git ls-remote --tags --refs "$REPO" 'refs/tags/v[0-9]*' 2>/dev/null \
    | sed 's|.*refs/tags/||' | sort -V | tail -1
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
cmd_install() {
  command -v git >/dev/null || die "git is required"
  command -v node >/dev/null || die "node >= 20.11 is required"
  local root target mount
  root="$(host_root)"; target="$(resolve_target)"; mount="$root/$DIR"
  [ -e "$mount/_workflow/driver.mjs" ] && die "already installed at $mount — use: setup/install.sh upgrade"
  log "installing factory $target -> $mount (host: $root, mode: $([ $SUBMODULE = 1 ] && echo submodule || echo clone))"
  if [ $SUBMODULE = 1 ]; then
    git -C "$root" submodule add "$REPO" "$DIR"
    [ "$target" != "main" ] && git -C "$mount" checkout --quiet "$target"
    log "submodule added — remember to COMMIT .gitmodules + the gitlink in the host repo"
  else
    git clone --quiet "$REPO" "$mount"
    [ "$target" != "main" ] && git -C "$mount" checkout --quiet "$target"
    if [ $NO_GITIGNORE = 0 ]; then
      if ! grep -qxF "$DIR/" "$root/.gitignore" 2>/dev/null; then
        { echo "# AI Implementation Factory mount (own git checkout; upgraded via setup/install.sh)"; echo "$DIR/"; } >> "$root/.gitignore"
        log "added '$DIR/' to host .gitignore (disable with --no-gitignore)"
      fi
    fi
  fi
  local initflags=(--repo-root "$root"); [ $HOOKS = 1 ] && initflags+=(--hooks)
  log "running setup/init.mjs ${initflags[*]}"
  node "$mount/setup/init.mjs" "${initflags[@]}"
  run_selftest "$mount" || die "selftest FAILED on a fresh install of $target — refusing to finish; report this version"
  if [ $NO_TELEMETRY = 0 ]; then cmd_telemetry_up "$mount" "$root"; else warn "telemetry bootstrap skipped (--no-telemetry) — run: setup/install.sh telemetry-up"; fi
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
  log "upgrade: $cur -> $target (state/, reports/, queue/, telemetry data + .env are untouched by design)"
  git -C "$mount" fetch --quiet --tags origin
  if [ "$target" = "main" ]; then git -C "$mount" checkout --quiet origin/main
  else git -C "$mount" checkout --quiet "$target" || die "version '$target' not found on the remote"; fi
  if run_selftest "$mount"; then
    log "upgraded to $target. changes:"
    git -C "$mount" log --oneline "$prev..HEAD" | head -20 || true
  else
    warn "selftest FAILED on $target — ROLLING BACK to $cur"
    git -C "$mount" checkout --quiet "$prev"
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
  local port; port="$(grep -E '^FACTORY_OTLP_HTTP_PORT=' "$tdir/.env" | tail -1 | cut -d= -f2)"; port="${port:-4318}"
  if [ ! -f "$tdir/claude-code-telemetry.env" ]; then
    sed "s|http://localhost:4318|http://localhost:$port|" "$tdir/claude-code-telemetry.env.example" > "$tdir/claude-code-telemetry.env"
    log "wrote telemetry/claude-code-telemetry.env (OTLP endpoint http://localhost:$port; per-host, gitignored)"
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
    let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
    s.env = { ...(s.env || {}), ...kv };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
    console.log("[factory] merged " + Object.keys(kv).length + " env var(s) into " + settingsPath);
  ' "$2/.claude/settings.local.json" "$1/telemetry/claude-code-telemetry.env"
}
shell_env_install() { # $1 = mount — the RELIABLE session-env path (KI-E33: some runtimes do not forward OTEL_* from settings env)
  local marker="# >>> ai-factory cost telemetry >>>" endmark="# <<< ai-factory cost telemetry <<<" f
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
  local prom; prom="$(grep -E '^FACTORY_PROM_PORT=' "$mount/telemetry/.env" | tail -1 | cut -d= -f2)"; prom="${prom:-9090}"
  local graf; graf="$(grep -E '^FACTORY_GRAFANA_PORT=' "$mount/telemetry/.env" | tail -1 | cut -d= -f2)"; graf="${graf:-3000}"
  local i=0; until curl -fsS -m 2 "http://localhost:$prom/-/ready" >/dev/null 2>&1; do
    i=$((i+1)); [ $i -ge 15 ] && { warn "prometheus not ready after 30s — check: docker compose --project-directory $mount/telemetry ps"; return 0; }
    sleep 2
  done
  log "telemetry up: grafana http://localhost:$graf  prometheus http://localhost:$prom (ready)"
  log "session cost telemetry activates in NEW shells/sessions — verify with: node $mount/_workflow/driver.mjs preflight"
}
cmd_telemetry_down() {
  local mount; mount="$(mount_path)"
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
  help|"")        sed -n '2,44p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0;;
  *) die "unknown command: $CMD (install | upgrade | status | telemetry-up | telemetry-down)";;
esac
