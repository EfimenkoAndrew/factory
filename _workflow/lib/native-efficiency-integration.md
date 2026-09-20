# Native execution contract

`_workflow/factory.js` runs in the filesystem-free Workflow sandbox. It schedules independent agents and computes lifecycle results; Node helpers perform deterministic filesystem and transcript operations through tool relays. The driver owns claims, ledger writes, recovery preparation, and the final evidence checks at fold. Telemetry is observational and cannot establish a passing verdict.

## Run identity and admission

Every non-dry launch requires a driver-supplied `runId`. Workflow replay retains that ID; a fresh launch or relaunch receives a new one. Item results preserve the supplied `claimId` and `attemptNumber`, including deferred and crashed results. SWEEP carries run identity on the envelope and sweep result, with claim identity on each site.

A claim reservation is distinct from actual execution. `result.admission` and envelope `admissionObservations` use:

```text
version, itemId, runId, claimId, attemptNumber, status, attempted, reason
```

`attempted` becomes true when the admission relay enters the concurrency limiter. Before any semantic worker runs, that relay invokes `native-evidence.mjs --persist-admission` to validate and atomically persist `progress.json`; an unsuccessful relay stops the lane. The record describes the relay already invoked, not a promised semantic invocation. An item stopped by the initial budget guard returns `status:'deferred'`, `attempted:false`, and `reason:'budget-before-start'`. No start timestamp is invented. Driver admission collection reconciles these signals and physical observations with the reserved claim.

Admission and later progress are available through per-item `progress.json`:

- Every item persists `admission` before semantic work; SWEEP does so for each site before shared design/apply work.
- Planned items persist `post-plan`; planner-skipped items persist `post-test` before fixer dispatch.
- A SWEEP apply worker's first requested tool action writes `sweep-apply-started`, including its own started physical observation.
- After SWEEP applies settle, the existing verifier—or architect for doc-only sweeps—writes `sweep-post-apply` snapshots containing apply dispositions and stable dispatch-start observations.

These are `IN_PROGRESS` records. Admission or partial-apply persistence does not authorize closure or reuse of an incomplete apply. Later checkpoints preserve verification and review progress; terminal results retain partial control fields and observations even after an unexpected native exception.

## Prompts and isolation

Native item and SWEEP composition places the common execution contract, host policies, role brief, and role-selected profile before dynamic item context. The pure helpers in `prompt-context.mjs` are inlined byte-identically. Minimal relays use its exact role allowlist; semantic classifiers retain acceptance and profile context. Isolation instructions, telemetry instructions, and structured output contracts remain present.

Source edits and builds belong in the assigned worktree. Artifact writes use the assigned artifact directory. The repository root and peer worktrees are read-only references. Agents do not mutate git, edit the ledger, or delete the owner-controlled stop marker.

## Command-specific verification

Launch input `item.verificationTargets` identifies the complete affected solution/project set. Optional `item.verificationExpected` has this shape:

```js
{
  build: ['ServiceA/ServiceA.sln', 'ServiceB/ServiceB.sln'],
  filter: [{ target: 'ServiceA/Tests/Tests.csproj', filter: 'RegressionClass' }],
  suite: ['ServiceA/ServiceA.sln', 'ServiceB/ServiceB.sln']
}
```

Build/suite targets and regression-filter targets are independent. FULL initial/final verification builds and suites every affected solution and runs the RED-proven owning test projects with explicit filters. LIGHT uses the shared owning-project derivation and its no-full-suite policy. Integration builds and suites every affected target.

`native-verification-contract.mjs` uses the shared driver `verificationExpectations` helper to derive owning projects and RED target/filter provenance. Explicit expectations can widen this set but cannot drop a derived obligation. Missing or conflicting provenance fails preparation.

The existing preparation relay combines contract derivation with fresh output creation:

```text
node _workflow/prepare-verification.mjs <artifactDir> <passId> initial <contractInput.json>
```

Input is `{item, test, worktree, band}`; the CLI supplies the artifact directory to contract derivation. Output is `{written, expected, integrationExpected, baseline}`. The structured baseline is captured from trusted pre-fix raw evidence with the reFix freshness fence. Results expose `verificationContract` and `verificationTargets` for diagnostics. Fold independently derives trusted expectations and baseline rather than treating returned values as authority.

### Fresh transcripts

| Result field | Artifact filename |
|---|---|
| `initialVerification:{transcript,passId}` | `verify-initial-<runId>-<claimId>.txt` |
| `finalVerification:{refreshed,codeChanged,transcript,evidenceHash}` | `verify-final-<evidenceHash>.txt` for refreshed code verification |
| `integrationVerification:{transcript,passId}` | `verify-integrate-<runId>-<claimId>.txt` |

Preparation archives existing same-pass output under a `.prior-N` suffix and creates an empty file. Historical `verify-raw.txt` and `integrate-raw.txt` are not appended to as current proof. Fold checks artifact containment, attempt/hash binding, freshness, expected invocations, and the raw machine evidence.

