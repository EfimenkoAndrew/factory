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
#   build-test.sh efmigration <api-project-dir> <persistence-project-relative-path> # KI-E185: EF Core pending-model-change lint (FACTORY::EFMIGRATION::<clean|dirty>) — real dotnet-ef invocation, not a text lint
#   build-test.sh claims    <worktree-path>       # KI-E11: phantom doc-path lint (FACTORY::CLAIMS::<n>)
#   build-test.sh countclaims <worktree-path> <item-dir> --transcript <current-path> [...] # KI-E182
#   build-test.sh leftovers <worktree-path>       # KI-D12: deferral/tech-debt lexicon lint (FACTORY::LEFTOVER::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh comments  <worktree-path>       # KI-E59: no-new-comments lint (FACTORY::COMMENT::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh registration-drift <worktree-path> # KI-E462: shared Program.cs/*InfrastructureRegistration.cs call-shape drift lint (FACTORY::REGISTRATION-DRIFT::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh docsync   <worktree-path>       # KI-E479: dataflow.md doc-sync lint (FACTORY::DOCSYNC::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh ledger-anchor <worktree-path>   # KI-E91: STANDARDS-DIVERGENCE-LEDGER.md duplicate-anchor/false-tag-claim lint (FACTORY::LEDGER-ANCHOR::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh rootcause <worktree-path>       # KI-E104: diff-touched-only-tests lint (FACTORY::ROOTCAUSE::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh phantom   <worktree-path> <claimed-files-json> # KI-E486: fixer filesChanged-vs-real-diff lint (FACTORY::PHANTOM::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh shellcheck-scan <worktree-path> <sh-file> [<sh-file>...] # KI-E241: real `shellcheck --enable=all` invocation on touched .sh files, not a text lint (FACTORY::SHELLCHECK::RESULT verdict=<clean|findings|unavailable|inconclusive>)
#   build-test.sh concurrency-scan <worktree-path> # KI-E237: lock/ChangeTracker/subprocess-in-test diff lint (FACTORY::CONCURRENCY-SCAN::<n>) — engine-owned, runs BEFORE the local-override seam
#   build-test.sh vacuous-test-scan <worktree-path> # KI-E238: [Fact]/[Theory]/[SkippableFact] early-return-before-assert lint (FACTORY::VACUOUS-TEST-SCAN::<n>) — engine-owned, runs BEFORE the local-override seam
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
# worktree AND the main tree are full checkouts of the SAME repo: `dotnet build SomeService/
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
#   registration-drift — KI-E462 shared-registration-call shape-drift detector (PREVENTION companion
#               to KI-E461's fold-time backstop). ADVISORY (never blocks): a shape mismatch on a
#               builder.Services.AddXxx(...)/services.AddXxx(...) call whose method is ALSO called
#               elsewhere in the repo with a materially different, non-lambda argument shape is a
#               candidate undocumented standards-evolution divergence — run this cheaply, right
#               after writing a remedy, before spending a single gate-agent token reviewing it.
case "${1:-}" in
  leftovers|comments|registration-drift|docsync|ledger-anchor|rootcause|phantom|concurrency-scan|vacuous-test-scan)
    _wt="${2:-}"
    if [ -z "$_wt" ]; then echo "usage: build-test.sh ${1} <worktree>" >&2; exit 64; fi
    _SD=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
    if [ "$1" = "leftovers" ]; then exec node "$_SD/../_workflow/leftover-lint.mjs" "$_wt"; fi
    if [ "$1" = "registration-drift" ]; then exec node "$_SD/../_workflow/registration-drift-lint.mjs" "$_wt"; fi
    if [ "$1" = "docsync" ]; then exec node "$_SD/../_workflow/docsync-lint.mjs" "$_wt"; fi
    if [ "$1" = "ledger-anchor" ]; then exec node "$_SD/../_workflow/ledger-anchor-lint.mjs" "$_wt"; fi
    if [ "$1" = "rootcause" ]; then exec node "$_SD/../_workflow/rootcause-lint.mjs" "$_wt"; fi
    # KI-E238: a [Fact]/[Theory]/[SkippableFact] method whose only reachable assertion is gated
    # behind a conditional early `return;` (or that never asserts at all).
    if [ "$1" = "vacuous-test-scan" ]; then exec node "$_SD/../_workflow/vacuous-test-scan-lint.mjs" "$_wt"; fi
    # KI-E237: does this diff add/modify a lock primitive, an EF ChangeTracker call, or a
    # subprocess/parallel construct inside a test file.
    if [ "$1" = "concurrency-scan" ]; then exec node "$_SD/../_workflow/concurrency-scan-lint.mjs" "$_wt"; fi
    # KI-E486: the ONLY subcommand in this group needing a 3rd positional arg (the scratch
    # claimed-files JSON the probe wrote via the Write tool immediately before this call —
    # NEVER fix.json, which a KI-E470 stepwise run never writes to disk at all).
    if [ "$1" = "phantom" ]; then
      _claimed="${3:-}"
      if [ -z "$_claimed" ]; then echo "usage: build-test.sh phantom <worktree> <claimed-files-json>" >&2; exit 64; fi
      exec node "$_SD/../_workflow/phantom-lint.mjs" "$_wt" "$_claimed"
    fi
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
#
# KI-E222: takes a FILE PATH, not the captured content as a string argument. Confirmed live that
# grepping a bash variable holding a large (~1MB) multi-project `dotnet test` transcript is
# unreliable for THIS specific extraction: `grep -c`/`grep -q` against the variable correctly
# found matches, but the `grep -oE ... | tail -1` extraction (the exact form below) reproducibly
# came back empty against the byte-identical content — never fully root-caused, sidestepped by
# operating on the file directly instead of round-tripping through a shell variable, which is reliable.
emit_realinfra() {
  if grep -qE 'FACTORY::REALINFRA::' "$1"; then
    grep -oE 'FACTORY::REALINFRA::\S+' "$1" | tail -1
  elif grep -qiE 'testcontainers|/ryuk|Docker[^\n]*container[^\n]*(creat|start)' "$1"; then
    kind=$(grep -oiE 'postgres|redis|rabbitmq|mssql|mysql' "$1" | head -1)
    echo "FACTORY::REALINFRA::Testcontainers-${kind:-unknown}"
  fi
}

