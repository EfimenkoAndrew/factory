# Efficiency improvements: implementation status

Implemented against the findings in [FACTORY-EFFICIENCY-REVIEW.md](FACTORY-EFFICIENCY-REVIEW.md).
That review remains a historical account of revision `65fe8db`, not a description of the
current runtime. No production token-saving percentage is claimed.

## Current evidence — 2026-09-20

| Slice | Established result | Remaining limit |
|---|---|---|
| OpenCode 1.18.31 and official 2.0.10 | Each ran nine real Copilot GPT-5-mini workers through the applicable doc runtime, finalize and actual driver fold **CLOSED**, with unchanged-ledger replay. Current-code running-tool cancellation and fresh retry passed on both versions. | Fixture bootstrap/static identities and temporary ledgers; no production scheduler/worktree admission or human delivery. Artificial delayed-start/interleaved-output races have HTTP regression coverage. |
| OpenCode 2.0.10 FULL code | Seventeen independent workers completed real .NET RED, product fix, build, 6 targeted/7 suite tests, full applicable reviews/refutation/re-audit/integration, and driver fold **CLOSED** with 10 applied/0 rejected. Replay preserved ledger bytes. | Synthetic offline fixture and static fixture identity; integration reused matching machine proof. Successful reported cost 0.16762505, whole 52-call code campaign 0.53732090 including failures, not verified invoices. |
| Claude CLI / Workflow primitives | Existing Claude login, structured workers, file relay and saved-session cached replay passed; separate injected code/doc fixture passed. | Primitive replay is distinct from actual `factory.js` replay/closure. |
| Actual native `factory.js` | Stable fixture E1QjaY completed 22 workers, terminal checkpoint and actual driver fold **CLOSED**: 9 applied, 0 rejected, 0 skipped, 0 overrides. Exact same-session replay cached **22/22**, with 0 worker tokens/tool calls and unchanged journal, ledger and artifacts. Independent audit recomputed all four bound receipts and current identities. | LIGHT doc-only verificationOnly, declared route overrides, archived HEAD product with real dynamic fingerprints and current frozen engine. No native full code/suite or production worktree scheduling claim. Controller replay cost is nonzero; lifecycle+replay reported $2.7208677 list price, not subscription billing. |
| Review benchmark | 6 initial + 12 held-out cases, **11 seeded defects total**; all three adjudicated arms detected the applicable 5/5 and 6/6 defects without misses/false positives. Held-out compact used **14.0% less input / 8.4% less list cost** versus the single original reviewer. | Synthetic same-model review batches, not production accepted-change savings or grounds for gate reduction. |
| Controlled cache TTL | Actual Workflow 5m/1h writes followed by three cache-reading workers per arm. | No expiration or real production stage-gap measurement. |

Sources: [OpenCode lifecycle](_workflow/LIVE-OPENCODE-LIFECYCLE.md),
[full code evidence](_workflow/LIVE-OPENCODE-CODE.md),
[compatibility](_workflow/opencode/COMPATIBILITY.md),
[native closure and replay evidence](_workflow/LIVE-CLAUDE.md), and
[benchmark/TTL reports](_workflow/LIVE-BENCHMARK.md). Earlier failures and unknown
usage remain in those records. V1 lifecycle replay overwrote its original cleanup
array/first-fold output before preservation was fixed; its current report cannot
supply the lost receipts, and the earlier terminal account remains separately dated.

## Delivered

