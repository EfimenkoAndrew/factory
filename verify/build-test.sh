#!/usr/bin/env bash
# Standardized build + test runner for the factory's verify stage. The runner agent
# invokes this inside an item's worktree so build/test invocation is consistent and
# parseable. Emits machine-greppable markers (FACTORY:: ...) the agent reports back.
#
# Usage:
#   build-test.sh build   <solution.sln>
#   build-test.sh red     <test.csproj-or-sln> "<FullyQualified~or~Name>"   # PRE-FIX: proves the test FAILS on old code
#   build-test.sh filter  <test.csproj-or-sln> "<FullyQualified~or~Name>"   # POST-FIX: proves the test is GREEN
#   build-test.sh suite   <test.csproj-or-sln>
#   build-test.sh claims    <worktree-path>       # KI-E11: phantom doc-path lint (FACTORY::CLAIMS::<n>)
#   build-test.sh leftovers <worktree-path>       # KI-D12: deferral/tech-debt lexicon lint (FACTORY::LEFTOVER::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh comments  <worktree-path>       # KI-E59: no-new-comments lint (FACTORY::COMMENT::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh ledger-anchor <worktree-path>   # KI-E91: STANDARDS-DIVERGENCE-LEDGER.md duplicate-anchor/false-tag-claim lint (FACTORY::LEDGER-ANCHOR::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh pack      <worktree-path> <out> # review pack snapshot for the gate band
#
# NEVER runs git. Read-only against the repo except for build artifacts in the worktree.
set -uo pipefail

# KI-E86 (2026-08-24, ported from a host-mount session): disable MSBuild node reuse for every
# dotnet build/test invocation below. Concurrent items run in SIBLING worktrees on the SAME host
# (`group --conc N`), and by default `dotnet build`/`dotnet test` leave persistent MSBuild worker
# processes running for reuse by the NEXT invocation — a well-documented source of intermittent
# cross-invocation contention/staleness under concurrent CI-style builds, independent of the code
# under test. Exporting this once, here, covers every dotnet call site in this script (present and
# future) without touching each one.
export MSBUILDDISABLENODEREUSE=1

