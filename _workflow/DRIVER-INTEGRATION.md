# Driver integration contract

## Verification commands

`lib/driver-integration.mjs:verifyTranscript` accepts command-specific expectations:

```js
{
  build: ['Service.sln'],
  filter: [{ target: 'tests/Service.Tests.csproj', filter: 'Regression' }],
  suite: ['Service.sln']
}
```

Each expected invocation must complete; an extra target, wrong command/target pair,
wrong filter, missing invocation, truncated retry or failed command fails closed.
The filter project does not also need a separate build and suite invocation.

For native `finalVerification`, the driver derives FULL build/suite targets from
the claim's solution targets (graph solution fallback). LIGHT builds derive from
the nearest unambiguous `.csproj` owning the graph's source files. Regression
projects derive from `test.json.testFiles`; the exact target/expression is checked
against RED transcript START markers and a recognized `test.json.runCmd` when
present (`build-test.sh filter/red` or `dotnet test --filter`). Paths must resolve
to existing files inside the worktree, including realpath/symlink containment.
The driver never executes the recorded run command. Ambiguous project ownership,
unsupported command-only provenance, and missing RED filter provenance fail closed.

`test.json` and RED evidence remain producer artifacts, not authenticated process
receipts. Project containment and source ownership constrain their claims; semantic
regression coverage still depends on the independent review contract. Final proof
also requires the dedicated hash-named transcript, current content identity and
claim freshness. No new expected-command fields are required on native
`finalVerification` itself.

Native attempt-bound `initialVerification` and `integrationVerification` are also
consumed: filenames/pass IDs must match the driver run/claim reservation, and their
mtimes must follow that reservation. Initial proof uses the same command-specific
expectations; integration requires build+suite for every trusted solution target.
Current proof supersedes historical `verify-raw.txt` / `integrate-raw.txt`.

### Target/test baselines

Failed suites require a structured baseline captured from trusted pre-fix
`baseline-raw.txt` by `lib/baseline.mjs:captureBaseline`. The fold independently
derives it; reported arrays, numeric counts and result JSON cannot grant allowances.
Each invocation's unique `(source,test)` failed set must be a subset of the captured
set for that normalized target. Equal counts with different failing tests, reuse on
another target, incomplete identities and inconsistent baseline retries fail closed.
Missing capture differs from measured zero; either permits only clean current suites.
Legacy transcripts/counts remain readable but authorize no nonzero failures.

Suite wrappers capture TRX and emit `FACTORY::TEST::FAILURE {"source":"Assembly.dll/net8.0",
"test":"Namespace.Type.Method(args)"}` inside the suite START/SUMMARY block, one
identity per failed case. The identity count must match the completion count. Detailed
dotnet `Test run for ...dll (framework)` / `Failed ... [duration]` output also works
when exactly one assembly source is present; interleaved assemblies require explicit
markers. Duplicate detail lines deduplicate; duplicate cases cannot inflate allowance.
Every retry is validated independently. Targets use shared Windows/MSYS alias rules.
Exact framework names and TFMs canonicalize together (`.NETCoreApp,Version=v8.0`
and `net8.0`); framework families, versions and parameterized tests stay distinct.
Malformed or ambiguous TRX fails closed rather than falling back to a count allowance.

The public API and producer contract are in
[`lib/BASELINE-CONTRACT.md`](lib/BASELINE-CONTRACT.md). Recovery and refreshed verification
use the identical baseline comparison, including the existing pre-reFix capture fence.
SWEEP has no implicit failure allowance; its complete-command validation fails closed
on nonzero suites without a trusted structured baseline.

## Recovery evidence

Recovery skeletons do not inherit old initial/integration/final proof pointers or
the old snapshot identity. `recover` reserves a fresh transcript and persists its
expected build/filter/suite contract in the ledger. Generated commands and the fold
read exactly that transcript. They capture full content identity immediately before
and after verification; fold independently recollects the current identity. All
three hashes must agree, and artifact timestamps must bracket verification after
the recovery reservation. Fresh failures cannot be hidden by an older green, and
an obsolete empty file cannot block fresh green. Even unchanged code gets fresh
recovery verification; no historical-proof reuse shortcut is enabled.

Code recovery requires a live worktree, unambiguous affected build targets, existing
test contract and RED filter evidence before preparation. Missing provenance is a
blocking preparation error, not an incomplete green skeleton.

## Affected targets and host paths

`group` persists `item.verificationTargets` and the identical ledger row field,
covering every non-document graph path. Owner-to-solution `cfg.solutions` mappings
take precedence; otherwise discovery searches ancestor directories for an owning
solution before falling back to the nearest unambiguous project. A known primary
solution can disambiguate solutions in its owning directory; it does not replace
a sibling service's owning solution. FULL and integration suites therefore include
the solution's test projects rather than targeting only a nested production project.
LIGHT build ownership is derived separately and may still use that nearest project.
Missing or ambiguous ownership refuses admission before worktree creation. Native's
`native-verification-contract.mjs` consumes these fields through the shared driver's
command-specific expectations; integration builds/suites every target. SWEEP uses
the union of all sites' affected targets.