`completeVerificationTranscript(text, {band, baseline, expected, worktree, required})` checks command completion, nonvacuous test counts, every expected invocation, exact filters, and unexpected or outside targets. Integration uses `required:['build','suite']`. Windows case, separator, and MSYS aliases are normalized through `repo-path.mjs`. An earlier failing or incomplete invocation in the same transcript is not erased by a later green invocation.

Failed suites require the same normalized target and a subset of its captured failed-test identities. The shared shell producer captures TRX, emits explicit failure identities and checks complete result counts; retained single-assembly console identities use canonical framework names/TFMs. Numeric baseline counts never authorize failures. See [`BASELINE-CONTRACT.md`](BASELINE-CONTRACT.md).

### Shared build leases

Native item and SWEEP prompts use `node <factoryRoot>/_workflow/opencode/build-lease.mjs <factoryRoot>` in place of the bare build-test entrypoint. Build, RED, filter, suite and EF commands acquire the same filesystem slots as OpenCode mechanics; generic commands use `<factoryRoot> -- <executable> [args...]`. Capacity is enforced by the wrapper independently of agent concurrency, using the shared driver-published capacity and effective configuration limits. Timeout, signal, unknown completion and orphaned process trees remain fenced. See `../opencode/RUNTIME-CONTRACT.md` for the shared lease API.

## Snapshot identity and final verification

`collectEvidenceIdentity(worktree, metadata)` returns `{version, hash, codeHash, baseRevision, fileCount}` with `EVIDENCE_IDENTITY_VERSION = 3`. Identity includes HEAD, full tracked and non-ignored untracked contents, deletions, modes, symlink targets, recursive initialized product gitlinks, discovered/declared ignored build inputs, acceptance, policies, profiles, effective briefs, model routes, review portfolio, verification obligations, and relevant control fields. Driver-owned `engineMount` binds the trusted live engine revision/source bytes and effective reviewer contract while excluding only its exact product-tree mount. Presentation timestamps and review-pack truncation do not define identity. `codeHash` excludes ordinary `.md` and `.rst`, but includes documents declared/discovered as build inputs; it is only a verification scheduling hint. See `evidence-path-contract.md` for input discovery and containment.

The native collector combines identity, verification transcript checks, RED proof, and root-cause touch evidence. Its relay schema requires current version 3, lowercase 64-digit SHA-256 hash/codeHash, baseRevision/fileCount, verification, integration, RED proof and root-cause fields. The Bash command quotes each argument literally, including apostrophes, spaces and shell metacharacters. The relay must return stdout fields unchanged; malformed output or structured-output exhaustion permits one relay-only retry, never a semantic rerun. Permission/terminal failures stop immediately. Shape validation cannot prove stdout fidelity; independent fold checks remain required. Transient transcript selectors are excluded from content identity. After mutation, an independent runner refreshes verification and the review pack. Prose-only changes rerun acceptance/document checks without repeating the full code suite. Applicable semantic scans rerun against the final snapshot; another identity check rejects a scan that changes inputs. Reviewer or integrator mutations also invalidate the earlier snapshot.

Gate reuse requires a matching canonical identity and exact `reviewPortfolio`, including effective gate/flow keys, roles, applicability, blocking status, and routes. Every required reviewer must have a saved structured approval, or an overruled dissent followed by a completed approved re-gate. Missing portfolio or completion evidence disables reuse. `reviewPackHash` alone is insufficient.

Structured planner checkpoints preserve escalation and steps. Legacy plan prose cannot establish that human sign-off was unnecessary. Accepted plan deviations retain declarations, original gaps, adjudication, and evidence identity. Final checking evaluates the effective alternatives; recurring declared gaps are independently re-adjudicated after mutation, and new gaps do not inherit an earlier waiver.

## Consolidated-scan shadow

With `policies.shadowConsolidatedScan`, eligible non-verification-only reFix items with a plan and applicable acceptance/plan/prior-finding axes receive a read-only pre-amend comparison. Three separate probes and one consolidated challenger judge the same source, pack and feedback without seeing each other's verdicts. Before/after snapshot hashes fence the comparison. Every axis records separate/consolidated booleans or null, plus AGREE/DISAGREE/SKIPPED; negative and mixed outcomes are retained. Changed/unavailable inputs or malformed output produce SKIPPED. Native's authoritative scans still run separately and alone determine amendments or failure. OpenCode implements the same observational axes, with snapshot/contract-fenced reuse of its original probe results. Neither binding claims false-negative performance from these samples; `opencode/stage-parity.mjs` has an empty `UNPORTED` list.

## Infrastructure classification and recovery

`effectiveInfraRequirement(result, originalRequirement)` evaluates the trusted original requirement together with the structured original/effective classification. An override requires complete `OVERRULED` adjudication and matching gate/detail evidence. A test-author override string alone cannot relax the requirement.

Recovery preserves planner, baseline, plan-deviation, and classification control fields, including normalization of the port's `realInfraClassification` spelling. Recovery requires fresh recovery verification rather than carrying an old attempt's transcript binding forward as current proof.