| Review area | Implementation |
|---|---|
| F01–F02: SWEEP closure/scheduling | Shared eligibility/readiness, claim/run provenance, legal/idempotent transitions, completed independent reviews, complete per-target machine proof, fail-closed conformance. Shared-worktree GC protects every unfinished sibling. |
| F03–F06: OpenCode contracts | Registered reachable schemas; positive lint payload validation; independent phase applicability; explicit rejection handling; completed/nonvacuous command evidence; phase-catalog submission tests. |
| F07–F10: recovery | Structured planner control fields; independently corroborated infra overrides; complete source/contract fingerprints and reviewer portfolios; persisted hashes; missing-stage failure classification; fresh recovery-bound proof and unique fresh-relaunch identities. |
| F11–F12: current evidence and dispatch | Serialized editorial writers; independent final mutation barrier; current semantic checks respecting adjudicated alternatives; read-only review/integration identity guards; unique idempotent dispatches and phase locks. |
| F13–F14: prompts/mechanics | Complete compact role briefs, no silent contract slicing, role-selected profiles, stable prefixes, minimal relay prompts, shared deterministic evidence collectors. |
| F15–F17: OpenCode automation | Pending-only descriptors, zero-dependency v1/v2 server dispatcher, fresh independent sessions, actual configured worker routing, launch snapshots, handoff-only integration, separate bounded agent/build capacities. |
| Measurement/calibration | Physical attempts and checkpoint overhead, immutable deduplication, actual admission vs reservation, driver-final outcomes, unknown usage preserved, human acceptance inputs, corrected cohort denominator, offline blinded frozen-snapshot comparisons including failures and mixed cases. |
| Setup/orchestration | Version-aware active instructions/profiles; deny-preserving merges; hash-managed upgrades; nonclaiming dry runs; child lifecycle/valid checkpoint checks; structured results; OpenCode backend. |
| Additional follow-ups | Batch refill, live precedent fallback, configured concurrency, retry classification, phase budget reserves, late-failure stall detection, canonical Windows/MSYS paths, no destructive main repair, complete affected-solution discovery, flake advisory fix. |
| Residual closure | Per-target/test baselines from real TRX results; recursive product submodules and declared ignored inputs; trusted engine-mount fingerprint; physical alias/directory locks; shared native/OpenCode build leases safe under capacity shrink; durable predispatch admission; negative/mixed shadows in both runtimes; nonmutating replacement fixtures; live installed OpenCode v1 checks. |

## Architecture

The implementation shares deterministic evidence, source identity, effective-infra,
path, prompt, persistence and observation contracts. Workflow-compatible pure functions
are inlined with parity checks where the sandbox requires it. Runtime adapters retain
their own execution/state-machine code; behavioral producer-to-consumer tests exercise
the boundaries. This is the incremental contract extraction recommended by the review,
not an untested replacement of both engines with one new reducer.

Relevant operating references:

- [Driver and recovery contracts](_workflow/DRIVER-INTEGRATION.md)
- [Native execution contract](_workflow/lib/native-efficiency-integration.md)
- [OpenCode runtime contract](_workflow/opencode/RUNTIME-CONTRACT.md)
- [OpenCode installation](/opencode-assets/README.md)
- [Orchestrator](/orchestrator/ORCHESTRATOR.md)
- [Measurement and offline experiments](_workflow/CALIBRATION.md)

## Offline verification record

Final validation pass (2026-09-20): the same nonmutating selftest command
passed **1,854 assertions and 22 focused suites**, zero failures; core reported
**145 checks**. All seven nonmutating git groups and 14 shell assertions completed,
including the real offline .NET/TRX fixture. This is offline validation, not a new
provider run. The earlier counts below remain a dated record.

Earlier integrated run (2026-09-19): `node _workflow/lib/_selftest.mjs --no-git-mutations` —
**1,847 passed, 0 failed**, plus **15 passing focused suites** (171 named tests,
zero failures or skips; the core entry point reports 95 checks). All seven formerly
skipped git-fixture groups now execute nonmutating behavioral equivalents and real
read-only checkout coverage. All 14 shell assertions execute through installed Git Bash.
The real offline .NET/TRX fixture passes. File-symlink semantics use injected metadata
with real target bytes where Windows denies creating an actual file symlink; real
hardlink and directory-junction cases execute. Destructive git effects are verified
through process injection, never performed in this session.
`git diff --check` passed.

The nonmutating shared selftest includes pure helpers, mocked native execution,
actual runtime CLI phase submissions, fake-server v1/v2 end-to-end dispatch, settlement
and cancellation, driver recovery/fold/sweep fixtures, path/GC safety, installation,
orchestration and measurement tests. Tests use no paid agents. The nonmutating entry point
now exercises the formerly excluded invariants instead of treating skipped fixtures as
passed coverage.

