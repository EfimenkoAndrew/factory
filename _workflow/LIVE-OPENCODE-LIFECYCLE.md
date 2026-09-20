# Live runtime lifecycle, driver fold and running-tool cancellation

**Latest result:** the v2 follow-up below completed the full applicable doc runtime,
finalize and actual driver fold CLOSED. Earlier v2 worker-only limitations in this
document describe the preceding run, not the current validation status.

**Independent-review correction (KI-O14):** earlier v1 header-only abort/delete
successes establish historical API acknowledgements, not proof that detached prompt
handlers could not start later. The adapter now fences those sessions instead of
releasing them. The running-tool and terminal-output cases below had actual startup
evidence; no full paid lifecycle was rerun for this correction.

Validated on **2026-09-19** with actual OpenCode **1.18.31** and official
**2.0.10**, both using `github-copilot/gpt-5-mini` through normal user auth.
No credentials were read/copied by the harness or printed. No git mutations,
source-checkout worker edits or edits to the real factory ledger were performed.

## Reproduction

```powershell
node _workflow/live-opencode-lifecycle.mjs --executable "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
node _workflow/live-opencode-cancel.mjs --executable "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
node _workflow/live-opencode-cancel.mjs --version v2 --executable "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode\package\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
```

The v2 executable's official npm provenance/integrity is documented in
[`opencode/COMPATIBILITY.md`](opencode/COMPATIBILITY.md). No package installation
or global config change is needed. V2 config is written only under the generated
TEMP config directory and loaded by a new owned server. Model inventory is emitted
as IDs only. Normal user auth/data context is retained; config/cache/state/project
settings are isolated. Consequently shared runtime databases/auth-refresh records
can be updated by OpenCode itself. No credential migration is performed manually.

`--prepare-only` makes the lifecycle fixture without any server/model request.
`--resume-root <owned-root>` resumes its persisted runtime state. There is no
automatic paid retry or verdict rewriting. A failed finalized fixture stays failed;
start a fresh fixture for a corrected configuration. The lifecycle has a 25-dispatch,
20-minute loop budget, 120-second per-worker deadline and eight steps per worker.
The cancellation probe has one tool call plus one fresh retry, each bounded by
90 seconds. A runtime model step can include multiple tools/provider HTTP requests;
these limits are not an exact provider-billing request counter or dollar cap.

## Actual v1 lifecycle

The successful fixture is retained at:

`C:\Users\ayefymenko\AppData\Local\Temp\opencode\factory-live-lifecycle-BnCxUK`

It contains a clean `git archive HEAD` source snapshot, a separate copied factory
mount, actual role prompts/results/session mappings and the isolated driver state.
Only engine directories and committed fixture source are copied; local overlays
and repo profiles are excluded. No dirty checkout review pack is sent to models.
Read-only git commands use `GIT_DIR` pointing at the existing repository and
`GIT_WORK_TREE` pointing at the archived fixture, with optional git locks disabled.
Harness scripts are excluded through process-only git configuration. The index and
objects are read, not copied or edited; unrelated staging in the original checkout
can therefore affect diagnostic status output. This is not a new git worktree.

Bootstrap calls actual `runtime.mjs init --fixture` and actual `driver.mjs init`.
The driver is the sole writer of the temporary ledger. No preclaimed ledger is
hand-authored: fold exercises the supported READY-to-CLAIMED auto-claim path.
Fixture identity is the runtime's static synthetic identity, not production
full-content claim identity. Real scheduling, worktree creation, premium routing,
code/.NET gates and production delivery are not claimed by this experiment.

Acceptance: README.md begins with `# AI Implementation Factory`.
The controller actually executed the owner-provided Node pinning assertion before
workers, captured `DOC_ASSERT_PASS: README heading` and `FACTORY::RED::0`, exit 0.
Seven editorial/reviewer/re-auditor workers independently executed the same command.
The test-author read source/script/evidence, but its shell attempts were denied;
its prose is not used as proof that it executed the command. The integrator only
read controller-produced integration evidence, as the real handoff contract requires.