prepare_test_results() {
  _SD=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
  _trx_dir=$(mktemp -d /tmp/factory-trx.XXXXXXXX) || return 1
  # KI-E222: a scratch file for the dotnet-test invocation's combined stdout/stderr — see the
  # `filter`/`suite` cases below for why this replaced bash `$(...)` command substitution.
  _out_file=$(mktemp /tmp/factory-testout.XXXXXXXX) || return 1
  trap 'rm -rf -- "$_trx_dir" "$_out_file"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# KI-E197 (ported from a host-mount session): aggregates every *.trx file `dotnet test` wrote into
# $_trx_dir (via _workflow/test-results.mjs — a dependency-free XML parser, no external package)
# into one failed/passed/skipped/total count PLUS a `FACTORY::TEST::FAILURE {...}` marker per
# actual failure, replacing the old "grep the LAST Passed!/Failed! console line" scrape that
# silently dropped every test project's counts except the last one on a multi-project run. Fails
# closed — a malformed/aborted/inconsistent TRX read never reports a wrong or partial count: it
# emits `FACTORY::TEST::DIAGNOSTIC {"status":"unavailable",...}` and forces exit=2 (never 0 or 1,
# so it can never be mistaken for an ordinary baseline-eligible pass/fail).
#
# Optional $1 = a pre-formatted extra `key=value` token spliced in immediately after `skipped=` on
# the emitted FACTORY::SUMMARY line — used by `suite` to carry a host-local `dockerfail=<N>`
# (KI-E85) at the exact position its `lib/verify.mjs` capture regex requires (immediately after
# `skipped=`; test-results.mjs's own trailing `total=` field would otherwise sit in the way). `filter`
# has no dockerfail concept and always calls this with no argument.
capture_test_results() {
  extra_field="${1:-}"
  evidence=$(node "$_SD/../_workflow/test-results.mjs" "$_trx_dir" "$cmd" "$code")
  captured=$?
  if ! printf '%s\n' "$evidence" | grep -q "^FACTORY::SUMMARY::$cmd exit=$captured "; then
    echo 'FACTORY::TEST::DIAGNOSTIC {"status":"unavailable","reason":"TRX extractor invocation failed"}'
    if [ "$code" -eq 0 ] || [ "$code" -eq 1 ]; then code=2; fi
    echo "FACTORY::TEST::${cmd^^}::RESULT exit=$code"
    echo "FACTORY::SUMMARY::$cmd exit=$code failed=-1 passed=-1 skipped=-1${extra_field:+ $extra_field} total=-1"
  else
    code=$captured
    echo "FACTORY::TEST::${cmd^^}::RESULT exit=$code"
    if [ -n "$extra_field" ]; then
      printf '%s\n' "$evidence" | sed "/^FACTORY::SUMMARY::$cmd /s/ total=/ ${extra_field} total=/"
    else
      printf '%s\n' "$evidence"
    fi
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
  codestyle)
    # KI-E378 — catch CS9113 (unused primary-constructor parameter) and IDE0290
    # (prefer primary constructor) violations that EnforceCodeStyleInBuild=true promotes to warnings.
    # Runs the build at full verbosity and greps for those specific diagnostic IDs. Advisory only
    # (exit 0) when warnings exist but no errors; exit 1 only on build errors (mirroring build case).
    _guard_worktree_path "$target" "target"
    echo "FACTORY::CODESTYLE::START $target"
    out=$(dotnet build "$target" --nologo 2>&1)
    code=$?
    cs9113=$(printf '%s\n' "$out" | grep -cE '\bCS9113\b' || true)
    ide0290=$(printf '%s\n' "$out" | grep -cE '\bIDE0290\b' || true)
    errs=$(printf '%s\n' "$out" | grep -cE ': error ' || true)
    printf '%s\n' "$out" | grep -E '\bCS9113\b|\bIDE0290\b|: error ' | head -30
    echo "FACTORY::CODESTYLE::RESULT exit=$code errors=$errs cs9113=$cs9113 ide0290=$ide0290"
    echo "FACTORY::SUMMARY::codestyle exit=$code errors=$errs cs9113=$cs9113 ide0290=$ide0290"
    exit $code
    ;;
  shellcheck)
    # KI-E378 — syntax-check shell scripts in a worktree with `bash -n`.
    # Catches syntax errors (unclosed brackets, bad substitutions) that would only surface at runtime.
    # Reports FACTORY::SHELLCHECK::HIT::<file> per broken script and a final count.
    _guard_worktree_path "$target" "target"
    echo "FACTORY::SHELLCHECK::START $target"
    hits=0
    while IFS= read -r -d '' f; do
      if ! bash -n "$f" 2>/tmp/.factory-sh-$$; then
        hits=$((hits + 1))
        echo "FACTORY::SHELLCHECK::HIT::$f"
        head -5 /tmp/.factory-sh-$$ | sed "s|^|  |"
      fi
    done < <(find "$target" -name '*.sh' -not -path '*/obj/*' -not -path '*/bin/*' -print0 2>/dev/null)
    rm -f /tmp/.factory-sh-$$ 2>/dev/null
    echo "FACTORY::SHELLCHECK::$hits"
    echo "FACTORY::SUMMARY::shellcheck hits=$hits"
    [ "$hits" -eq 0 ]
    ;;
  red)
    _guard_worktree_path "$target" "target"
    # Run the NEW regression test against the CURRENT (unfixed) worktree. A non-zero exit (compile-or-assert
    # failure) is the REQUIRED red proof — it shows the test genuinely fails on old code (non-vacuous).
    # KI-E482: optional 4th arg (the 3rd arg AFTER target+filter) = the transcript path to SELF-TEE
    # to. The red proof is the single most load-bearing artifact in the pipeline and it used to exist
    # only if an agent remembered to type `| tee <exact path>`. Self-teeing removes the ritual; the
    # brief's `| tee` becomes harmless redundancy rather than the only thing holding the evidence
    # chain together.
    # KI-E132: this was `${3:-}` — the SAME positional slot as $filter (assigned two lines above,
    # unconditionally, for every subcommand) — so _redout was never actually optional; it silently
    # equalled the filter string on every single `red` invocation. Since a filter never contains `/`,
    # `dirname` resolved to `.` (cwd) and the transcript got cp'd to a file LITERALLY NAMED after the
    # test filter (e.g. `ClassName::MethodName`) in whatever directory happened to be current —
    # harmless litter in a worktree, but real main-tree contamination when cwd was the repo root.
    # Fixed to the actual 4th positional arg, plus a guard: only tee to an ABSOLUTE path (the brief's
    # own requirement), so a future caller that passes a bad value fails LOUD instead of silently
    # littering wherever cwd happens to be.
    _redout="${4:-}"
    case "$_redout" in
      /*|'') ;; # absolute path (accepted) or not provided (tee stays optional, per the original contract)
      *) echo "FACTORY::RED::TEED::SKIPPED non-absolute redout path rejected: $_redout" >&2; _redout="" ;;
    esac
    echo "FACTORY::RED::START $target :: $filter"
    out=$(dotnet test "$target" --nologo --filter "$filter" 2>&1)
    code=$?
    {
      echo "FACTORY::RED::START $target :: $filter"
      printf '%s\n' "$out" | grep -iE 'Passed!|Failed!|Passed:|Failed:|error|No test matches' | tail -20
      echo "FACTORY::RED::$code"
      echo "FACTORY::SUMMARY::red exit=$code"
    } > /tmp/.factory-red-$$ 2>/dev/null
    printf '%s\n' "$out" | grep -iE 'Passed!|Failed!|Passed:|Failed:|error|No test matches' | tail -20
    echo "FACTORY::RED::$code"
    echo "FACTORY::SUMMARY::red exit=$code"  # KI-E19 evidence manifest
    if [ -n "$_redout" ]; then mkdir -p "$(dirname "$_redout")" 2>/dev/null; cp /tmp/.factory-red-$$ "$_redout" 2>/dev/null && echo "FACTORY::RED::TEED::$_redout"; fi
    rm -f /tmp/.factory-red-$$ 2>/dev/null
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
    if ! prepare_test_results; then
      echo 'FACTORY::TEST::DIAGNOSTIC {"status":"unavailable","reason":"TRX temporary directory unavailable"}'
      echo 'FACTORY::SUMMARY::filter exit=2 failed=-1 passed=-1 skipped=-1 total=-1'
      exit 2
    fi
    # KI-E222: capture via a FILE, never bash `$(...)` command substitution — confirmed live that
    # `$(...)` reproducibly loses console detail for a multi-project `.sln` target under concurrent
    # vstest.console child-process writers, even though the exit code and TRX-derived counts
    # (written straight to disk, unaffected) stay correct — only the console text carrying the
    # realinfra marker was silently reduced to a small fraction of its real size. Plain file
    # redirection does not exhibit this. Downstream consumers grep the file directly, never
    # re-capture its content into a bash variable.
    dotnet test "$target" --nologo --filter "$filter" --logger "console;verbosity=detailed" --logger trx --results-directory "$_trx_dir" > "$_out_file" 2>&1
    code=$?
    grep -iE 'Passed!|Failed!|Passed:|Failed:|error|No test matches' "$_out_file" | tail -20
    emit_realinfra "$_out_file"
    # KI-E197 (ported from a host-mount session): failed/passed/skipped/total now come from the
    # *.trx file this run wrote, not a bare `exit=$code` with no count breakdown at all — see the
    # KI-E197 comment on `capture_test_results` above for the full rationale.
    capture_test_results
    exit $code
    ;;
  suite)
    _guard_worktree_path "$target" "target"
    echo "FACTORY::TEST::SUITE::START $target"
    if ! prepare_test_results; then
      echo 'FACTORY::TEST::DIAGNOSTIC {"status":"unavailable","reason":"TRX temporary directory unavailable"}'
      echo 'FACTORY::SUMMARY::suite exit=2 failed=-1 passed=-1 skipped=-1 dockerfail=-1 total=-1'
      exit 2
    fi
    # KI-E220 (2026-09-21): same fix as KI-L22's `filter` case, applied here -- at dotnet test's
    # default verbosity the VSTest host suppresses test stdout, so a real-infra item whose ONLY
    # evidence comes from a whole-solution `suite` run could never surface a
    # `FACTORY::REALINFRA::<kind>` marker or the testcontainers/ryuk lifecycle logs
    # emit_realinfra's `elif` heuristic keys on, even though the real container genuinely ran.
    # Display stays bounded exactly as `filter` already does: only the grepped summary + the
    # extracted marker are printed, never the full transcript.
    # KI-E222: capture via a FILE, never bash `$(...)` command substitution — see the `filter`
    # case's identical comment above for the full rationale.
    dotnet test "$target" --nologo --logger "console;verbosity=detailed" --logger trx --results-directory "$_trx_dir" > "$_out_file" 2>&1
    code=$?
    # KI-E85 (2026-08-23): compute the Docker/Testcontainers-unavailable environmental-failure count
    # from the FULL, untruncated output BEFORE the display grep below trims it — a transcript already
    # bounded to summary lines cannot carry the per-test exception text the count depends on.
    # Best-effort: node/script absence never blocks the suite result. This counter is INDEPENDENT
    # of, and survives unchanged across, the KI-E197 TRX-based count upgrade below — the two are
    # computed from two different sources (the raw console text vs. the *.trx files) and both ride
    # the SAME keyed FACTORY::SUMMARY::suite marker.
    SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
    dockerfail=$(node "$SCRIPT_DIR/../_workflow/docker-envfail-count.mjs" < "$_out_file" 2>/dev/null)
    dockerfail="${dockerfail:-0}"
    grep -iE 'Passed!|Failed!|Passed:|Failed:|Skipped:|error' "$_out_file" | tail -30
    emit_realinfra "$_out_file"
    # KI-E197 (ported from a host-mount session): failed/passed/skipped/total now come from
    # aggregating every *.trx file this run wrote (via _workflow/test-results.mjs), not from
    # grepping the LAST "Passed!/Failed!" console line — the old approach silently dropped every
    # test project's counts except the last one on a multi-project `dotnet test` invocation.
    # capture_test_results also emits a `FACTORY::TEST::FAILURE {...}` marker per actual failure
    # and fails closed (forced exit=2 + FACTORY::TEST::DIAGNOSTIC) on malformed/aborted/inconsistent
    # TRX evidence instead of reporting a wrong or partial count. `dockerfail=<N>` (KI-E85, computed
    # above from the full output) still rides the SAME keyed marker.
    capture_test_results "dockerfail=${dockerfail}"
    exit $code
    ;;
  efmigration)
    # KI-E185 (ported from a host-mount session): EF Core pending-model-change detector. Unlike every
    # sibling lint dispatched above (leftovers/comments/ledger-anchor/rootcause) or below
    # (claims/countclaims), this is NOT a text/AST-shape diff scan — "does the persisted model match
    # the migration history" is a question only the real EF tooling can answer, which is exactly why
    # 5 independent gate/review roles on the origin host each had to run this SAME command by hand to
    # catch a persisted-entity schema change shipping with no migration and a stale ModelSnapshot.
    # $target = the API (startup) project's DIRECTORY (dotnet ef resolves the startup project from
    # cwd); $filter = the --project path to the *.Persistence project, relative to $target.
    #   usage: build-test.sh efmigration <worktree-path-to-Service.Api-dir> <../Service.Persistence>
    _guard_worktree_path "$target" "target"
    if [ -z "$filter" ]; then echo "usage: build-test.sh efmigration <api-project-dir> <persistence-project-relative-path>" >&2; exit 64; fi
    echo "FACTORY::EFMIGRATION::START $target :: $filter"
    out=$(cd "$target" 2>/dev/null && dotnet ef migrations has-pending-model-changes --project "$filter" 2>&1)
    code=$?
    printf '%s\n' "$out" | tail -20
    # Exit 1 is ALSO what this command returns on an unrelated build failure (it builds the project
    # first) — only the specific "pending changes" message is a genuine dirty verdict; any other
    # non-zero exit is inconclusive (fail-open, same posture as every pre-band probe here), not a
    # false CRITICAL. A clean run is exit 0 with no such message.
    # KI-E185 (ported from a host-mount session, folding in a same-session self-correction there): the
    # CLEAN message is "No changes have been made to the model since the last migration." — an
    # UNANCHORED substring grep for "Changes have been made to the model" matches that too (it is a
    # literal substring of the clean message), which on the origin host reported verdict=dirty
    # unconditionally regardless of actual EF state until caught by a live gate re-check. Anchored to
    # line-start here from the start: only the dirty message ("Changes have been made...") begins the
    # line; the clean message begins with "No ".
    if printf '%s\n' "$out" | grep -qi '^Changes have been made to the model'; then
      verdict=dirty
    elif [ "$code" -eq 0 ]; then
      verdict=clean
    else
      verdict=inconclusive
    fi
    echo "FACTORY::EFMIGRATION::RESULT verdict=$verdict exit=$code"
    echo "FACTORY::SUMMARY::efmigration exit=$code verdict=$verdict"  # KI-E19 evidence manifest
    exit $code
    ;;
  shellcheck-scan)
    # KI-E241 (a prior item follow-up): real `shellcheck` invocation on touched .sh files, not a
    # text/AST-shape diff — same "a real external tool answers this" posture as efmigration above.
    # Verified empirically (see _workflow/lib/shellcheck-lint.mjs's own header comment) that
    # shellcheck's DEFAULT check set does NOT catch that masking-bug class (a function
    # invoked under `||` silently disabling `set -e` inside it) — that check, SC2310, is OPTIONAL
    # and only fires with --enable=all, at info severity, so --severity=style is required too or
    # shellcheck's own default severity floor (style is its lowest) would filter it out anyway;
    # passing it explicitly documents the intent rather than relying on the current default.
    #   usage: build-test.sh shellcheck-scan <worktree-path> <sh-file> [<sh-file>...]
    _guard_worktree_path "$target" "target"
    if [ -z "$filter" ]; then echo "usage: build-test.sh shellcheck-scan <worktree-path> <sh-file> [<sh-file>...]" >&2; exit 64; fi
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    echo "FACTORY::SHELLCHECK::START $target :: $filter ${*:4}"
    if ! command -v shellcheck >/dev/null 2>&1; then
      echo "FACTORY::SHELLCHECK::RESULT verdict=unavailable exit=0"
      echo "FACTORY::SUMMARY::shellcheck exit=0 verdict=unavailable"
      exit 0
    fi
    out=$(shellcheck --format=json --severity=style --enable=all "$filter" "${@:4}" 2>&1)
    code=$?
    result_json=$(printf '%s' "$out" | node --input-type=module -e "
      import { classifyShellcheckOutput } from '$SCRIPT_DIR/../_workflow/lib/shellcheck-lint.mjs';
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { input += c; });
      process.stdin.on('end', () => {
        const result = classifyShellcheckOutput(input, { exitCode: $code });
        console.log(result.summary);
        for (const f of result.findings) {
          console.log('  ' + f.file + ':' + f.line + ':' + f.column + ' [' + f.level + '] SC' + f.code + ': ' + f.message + (f.notable ? ' (NOTABLE: ' + f.notable + ')' : ''));
        }
        console.log('VERDICT=' + result.verdict);
      });
    ")
    printf '%s\n' "$result_json" | grep -v '^VERDICT='
    verdict=$(printf '%s\n' "$result_json" | grep '^VERDICT=' | tail -1 | cut -d= -f2)
    echo "FACTORY::SHELLCHECK::RESULT verdict=$verdict exit=$code"
    echo "FACTORY::SUMMARY::shellcheck exit=$code verdict=$verdict"  # KI-E19 evidence manifest
    exit 0
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
  countclaims)
    # KI-E182 (2026-09-18): deterministic stale/invented test-count-claim linter, run EARLY (fix/
    # editorial/verify time) or during a manual recovery — same lib a future fold-time check would
    # use (single source of truth). Emits FACTORY::COUNTCLAIMS-MISS::<claim> per unevidenced "N/M
    # passed" claim + FACTORY::COUNTCLAIMS::<count>; exit 1 when count>0.
    #   usage: build-test.sh countclaims <worktree-path> <item-artifacts-dir> --transcript <current-path> [...]
    wt="$target"; itemdir="$filter"
    if [ -z "$wt" ]; then echo "usage: build-test.sh countclaims <worktree> <item-artifacts-dir>" >&2; exit 64; fi
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    node "$SCRIPT_DIR/../_workflow/countclaims-lint.mjs" "$wt" "$itemdir" "${@:4}"
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
    echo "usage: build-test.sh build|codestyle|shellcheck|red|filter|suite|efmigration|shellcheck-scan|claims|countclaims|leftovers|comments|registration-drift|docsync|ledger-anchor|rootcause|phantom|concurrency-scan|vacuous-test-scan|pack <target> [filter|outfile]" >&2
    exit 64
    ;;
esac
