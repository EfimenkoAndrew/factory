# OpenCode runtime contracts

## Identity and lifecycle authority

Initialization consumes the driver’s enriched launch envelope and validates its runId, claimId,
attemptNumber, worktree and branch against the active claim. The lifecycle attemptId is claimId.
Only the driver admits lifecycle attempts and records their final folded outcomes. Runtime
checkpoints and physical-dispatch observations do not constitute competing lifecycle verdicts.

Every physical dispatch has a unique dispatchId, prompt/input fingerprints and a fresh server
session. The session mapping binds server URL, API version, worktree, item and lifecycle attempt.
Repeated submission is idempotent only for the identical dispatch/result. Conflicting or stale
submissions fail. The shared atomic JSON writer and per-item lock serialize persistence.

## Admission and portable results

`sending` means a request may have been sent; it does not prove admission. A successful server
acknowledgement or a matching durable user input/inbox record sets `invoked:true`, `admittedAt`,
and an immutable version-1 `admission` receipt. The receipt identifies run, claim, item, dispatch,
session and message, with `attempted:true` and the observed admission time/source.

The receipt survives failed or cancelled execution, including failures with no reported model,
tokens or cost. Pre-invocation failures and uncertain sends without durable evidence have no
receipt. The driver’s `invokedOpenCodeDispatch` collector recognizes `invoked`/`admittedAt`.

Terminal checkpoints attach claim-matched receipts and schema-validated physical observations
from dispatch mappings. Final envelopes carry those fields inside each result, plus runId at
envelope level, so folding a copied envelope does not require the original local session files.
Admission is an attempted-work signal, never proof of successful execution or verification.

## Completion and cancellation

Both APIs require durable final assistant output, settled tool parts and idle execution before
submission. V2 also requires an empty durable inbox. Completed-result replay rechecks settlement
and matching output without another admission request.

Completion reads messages, checks idle (and v2 inbox), re-reads messages and checks
tools/idle/inbox again. Only identical durable snapshots may be evaluated. A change
between reads is pending; the next poll evaluates the new final output. These APIs
do not provide an atomic snapshot/revision lock, so this assumes an exclusively owned
single-input session and the runtime's idle/terminal contract.

V1 uses documented session/status, message, prompt_async and abort endpoints. V2 uses the separate
`/api/` surface. V2 cancellation first deletes the dispatch’s inbox item, then interrupts with
`resume=false`, then reconciles inbox, messages/tools and active execution. Interrupt acknowledgement
alone does not prove termination. Any potentially-live unresolved state remains fenced across
restart; no retry or replacement worker is admitted until stopping is proven.

V1 `prompt_async` returns 204 after forking the prompt handler, not after runner
registration. Neither that response, abort=true nor any number of idle polls proves
the handler has passed startup. Before abort, stop therefore requires the matching
nonempty durable user prompt and either currently observed busy execution or its
matching terminal assistant record. Header-only, absent-after-send and nonempty-
but-not-started input stay uncertain and must not be deleted or retried. The sole
empty-session exception is local knowledge that this adapter created the session
and has never attempted send; it does not survive restart. V2 uses its durable
inbox cancellation contract instead. Cleanup preserves unresolved owner identities.

## Prompts, routes and capacities

Runtime composes each phase with `{outputSchema, handoffOnly}` and authoritative snapshotted
briefs, profiles and policies. Installed `factory-{writer|reviewer|probe}-{tier}` definitions
determine effective routes, including host model overrides. Missing definitions fail explicitly.
Read-only workers return structured results; the controller persists their role artifacts.
Integration is handoff-only over unchanged independent machine evidence.

Agent concurrency is bounded across the complete persisted batch. Build commands use the shared
build-lease wrapper. Timed-out or orphaned build slots remain fenced for process-tree inspection;
the death of the shell/controller alone cannot prove its child processes stopped. The wrapper
contract does not intercept arbitrary shell commands issued outside this runtime.

## Shared evidence contracts

- `lib/evidence-identity.mjs` uses version 3 and hashes full tracked/nonignored untracked contents and contracts, recursively
  binding initialized product gitlinks and default-discovered ignored build inputs. The runtime additionally binds
  code-only reuse to frozen contract identity. `config.evidenceInputs` passes the shared explicit
  input contract (`includePaths`, `includeGlobs`, exclusions and `discoverDefaults`) unchanged.
  Unreadable/unprovable nested repositories or input paths fail closed.
  Driver-supplied `launch.engineMount` (`path`, absolute `sourceRoot`) is passed to the collector
  with the effective brief snapshot. The collector binds live engine sources/version/revision
  independently of the product tree; the runtime does not infer an engine exclusion from a path.
- `lib/stage-evidence.mjs:completeCommand` validates invocation completion, markers, target/filter,
  nonvacuous test counts and structured per-target/per-test suite baselines. The shell producer
  captures TRX and emits validated case identities; retained console framework names and TFMs
  canonicalize together. Numeric allowances cannot authorize failures. See
  [`../lib/BASELINE-CONTRACT.md`](../lib/BASELINE-CONTRACT.md).
- `lib/effective-infra.mjs:effectiveInfraRequirement` validates versioned `infraClassification`
  against the trusted original requirement and matching independent adjudication details.
- `lib/observations.mjs` validates physical observations. Unknown actual model, tokens and cost
  remain null. Admission receipts never fabricate usage or provider requests.