All nine calls used fresh parentless sessions and the unmodified role briefs,
with a temporary worker system instruction enforcing read-only synthetic scope:

| Role | Session |
|---|---|
| test-author | `ses_f44e11200ffeNHkFvZW2wIbDql` |
| editorial structure | `ses_f44e0005cffe28VzX35sFkO7HQ` |
| editorial prose | `ses_f44df98efffeAMUgCWeAFnCK4L` |
| developer | `ses_f44df2dbdffehc0Jmcq7c7a5wP` |
| QA | `ses_f44df2dc1ffex5yjkowA9eHb8m` |
| adversarial | `ses_f44df2dd1ffedfMK9sCKVqH3WG` |
| test review | `ses_f44df2dc4ffeYmcyKWHPTMPzoz` |
| re-auditor:code | `ses_f44deb4f7ffeb74mpnyttMrGzH` |
| integrator | `ses_f44de562effeRXpKHCdqRjciUv` |

Applicable pooled gate roles ran concurrently. LIGHT/doc/mechanical routing skips
planner/fixer/PO/code-edge scans, and its adversarial review covers the separate
refuter call by existing policy. These skips are actual runtime decisions.

Actual transitions in the finalized result:

```text
RED → GREEN → BUILT → TESTED → GATED → REFUTE_OK → REAUDITED → INTEGRATED → CLOSED
verificationOnly=true, codeChange=false
```

These state names do not imply a .NET build ran: the doc branch explicitly records
no-build/no-suite evidence. Controller source-byte check also passed.

Actual driver fold output: **`fold: applied 10, rejected 0, skipped 0`** (includes
auto-CLAIMED). Ledger: **CLOSED**, attempts **1**, cycle **1**, journal
`LIVE-DOC-VERIFY#1`. A later actual finalize/fold replay returned
`no new current results (already folded or stale)` and left ledger bytes unchanged.
No further model calls occurred on replay. That replay overwrote the report's first
fold output/cleanup array before preservation was fixed; original transition/fold
and cleanup evidence was captured in the live terminal result and is retained here.

Endpoint `http://127.0.0.1:4096`; live server PID **34644**, replay server **22616**.
Both stopped; all nine sessions were aborted/reconciled and deleted. TEMP artifacts
are deliberately retained for inspection. `report.json` plus `factory/state/`
contain the observations, checkpoint, finalized envelope and folded ledger.

Model claims remain separate from machine evidence: the integrator listed README
in `changedFiles` despite the source being unchanged, and some reviewers reported
`redGreenConfirmed:true` for a passing pinning check. Those are visible self-report
limitations, not evidence of edits or a failing-then-passing test sequence.

## Failures and implementation fix

- `factory-live-lifecycle-jivhmB`: Windows short-path session identity failure
  before admission; fixed harness canonicalization with `realpathSync.native`.
  The empty orphan session was found by exact dispatch title, stopped and deleted.
  Then one model call failed because the script was outside the specified worktree.
  The actual runtime finalized FAILED and actual driver folded FAILED, retained.
  Server PIDs **25728**, **44076** stopped. Sessions
  `ses_f44e62e8dffe7Y9dxCU1yX3OtL` and `ses_f44e5ce93ffe3Qtkd1E8KP9YYC` deleted.
- `factory-live-lifecycle-DaEdjU`: nine model calls; overly narrow temporary read
  patterns denied evidence reads. The integrator returned `globalGreen:false`;
  actual finalize/fold recorded FAILED. Server **13324** stopped, all nine session
  deletions confirmed in that root's report.
- That failed full run exposed duplicate GREEN/BUILT/TESTED transitions when doc
  verification refreshed after editorial invalidation. The driver rejected two
  backward transitions. `runtime.mjs` now appends the trio only before the first
  TESTED. `live-opencode-lifecycle.test.mjs` exercises the actual CLI through that
  refresh using a real machine doc assertion. No evidence gate is weakened.
