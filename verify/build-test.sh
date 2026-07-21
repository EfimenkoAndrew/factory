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
#   build-test.sh leftovers <worktree-path>       # KI-D12: deferral/tech-debt lexicon lint (FACTORY::LEFTOVER::<n>)
#   build-test.sh pack      <worktree-path> <out> # review pack snapshot for the gate band
#
# NEVER runs git. Read-only against the repo except for build artifacts in the worktree.
set -uo pipefail

# Host-stack override seam (KI-E17, SETUP.md § 6): the default runner below is .NET (dotnet
# build/test emitting the FACTORY:: markers). A non-.NET host drops an EXECUTABLE
# verify/build-test.local.sh next to this file implementing the SAME subcommand + marker
# contract; it takes over everything. A local script that wants to delegate back to this
# default must set FACTORY_BT_NO_LOCAL=1 to avoid recursion. (Gitignored — never committed.)
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
    echo "FACTORY::BUILD::START $target"
    out=$(dotnet build "$target" --nologo -clp:ErrorsOnly 2>&1)
    code=$?
    errs=$(printf '%s\n' "$out" | grep -cE ': error ' || true)
    printf '%s\n' "$out" | tail -40
    echo "FACTORY::BUILD::RESULT exit=$code errors=$errs"
    exit $code
    ;;
  red)
    # Run the NEW regression test against the CURRENT (unfixed) worktree. A non-zero exit (compile-or-assert
    # failure) is the REQUIRED red proof — it shows the test genuinely fails on old code (non-vacuous).
    echo "FACTORY::RED::START $target :: $filter"
    out=$(dotnet test "$target" --nologo --filter "$filter" 2>&1)
    code=$?
    printf '%s\n' "$out" | grep -iE 'Passed!|Failed!|Passed:|Failed:|error|No test matches' | tail -20
    echo "FACTORY::RED::$code"
    exit $code
    ;;
  filter)
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
    exit $code
    ;;
  suite)
    echo "FACTORY::TEST::SUITE::START $target"
    out=$(dotnet test "$target" --nologo 2>&1)
    code=$?
    printf '%s\n' "$out" | grep -iE 'Passed!|Failed!|Passed:|Failed:|Skipped:|error' | tail -30
    echo "FACTORY::TEST::SUITE::RESULT exit=$code"
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
  leftovers)
    # KI-D12 (2026-07-19): deterministic LeftoverScan — greps the worktree diff's ADDED lines for the
    # intentionally-created-tech-debt lexicon (TODO/FIXME/HACK/XXX, NotImplementedException, "for now",
    # "deferred", "temporary workaround", "follow-up", …), excluding the sanctioned mechanisms
    # (standards-evolution: tags, .claude/rules + _bmad-output docs, REPLACE_WITH_/CHANGE_ME secret
    # templates). Emits FACTORY::LEFTOVER-HIT::<file>::<lexeme>::<line> + FACTORY::LEFTOVER::<count>;
    # exit 1 when count>0. Candidate detector only — a haiku probe classifies punt-vs-legit, the fold
    # re-greps as the backstop. Same lib the factory's probe + fold read (single source of truth).
    #   usage: build-test.sh leftovers <worktree-path>
    wt="$target"
    if [ -z "$wt" ]; then echo "usage: build-test.sh leftovers <worktree>" >&2; exit 64; fi
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    node "$SCRIPT_DIR/../_workflow/leftover-lint.mjs" "$wt"
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
    echo "usage: build-test.sh build|red|filter|suite|claims|pack <target> [filter|outfile]" >&2
    exit 64
    ;;
esac