`failure:{kind,stage}` distinguishes unavailable, terminal, malformed, budget, and quality outcomes. Missing-stage recovery ignores the terminal `FAILED` suffix while examining successful progress. An unavailable integrator can qualify; a completed failing integrator cannot. Re-audit recovery selects missing lenses and rejects mixed unavailable/nonconverged outcomes.

## SWEEP contract

Any declared file outside `.md`, `.rst`, or `.txt` makes a SWEEP verification-required. Native consumes the launch's `verificationTranscript` and every `verificationTargets` entry, requesting fresh build, nonempty regression-filter, and suite evidence for each target. Applicable real-infrastructure requirements still require observed container evidence.

Before dispatch, target paths are checked against the assigned worktree prefix. Workflow-local file-overlap decisions use byte-identical `canonicalRepoPath` with an explicit platform: slash and dot-segment aliases overlap, Windows case aliases overlap, and invalid/escaping paths fail closed. Driver admission/scheduling uses root-aware physical identities, including hardlinks and junction parents; fold independently checks containment.

Per-site closure requires claim provenance plus `execution.version:1`, successful completed verification, and completed architect/security reviews. Original verification and review objects are retained. Completed, mapped dissent may affect only particular sites; unavailable or malformed reviews cannot be treated as advisory approval.

## Observations and budgets

The final envelope's `attemptObservations` retains invocation outcomes, including retries, fallback routes, failures, SWEEP applies, and checkpoint writers. Records carry immutable attempt/dispatch identities, requested model/effort, phase, outcome, and overhead classification. Workflow replay can satisfy an invocation from its journal: neither these logical invocation records nor item role-cost counts establish fresh paid execution. Outer Workflow/CLI telemetry must establish actual execution and usage.

All persisted checkpoint observations are stable `outcome:'started'` records, including the writer. Runtime completion/error/timestamp/token fields and result `tokensUsed`/usage are excluded by `nativeCheckpointSnapshot`, inlined byte-identically. This preserves exact prompt/options replay when the shared output counter becomes zero. The final return retains full observations and item `tokensUsed` labeled `shared-completion-delta-estimate`; its usage total is invocation-local, not an all-in interrupted/replayed campaign total. Driver/outer harness owners should persist that returned observational envelope separately, without inserting it into subsequent native prompts. A kill with checkpoint-only recovery leaves terminal dispatch outcomes/usage unknown; do not infer them from lifecycle verdicts or call counts. Native still emits best-effort stage telemetry independently.

Budget guards reserve checkpoint headroom at dispatch admission and inside the concurrency limiter. A phase-budget stop is reported separately from a quality failure. This repair does not disable those guards: it establishes stable completed-prefix prompts when both executions admit the same calls, not replay equivalence across budget stops, changed launch controls, or failed calls. Build capacity is enforced separately by the shared wrapper.

## Known limitations

- **Product submodules:** every product gitlink must be initialized recursively in the execution worktree. Missing/unreadable inputs fail closed; the factory does not initialize them. The trusted live engine mount is the only special case.
- **Pre-persistence admission:** a kill or platform failure before the first admission relay writes can leave that relay invocation unknown. Semantic dispatch waits for durable admission. The sandbox has no direct durable I/O and cannot measure a lost pre-first-write invocation without returned or persisted evidence.
- **Build enforcement boundary:** shared leases enforce wrapper-issued commands. Arbitrary OS commands that bypass the wrapper are not intercepted, and shell/controller termination does not prove child-process termination.
- **Baseline meaning:** matching target/test identities establish pre-existing failing cases, not identical failure causes or equivalent environments. Missing/ambiguous identity evidence fails closed.
- **Relay evidence:** native transcript parsing proves marker completeness and declared target/filter consistency, not an independently captured OS exit. Tool-relay fidelity still matters; fold's independent transcript and claim checks remain authoritative.
- **Snapshot boundaries:** default discovery and declared inputs cover ignored build inputs, but arbitrary dynamic/external dependencies require a host input contract. Point-in-time hashes and physical scheduling locks are not filesystem snapshot locks and cannot detect every transient mutate/revert. Changed test targets after preparation must satisfy the prepared RED-derived contract or fail; runner prose cannot widen it.
- **Usage:** physical invocation counts are not API request counts, billed tokens, or costs. Unknown actual usage remains unknown.

## Verification entry points

```text
node _workflow/lib/native-efficiency_test.mjs
node _workflow/lib/_prompt-selftest.mjs
```

These cover executable native source with mocked agents, source parity, checkpoint/recovery contracts, multi-target verification, transcript failures, durable admission, shadow axes and Windows path handling. Native fixtures use temporary artifacts and read-only repository inspection; they do not invoke real agents or mutate git. Shared physical-path fixtures inject file-symlink metadata/realpath when Windows denies creation, while retaining real target bytes and actual junction coverage. Tests do not establish production billing or runtime-performance results; unavailable native actual model/usage remains unknown.