- Failed setup runs are retained, not counted as successful executions. Read-only
  git diagnostic drift warnings arose from using the existing index with archived
  HEAD bytes; they did not trigger any repair or checkout write.

## Actual running-tool cancellation and fresh retry

The probe asks an actual model to run only `node delay-check.mjs`. The synthetic
tool writes a start marker/PID, then schedules a second marker after 15 seconds.
The harness observes both the running tool part and start marker, calls actual
`api.stop`, waits 17 seconds, rechecks idle and absence of the late marker, and only
then admits a fresh `dispatchAgent` request with `PROBE_SCHEMA`.

| | V1 | V2 |
|---|---|---|
| runtime | 1.18.31 | 2.0.10 |
| endpoint | `http://127.0.0.1:4096` | `http://127.0.0.1:54502` |
| root suffix | `factory-live-cancel-bfD7We` | `factory-live-cancel-3AZizV` |
| server / tool PID | 29576 / 44672 | 40072 / 17104 |
| cancelled session | `ses_f44dcccebffeVj3PjcVeXk98bL` | `ses_718fbd837e74f321e53a208f07781e34` |
| retry session | `ses_f44dc71ffffejnhKlXa32eCr6h` | `ses_4a02fb0aa6db0c178c7b0e3897c3ce64` |
| running observed / durable admission | true / true | true / true |
| stop / idle after delay / no late write | true / true / true | true / true / true |
| durable inbox after cancellation | not a v1 API | empty |
| fresh retry actual model | github-copilot/gpt-5-mini | github-copilot/gpt-5-mini |
| retry JSON | markerFound=true | markerFound=true |
| cleanup | both sessions deleted, server stopped | both sessions deleted, server stopped |

V2's model inventory and provider IDs were discovered from actual `/api/model`
and `/api/provider`; session create/prompt/inbox/messages/active/interrupt/delete
were the actual v2 routes. This supersedes prior *no-model-only* v2 evidence for
this specific 2.0.10 worker slice. The later full applicable v2 doc lifecycle is
recorded below; future runtime releases still require validation.

Additional no-inference startup probes: v1 `factory-live-cancel-Xt9vDd`, server
**44412**, returned `/agent` HTTP 500. V2 `AsmJvn` (**31992**) and `Kjo01U`
(**44472**) hit bounded profile readiness timeouts. Increased readiness allowance
and disabled model-catalog fetch permitted `bRD6my` (**28664**) discovery to pass.
All those owned servers stopped and no sessions were admitted. Their reports and
TEMP config directories are retained. No raw global config or auth content was logged.

## Accounting

This continuation used **23 admitted worker prompts**: 1 failed short fixture,
9 failed full fixture, 9 successful full fixture, and 2 cancellation/retry pairs.
One additional pre-admission session-identity attempt made no prompt request.
No premium calls or full v2 lifecycle were attempted in that 23-prompt continuation;
the subsequent full v2 lifecycle has separate accounting below.

Costs are runtime-reported estimates, not verified Copilot invoices. Canceled
requests were not fully accounted and stay **null/unknown**, not zero. Reports
retain per-call token/cache/cost fields for completed requests, including failures.
The original six-call worker experiment is separate from this continuation.

| Accounted work | Runtime-reported cost |
|---|---:|
| successful nine-call lifecycle | 0.07348635 |
| ten completed calls across failed lifecycle fixtures | 0.07982025 |
| v1 fresh retry | 0.00033605 |
| v2 fresh retry | 0.00046075 |
| known subtotal | **0.15410340** |
| two cancelled requests | **unknown** |

Successful lifecycle usage: **85,523 input**, **4,272 output**, **134,784 cache-read**,
**0 cache-write** tokens as reported by the runtime. The known subtotal is not a
complete total because cancelled-request usage is unknown.

## Regression results

