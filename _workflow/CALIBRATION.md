# Attempt telemetry and offline calibration

These interfaces implement measurement and experiments from sections 4 and 8 of
`FACTORY-EFFICIENCY-REVIEW.md`. They are observational: no telemetry value changes
fold evidence, ledger state, routing, reviewer selection or model configuration.
Everything uses Node built-ins. The CLI reads supplied JSON and prints to stdout;
it never launches agents, accesses the network, runs git or writes files.

## Pure driver integration

`lib/observations.mjs` exports:

- `makeObservation(input)`: fills explicitly unknown fields with `null`, validates
  version 1, returns a new record. Throws on malformed fields or unknown keys.
- `validateObservation(record)`: returns errors, never treats missing metrics as zero.
- `observationEvent(record)`: returns an `attempt_observation` event for `emit()`.
- `adaptNativeAttemptObservation(raw, {itemId, itemAttemptId, currency})`: adapts
  the native v1 producer. Its raw `dispatchId` is logical;
  raw `attemptId` uniquely identifies a **physical invocation**, so this adapter uses
  raw `attemptId` as the reporting `dispatchId`. Supply the claim/lifecycle attempt
  ID as `itemAttemptId`; do not use a physical retry ID for a lifecycle attempt.
  Checkpoint calls, including predispatch admission, become shared overhead. Sweep labels require explicit item or
  cluster attribution from the driver; never parse a site identity from `sweep:*`.
- `normalizeAttemptObservations(array, contextForRaw)`: accepts a mixed flat array
  of native raw snapshots and already-normalized OpenCode records. The callback
  supplies native claim/item context only; normalized records retain their original
  immutable IDs, lifecycle IDs and unknowns. Returns `{records,invalid}` rather than
  aborting the whole array on one bad row. It neither infers human acceptance nor
  generates lifecycle records from dispatches. Report/log `invalid` explicitly.
- `aggregateObservations(records, options)` and `renderObservationReport(report)`.
- `deduplicateImmutable(records, keyOf)` excludes all conflicting versions of an
  identity, independent of input order. Exact repeats count once.
- `aggregateFindings(records)` computes canonical finding counts and reviewer overlap.

Every observation requires `version:1`, `kind`, immutable `id`, and `runId`.
Records use `null` for unknown values, not `0`, empty strings or requested-model
fallbacks. Supported kinds:

| Kind | Required identity / interpretation |
|---|---|
| `dispatch` | `dispatchId` identifies one physical invocation, including retry/fallback. Item bucket requires `itemId` and lifecycle `attemptId`. Use `bucket:'shared-overhead'` for unattributed bookkeeping. |
| `item-attempt` | `itemId`, `attemptId`, `attemptNumber` (1-based or null), `phase:'started'|'completed'`. Start and completion are separate immutable IDs. Completion carries the **final driver** outcome and `recovery`. |
| `acceptance` | Explicit human `actor`, `sourceRef`, `recordedAt`, `itemId`, `status:'accepted'|'rejected'|'pending'`, `delivered:true|false|null`. No CLOSED/commit/branch-based acceptance inference. |
| `finding` | `itemId`, `snapshotId`, `role`, `findingId`; independently adjudicated `canonicalFindingId`, `adjudication:'valid'|'false-positive'|'unresolved'`, `independent`, `blind`. |
| `reuse` | `itemId`, `attemptId`, `stage`, `status:'hit'|'miss'`, explicit `reason`, optional `savedCalls`. |

Dispatch observations expose `requestedModel` **and** `actualModel`, effort,
runtime/session/task identity, retry ordinal, fallback, hashes, timestamps, outcome,
input/cache-read/cache-write/output tokens, measured cost/currency/source,
attribution confidence, usage scope, cache source/scope, provider request count,
queue and execution milliseconds. Omitted metadata becomes null. Shared budget
counter deltas must use `usageScope:'shared-counter-delta'` with estimated/unknown
attribution: atomic accounting does not establish causal item attribution.
Model-runtime internal requests/retries are not necessarily observable even when
physical Workflow invocations are counted.

