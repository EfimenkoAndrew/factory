# Live OpenCode .NET code lifecycle

## Latest result — actual FULL code lifecycle CLOSED

The follow-up on 2026-09-19 completed the **real .NET code lifecycle**, including
actual driver fold **CLOSED**. The earlier failure history below is retained.

Root: `C:\Users\ayefymenko\AppData\Local\Temp\opencode\factory-live-code-RDxhXR`.
Report: `report.json`. OpenCode **2.0.10**, **github-copilot/gpt-5-mini**, standard
user authentication; endpoint `http://127.0.0.1:55801`, owned server PID **44052**.
Elapsed **387,756 ms** (6m28s), **17 worker admissions**.

### Machine evidence and independent work

1. Test-author created `tests/Numeric.Tests/ArithmeticRegressionTests.cs` and ran
   the actual leased helper against the unfixed product. RED transcript: **5 failed,
   1 passed, 6 total**, `FACTORY::RED::1`. Product bytes remained unchanged.
2. A separate fixer session changed `Arithmetic.Add` from `(long)left - right` to
   `(long)left + (long)right`. Regression test bytes remained unchanged.
3. Actual runtime verification: build **0 errors/0 warnings**, targeted **6 passed**,
   full suite **7 passed**, using the stock .NET/TRX producer.
4. Fresh independent sessions ran edge review, RED-coverage and breadth probes,
   architect/developer/QA/security gates, code/adversarial/test-quality reviews,
   PO, refuter, code re-audit and integrator. Edge review ran twice following the
   runtime's final-verification flow. Applicable gates approved. No verdict override.
5. Integration used the runtime's supported reuse of matching, complete FULL-band
   build/suite evidence. The independent handoff integrator checked the resulting
   `integrate-raw.txt`; this is evidence reuse, not an additional claimed .NET run.
6. Actual checkpoint/finalize and driver fold: **10 applied, 0 rejected, 0 skipped**.
   Ledger **CLOSED**, attempts **1**. Fold replay preserved ledger bytes. Settled
   test-author dispatch replay returned the same value/messages with no new admission.

```text
RED → GREEN → BUILT → TESTED → GATED → REFUTE_OK → REAUDITED → INTEGRATED → CLOSED
band=FULL, codeChange=true, verificationOnly=false
```

The successful report records every role/session, tool outcome, model, tokens/cost,
mechanical step, finalized envelope, folded row and cleanup receipt. All **17 sessions
were stopped/deleted** and the owned server stopped. Process inspection found no
remaining .NET/testhost/compiler processes or owned server PIDs.

### Implemented command-contract fixes

- Runtime appends trusted `workerCommandHint` and `workerRoleCommandHints[role]`
  from its captured host configuration **after** generic command examples. They
  override command spellings, never evidence requirements or gate decisions.
- TEMP workers derive from the shipped standard writer/reviewer guidance. Actual
  effective profiles are checked before dispatch; all route to Copilot GPT-5-mini.
  Worker session directory is the assigned worktree. V2 evaluates internal file
  permissions against session-relative paths, so test/product edit rules include
  those forms. Read-only git status/diff are permitted with the original read-only
  git environment. External reads are bounded to the owned TEMP root; config/auth/
  ledger/env files remain denied. This is runtime permission enforcement, not an OS
  sandbox. No credentials were read/copied and no git mutations were made.
- Test-author gets the exact absolute RED helper command; reviewers get the suite
  command and read historical RED. They cannot overwrite RED by executing it on
  fixed code. Shell `workdir` handles directory selection rather than `cd`.
- The helper restores only required noncredential Windows path environment alongside
  its isolated offline package cache. This fixes NuGet's null `path1` setup failure
  in the worker environment. A setup error is not accepted as regression RED.
- Process-only fixture excludes include `bin/obj`, preventing generated assemblies
  from entering source/lint review. Packages are centrally versioned in
  `Directory.Packages.props`; the sibling assertion and regression instructions use
  descriptive messages supported by the actual xUnit version.

Only the fixture host config/profiles changed; the current user's OpenCode config
was not edited. Each new owned server loads the corrected profiles at startup.
Fixture bootstrap/static identity remains distinct from production scheduler
admission. Planner is skipped for mechanical fixes, editorial flows do not apply,
and real-infra/EF gates do not apply to pure numeric logic.

### Retained follow-up failures and resume

All roots below share the parent shown above and the `factory-live-code-` prefix.
All failed results remain FAILED, with original model responses retained.