- `node --test _workflow/live-opencode-lifecycle.test.mjs _workflow/live-opencode-workers.test.mjs`: **6 passed**.
- `node _workflow/lib/_selftest.mjs --no-git-mutations`: **1847 assertions passed**,
  **20 focused suites passed**, zero failures; all seven nonmutating git fixture
  groups and all 14 shell assertions completed.
- `node _workflow/opencode/_selftest.mjs`: **190 legacy/pure passed**, plus the
  runtime/API, actual CLI phase, dispatch, settlement, admission and lease suites.

## Safety and evidence limits

The original no-model check is unchanged. The live harnesses use Node built-ins.
Only synthetic/public engine fixture data enters worker prompts. Runtime edit,
network and arbitrary-shell permissions are denied; this is cooperative runtime
permission enforcement, not an OS sandbox. Sessions share normal runtime auth/data
storage. All currently owned sessions/servers are cleaned, but generated TEMP
evidence roots intentionally remain. Interrupted/crashed harnesses cannot guarantee
automatic cleanup. Inspect the recorded root/PID/session identities before recovery.

## V2 full doc lifecycle and unavailable-model fallback — follow-up

```powershell
node _workflow/live-opencode-lifecycle.mjs --version v2 --retry-probe --executable "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode\package\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
```

Version-aware profiles use v2 `agents`, `permissions`, `system`, eight steps and
`snapshots:false`. Resume binds API version. V2 bounds are 12 lifecycle dispatches,
six-minute loop deadline, at most 120 seconds per worker, and pre-admission reported
cost stop at 1.5. A pooled batch can incur cost after that check: this is not an
invoice-enforced cap. Optional retry probe adds two bounded 60-second attempts.
No native factory, driver, shared schema or server-adapter changes were needed.
Named output schemas were checked against current native source before/after work;
native-only identity changes remain separate.

### Actual CLOSED result

Root: `C:\Users\ayefymenko\AppData\Local\Temp\opencode\factory-live-lifecycle-YTf47w`.
Runtime **2.0.10**, endpoint **http://127.0.0.1:59708**, server PID **39216**.
Nine independent actual **github-copilot/gpt-5-mini** workers completed in
**200,966 ms** (3m21s). Actual checkpoint/finalize: **CLOSED**, verificationOnly=true,
codeChange=false. Driver: **`fold: applied 10, rejected 0, skipped 0`**; ledger
CLOSED, attempts 1, cycle 1, journal `LIVE-DOC-VERIFY#1`. Replay preserved ledger
bytes and sent no additional lifecycle workers. Original elapsedMs was overwritten
with 555 ms by the first replay before preservation was fixed; 200,966 ms is the
captured original terminal result, not a replay estimate.

| Role | Actual session |
|---|---|
| test-author | `ses_0c154b233f6431d1150fd0bec86dc620` |
| editorial structure | `ses_945ff6df8ef8502a406e0cfa19402207` |
| editorial prose | `ses_6acba175454c895f2afaad913672b8c6` |
| developer | `ses_4e36e487f6dfbc703af495131379ce35` |
| QA | `ses_c92ec341f2cc61a7d053b828da74d5e3` |
| adversarial | `ses_2a36f3044ba8a6f6a0b8accc0b493257` |
| test review | `ses_df44b8d309ae55c7cbec665ce27a608a` |
| re-auditor | `ses_de72fee0043926adfd52c3ce83bd7249` |
| integrator | `ses_75b3426e257b2781c08c6d141a41ac32` |

Controller executed the real doc assertion; both editorial roles and developer
independently completed `node check-doc.mjs`. Others read source/evidence after
non-whitelisted shell attempts were denied. Their prose does not establish command
execution. Initial v2 summaries omitted tool names due to differing content shape;
completed statuses and exact allowed command fields are real evidence. Extraction
now accepts v2 name fields too. No source changes or real RED→GREEN code tests are
inferred from model self-reported changedFiles/redGreenConfirmed fields.

### Unavailable route fails closed, then explicit fallback