### Exact fold/driver wiring

1. Persist a unique run identity in the launch envelope. Re-folds and reconstruction
   reuse it; distinct launches must not reuse physical dispatch IDs. Persist a
   lifecycle attempt ID and ordinal at actual item admission, including failed,
   killed, recovery and sweep attempts. An unstarted budget-deferred item is not
   an attempted item. Emit `item-attempt` started observations then; emitting only
   on successful fold loses killed attempts.
2. After deterministic fold computes the final state, emit a completed attempt
   observation, with `lateDeterministicFailure:true` when execution completed but
   the fold rejected it. Use immutable IDs such as `claimId + ':completed'` and
   `claimId + ':started'`. Recovery uses its own attempt identity even when the
   ledger's retry-budget `attemptsDelta` is zero. Do the same per sweep site.
3. Adapt `results.attemptObservations` (and reconstructed checkpoint observations)
   before emission. Emit each record separately; the existing telemetry line cap
   will discard an oversized array. Emit physical calls even if a duplicate result
   fold is skipped: immutable IDs make reporting idempotent, and newly recovered
   failed/checkpoint observations still matter. The native checkpoint includes its
   **own invocation as `started`**, while later snapshots/run return carry that
   same physical `attemptId` with terminal outcome. The adapter gives these separate
   immutable event IDs `native:<physicalAttemptId>:started` and
   `native:<physicalAttemptId>:terminal`, retaining one physical `dispatchId`.
   Do not stamp a common `attrs.observationId` over these two events.
   Aggregation reconciles matching starts and terminals independent of input order:
   one physical invocation, terminal metrics only, and a superseded-start count.
   A checkpoint-only start counts as an invoked but **incomplete** dispatch, never
   completed work or final measured cost. Conflicting terminal values or mismatched
   immutable start/terminal metadata remain excluded and visibly conflicted.
4. Wrap normalization **and** emission in best-effort `try/catch`, log malformed
   observations, and continue the evidence-driven fold. No telemetry validation
   error is a close condition or a reason to mutate the ledger.

```js
import { normalizeAttemptObservations, observationEvent, makeObservation }
  from './lib/observations.mjs';

try {
  const rows = [
    ...(results.attemptObservations || []),
    ...(results.results || []).flatMap(r => r.attemptObservations || []),
  ];
  const normalized = normalizeAttemptObservations(rows, observationContextFor);
   // Log normalized.invalid; observationContextFor uses persisted claims, not label guesses.
  for (const record of normalized.records) temit(observationEvent(record));
  temit(observationEvent(makeObservation({
    kind: 'item-attempt', id: claimId + ':completed', runId,
    itemId: r.id, attemptId: claimId, attemptNumber: observedAttemptNumber,
    outcome: finalState, recovery: isRecovery, band: r.band ?? null,
    lateDeterministicFailure: executionState === 'CLOSED' && finalState !== 'CLOSED',
  })));
} catch (error) { /* log observational failure; never alter fold */ }
```

5. Give run usage events `attrs.usageId = runId + ':usage:final'` (or another
   persisted immutable measurement identity). Use stable attrs on re-fold; paths
   to a copied results file are not measurement identity. Keep run totals separate
   from dispatch totals to avoid double counting. `aggregateEvents()` deduplicates
   `usageId`, top-level event `id`, `(item,resultId)` folds, or runId-only final
   usage. Identity-less historical usage is explicitly not deduplicated by filename.
6. `aggregateEvents(events, observationOptions)` now includes `agg.observations`;
   `renderTelemetryReport` renders it automatically. Feed human acceptance as
   explicit observational records; do not add an inferred acceptance transition.

Native raw `error`/`phase`/`overhead` fields are intentionally handled by the adapter,
not accepted verbatim by the strict reporting schema. Native raw timestamps/hashes
remain null when unavailable. The adapter does not import native globals or mutate
the payload. Producer changes must preserve this explicit adapter contract.

