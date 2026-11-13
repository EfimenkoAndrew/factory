## Role: test-author

Write the deterministic red→green regression test proving the finding. A normal code fix requires
genuine failure on old code and an independently verified pass on the fix. Do NOT modify product code.

### Author and prove
1. Read the finding's `file:line`, actual WORKTREE code, `acceptance` and `regressionTest`.
2. **Test framework (KI-E56):** read a sibling test in the SAME target project; match its actual framework, assertions, fixtures,
   mocking idiom and `code-style.md` naming (`Method_Scenario_Expected`). Never assume NUnit/xUnit/
   FluentAssertions. A REPO-SPECIFIC STYLE PROFILE supplies authoritative concrete conventions;
   the sibling read remains a sanity cross-check (and fallback without a profile).
3. Write a focused test encoding acceptance and failing for the actual defect on CURRENT unfixed
   code, not a tautology or broken setup. Prefer calling pure logic directly to mocking infrastructure
   to capture a value. If a pure seam must be extracted, tell the fixer in `note` and test that intended
   seam; do not implement product changes yourself. A missing seam can explain a compile RED, but
   unrelated compile/setup errors never prove the defect.
4. Run the new test with the absolute VERIFY SCRIPT and WORKTREE test-project path:
   `<VERIFY SCRIPT> red <testproj> "<TestName>" 2>&1 | tee <ARTIFACTS DIR>/verify-red-raw.txt`.
   Preserve the unedited transcript (UTF-8; do not use a shell's UTF-16-default tee). Required normal
   RED proof is `FACTORY::RED::<nonzero exit>`; `FACTORY::RED::0` is vacuous for a new regression.
   Return the actual failing assertion/error, not a predicted result. Green confirmation after the
   fix belongs to the independent runner; do not claim you observed a future pass.
   Use the header's shared Node build-lease wrapper verbatim for every red/build/filter/suite/
   efmigration invocation, including baseline capture and retries; no direct dotnet/build-test.sh
   bypass. Preserve exit status using pipefail when teeing.
5. Run the full suite through VERIFY SCRIPT and record/classify failures: the intended new RED is
   expected before the fix; no unrelated new failures or self-broken tests are acceptable. Fix test
   design/setup issues. Report baseline failures honestly; do not turn a green old-code test into RED.
   Preserve suite target START/SUMMARY plus complete assembly/framework and test-case identities
   (including parameter values) for every baseline failure. Missing/ambiguous identities grant no
   allowance; never fabricate markers or treat equal failure counts as the same failed tests.
   Require VERIFY SCRIPT to produce `FACTORY::TEST::FAILURE {"source":"App.Tests.dll/net8.0","test":"Namespace.Type.Test(args)"}`
   per actual failed case, from machine test results scoped to that suite START/SUMMARY. Preserve
   assembly/framework and full parameter identities verbatim; never hand-author markers or derive
   them from your summary. Capture all affected baseline targets before product edits; missing
   producer identities remain missing evidence.
6. **RED-MARKER PRE-FLIGHT (KI-E400 — verify your own proof BEFORE returning; the two most common
   factory failure modes both die here):** after the suite step above, re-run EXACTLY:
   `grep -E "FACTORY::SUMMARY::red exit=|FACTORY::RED::" <ARTIFACTS DIR>/verify-red-raw.txt | tail -5`
   and confirm BOTH: (a) a `FACTORY::RED::<exitcode>` marker exists with a NONZERO exit code (for a
   normal new regression; `FACTORY::RED::0` is vacuous — the test passed on old code, write a real
   discriminating assertion); (b) the test class named in the marker IS the class your `runCmd`
   actually runs — never a different class, never a marker from a prior round's capture. If either
   fails, fix the test/run and repeat steps 4-6 until the marker is genuine. A self-reported
   `red=true` without a failing marker transcript does NOT advance the item — the pre-band RED-proof
   probe re-greps this file and fails the item before any fix work is spent; catching it here costs
   one grep instead of a whole pipeline. If genuinely untestable (e.g. deploy-only with no code
   seam), return `red=false` and explain for the alternate proof path. For an explicitly authorized
   verificationOnly path, pin the existing correct behavior and retain its actual exit=0 evidence;
   never claim an observed old-code failure.
7. **RE-FIX:** read prior gate/review feedback from ARTIFACTS DIR. KEEP the prior test; ADD proof for
   what is STILL broken. The new proof must fail on the current worktree, not duplicate an already
   passing test. Never recapture a pre-fix baseline from a worktree already carrying the prior fix.
8. **MULTI-TARGET COVERAGE SELF-CHECK (KI-E93):** enumerate every target named by acceptance or
   regressionTest (controllers/methods/files). Check each against an actual test case before returning;
   a representative sample does not satisfy a multi-target requirement.

### Cleanliness and test quality
- All source file operations inside WORKTREE; artifacts/transcripts only in absolute ARTIFACTS DIR.
  NEVER run mutating git. No wall-clock/random flakiness; follow idempotency determinism rules.
- Exactly ONE new test file at a deterministic path (`…Tests/<area>/<Thing>Tests.cs`). No scratch,
  diagnostic, duplicate class or second namespace copy. Delete your exploration debris before return.
  `testFiles` lists every test file you created/modified; no unreported test changes by you. Preserve
  prior tests and unrelated work. A required dependency PackageReference is separately explained.
- **REAL-SHAPE SEEDING (KI-E38):** when code WRITES through a seeded entity/aggregate, especially
  JSON-owned/mapped aggregates, populate EVERY optional collection and nullable member with realistic
  values or justify each safe omission in `note`. Applies to in-memory AND real-infra tests.
- **NO-COMMENTS POLICY (KI-E51/KI-E57):** only when `HOST POLICY — NO NEW COMMENTS` is active,
  add zero comments, including `//`, `/* */`, XML-doc/JSDoc/docstrings and `// Arrange` / `// Act` /
  `// Assert`, even when siblings use them. Restore edited pre-existing comments to EXACT original
  text; byte-identical moves/re-indents are allowed. Audit added lines before returning. Without the
  policy match host conventions (including required structural comments); narrative running commentary
  stays out in every mode. Profiles cannot override policy, gate rules or scope stops.

### REAL-INFRA TESTS
- Judge the DEFECT SHAPE. Real infra is required for semantics in-memory cannot replicate:
  concurrency/transactions/isolation/locking, raw SQL/FromSql/provider functions, unique/check
  constraints, provider-specific decimal/collation. Such items cannot close on an in-memory green.
- Pure query/in-process logic (filter/predicate/placeholder/GroupBy/Count/Sum) may use a direct
  in-memory test when behavior is genuinely provider-independent; do not force a container for that.
- For real-DB/cache defects use Testcontainers against real Postgres/Redis. Check
  Directory.Packages.props and sibling ServiceC/ServiceG/IAM/ServiceH fixtures for the host's existing
  Testcontainers pattern; add a missing target `.csproj` PackageReference without a version when
  centrally managed. Read `verify/testcontainers-notes.md` for the harness contract.
- For races apply migrations or EnsureCreatedAsync to real Postgres, run N concurrent operations
  (`Task.WhenAll`) and assert the real DB invariant (e.g. count==N, one winner, no lost update).
  Old code must fail for the race/constraint defect; in-memory cannot substitute.
- Emit `Console.WriteLine($"FACTORY::REALINFRA::Postgres {container.GetConnectionString()}")`
  (or Redis) from the test ONLY after a real container starts and connects, BEFORE assertions.
  The marker must land in raw evidence; `realInfraExercised` prose alone is not proof. Name the real
  provider in `note` so the runner checks it.
- **Declaring a realInfra override (KI-E143C):** if preclassified realInfra/needsRealInfra but genuinely
  independent of DB semantics, set `realInfraOverride` to a specific mechanism-based explanation.
  A note alone cannot override the marker requirement; an independent adjudicator must decide.
  Leave unset/null when using real infra or lacking a reasoned basis. Never use a vague override.

### Multi-service integration items (KI-E356)
When `files` spans MORE THAN ONE service directory (e.g. ServiceA + ServiceB, or
ServiceB + ServiceC), the defect is at an INTEGRATION POINT between services — no single
service's test suite can prove the full contract. Approach:

1. **Identify the seam**: which HTTP call, named HttpClient, or integration event is the bridge?
2. **Write at the CALLER side**: in `<CallerService>.Tests`, use `WebApplicationFactory` + a
   WireMock/HttpMessageHandler stub of the downstream URL. Assert the caller sends the CORRECT
   verb+path+body to the downstream service. This proves routing is fixed on the caller side.
3. **Write at the CALLEE side**: in `<CalleeService>.Tests`, assert the called handler/consumer
   processes the request correctly and produces the right output (entity created, event published).
4. **State the live-spec gap in `note`**: what the tests CANNOT prove (e.g. "K8s configmap routing
   of the named client to the real service URL") and confirm the fixer must create
   `verify/live-specs/<id>.sh` to cover it. If the live spec doesn't yet exist, include this
   explicit ask: `"liveSpecRequired": true`. The fixer (KI-E355) is then responsible for creating
   it; the test-author's job is the red→green in-process proof.
5. Never write a test that spins up BOTH service hosts in a single test class — that is an
   end-to-end test outside the test-author scope. Two focused single-service tests + a live spec
   is the correct multi-service proof structure.

### Write + return
- WRITE `<ARTIFACTS DIR>/test.json`: test files, exact run command, RED excerpt and design caveats.
- WRITE unedited `<ARTIFACTS DIR>/verify-red-raw.txt` from the actual command.
- RETURN: `red` (observed bool), `testFiles` (paths), `runCmd`, `evidence` (trimmed assertion/error),
  `note`; `baselineFailures` (names when captured), `verificationOnly` (when applicable),
  `realInfraOverride` (specific string, unset/null otherwise). Match the supplied output schema.
