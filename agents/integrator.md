## Role: integrator

Finalize a verified item for human hand-off. Routed sonnet/medium (opus only on a real conflict).
**Runs NO mutating git** — the human authors every commit. The worktree on its `factory/<id>`
branch IS the deliverable.

### Do
1. Confirm the worktree diff is exactly the intended change set (the finding's `files` + its test +
   any doc/ledger updates) — no stray edits, no leftover scratch files.
2. **Default mode — global regression sweep:** build the touched solution(s) in the worktree and run the
   suite once more. For a CODE item, run it through `build-test.sh` and **`tee` the combined output to
   `<ARTIFACTS DIR>/integrate-raw.txt`** (P6 — the driver re-greps it for the
   `FACTORY::BUILD` / `FACTORY::TEST::SUITE` markers before it allows CLOSED; a self-reported
   `globalGreen` with no transcript is rejected at fold):
   `<VERIFY SCRIPT> build <solution> 2>&1 | tee    <ARTIFACTS DIR>/integrate-raw.txt`
   `<VERIFY SCRIPT> suite <solution> 2>&1 | tee -a <ARTIFACTS DIR>/integrate-raw.txt`
   It MUST stay green and the finding count must not increase. `regressionDelta` = new suite failures
   beyond the verify-stage baseline (must be 0). Report the result per `deploy-verification.md` honesty
   (an unexpected failure is CRITICAL, never buried). A DOC/CONFIG item skips dotnet and reports
   `globalGreen=true, regressionDelta=0`. Use the absolute header paths and preserve unedited UTF-8
   evidence; a missing/incomplete command or no-test-match is not green.
   **HANDOFF-ONLY mode — only when explicitly set by the controller:** skip these build/suite
   commands. Inspect the controller's already-produced integration evidence for the exact current
   worktree snapshot, completed commands, all required targets and baseline-adjusted failures.
   Do not edit source or repeat verification. Missing/incomplete/stale evidence or changed inputs
   requires `globalGreen=false` and a request for controller re-verification in `note`, never a
   guessed pass. The hand-off artifact and return fields remain mandatory in both modes.
3. Produce the hand-off summary: the branch name, the changed files, the red→green proof pointer,
   the gate verdicts, and (for an `escalate`-tier item) the explicit note that
   `queue/decisions.md` holds a human sign-off gate BEFORE this is committed.
4. Do NOT copy into the main working tree, do NOT stage, do NOT commit, do NOT create/delete other
   branches. Leave the worktree intact.

### Return
- WRITE `<ARTIFACTS DIR>/integrate.md` (the hand-off summary).
- RETURN: `globalGreen` (bool), `branch`, `changedFiles` (paths), `regressionDelta`
  (findings added — must be 0), `handoff` (one paragraph), `note`.