Independent reviews found and drove fixes for stale recovery evidence, incomplete review
portfolio hashes, queued-input cancellation, uncertain-worker fencing, historical transcript
poisoning, accepted plan deviations, mixed solution/test-project commands, main-tree owner
edits, shared-worktree GC, equivalent path locks, and Windows transcript aliases.

## Host validation and empirical rollout

The [installed OpenCode v1 smoke](_workflow/LIVE-CHECK.md) passed against **1.18.31**:
11 checks, all 10 required endpoint definitions, session creation/identity/idle/abort,
and verified cleanup. No model or tool request was sent. Node, Claude Code, .NET and
Docker are installed and responsive. The real offline .NET test exercises the shipped
TRX producer through Git Bash.

Subsequent real-provider runs established normal existing Copilot and Claude access,
effective fixture worker routes, doc fixture closure on both OpenCode majors and
controlled cache reuse. Missing authentication is not the current blocker.

Remaining empirical work:

1. Exercise production scheduler admission/worktrees and interrupted recovery on a supplied
   host workload. Doc and .NET code fixture execution/fold now pass, but fixture bootstrap
   is not production worktree scheduling. Custom runners must produce completed markers.
2. Capture a stratified production baseline with explicit human acceptance, including failed
   and recovered items in lifetime cost. The 18 synthetic cases do not supply this cohort.
3. Measure cache expiry and reuse across actual stage gaps; both controlled TTL settings
   already have immediate write/read evidence. Production TTL/model/reviewer defaults
   were not changed by these experiments.

## Remaining constraints

- Native Workflow still needs agents for filesystem/shell effects. Added integrity barriers
  and durable preparation can increase fresh-run invocation count; improvements target avoided
  repeated/invalid work. Measure total accepted-change cost before claiming net savings.
- Native semantic workers cannot start before successful durable admission. A platform death
  inside the first persistence relay can still leave that relay's usage unknown; the sandbox
  provides no direct durable I/O or independently attributable per-call billing.
- Identity v3 includes initialized recursive product submodules, relevant ignored build inputs
  and declared custom inputs. The trusted engine mount is fingerprinted from its live source
  and effective contracts. Missing product submodules fail before admission. Point-in-time
  fingerprints do not claim to lock arbitrary filesystem or external/network inputs.
- Shared build leases govern prescribed native and OpenCode wrapper commands and count all
  occupied slots when capacity changes. Arbitrary shell bypass is outside this cooperative
  contract; uncertain sessions/process trees remain fenced rather than silently released.
- Baselines now bind exact failed tests to each target and assembly/framework. Old count-only
  failure allowances are rejected; retained detailed-console baselines normalize to current
  TRX identities. Unsupported/malformed test evidence fails closed.
- Native actual model, per-call billing and timing can remain unknown. Shared output-counter
  deltas are labeled estimates, not precise concurrent per-item billing.
- Both bindings collect optional negative/mixed shadow comparisons on unchanged pre-amend
  snapshots. Shadow data never authorizes closure; promotion still requires independent
  reference truth. OpenCode's declared unported stage set is empty.
- Live provider access and native/OpenCode doc fixture closure are established for the
  versions/routes above, plus OpenCode FULL .NET code closure. These do not establish every
  production provider entitlement, stock/premium route, native code lifecycle, or scheduler
  worktree boundary. The human-accepted production cohort remains unsupplied. Current-code
  running-tool cancellation is live-validated on both OpenCode majors; adversarial
  startup/response races retain non-inference HTTP fixtures.
- The native archive fixture references the owner's Git metadata read-only. Product bytes,
  HEAD and receipt identities remained stable through run/replay, but unrelated later Git
  index-byte changes can invalidate its strict historical snapshot comparison. Preserved
  run/replay evidence is not a claim that shared Git metadata stays immutable forever.