SWEEP's launch `verificationTargets` is a list: the runner invokes build/filter/suite
on each target, substituting only a nonempty regression expression. This differs from
an ordinary item's solution/test-project layout. The driver checks every target and
requires the returned `runId`; observation records never authorize claim provenance.

Transcript paths use shared `repo-path.mjs:normalizeHostPath`: Windows native drive,
MSYS `/c/...`, slash and case aliases compare as the same path. Filesystem realpath
containment is checked separately; lexical normalization does not authorize symlink
escapes.

Production scheduling passes `repoRoot` through ready selection, dirty-overlap checks,
claim admission, suggestion batches, group and SWEEP. In-repository hardlink and
junction/symlink aliases therefore share locks; optional rootless helper calls retain
lexical behavior for standalone callers. Tests exercise actual hardlinks and directory
aliases through scheduler and driver commands without git mutations.

Launches carry `evidenceInputs: cfg.evidenceInputs || {}` for producers to persist as
identity metadata `inputs`. Recovery writes that metadata itself. Final/recovery fold
requires metadata inputs to match current host configuration and requires the exported
`EVIDENCE_IDENTITY_VERSION` on all supplied and freshly collected identities. The
current version is 3; version-1/2 fingerprints cannot satisfy it. Default discovery
includes ignored build/config/env inputs; nonstandard inputs require explicit host
declaration as specified in `lib/evidence-path-contract.md`.

Launches also carry `buildCapacity`, resolved from `--build-capacity`,
`cfg.concurrency.builds`, `cfg.buildConcurrency`, `cfg.buildCapacity`, then 1. Before
launch preparation, the driver atomically writes `state/build-capacity.json` under its
ledger lock/controller guard. The shared `lib/build-lease.mjs` consumes this file for
all backends; dry preparation does not change it. Item/site `claimAt` is copied from
the reservation's `reservedAt`, including fresh reuse and legacy claim attachment.

When the installed factory is exactly a host-index gitlink, launches also carry
`engineMount: {path, sourceRoot}`. Identity metadata copies this field; the collector
excludes only that mount and binds the actual installed engine revision/source hash
and effective reviewer contract instead. Final/recovery fold checks the metadata
against the trusted mount derived from host index and installed location. Product
gitlinks remain recursively verified. Admission checks their initialization before
claims and in newly created worktrees; failures instruct the owner to initialize the
product submodule recursively in that worktree. The driver performs no initialization.

## Owner edits and shared-worktree GC

Fold and resume only diagnose main-tree drift. They do not call a destructive repair
helper or discard owner changes. GC groups ledger references by canonical physical
worktree path; any unfinished reference protects the entire shared worktree and its
compose resources. After successful eligible removal, every reference is cleared
together. The compatibility `mainguard.repairDirtyDrift` export is diagnostic-only;
it does not restore, clean or otherwise modify files.

`main-check` and fold's unclaimed-drift scan share the same normalized mount
exclusion. `FACTORY_REPO_ROOT` may point to a host outside the engine installation.
Only an engine strictly inside that host both lexically and by realpath gets an
exclusion, using its physical host-relative path. External, root-equal or unresolved
mounts pass `null` (no exclusion); config path rewriting still locates the installed
engine. Product paths retain strict traversal and physical-containment checks.

## Reservation, admission, completion

The driver reserves `{runId, claimId, attemptNumber}` at group/claim/sweep/recover.
It emits `claim_reserved`, an ordinary observational event, not an `item-attempt`.
`attemptNumber` is a candidate ordinal until runtime admission is observed;
unstarted budget deferrals do not consume the observed-attempt ordinal.

Native results/checkpoints carry `admission: {version:1, itemId, runId, claimId,
attemptNumber, status, attempted}`. Only `attempted:true` establishes admission;
`status:'admitted'` alone does not. A claim-matched non-checkpoint physical call is
also sufficient. Admission is observational only and never participates in a fold
verdict. Unknown native execution timestamps remain null, not claim timestamps.

Native requires a successful durable `admission` checkpoint before any semantic
worker dispatch. It records the admission relay itself as attempted work, not a
future semantic call. SWEEP persists one such checkpoint per site before shared
design/apply work. Native also persists post-plan and post-test progress. SWEEP
apply dispatch supplies an exact `IN_PROGRESS`
snapshot for the worker's first tool action. Subsequent verification/review prompts
persist the post-apply frontier. Apply observations have explicit site identities;
shared design, verification and review calls remain shared overhead. These snapshots
record execution progress, never authorize closure.

