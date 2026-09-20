# Structured suite baseline contract

`baseline.mjs` exports `captureBaseline(text, {worktree, platform} = {})`,
`compareSuiteBaseline(text, target, failed, baseline, options = {})`, and
`baselineTarget(target, options = {})`. `captureBaseline` returns a serializable
`{version:1,status:'captured'|'absent'|'invalid',targets:[{target,failed,passed,failedTests}],reason?}`.
Pass this object as the existing `baseline` argument to `completeCommand`,
`completeVerificationTranscript`, and driver `verifyTranscript`. `completeCommand`
also accepts a sixth options argument `{worktree,platform}`. Do not pass a count.

Capture ONLY from trusted pre-fix `baseline-raw.txt`; retain the reFix capture fence.
Agent-reported `baselineFailures` and old numeric counts are diagnostic-only. Missing
baseline permits clean suites, never failed suites. The fold independently captures
the same object from the trusted raw file; result JSON alone grants no allowance.

Each suite needs its existing START and SUMMARY markers. Failed-test evidence is:

```
FACTORY::TEST::FAILURE {"source":"App.Tests.dll/net8.0","test":"Namespace.Type.Test(args)"}
```

Emit one marker per failed case. `source` must distinguish assemblies/frameworks;
`test` must preserve full test/parameter identity. Markers are scoped by the enclosing
suite START. Repeated identical lines deduplicate but distinct identity count must
equal the suite failed count. No free-form names from agent JSON are accepted.
The parser also supports retained detailed dotnet output: `Test run for ...dll (framework)`
followed by `  Failed Fully.Qualified.Test(args) [duration]`; source is the DLL basename
plus framework. This fallback requires exactly one assembly source. Concurrent or
interleaved assemblies require explicit markers.
If identities are unavailable, nonzero suite failures fail closed.

Retries are checked separately, never unioned into a growing allowance. Baseline
retries for a target must report identical failed sets (otherwise capture is invalid).
Current failed sets must be subsets of that SAME normalized target's baseline.
Use all affected targets in pre-fix baseline capture. Windows/MSYS aliases normalize;
relative targets require `worktree` (or must match relative-to-relative standalone use).

## Machine producer

`verify/build-test.sh` requests TRX output for filter and suite commands in a fresh
temporary results directory. `_workflow/test-results.mjs` validates and aggregates
the result files, emits failed-case markers and a keyed SUMMARY, and preserves the
completed dotnet exit status. The shell removes its temporary results directory.
Detailed filter console output remains available for RED/infrastructure evidence.

`lib/test-results.mjs` checks counters against actual result records, assembly/TFM
identity, execution/definition correspondence, duplicate cases and infrastructure
errors. Missing, malformed, incomplete, ambiguous or exit-inconsistent TRX emits an
unavailable diagnostic and negative counts; an otherwise ordinary exit 0/1 becomes
exit 2. It cannot become baseline-eligible failure evidence. The XML reader is a
bounded TRX subset, not a general XML parser: unsupported structures fail closed.

Framework identity canonicalizes exact .NET framework names and TFMs. Retained
console `.NETCoreApp,Version=v8.0` matches `net8.0` markers, including exact
parameterized names; net8/net9, platform-specific TFMs and framework families remain
distinct. Console text cannot supply missing identities for ambiguous assemblies.

## Consumers and trust boundary

Native verification preparation, OpenCode mechanics, refreshed verification,
recovery and driver fold use the shared structured comparison. Fold independently
reads and decodes the trusted raw baseline. On reFix, capture must predate the
claim; a recapture of already-fixed code is not trusted. Build and regression-filter
failures never use suite baselines. SWEEP has no implicit baseline allowance.

The baseline proves only that the same identified tests already failed for the same
target. It does not prove that today's failure has the same cause or that the
pre-fix environment is equivalent. Completeness, freshness and provenance remain
required; agent prose or a scalar count cannot substitute for them.

Source identity, ignored inputs and engine mounts are specified in
[`evidence-path-contract.md`](evidence-path-contract.md); launch/fold and recovery
binding are specified in [`../DRIVER-INTEGRATION.md`](../DRIVER-INTEGRATION.md).

## Verification entry points

```text
node --test _workflow/lib/baseline.test.mjs _workflow/lib/test-results.test.mjs _workflow/driver-integration.test.mjs
```

Fixtures cover same-count substitution, cross-target reuse, legacy-count rejection,
framework normalization, malformed TRX and reFix fencing. The integrated
`node _workflow/lib/_selftest.mjs` discovers these suites and prepares its offline
dotnet fixture. The standalone TRX suite's real-dotnet case is opt-in via
`FACTORY_TEST_REAL_DOTNET`; synthetic cases do not establish live provider behavior.