OpenCode's `_workflow/opencode/observations.mjs` produces normalized
`dispatchObservation` records. Its dispatcher persists terminal observations and
emits them on completion/replay. Runtime does **not** emit competing lifecycle
events. Pass dispatch arrays unchanged through the normalizer; never substitute
requested model for `actualModel:null`. Mechanical Node steps are not paid calls.

The driver owns lifecycle events through `lib/driver-integration.mjs`:
`admitAttempt` reserves an identity, `claim_reserved` is not an observed attempt,
`observeAdmission` emits the actual start only after execution admission, and
`lifecycleObservation`/`observe` emit the deterministic final fold state. Deferred
reservations do not consume the first observed ordinal. `observePhysical` combines
top-level/per-result arrays, normalizes native records with persisted claim context,
preserves OpenCode dispatch identity, and filters runtime `item-attempt` records.
Use these existing helpers instead of emitting a second lifecycle independently.
Tests exercise them directly with actual native checkpoints and OpenCode dispatch
producer output, including a native CLOSED outcome ultimately FAILED by the driver.

OpenCode persists an invocation receipt only after acknowledgement or matching durable
server input. The driver recognizes that receipt even when execution subsequently fails.
Pre-invocation failures and unresolved sends do not fabricate lifecycle admission.
Portable finalized envelopes retain claim-matched receipts and physical observations.

Native semantic work waits for a durable admission relay; SWEEP persists one per
site before shared semantic work. That relay counts as attempted bookkeeping and
shared overhead. A platform failure or kill before its first successful persistence
can still leave the relay invocation unknown if no result survives. Neither a claim
reservation nor a later projection supplies the missing measurement.

## Cohorts, denominators and coverage

```json
{
  "currency": "USD",
  "cohort": {
    "id": "pilot-2026-09",
    "itemIds": ["ITEM-A", "ITEM-B"],
    "runIds": ["run-1", "run-2"],
    "lifetimeComplete": false
  }
}
```

Item IDs select their full observed lifetime across runs (failed attempts and
recovery included). Run IDs select shared overhead. Select **all participating
items in shared runs**, or explicitly account for allocation before supplying
records; do not claim complete cost for a cherry-picked subset. Never time-slice
away earlier attempts when comparing delivered-change lifetime cost.
`lifetimeComplete` is an explicit data-curator attestation, not inferred from
presence of records. Keep it false for censored, incomplete or partial-run cohorts.

- First-pass rate = first-attempt CLOSED, excluding recovery, divided by every
  item with an observed attempt ordinal 1, including starts with no completion.
  Unknown ordinals are counted separately. Legacy reports use first observed
  fold / all folded items and are labeled a potentially left-censored proxy.
- All-in cost per accepted delivery = **all cohort dispatch cost**, including
  failures, rejected items, recovery and shared overhead / explicit human-accepted
  delivered items. Latest timestamped human decision wins; conflicting simultaneous
  decisions become pending. Human correction minutes and escaped defects are
  separately reported with unknown coverage; no invented labor price is added.
- Full cost is null unless lifetime completeness is attested, every cohort item
  has dispatch coverage, all observed dispatch costs have source/currency and
  direct/shared attribution and terminal outcomes, and no invalid/conflicting record was excluded.
  A known subtotal/accepted is separately labeled partial, never a complete bill.
- Reviewer detections collapse by `(item,snapshot,canonicalFindingId)`.
  Exclusive valid findings have only one detecting role; pair overlap counts
  shared valid canonical findings. False-positive rate excludes unresolved findings.
  Contradictory adjudications become unresolved. Similar prose is never automatically
  assigned the same defect identity. Gate APPROVED rates are not finding validity.
- Reuse hit/miss reasons and saved-call unknowns are explicit. Observed-dispatch
  coverage cannot prove that unrecorded dispatches did not occur.

### Cache bridge