Editorial writes are serialized. Source mutations invalidate dependent evidence and reviews.
Final verification refreshes the evidence and review pack; prose-only changes may reuse complete
unchanged code evidence. Required prior feedback, RED coverage, EF, cross-target verification and
the registered semantic stages cannot disappear through a missing optional response field.
The policy-gated consolidated-scan shadow runs before pre-band amendments on eligible items
(all three axes applicable). Four independent read-only sessions grade the same worktree,
pack, acceptance, plan and prior feedback: three original probes and one consolidated challenger.
Original prompts are shared with the normal scan phases. Completed original results feed those
phases without redispatch only while the complete snapshot and exact probe contract still match.
Any writer call, including a note-only amendment, invalidates this reuse. The source identity,
pack and feedback are checked again after all four workers settle; changed/unavailable inputs
produce SKIPPED comparisons and cannot authorize original-result reuse.
Negative and mixed controls are retained, not selected away. `shadow-scan-input.json` and
`shadow-scan.json` bind snapshot/claim identities and carry every axis, including null/SKIPPED
for unavailable output. The consolidated verdict never changes the lifecycle disposition; the
original results retain their usual authority. A possibly-live shadow session retains the same
settlement fence as any worker. These comparisons are calibration data, not proof of production
false-negative performance. `UNPORTED` is empty.

## Shared build API

`lib/build-lease.mjs` exports synchronous `withBuildSlot(root, fn, timeoutMs)`,
`leasedCommand(root, executable, argv, spawnOptions)` and `buildCapacity(root, requested?)`.
`opencode/build-lease.mjs` reexports them and retains `limitedBuildTest` and the existing
`<factoryRoot> <build-test-subcommand> [args]` CLI used by native prompts and OpenCode.
Generic executable/argv execution is also available:

```text
node _workflow/opencode/build-lease.mjs <factoryRoot> -- <executable> [args...]
```

Arguments are passed directly without a shell; invoke `bash`/`pwsh` explicitly when needed.
The exit status is preserved. Capacity is the minimum of all declared limits: shared
`state/build-capacity.json` (`limit`), effective factory local/base config (`concurrency.builds`,
or `buildConcurrency`), legacy `state/opencode-build-capacity.json`, and an optional request.
Without any declaration it defaults to one. The dispatcher writes only the shared capacity
file; a conflicting legacy file cannot relax another limit. Both runtimes use the historical
`state/opencode-build-slots` directory to preserve existing fences. Change capacity only while
drained. Timeout/signal/unknown completion retains the lease; executable-not-found/access-denied
before spawning releases it. Async callbacks are rejected and fenced.
Admission is serialized by a same-filesystem directory mutex. Each wait rereads capacity and
counts every numeric slot, including slots above a newly lowered limit. Existing work drains;
shrink never admits additional work while occupancy reaches/exceeds the new limit. Owner records
identify active/uncertain leases. Dead lease owners remain fenced. Only the brief admission mutex
can recover after a proven-dead PID, by removing its unique owner token and empty directory;
missing/malformed ownership is never cleared by age or timeout. Admission does not rewrite config.

## Regression coverage

`node _workflow/opencode/_selftest.mjs` includes actual CLI phase submissions, role artifacts,
positive lints, final mutation barriers, local HTTP-fake v1/v2 dispatch, settlement/cancellation,
durable replay, observation validation and process-level build concurrency fixtures.
`_phase-catalog-tests.mjs` covers every result-consuming agent phase. `stage-parity.mjs` is checked
against the native source to detect undeclared, stale or missing stages. No paid worker calls or
git mutations are required by these tests.

Local no-model capability smoke passed on installed OpenCode **1.18.31** on
2026-09-19, including empty-session lifecycle and owned-resource cleanup. Official portable
v2.0.10 also passed effective profile routing and durable no-model admission/cancellation;
see `COMPATIBILITY.md`. See `../LIVE-CHECK.md` for the v1 command and evidence limits.
Neither these no-model checks nor the synthetic
fixtures measures native Workflow actual model/usage or production billing.

The separate opt-in [`../LIVE-OPENCODE-WORKERS.md`](../LIVE-OPENCODE-WORKERS.md)
records real 1.18.31 GPT-5-mini writer/reviewer dispatch, tool execution, local
schema validation, durable completion/replay and exact owned-resource cleanup.
It also records the live header-before-text race fixed in `server-api.mjs` and
the installed runtime's rejected server-format experiment. This is a bounded
synthetic worker slice, not a driver claim/fold or v2 inference validation.

Follow-up [`../LIVE-OPENCODE-LIFECYCLE.md`](../LIVE-OPENCODE-LIFECYCLE.md) records
the actual v1 doc verificationOnly runtime → checkpoint → finalize → driver fold
CLOSED and unchanged-ledger replay. Bootstrap uses `--fixture` and isolated driver
init, not scheduler/group admission or production full-content identity. It also
records real v1 1.18.31 and v2 2.0.10 authenticated running-tool cancellation,
no delayed write after 17 seconds, and fresh schema-valid retry. Its subsequent
v2 nine-worker doc lifecycle finalized/folded CLOSED in 201 seconds with unchanged
ledger replay, plus missing-model timeout/settlement and explicit valid fallback.
These supersede earlier untested statements for those specific exercised paths;
production scheduling/full-content admission remains a separate scope.