| Root suffix | Calls | Outcome / correction | Server PID(s) |
|---|---:|---|---|
| `C6oWJV` | 1 | git commands worked; v2 relative read/edit matching rejected absolute-only rules; negative response folded FAILED | 39068 |
| `HoA3t3` | 1 | reads/git worked; patch path resolved against the harness root; switched session directory to worktree; folded FAILED | 27764 |
| `aHQPi7` | 1 | actual helper ran but NuGet failed before assertions; worker red=true was rejected by harness and runtime fail/finalize/fold recorded FAILED | 14428 |
| `pqo5Y3` | 17 | real RED/fix/green achieved; paused at generated-binary lint, resumed the same runtime after process-only bin/obj excludes; reviews rejected shared RED command confusion and project conventions; folded FAILED | 39064, 25608 |
| `71t0NF` | 13 | real RED/fix/green and every gate except test review approved; test reviewer required assertion messages; folded FAILED | 39232 |
| `RDxhXR` | 17 | FULL lifecycle CLOSED | 44052 |

The `pqo5Y3` continuation reused completed runtime submissions rather than redoing
test authoring/fixing; no active writer was killed. All **50 follow-up sessions**
were deleted and **seven owned servers** stopped. No failed review was relabelled
APPROVED. Historical setup errors are not counted as successful regression proofs.

### Complete code-campaign accounting

| Work | Calls | Runtime-reported cost |
|---|---:|---:|
| Prior two attempts retained below | 2 | 0.02040310 |
| `C6oWJV` | 1 | 0.01618155 |
| `HoA3t3` | 1 | 0.01039585 |
| `aHQPi7` | 1 | 0.01478615 |
| `pqo5Y3`, both invocations | 17 | 0.18513210 |
| `71t0NF` | 13 | 0.12279710 |
| Successful `RDxhXR` | 17 | 0.16762505 |
| **Total** | **52** | **0.53732090** |

Successful run tokens: **246,537 input**, **18,165 output**, **963,712 cache-read**,
**0 cache-write**. Each retained report contains per-call tokens for every failed
attempt too. All calls have runtime usage/cost fields; billing remains **unverified**.
The continuation used no Claude calls. Each lifecycle invocation retained its
25-dispatch/20-minute bounds and a reported-cost admission stop at 0.75; a pooled
batch can add cost after that check, so it is not an invoice-enforced dollar cap.

Latest regressions:

- Full nonmutating selftest: **1,854 assertions / 22 focused suites passed**.
- OpenCode selftest: **190 legacy/pure**, **90 runtime/API**, plus actual CLI phase,
  dispatch, settlement, admission, shadow and build-lease suites passed.
- Code harness: **3 tests passed**, including actual generated prompt commands,
  stripped-environment offline suite, generated-output lint exclusion, negative
  runtime/finalize/fold, uncertain-result refusal and setup-error RED rejection.

Known issues **KI-O17/KI-O18** record this follow-up. Official v2 source inspected
for the matching contract: `packages/core/src/tool/plugin/shell.ts`,
`packages/core/src/shell/parse.ts`, `packages/core/src/file-access.ts`,
`packages/core/src/tool/plugin/patch.ts` at tag **v2.0.10**.

## Earlier result — FAILED at regression proof

On 2026-09-19, two bounded attempts used actual OpenCode **2.0.10** and
**github-copilot/gpt-5-mini** with normal user authentication. Both test-author
workers wrote real C# regression tests, but returned `red:false` after attempting
denied generic shell commands instead of the permitted fixture helper. Neither
produced `verify-red-raw.txt`. The initial attempt plus one harness retry exhausted
the requested retry allowance; no further inference was launched.

The unchanged negative responses were submitted through the actual runtime CLI,
checkpointed, finalized and folded by the actual driver. **Both isolated ledgers
are FAILED**, with the reason:

> no red proof (verify-red-raw.txt) — test-author must prove the regression test fails on old code

Each driver fold reported `applied 1, rejected 0, skipped 0`. A second fold returned
`no new current results (already folded or stale)` and preserved ledger bytes.
This is terminal failure evidence, **not a completed RED→fix→GREEN code lifecycle**.
Fixer, build/test-after-fix, independent code reviews and integration were not reached.

## Harness and scope

- `_workflow/live-opencode-code.mjs` reuses the exported archive/bootstrap,
  authentication/server, hardened `dispatchAgent`, immutable report and cleanup
  helpers. It creates only public synthetic fixture data in TEMP.
- Source is an archived public factory HEAD with new `src/Numeric` and
  `tests/Numeric.Tests` projects beneath `state/worktrees/LIVE-NUMERIC-CODE`.
  The existing `.git` is used read-only through `GIT_DIR`/`GIT_WORK_TREE` and
  `GIT_OPTIONAL_LOCKS=0`; no git mutations or index refresh occur.
- Installed .NET 8 and an isolated copy of cached xUnit packages supply an offline
  build. The **stock** `verify/build-test.sh`, worktree path guard, shared build
  lease and actual TRX producer run. No custom verification override is installed.
  Explicit solution mapping points to `tests/Numeric.Tests/Numeric.Tests.csproj`.