A random missing model under the connected Copilot provider was verified absent
from `/api/model`, with the valid fallback present. Real `dispatchAgent` created
and admitted the missing route but the installed runtime produced **zero assistant
messages**. After 60 seconds, cancellation/reconciliation persisted **failed**,
**stopped=true**, no successful value. This is an unavailable-route timeout, not
a fabricated provider error or evidence of paid inference. Model/tokens/cost remain
null; no invoice or provider HTTP trace was inspected.

Only after confirmed settlement, one explicit fresh mapping selected
`github-copilot/gpt-5-mini` and returned schema-valid
`{"markerFound":true,"line":"explicit valid fallback"}`. Failed mapping bytes
stayed unchanged. Failure session: `ses_750c64c0167842b82c1472f65969fd7d`;
fallback: `ses_c71dca2e7913384b0a447412b7f276b3`. Endpoint
**http://127.0.0.1:62767**, server **39416**. This is caller-controlled explicit
fallback, not automatic production routing promotion. A negative regression proves
uncertain termination prevents fallback admission.

### Failures and exact cleanup

- `factory-live-lifecycle-Ru66Hu`: seven completed workers; adversarial reviewer
  rejected ten status-only modified paths. Actual finalize/fold FAILED; retained.
  Endpoint **127.0.0.1:52777**, PID **23068**, all seven sessions deleted/server stopped.
- `factory-live-lifecycle-bSHQkM`: preparation-only failure, no server or prompt.
  Filtered HEAD bytes still left status stat-cache entries dirty while actual diff
  HEAD was empty. Preparation now independently requires `git diff HEAD --exit-code`
  and describes this synthetic read-only-index artifact. It never refreshes the
  owner's index, rewrites review-pack output, or overrides reviewer verdicts.
- Initial missing-route session `ses_a5d399ed8c642bd4e3f2e31f2bb7a4b4` timed out,
  settled and was deleted, but the probe initially required a model-named error.
  Timeout is now accepted only with catalog absence and zero assistant output.
- One no-inference replay reused a fixed mapping filename and encountered the
  already-deleted session. Dispatch-unique mapping filenames fix that harness bug.
  PID **22632**, endpoint **127.0.0.1:51074**, stopped. Historical duplicate cleanup
  failure was reconciled by actual session GET **404**, not assumed gone.
- Final cleanup-only replay: **31036**, **127.0.0.1:56978**, stopped; final report
  **PASS**, no new prompts. Initial lifecycle server **39216** and fallback server
  **39416** also stopped.

All **19 unique sessions** deleted and **five owned servers** stopped. Three TEMP
evidence roots remain: `Ru66Hu`, `bSHQkM`, `YTf47w` with prefix
`factory-live-lifecycle-`. No raw credentials/global secrets were read or copied.

### Separate follow-up accounting

| Work | Completed calls | Runtime-reported cost |
|---|---:|---:|
| successful v2 lifecycle | 9 | 0.06396265 |
| retained failed v2 lifecycle | 7 | 0.04288260 |
| explicit valid fallback | 1 | 0.00197345 |
| known subtotal | 17 | **0.10881870** |
| unavailable admissions, no assistant output | 2 | **unknown** |

Successful lifecycle: **113,017 input**, **3,923 output**, **95,616 cache-read**,
**0 cache-write** tokens. Fallback: **1,289 input**, **104 output**, **1,408 cache-read**.
Nineteen admissions total including failed fixture and unavailable routes. Runtime
cost is not verified billing. Fixture bootstrap/static identity limitations still
apply: actual v2 runtime/finalize/fold is proven, production scheduling is not.

Follow-up regressions: **9 focused harness tests passed**; full nonmutating
selftest **1854 assertions / 21 focused suites passed**; OpenCode adapter
**190 legacy/pure tests plus runtime/dispatch/settlement/phase suites passed**.
Native strict evidence-identity schema is local to the native relay; named shared
schemas still pass adapter parity, so no speculative port schema widening was made.

## Independent-review hardening