`parseTokenUsageVector()` now returns null for missing/invalid buckets, including
an empty query response. `tokenUsageSummary(usage, provenance)` retains unknowns
and exposes source/scope/selector. Cache ratio is unknown unless all three input
buckets are known. `buildTokenUsageQuery(sinceMs, untilMs, labels={})` supports
escaped exact-match labels; use labels actually present in your metric deployment.
Without labels, scope is `unfiltered-metric-window`, **not** cycle or item.
The driver should pass `{source:'prometheus',scope:'session-window',selector:labels}`
only when those labels genuinely isolate the intended session. Window increases
are Prometheus estimates, may include concurrent unrelated activity, and overlapping
windows cannot be summed. Prompt-cache tokens do not measure Workflow replay reuse.

## Conditional call projections

`projectedCallBreakdown(item, band, conditions)` exposes every counted component.
`projectedCalls` remains numeric; `projectBatch(items, bandOf, conditionsOf)` accepts
optional per-item conditions. `admission` counts the predispatch durable-admission
relay separately. Components expose five later checkpoint writers plus
`postPlanCheckpoint` when planning or `postTestCheckpoint` otherwise: six total on
each representative happy path, or seven including admission. Planning adds three calls (planner + feasibility
+ quality). `initialVerificationPreparation` always contributes one command-relay
call; `integrationPreparation` contributes one only for C# `codeChange`. Neither
preparation is folded into the implementation or checkpoint count.

The **current actual source**, executed with `execSmoke` and deterministic stubs,
produces the following physical invocation counts:

| Source fixture | Calls | Path |
|---|---:|---|
| `light-code` | 26 | LIGHT mechanical C# |
| `light-doc` | 23 | LIGHT mechanical docs |
| `full-code` | 36 | FULL nonmechanical CRITICAL security |

These documentation rows are checked against source execution and `projectedCalls`, not hand-entered
idealized dispatch records. Conditions: policies off, single-clause acceptance,
stable collector hashes, complete successful calls, C# `redCoverage:true`, and
FULL `planCommitment:true` (the planner returns steps). Doc stubs return doc test
and changed-file paths, so a fake C# test does not enable machine probes.
All three have four evidence collectors (post-verify, post-mutation, post-review,
post-integrate); C# RED/rootcause results come from those collectors and cost **no
additional relay calls**. The default no longer double-counts them. Set
`redProofFallback:true` or `rootCauseFallback:true` only when those separate probes
actually execute. `identityCalls` permits explicit collector-count overrides.
Historical 21/17/31 counts in the review describe the earlier source, not today's
pipeline; the collector consolidation and added boundaries changed the composition.
An additional final verification refresh, output preparation, semantic rechecks,
post-final-verify/post-final-scans collectors, real-infra marker, acceptance,
EF, breadth, ledger, comments, shadow, drift and prior-finding probes are conditional.
Set supported flags explicitly; custom review portfolios and mutated paths require
their own measured calibration. C# machine probes differ from generic code review
applicability. A LIGHT C# fixture with two unavailable test-author retries measures
28 physical invocations, including 7 checkpoint writers; cost and actual model
remain unknown rather than being fabricated from that count.
These are fresh-success projections, not unconditional minimums: early failure,
verification-only and reuse cost less; retries and amendments cost more. Never
compare them to old successful-logical-call maps as if units were identical.
The predispatch admission relay adds one invocation to each item path. SWEEP has
one admission relay per site before shared design/apply work; a source-executed
doc SWEEP test checks those calls and their shared-overhead attribution. Item
projections do not estimate an entire SWEEP. Baseline failure counts alone never
authorize failed suites: the baseline API requires captured target/test identities.
The native happy-path runner stub returns a clean suite (zero failed tests).

## Offline frozen-snapshot workflow

### Decision preservation and accounting bases (report v2)

`normalizeResponse` retains `decision:{version:1,rawVerdict,verdict,rule}` and
structured finding `severity`, `file`, `line`, and `rule`. The optional decision
contract accepts historical submissions without it as unknown. Legacy finding
severity is null; no severity or verdict is extracted from prose. The independent
blind packet carries decisions/severity, excludes arm/model/cost metadata, and
replaces portfolio source-role labels with anonymous reviewer numbers. Free-text
finding contents are preserved, not semantically anonymized.