- The pre-created bug is `(long)left - right` in `Arithmetic.Add(int,int)`;
  acceptance requires exact Int64 addition, including Int32 boundary inputs.
  A pre-existing zero-input test passed through the real suite before workers.
  The new regression file did not exist at bootstrap. Product source stayed unfixed.
- Separate effective test-author, fixer and read-only reviewer profiles route only
  to Copilot GPT-5-mini. Test-author edits are restricted to its regression file;
  fixer edits to the production C# file. New independent sessions are used per call.
  Shell permissions expose only `node code-check.mjs red` and/or
  `node code-check.mjs suite`. The helper calls the actual build-lease/verify code
  and persists the unedited RED transcript. No hand-authored success markers.
- Runtime bootstrap uses `init --fixture`, `codeChange=true`, FULL band and static
  fixture identity. This does not test production scheduler/worktree admission or
  full-content claim identity. Only driver CLI commands write the temporary ledger.
- Bounds are 25 dispatches and a 20-minute loop budget per invocation, with at most
  180 seconds per worker. The live campaign used only two dispatches total. There
  is no automatic provider fallback or automatic paid retry.

The first test-author tried Docker and the generic build-lease/tee command, both
denied. The retry added an explicit host command mapping to TEMP role briefs,
but the second worker still tried generic `git status`, then stopped with an honest
permission failure. These observations do **not** prove the allowed helper itself
is rejected: neither worker attempted its exact allowed spelling. Resolving command
precedence between generic runtime hints, role text and host helper instructions
remains the concrete harness blocker. No production gate or permission was weakened.

## Reproduction

```powershell
node _workflow/live-opencode-code.mjs --prepare-only --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
node _workflow/live-opencode-code.mjs --resume-root "<prepared-root>" --executable "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode\package\bin\opencode.exe"
```

Without `--prepare-only`, `--temp-parent` starts a fresh live attempt. The harness
launches a new owned server, so its TEMP profiles take effect at startup; existing
user OpenCode sessions/configuration are not modified. Do not treat `--resume-root`
as a retry for a deleted pending worker session. Saved dispatch mappings bind server
identity and fail closed when the original owned server/session is gone.

For the specific stopped test-author failure shape, `--fold-failure <root>` submits
the saved schema-valid `red:false` response without inference, then calls runtime
checkpoint/finalize and driver fold/replay. It refuses uncertain or positive test
results. It never changes a worker verdict or writes a ledger directly.

## Retained evidence

Parent: `C:\Users\ayefymenko\AppData\Local\Temp\opencode`

| Attempt | Root | Endpoint | Server PID | Session |
|---|---|---|---:|---|
| Initial | `factory-live-code-z5vbQV` | `http://127.0.0.1:63468` | 7568 | `ses_a0a916c36665cb42145944aaa5bd417b` |
| One retry | `factory-live-code-JOLQij` | `http://127.0.0.1:49235` | 43232 | `ses_78563da0ca7b5fe9d02d3cddcea5e23c` |

Each root retains `report.json`, immutable continuation reports selected by
`report-latest.json`, append-only cleanup receipts, `before-fix.json`, real baseline
`before-suite.txt`, generated projects/tests and `factory/state` runtime artifacts.
Final failure-fold reports:

- Initial: `replay-bd03ed12-0702-4d9f-8839-b38ae329185d.json`
- Retry: `replay-165189b3-51f0-48da-9767-f40d9cb5447d.json`

Before deletion, each completed worker was passed to actual `dispatchAgent` again:
the settled output and message snapshot were unchanged and no new admission occurred.
No active writer was deliberately killed. Both sessions were confirmed stopped and
deleted; both owned servers stopped. Process inspection found no .NET/testhost/compiler
processes. TEMP evidence is deliberately retained.

## Accounting

| Call | Input | Output | Cache read | Cache write | Runtime-reported cost |
|---|---:|---:|---:|---:|---:|
| Initial test-author | 6,387 | 1,442 | 36,480 | 0 | 0.00948875 |
| Retry test-author | 11,051 | 1,327 | 20,224 | 0 | 0.01091435 |
| Total | **17,438** | **2,769** | **56,704** | **0** | **0.02040310** |

Two actual worker admissions, both completed and accounted by the runtime. Costs
are reported estimates, not verified Copilot billing. No unavailable worker usage
was converted to zero. No Claude invocation or credential inspection/copy occurred.

## Checks

- `node --test _workflow/live-opencode-code.test.mjs`: **2 passed**, including a
  real offline baseline plus actual negative-test runtime/finalize/driver-fold and
  rejection of uncertain saved results. That unit test supplies a synthetic negative
  response and makes no model call; it is distinct from the two live attempts above.
- `node _workflow/lib/_selftest.mjs --no-git-mutations`: **1,854 assertions,
  22 focused suites passed**, zero failures; all seven nonmutating git fixture
  groups and 14 shell assertions completed. Included native/Claude-named suites
  use pure/mock fixtures and did not invoke Claude.
- Known issue: **KI-O16**.