Official source checked at tag v1.18.31:
`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`.
`promptAsync` calls `Effect.forkIn(scope, {startImmediately:true})`, then returns
NoContent; `abort` calls `promptSvc.cancel` then returns true. Waiting for POST
completion therefore cannot close the pre-runner-registration cancellation gap.
New tests keep stop uncertain through 24 acknowledged abort/idle cycles, then prove
only actual matching-prompt startup/terminal evidence can release the fence. The
dispatcher retains uncertain state across repeated restarts without admitting retry.

Both API versions now reject a stale APPROVED snapshot when CHANGES_REQUIRED appears
between message and idle reads; changed snapshots remain pending and the fresh final
verdict is evaluated on a subsequent poll. Tools, idle and v2 inbox are rechecked.
This is not an atomic server lock and does not protect against an external client
writing into the exclusively owned session after validation.

Nullable object/array schema types recurse into actual containers, including required
nested baseline fields, boolean types, array items and additional-property rejection;
null remains valid only when its type and independent enum permit it. Schema constants
and native/adapter parity are unchanged.

Every lifecycle invocation after the first writes `replay-<uuid>.json` rather than
overwriting `report.json`; `report-latest.json` points to the latest continuation.
Session/server cleanup outcomes append to `cleanup-receipts.jsonl` and report receipt
arrays, including failed attempts and later 404 reconciliation, without editing old
receipts. A regression performs replay saves after nine confirmed deletions and
checks original report bytes, receipt prefix and all nine deletion receipts survive.
Unresolved sessions are not deleted; their dispatch/message/session/server/directory
identities remain in evidence even if the owned server is subsequently terminated.

## Latest-code cancellation validation — 2026-09-19, 21:02 UTC

**PASS on actual v1 1.18.31 and v2 2.0.10 after the settlement fixes.** The
current `live-opencode-cancel.mjs` was run concurrently against these exact binaries:

```powershell
node _workflow/live-opencode-cancel.mjs --version v1 --model github-copilot/gpt-5-mini --executable "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
node _workflow/live-opencode-cancel.mjs --version v2 --model github-copilot/gpt-5-mini --executable "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode\package\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
```

Exactly **four worker prompt admissions**: cancellation plus fresh retry for each
version. Both used standard Copilot auth and `github-copilot/gpt-5-mini`; no Claude
quota was used. The only requested shell command was the synthetic delayed fixture,
`node delay-check.mjs`. Both servers requested `--port 0` and had separate fixture
directories and UUID-based session titles. Actual v1 selected **4096**, whereas v2
selected **49469**: independent endpoints were observed, but an ephemeral v1 port
is **not** established by this run.

### Exact observed results and retained cleanup receipts

Artifact parent: `C:\Users\ayefymenko\AppData\Local\Temp\opencode`.

| Evidence | V1 | V2 |
|---|---|---|
| root | `factory-live-cancel-fJgBCN` | `factory-live-cancel-JDqnse` |
| endpoint | `http://127.0.0.1:4096` | `http://127.0.0.1:49469` |
| server / tool PID | 25608 / 43636 | 43304 / 28816 |
| cancelled session | `ses_f4486877cffefb7ytHgeFw134e` | `ses_4aa2b07f824715d0e750c48a9465e06d` |
| fresh retry session | `ses_f44862cd7ffewNwhjVmcrM0zTh` | `ses_72a44feecc39efdd726c052fafa2ba74` |
| running tool / durable admission | true / true | true / true |
| stop confirmed | true | true |
| no late write after 17 seconds / idle | true / true | true / true |
| durable inbox after delay | not a v1 API | empty |
| retry persisted status / stopped | completed / true | completed / true |
| cleanup session stop / DELETE | both succeeded | both succeeded |
| owned server stopped | true | true |

The fresh dispatch occurred only after `api.stop` returned, the 17-second wait,
and the no-late-write/idle checks. Both fresh responses were schema-valid:
`{"markerFound":true,"line":"synthetic fresh retry after confirmed stop"}`.
The current adapter's stable-snapshot settlement path was exercised by both stop
and fresh completion. Cleanup performed actual session DELETE requests; these are
successful DELETE receipts, not independent post-delete GET/404 checks. A subsequent
OS process query found none of the four recorded server/tool PIDs still running.