`reviewDecision`, `portfolioDecision`, and `decisionMetrics` are exported from
`lib/review-decisions.mjs`. Portfolio decisions use conservative dissent: any
`CHANGES_REQUIRED` blocks; all known `APPROVED` approves; otherwise unknown. Each
source role's raw verdict remains available in submissions and per-role metrics.
Missing legacy source decisions never become approval.

`reportExperiment(...).arms[id].decisions` separates `falseApprove`, `falseBlock`,
`inconsistent`, `dissent`, `scored`, and `unknown`, with per-case and portfolio-role
details. Inconsistency compares the verdict to its own structured findings;
accuracy compares to independent complete reference truth. The explicit metric
policy is `HIGH-or-CRITICAL-blocks` (`criticalSeverity:["HIGH","CRITICAL"]`). It
does not change production gate policy. Truth rows can optionally supply
`findingSeverities:[{canonicalFindingId,severity}]`; every valid reference finding
must have independently assigned known severity before a nonempty case can be
scored. Complete empty truth supports approval. Review-quality `accepted` never
means the underlying source should be approved. The severity assignments cannot
be copied from candidates or inferred from findings prose.

Observation v1 accepts optional `costBasis`, `costParentDispatchId`,
`costIncludesChildren` and finding `severity`, preserving existing record readers.
`costSource` remains the exact provenance label; `costBasis` is a typed value:
`invoice`, `list-equivalent`, `runtime-reported`, `synthetic`, or `unknown`.
Absent basis is unknown, even when the source label sounds like a bill. Synthetic
fixtures explicitly declare their synthetic basis; they are never invoice proof.

`lib/cost-accounting.mjs` exports `aggregateCosts(rows,{eligible,expected})`.
Consumers must validate and reconcile immutable identities first. The returned
`groups`, `byRole`, `byModel`, `byRuntime`, and `byBucket` always include currency,
basis, source labels, record counts and measured subtotal. `measurementComplete`
describes amount coverage; `basisComplete` requires one known comparable basis and
currency. `complete` requires both. Mixed bases yield null unqualified totals;
legacy unknown amounts remain visible but cannot establish complete billing cost.
Only `invoice` means billed cost. Calibration paired USD deltas are also separated
by basis; unknown or mismatched bases are not compared.

For inclusive controller totals, set `costIncludesChildren:true` on the parent and
`costParentDispatchId` on each covered child in the same run. The aggregator selects
the highest parent once and excludes linked children, including cross-model/role
children. It never subtracts or allocates a synthetic controller-only remainder.
An explicitly shared inclusive counter may supply the parent amount; estimated
deltas remain ineligible. Missing parents, cycles and noninclusive parents prevent
completeness. Without explicit links, dispatch records assert nonoverlapping
charges; arbitrary overlapping external totals cannot be detected. Breakdowns
attribute selected parent totals, not fabricated worker amounts.

`aggregateObservations(...).accounting` and
`reportExperiment(...).arms[id].accounting` expose the same reporting interface.
The observation Markdown renderer includes it; telemetry consumers may use that
existing renderer without altering event or fold semantics.

### Retained experiments: offline reconstruction

```text
node _workflow/live-benchmark.mjs recompute-retained DIRECTORY [NEW_PREFIX]
```

Default prefix: `decision-v2`. The command cross-checks retained finding identities,
roles and text against original raw responses, restores exact verdicts and structured
severity, preserves independent reference truth, projects unmeasured labor/escape
fields to null, and writes new submissions, blind packet, JSON/Markdown report and
cost summary using exclusive creation. Existing files are never overwritten. This
command has no model calls. Per-batch usage is not allocated to individual cases.
CLI `total_cost_usd` is explicitly list-equivalent, not an invoice; auxiliary models
remain in the retained aggregate rather than being guessed as one actual model.