`resume` and `reconstruct` collect admission from early or final checkpoints without
requiring a recognized presentation `progressStage`. They also read claim-matched
OpenCode durable dispatch session files: admitted/completed mappings establish
admission. Failed mappings also count when a real session plus terminal observation
has invocation/outcome/model/token evidence. Session-creation errors and explicit
`notInvoked` records do not count. Terminal observations are retained. Creating,
sending or uncertain mappings alone do not establish invocation. These commands take the
ledger lock/lease because they persist the observation ordinal. Fold also collects
admission before completing an attempt.

OpenCode `finalize` validates the terminal checkpoint and writes
`{mode:'opencode-adapter', runId, cycle, results:[res]}`. The result carries the driver
run/claim identity, claim-matched admission receipts and validated physical
observations from dispatch mappings. These survive copying the final envelope.
The driver also reads matching local dispatch records when available; immutable
identities prevent duplicate accounting.

Lifecycle IDs are `driver:<claimId>:started|completed`. Only an admitted attempt gets
a completion; its outcome is the final driver state after deterministic checks.
Runtime lifecycle records are not forwarded as competing verdicts. Physical records
use `normalizeAttemptObservations(rows, contextForRaw)`, preserving native started/
terminal supersession and normalized OpenCode dispatches. Incomplete checkpoint
writer calls remain incomplete, not successful or zero-cost calls.

Direct recovery preparation only reserves an identity. To observe manual recovery
execution, include claim-matched `admission` with `attempted:true` on the recovery
result, or supply physical dispatch observations for that run/item. Set it only
after execution actually starts; retain null timestamps when unknown. Recovery
proof and a CLOSED verdict do not themselves establish an observed invocation.
Admission reporting does not relax the mandatory fresh recovery evidence checks.

## Fresh reuse versus replay

Plain `resume` leaves launcher contents and run identity intact for exact Workflow
replay. `resume --reuse` creates a **new** UUID run, claim UUIDs and an incremented
launch cycle, with unique `run-args-reuse-<uuid>.json` and
`run-script-reuse-<uuid>.js` paths. The original launcher bytes remain unchanged.
It includes only still-inflight items and fences prior artifact attachment against
the previous claim/run before reserving the new attempt. The ledger points at the
fresh launch; a stale old result cannot fold against it. Cycle advancement prevents
legacy `<id>#<cycle>` result IDs colliding across fresh executions.

Every newly emitted launcher normalizes CRLF and lone CR source line endings to LF
before replacing the official batch marker. The source file is untouched, metadata
stays first, and literal `$`/escaped CR values in batch JSON survive injection.
`group` (including labels/dry plans), `select`, `claim`'s refreshed select envelope,
SWEEP and `resume --reuse` share this emitter. Plain `resume` preserves even a legacy
CRLF launcher's bytes for exact replay; generate a fresh launch to obtain LF bytes.

## Operational limits

- A native kill or platform failure before the first admission relay persists can
  leave that relay's invocation unknown to the driver. Semantic work waits for its
  successful persistence. The filesystem-free runtime cannot measure an invocation
  lost before any durable record or returned result; it never invents that evidence.
- A portable OpenCode envelope carries the receipts/observations available at
  finalization. An attempt killed before finalization still needs its local durable
  dispatch records for recovery; portability does not prove complete lifetime usage.
- Manual recovery without explicit execution observations remains outside the
  observed attempt cohort, even when its evidence-driven fold succeeds.
- Checkpoints with only reservation evidence stay outside the observed cohort;
  this is incomplete coverage, not proof that no execution occurred.
- Launcher/args/ledger are separate atomic files, not a filesystem transaction.
  A crash between writes can leave an orphan launch; claim matching prevents its
  results from being attributed to another active claim.
- A failed OpenCode session without an invocation receipt, returned outcome, actual
  model or token evidence remains admission-unknown: a terminal failure alone cannot
  distinguish timeout-after-send from a pre-send error.

## Verification

`node --test _workflow/driver-integration.test.mjs` executes the actual driver command
functions under injected filesystem/process boundaries, using temporary fixtures.
No real git mutations or paid agents are invoked.

The CLI fixture runs the installed driver in a child Node process against an external
engine copied with CRLF `factory.js`, exercising generated launcher bytes, fresh reuse
and unchanged legacy replay. Worktree creation is process-injected; `main-check` uses
real read-only Git status on a scratch host and proves dirty owner bytes and the
ledger remain unchanged. Junction fixtures cover lexical/physical mount boundaries.

Driver coverage includes executable recovery failure/current-content checks,
owner-edit preservation, shared-worktree GC, multiple affected services, MSYS paths,
and failed-versus-pre-invocation admission. Shared native-efficiency, core and
observation suites are also run without git mutation.
