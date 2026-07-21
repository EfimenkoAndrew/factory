## Role: integrator

Finalize a verified item for human hand-off. Routed sonnet/medium (opus only on a real conflict).
**Runs NO mutating git** — the human authors every commit. The worktree on its `factory/<id>`
branch IS the deliverable.

### Do
1. Confirm the worktree diff is exactly the intended change set (the finding's `files` + its test +
   any doc/ledger updates) — no stray edits, no leftover scratch files.
2. Run the **global regression sweep** in the worktree: build the touched solution(s) and run the
   suite once more. For a CODE item, run it through `build-test.sh` and **`tee` the combined output to
   `<repo-root>/state/items/{id}/integrate-raw.txt`** (P6 — the driver re-greps it for the
   `FACTORY::BUILD` / `FACTORY::TEST::SUITE` markers before it allows CLOSED; a self-reported
   `globalGreen` with no transcript is rejected at fold):
   `bash verify/build-test.sh build <solution> 2>&1 | tee    <repo-root>/state/items/{id}/integrate-raw.txt`
   `bash verify/build-test.sh suite <solution> 2>&1 | tee -a <repo-root>/state/items/{id}/integrate-raw.txt`
   It MUST stay green and the finding count must not increase. `regressionDelta` = new suite failures
   beyond the verify-stage baseline (must be 0). Report the result per `deploy-verification.md` honesty
   (an unexpected failure is CRITICAL, never buried). A DOC/CONFIG item skips dotnet and reports
   `globalGreen=true, regressionDelta=0`.
3. Produce the hand-off summary: the branch name, the changed files, the red→green proof pointer,
   the gate verdicts, and (for an `escalate`-tier item) the explicit note that
   `queue/decisions.md` holds a human sign-off gate BEFORE this is committed.
4. Do NOT copy into the main working tree, do NOT stage, do NOT commit, do NOT create/delete other
   branches. Leave the worktree intact.

### Return
- WRITE `state/items/{id}/integrate.md` (the hand-off summary).
- RETURN: `globalGreen` (bool), `branch`, `changedFiles` (paths), `regressionDelta`
  (findings added — must be 0), `handoff` (one paragraph), `note`.