Recomputed the retained `factory-review-benchmark-20260919-a` and
`factory-review-heldout-20260919-a` directories under the OpenCode temporary root.
Each now contains `decision-v2-report.json` / `.md` and companion files. All three
arms retain every verdict. Per arm, independently scoreable cases are 2/6 and 6/12,
respectively (complete empty truth); the other 4 and 6 cases have unknown reference
severity. No false blocks on those scoreable clean cases and no own-finding verdict
inconsistencies were observed. False-approval safety on defective cases remains
unmeasured. Historical recall/quality results and original reports are preserved.

```text
node _workflow/calibrate.mjs freeze input.json
node _workflow/calibrate.mjs validate frozen.json
node _workflow/calibrate.mjs blind frozen.json submissions.json
node _workflow/calibrate.mjs report frozen.json submissions.json adjudications.json
node _workflow/calibrate.mjs report frozen.json submissions.json adjudications.json --json
node _workflow/calibrate.mjs observations observations.json options.json --json
node _workflow/calibrate.mjs prepare-observations _workflow/fixtures/manual-observations.json
```

All outputs go to stdout for the caller to save outside machine-owned evidence.
Input errors produce stderr and exit 1. `--help` documents accepted commands.
`_workflow/fixtures/calibration-synthetic.mjs` supplies executable, fully shaped
fixtures for every input (including approved, rejected and mixed cases).

### Explicit manual acceptance and finding data

The last command above is immediately runnable and validates the shipped synthetic
human acceptance/finding example, printing normalized records to stdout. Replace
fixture identities, actor, decision source/time and adjudication with real explicit
inputs before using it for an actual cohort. `prepare-observations` accepts only
`acceptance`, `finding`, and `reuse`, fills omitted **unknown** fields with null,
and rejects malformed fields/conflicting immutable IDs. It does not append telemetry
or modify ledger/evidence. Ingest the resulting records with
`observationEvent`; for offline use save stdout as `manual.normalized.json`, then:

```text
node _workflow/calibrate.mjs observations manual.normalized.json --json
```

This second command strictly validates complete normalized arrays and reports them.
Acceptance-only input can report one explicit accepted delivery but **unknown**
lifetime cost and zero observed dispatches. It cannot turn acceptance into a fold
verdict or canonicalize findings by guessing from prose. Combine manual records
with producer observations when calculating a complete lifetime cohort.

1. Author `{experimentId,baselineArm,arms,cases}`. Every arm has an ID, complete
   `contract` and explicit `requestedModel` (null permitted). Preserve the recorded
   Sonnet 4.6 mechanical baseline. Each case has case/item ID, `stratum`
   (`documentation|ordinary-code|high-risk`), original outcome
   (`approved|rejected|mixed`), and a snapshot containing `baseRevision`, full text
   `files`, `acceptance`, `policy`, and `reviewerContract`. Windows relative paths
   are supported. Binary inputs are outside v1's text-snapshot contract.
2. Freeze to a versioned SHA-256 manifest. Hashes cover complete embedded content,
   policy, acceptance and contracts without review-pack truncation or timestamps.
   Read-only validation detects changed content/digests; hashes are integrity
   checks, not authentication against someone deliberately reauthoring a manifest.
3. Collect independently produced outputs outside this tool. Submission identity
   is `blindId(manifest,caseId,armId)`; supply the exact `snapshotHash`, status
   (`completed|error|timeout`), actual model or null, measured cost/source/currency
   or null, explicit token/read/format/physical/reused-call counters or null, and
   findings `{findingId,role,text}`. No calls are executed by this CLI.
4. Give the **blind packet only** to an independent adjudicator. It omits arm,
   model, reviewer role, costs and original verdict; it retains anonymized candidate
   findings and full snapshot. The coordinator retains arm mapping. Opaque IDs
   are not cryptographic blinding: reviewers with the manifest can reconstruct
   mappings, and text may reveal authorship. Actual blindness/independence is an
   explicit adjudicator attestation; this tool cannot verify it.