# KI-E134 (2026-09-04) — PREVENTION, not just detection. Every main-tree contamination incident this
# session traced back to the SAME root cause: `dotnet build $target` (and friends) resolved a
# worktree-rooted argument against the WRONG cwd — usually because the caller forgot to `cd` into its
# assigned worktree first. This is unusually dangerous here specifically because every factory
# worktree AND the main tree are full checkouts of the SAME repo: `dotnet build AdminIdentityService/
# ...` run from the wrong directory frequently does NOT error (no MSB1009) — it silently SUCCEEDS
# against the OTHER tree's copy of that same relative path, giving the caller no signal anything is
# wrong, and (for red/filter, whose exit code and teed transcript become fold evidence) can make the
# wrong tree's state look like proof about the right one. Refuse instead of silently substituting the
# wrong tree: the argument must resolve to somewhere under a `state/worktrees/<id>/` directory, or
# this script exits loud before touching anything.
#
# Scoped DELIBERATELY to build/red/filter/suite — the four subcommands that invoke `dotnet` and so
# carry the "silently succeeds against the wrong tree" danger above. The read-only lints (claims/pack,
# and any future git-diff-based lint added alongside them) do not share that failure mode —
# `git -C <path> ...` / a node script over the path either operates correctly or fails cleanly if the
# path isn't a real worktree, and (confirmed live on the origin host this fix was ported from) a
# synthetic/placeholder worktree path is a legitimate, useful thing for a caller to pass there when
# exercising wiring logic
# rather than real content. Guarding them too would reject exactly that legitimate use for no safety
# benefit, so they are intentionally left unguarded. This does not replace the fold-time/main-check
# detection nets (KI-L65/E41/E45/E50/E61/E82/E89) — a direct Edit/Write/Bash-heredoc write that never
# goes through this script is a separate vector those still cover — it closes the specific,
# well-evidenced class that flows through the four dotnet-invoking subcommands.
_guard_worktree_path() {
  raw="$1"; label="$2"
  case "$raw" in
    /*) abs="$raw" ;;
    *) abs="$(pwd)/$raw" ;;
  esac
  case "$abs" in
    */state/worktrees/*) ;;
    *)
      echo "FACTORY::WORKTREE-GUARD::REFUSED $label '$raw' resolves to '$abs' (cwd=$(pwd)) — that path is NOT inside any state/worktrees/<id>/ directory. You are very likely operating against the MAIN tree instead of your assigned worktree (both are full checkouts of the same repo, so this often does not fail the way you'd expect it to). cd into your worktree first, or pass an absolute .../state/worktrees/<id>/... path." >&2
      exit 65
      ;;
  esac
}

# Engine-owned diff lints run BEFORE the host-override seam below: leftovers/comments are
# stack-agnostic (pure git-diff + node — no dotnet), so a host's build-test.local.sh never needs to
# implement them, and a pre-existing override that predates a lint subcommand must not swallow it
# (PR#9 review: an old override's unknown-subcommand usage error carried no FACTORY::COMMENT marker,
# which parsed downstream as count=0 — the whole gate silently vanished on every override host and
# even recorded a false APPROVED).
#   leftovers — KI-D12 deferral-lexicon candidate detector (haiku probe classifies punt-vs-legit).
#   comments  — KI-E59 no-new-comments detector (host-policy `noNewComments` gates the callers; NO
#               classifier stage — when the policy is on, every hit is a hard violation).
#   ledger-anchor — KI-E91 STANDARDS-DIVERGENCE-LEDGER.md consistency detector. ADVISORY (never
#               blocking on its own — the haiku classify step decides): duplicate-anchor +
#               false-tag-claim candidates, mirroring the leftovers/comments engine-owned shape.
case "${1:-}" in
  leftovers|comments|ledger-anchor|rootcause)
    _wt="${2:-}"
    if [ -z "$_wt" ]; then echo "usage: build-test.sh ${1} <worktree>" >&2; exit 64; fi
    _SD=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
    if [ "$1" = "leftovers" ]; then exec node "$_SD/../_workflow/leftover-lint.mjs" "$_wt"; fi
    if [ "$1" = "ledger-anchor" ]; then exec node "$_SD/../_workflow/ledger-anchor-lint.mjs" "$_wt"; fi
    if [ "$1" = "rootcause" ]; then exec node "$_SD/../_workflow/rootcause-lint.mjs" "$_wt"; fi
    exec node "$_SD/../_workflow/comment-lint.mjs" "$_wt"
    ;;
esac

# Host-stack override seam (KI-E17, SETUP.md § 6): the default runner below is .NET (dotnet
# build/test emitting the FACTORY:: markers). A non-.NET host drops an EXECUTABLE
# verify/build-test.local.sh next to this file implementing the SAME subcommand + marker
# contract; it takes over everything EXCEPT the engine-owned diff lints dispatched above. A local
# script that wants to delegate back to this default must set FACTORY_BT_NO_LOCAL=1 to avoid
# recursion. (Gitignored — never committed.)
_LOCAL="$(dirname "${BASH_SOURCE[0]:-$0}")/build-test.local.sh"
if [ -x "$_LOCAL" ] && [ -z "${FACTORY_BT_NO_LOCAL:-}" ]; then exec "$_LOCAL" "$@"; fi

# Deterministic real-infra detection: Testcontainers-for-.NET logs container lifecycle, and the factory
# convention has the regression test print `FACTORY::REALINFRA::<kind>` itself once its container is up.
# Echo the marker when the ACTUAL run shows a real container — never on an EF in-memory run (fail-closed).
emit_realinfra() {
  if printf '%s\n' "$1" | grep -qE 'FACTORY::REALINFRA::'; then
    printf '%s\n' "$1" | grep -oE 'FACTORY::REALINFRA::\S+' | tail -1
  elif printf '%s\n' "$1" | grep -qiE 'testcontainers|/ryuk|Docker[^\n]*container[^\n]*(creat|start)'; then
    kind=$(printf '%s\n' "$1" | grep -oiE 'postgres|redis|rabbitmq|mssql|mysql' | head -1)
    echo "FACTORY::REALINFRA::Testcontainers-${kind:-unknown}"
  fi
}

cmd="${1:-}"; target="${2:-}"; filter="${3:-}"

case "$cmd" in
  build)
    _guard_worktree_path "$target" "target"
    echo "FACTORY::BUILD::START $target"
    out=$(dotnet build "$target" --nologo -clp:ErrorsOnly 2>&1)
    code=$?
    errs=$(printf '%s\n' "$out" | grep -cE ': error ' || true)
    printf '%s\n' "$out" | tail -40
    echo "FACTORY::BUILD::RESULT exit=$code errors=$errs"
    echo "FACTORY::SUMMARY::build exit=$code errors=$errs"  # KI-E19 evidence manifest (keyed; append-order-proof)
    exit $code
    ;;
  red)
    _guard_worktree_path "$target" "target"
    # Run the NEW regression test against the CURRENT (unfixed) worktree. A non-zero exit (compile-or-assert
    # failure) is the REQUIRED red proof — it shows the test genuinely fails on old code (non-vacuous).
    echo "FACTORY::RED::START $target :: $filter"
    out=$(dotnet test "$target" --nologo --filter "$filter" 2>&1)
    code=$?
    printf '%s\n' "$out" | grep -iE 'Passed!|Failed!|Passed:|Failed:|error|No test matches' | tail -20
    echo "FACTORY::RED::$code"
    echo "FACTORY::SUMMARY::red exit=$code"  # KI-E19 evidence manifest
    exit $code
    ;;
  filter)
    _guard_worktree_path "$target" "target"
    # NOTE (KI-L22, 2026-06-28): run the TARGETED test at DETAILED console-logger verbosity. At dotnet
    # test's default verbosity the VSTest host SUPPRESSES test stdout, so a regression test's
    # `FACTORY::REALINFRA::<kind>` marker (and the testcontainers/ryuk container lifecycle logs) never
    # reach `$out` and emit_realinfra cannot see them — the deterministic P2 real-infra gate then FAILS
    # every realInfra item even when a real container actually ran (ITEM-H-6 failed twice this way).
    # `--logger "console;verbosity=detailed"` surfaces the test's "Standard Output Messages" block (the
    # marker AND the testcontainers logs the emit_realinfra `elif` heuristic keys on). Display stays
    # bounded: we still print only the grepped summary + the extracted marker, never the full transcript.
    echo "FACTORY::TEST::FILTER::START $target :: $filter"
    out=$(dotnet test "$target" --nologo --filter "$filter" --logger "console;verbosity=detailed" 2>&1)
    code=$?
    printf '%s\n' "$out" | grep -iE 'Passed!|Failed!|Passed:|Failed:|error|No test matches' | tail -20
    emit_realinfra "$out"
    echo "FACTORY::TEST::FILTER::RESULT exit=$code"
    echo "FACTORY::SUMMARY::filter exit=$code"  # KI-E19 evidence manifest
    exit $code
    ;;
  suite)
    _guard_worktree_path "$target" "target"
    echo "FACTORY::TEST::SUITE::START $target"
    out=$(dotnet test "$target" --nologo 2>&1)
    code=$?
    printf '%s\n' "$out" | grep -iE 'Passed!|Failed!|Passed:|Failed:|Skipped:|error' | tail -30
    echo "FACTORY::TEST::SUITE::RESULT exit=$code"
    # KI-E19 evidence manifest: the suite's OWN counts on a keyed marker, so a later `filter` append
    # in the same teed transcript can never shadow them (the ambient dotnet Passed!/Failed! line is
    # type-agnostic and last-match-parsed). Counts read from the LAST dotnet summary line (same
    # per-project caveat as the legacy parse); -1 = no summary line found (build error before tests).
    sum=$(printf '%s\n' "$out" | grep -E 'Passed!|Failed!' | tail -1)
    sf=$(printf '%s' "$sum" | sed -nE 's/.*Failed:[[:space:]]*([0-9]+).*/\1/p')
    sp=$(printf '%s' "$sum" | sed -nE 's/.*Passed:[[:space:]]*([0-9]+).*/\1/p')
    ss=$(printf '%s' "$sum" | sed -nE 's/.*Skipped:[[:space:]]*([0-9]+).*/\1/p')
    echo "FACTORY::SUMMARY::suite exit=$code failed=${sf:--1} passed=${sp:--1} skipped=${ss:--1}"
    exit $code
    ;;
  claims)
    # KI-E11 (2026-07-19): deterministic phantom-path linter for doc claims, run EARLY (fix/editorial/
    # verify time) — same lib the driver's fold-time F2 WARN uses (single source of truth). Emits
    # FACTORY::CLAIMS-MISS::<path> per phantom claim + FACTORY::CLAIMS::<count>; exit 1 when count>0.
    #   usage: build-test.sh claims <worktree-path>
    wt="$target"
    if [ -z "$wt" ]; then echo "usage: build-test.sh claims <worktree>" >&2; exit 64; fi
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    node "$SCRIPT_DIR/../_workflow/claims-lint.mjs" "$wt"
    exit $?
    ;;
  pack)
    # REVIEW PACK (cache-strategic reviewer input, 2026-07-18): ONE machine-generated snapshot of the
    # worktree change (git status + full diff vs HEAD + untracked-file contents) that every
    # review-band agent Reads FIRST instead of re-running its own exploratory diff/file reads
    # (telemetry: ~10 band agents x 8-21 duplicated Reads each on cycle 39-40). Read-only git.
    # The editorial pass REGENERATES it after applying doc edits (KI-L34 — gates must review the
    # FINAL diff). Observability marker only — the pack is an accelerator, NEVER fold evidence.
    #   usage: build-test.sh pack <worktree-path> <outfile>
    wt="$target"; outfile="$filter"
    if [ -z "$wt" ] || [ -z "$outfile" ]; then echo "usage: build-test.sh pack <worktree> <outfile>" >&2; exit 64; fi
    {
      echo "# REVIEW PACK — machine-generated worktree snapshot ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
      echo "# worktree: $wt"
      echo "# This file is generated by exact git commands (status/diff/ls-files) — it is INPUT"
      echo "# curation for reviewers, not an authored judgment. Verify load-bearing facts in the"
      echo "# worktree itself; regenerate any time via: build-test.sh pack <worktree> <outfile>"
      echo
      echo "## git status --porcelain"
      git -C "$wt" status --porcelain
      echo
      echo "## diff vs HEAD (tracked files)"
      git -C "$wt" diff HEAD
      echo
      echo "## untracked (new) files — contents"
      git -C "$wt" ls-files --others --exclude-standard | while IFS= read -r f; do
        echo "### NEW FILE: $f"
        head -c 60000 "$wt/$f"
        echo
      done
    } | head -c 400000 > "$outfile"
    echo "FACTORY::PACK::$(wc -c < "$outfile" | tr -d ' ') bytes -> $outfile"
    exit 0
    ;;
  *)
    echo "usage: build-test.sh build|red|filter|suite|claims|leftovers|comments|ledger-anchor|rootcause|pack <target> [filter|outfile]" >&2
    exit 64
    ;;
esac
