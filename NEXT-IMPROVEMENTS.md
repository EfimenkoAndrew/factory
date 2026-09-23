# Next factory improvements — latest-main review

## Upstream status

PR #19 is merged. Latest `main` checked through GitHub is
`05f9c1414dea53ba0791a37b9829bf5c11d6c701` (2026-09-20).
Local commit `565e9e5ee9f503afa1e22be3087d348b6d83e778` and that commit have the
same Git tree: `921481d10de4ba9220dcb188306f092928e7511d`.

The factory source was therefore already current at the start of this review.
No source update was required. Local branch history still names the merged PR
branch; no fetch, checkout, reset or other Git mutation was performed.

Three parallel read-only investigations reviewed the current execution contracts,
native runtime economics, and measurement/experiment quality. Findings below refer
to this tree; line numbers can move in later changes. No paid calls were made.

## Priority 1: finish independent evidence validation across both runtimes

### OpenCode loses source identity between finalize and fold

`_workflow/opencode/runtime.mjs:1391–1392` keeps verification identity on
`progress.evidence`; integration identity lives on `progress.integrationEvidence`
at `1496–1497`. Checkpoint and finalize export `progress.res`, without either
record (`1503–1506`, `1531–1541`). Finalize checks the current source, but fold may
happen later. Driver native-receipt/final-transcript checks return without action
when the identifying fields are absent (`lib/driver-integration.mjs:269–279`,
`355–357`, `380–382`).

An in-memory producer → finalize → actual deterministic override → fold reproduction
changed source after finalize and still reached CLOSED with no rejection.

**Fix:** export a versioned OpenCode evidence contract with claim-bound transcript
references/hashes, complete source identity and collector metadata. The driver must
recompute identity and validate proof immediately before forward folding. Bind the
required runtime contract to the trusted claim so deleting a payload field cannot
select a legacy, weaker path.

**Tests:** unchanged control plus post-finalize source, verify-transcript and
integration-transcript mutations. All changed cases must refuse closure.

### Nonfixture leftover checking drops the engine-mount exception

At `runtime.mjs:1432`, `snapshotTree(worktree, contractHash)` omits the inputs,
engine mount and briefs supplied by the normal `contentFor(progress)` path.
With a trusted factory gitlink uninitialized in a fresh product worktree, initial
identity succeeds but the leftover phase treats that engine as a missing product
submodule. A read-only reproduction reached ENOENT before the lint subprocess.

**Fix:** use the same identity function/options at every phase. Test a real-shaped
nonfixture launch with an uninitialized trusted engine gitlink; missing product
gitlinks must still fail closed. Static-identity fixture success does not cover this.

## Priority 2: align artifact consumers with current producers

### Recovery quarantine moves valid evidence away

`lib/telemetry.mjs:73–108` recognizes legacy names, but `nonCanonicalArtifacts()`
classifies these current outputs as debris:

- `verify-initial-*.txt`, `verify-final-*.txt`, `verify-integrate-*.txt`
- `native-evidence-<digest>.json`, `evidence-input-<digest>.json`
- `verification-contract-input.json`, `admission-input.json`

This was reproduced with the actual classifier. `resume --quarantine` moves them
before relaunch (`driver.mjs:1413–1439`), while cached workers need not recreate
them and fold still requires them.

**Fix:** one versioned artifact vocabulary shared by writers, timeline reporting,
recovery and quarantine, with strict dynamic filename validation. Exercise the
actual checkpoint → quarantine → cached continuation → fold chain.

### Count-claim lint still reads only historical transcript names

`lib/countclaims.mjs:99–116` reads `verify-raw.txt` and `integrate-raw.txt`, not
the current attempt-bound native proof. It can flag a correct current count while
accepting an obsolete count supported only by historical evidence. Its untracked
Markdown reader also shells out to `cat` instead of using portable filesystem I/O.

**Fix:** supply explicit trusted current transcript references; never union all
historical runs. Test current-only proof, stale-only proof, and new Markdown files
on Windows. Make missing/unavailable evidence explicit.

### Prevent artifact files from becoming instructions

The retained E1QjaY admission worker created an unrequested item-local `CLAUDE.md`.
Later worker transcripts show it loaded as nested instructions; an editorial report
described content in that artifact rather than the small product file. The genuine
pin and independent fold still passed, so this is review-context contamination—not
proof that closure was fabricated.

**Fix:** constrain mechanical outputs to named artifacts and prevent instruction
files in artifact directories. Assert no unexpected instruction-bearing files are
created during live validation. Prompt prose alone is weaker than enforced tool
output boundaries.

## Priority 3: measure decisions and costs correctly before changing reviewers

- **Preserve verdicts in calibration.** `live-benchmark.mjs:77–90` validates then
  discards `verdict`; opposite verdicts with identical findings normalize identically.
  Retain decision and structured severity, then score false approvals, false blocks
  and inconsistent verdicts separately from finding recall. Existing recall results
  do not establish gate-decision reliability.
- **Separate cost bases.** `lib/observations.mjs:243–304` can combine invoice,
  list-equivalent and synthetic costs of the same currency into a complete-looking
  total. Report measurement completeness separately from billing basis, with
  role/model/runtime breakdowns and nonoverlapping controller/worker totals.
- **Make installation tests reproducible.** The shared selftest requires .NET 8
  and exact packages already in the user's cache (`_offline-dotnet-fixture.mjs`).
  Declare/provision the integration prerequisites and distinguish portable smoke
  from provisioned integration coverage. The installer's E2E failure injection
  also matches an obsolete selftest exit expression (`setup/_e2e.sh:43–44`). Test
  injected nonzero failure directly rather than patching an implementation string.

## Next cost experiments

The strongest measured overhead is native mechanical work: **12 of 22 workers**
in the successful doc fixture were admission/checkpoint/preparation/identity relays.
The whole run took 19.2 minutes and reported $2.5696483 list cost; replay still cost
$0.1512194 in controller work. These are one fixture's measurements, not a native
versus OpenCode comparison.

1. Pre-stage immutable context in Node and send only bounded dynamic state through
   relays. Use digest-checked persistence rather than parse-only JSON checks. Keep
   fold independent. Workflow still cannot directly use filesystem/shell APIs.
2. Evaluate native FULL integration reuse when complete current proof covers every
   required target and source/command/environment contracts match. Always rerun for
   changed or incomplete inputs; LIGHT commonly still needs a full suite.
3. Test one lower-cost reviewer at a time against the current authoritative route
   on frozen real snapshots. Separately test compact context with the model held
   fixed. Measure severity-specific misses, false blocks, retries, tool reads,
   whole-attempt cost and latency. Do not remove gates based on 18 batched synthetic
   cases alone.
4. Compare cache TTLs at actual short, >5-minute and >1-hour reuse gaps. Existing
   experiments prove immediate writes/reads, not expiry or lifecycle break-even.

## Recommended delivery order

1. **OpenCode finalize-to-fold evidence contract + engine-mount consistency.**
2. **Shared artifact vocabulary + current-evidence count lint + instruction-file confinement.**
3. **Verdict-preserving calibration + accounting-basis separation + reproducible install gate.**
4. **Measured relay/integration-reuse improvements, then controlled routing experiments.**

These are findings and proposed changes, not fixes made by this review. Current
source equivalence with upstream is verified; no new production savings are claimed.