5. Supply `{version:1,experimentDigest,outcomes,findings,truth}`. Every adjudication
   row names `adjudicator` and explicitly sets `blind:true,independent:true`:
   - outcomes: `{blindId,outcome:accepted|rejected|mixed|unresolved,
     escapedDefects:number|null,correctionMinutes:number|null}`;
   - findings: `{blindId,findingId,canonicalFindingId:string|null,
     outcome:valid|false-positive|unresolved}`;
   - truth: `{caseId,complete:boolean,validFindingIds:[...]}`.
   False negatives require complete independently established reference truth and
   fully adjudicated completed submissions. Unknown truth/unresolved findings
   are excluded from false-negative calculations with coverage shown. Empty
   complete truth is a clean case, not an unavailable adjudicator.
6. Inspect the report/JSON. Every arm uses the same frozen cohort denominator;
   missing, failed, rejected and mixed cases remain visible. Paired baseline deltas
   show cost and acceptance only where both outcomes are adjudicated. Offline
   blind acceptance is **not** human-accepted delivered change or lifetime cost.
   The output always sets `automaticChanges:false`; no routing/reviewer update
   is made even if a challenger looks cheaper.

Use a stratified 30–50-item baseline pilot before tuning. That pilot cannot prove
rare-defect safety. For context experiments retain complete baseline briefs and
track cache/input/output, extra reads and format failures. For recovery experiments
freeze both unchanged/changed snapshots around each injected kill boundary and
record physical/reused calls separately. For consolidated scans include rejected
and mixed examples, not just all-approved shadow runs. SWEEP comparisons require
repaired eligibility/evidence contracts and equivalent closure standards.

## Verification

Run `node --test _workflow/observations.test.mjs`. Tests are synthetic, offline,
read-only/in-memory apart from spawning this read-only CLI. No git fixture mutation
or paid agent run occurs. The repository-wide `_selftest.mjs` includes this suite
and uses nonmutating git fixtures with real read-only checkout coverage.

All seven git fixture groups run without mutating git or excluding groups. The
three shell groups cover all 14 behavioral/syntax assertions through the shared
`lib/bash.mjs:resolveBash` execution probe: `OPENCODE_FACTORY_BASH`, Windows Git Bash
locations, then PATH Bash. An unusable candidate falls through; no usable shell is
a failure, not a skipped green. This is separate from physical-path coverage:
Windows-denied file-symlink creation uses injected link metadata/realpath with real
target bytes, while hardlinks and junctions exercise the actual filesystem.

`fixtures/observation-producers.mjs` reads the current native source and invokes the
existing in-memory `execSmoke` stub harness. It captures actual checkpoint JSON
from writer prompts (including their own started calls) and final run arrays, then
tests normalizer → event aggregation → report, in both snapshot orders. It verifies
checkpoint-only incompleteness, full refold deduplication, retries, overhead and
unknown actual model/currency. OpenCode tests invoke its actual dispatch producer
and the driver's authoritative reservation/admission/lifecycle helpers; no OpenCode
server or agent is called. Breakdown assertions compare components with actual
recorded labels/prompts for admission, preparation, post-plan/post-test, collectors, planning
reviews and re-audit lenses, rather than deriving expected calls from projection
constants. The test imports no OpenCode lifecycle compatibility formatter.

Regression coverage uses conditional physical-call projections, first-attempt cohort
denominators, and explicit unknown cache buckets. Historical identity-less observations
remain potentially incomplete or left-censored; they cannot establish a complete bill.

For reproducible, unpaid local OpenCode endpoint checks, see [LIVE-CHECK.md](LIVE-CHECK.md)
and `node _workflow/live-check.mjs --help`. Endpoint capability evidence is separate
from synthetic call-count calibration and measured delivery cost.
For the measured, real-agent six-case synthetic review/context/cache experiment,
see [LIVE-BENCHMARK.md](LIVE-BENCHMARK.md). Its provider usage and independent
blind review judgments are separate from production human delivery acceptance.
The recorded no-model smoke passed on installed OpenCode **1.18.31** on 2026-09-19.
V2 remains HTTP-fake coverage only here, with no installed v2 runtime. Native actual
model/usage and production savings remain unknown until measured in that runtime.