Each new root retains its original `report.json` with both session cleanup receipts,
plus `retry-session.json` with durable admission, actual model, settlement and usage.
These files were read and hashed after cleanup, not replayed or rewritten. The
cancellation harness creates a new root per invocation; the lifecycle harness's
separate append-only `cleanup-receipts.jsonl` replay mechanism remains as documented
above. SHA-256 evidence anchors:

| File (root suffix / filename) | SHA-256 |
|---|---|
| `fJgBCN/report.json` | `612348D223093335217E3BD6CA6456DAEBC2731D60E98AF12C95E493C1BE9ACE` |
| `fJgBCN/retry-session.json` | `E532FF7418B63F19BCF290E6450845B86024FE758D6F6FBC4F8D26106F86B83A` |
| `JDqnse/report.json` | `A1B2130D7DF5C4A1E14BEE2068AAE97C86DA676B2B908436BF7913996A050097` |
| `JDqnse/retry-session.json` | `3525DDDE5B90B4766DBD047974142DB7D36E7A44FDAA730696453754719EC7EC` |

### Separate accounting for these four admissions

| Request | Input / output / cache-read / cache-write tokens | Runtime-reported USD |
|---|---|---:|
| v1 fresh retry | 69 / 48 / 1792 / 0 | 0.00028605 |
| v2 fresh retry | 770 / 42 / 0 / 0 | 0.00053250 |
| known subtotal | 839 / 90 / 1792 / 0 | **0.00081855** |
| both cancelled requests | unknown | **null / unknown** |

The subtotal excludes cancelled usage and is not a verified invoice. Four admissions
are the worker-request count, not a count of provider HTTP requests.

### Exact code identity and remaining scope

The following SHA-256 values matched before and after both live runs:

| File under `_workflow/` | SHA-256 |
|---|---|
| `live-opencode-cancel.mjs` | `B1D2C7435AAD223AD4E8B774E2C7CE1D7E2941F501DAF5436F55B6586373FDAB` |
| `live-opencode-workers.mjs` | `662593AFE6FD3D5AD92A84B7F7CD743035B92585C15E4681D0007EDCAB3C5C0A` |
| `opencode/server-api.mjs` | `7F3ACE19484DA17C294243D23C3790B117D4A63EF37AC083260D6A0EEE79DE60` |
| `opencode/dispatcher.mjs` | `CF2DA3DEABA84EE2F7E0EB1B123188D21105D104C69C61FD6810928F73FEFF77` |
| `opencode/schemas.mjs` | `35459D2F41CB5BC3E99E9F1A79BE69A7AD58E617A923E1BBD282F8BD69E01D19` |

This follow-up changed documentation only. Per the requested no-code-change scope,
regression suites were not rerun. Existing coverage was inspected read-only:
`opencode/_settlement-tests.mjs` covers delayed startup across uncertain restarts,
stale APPROVED-to-CHANGES_REQUIRED reads and v2 queued cancellation;
`opencode/_runtime-tests.mjs` covers completed replay without new admissions and
stale mapping rejection; `live-opencode-lifecycle.test.mjs` covers immutable report
and cleanup-receipt replay. Their earlier test results remain earlier evidence,
not newly executed test results from this continuation.

The live proof is narrowly **already-running tool cancellation followed by settled
fresh completion**. A v1 prompt admitted but never observed starting remains fenced:
abort acknowledgement and idle alone cannot release it or authorize retry/deletion.
The artificial delayed-start and stale-snapshot races remain harness-test coverage;
neither was naturally triggered here. Immediate-cancel probing was not needed and
would not prove safe release of a never-started handler. The earlier nine-worker
lifecycle runs were not repeated, and this result does not revalidate that full
lifecycle on the latest hardening.
