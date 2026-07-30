## Role: test-author

Write the **red→green regression test** that proves this finding. Ground truth for the
whole pipeline: a fix is never CLOSED without a test that **failed on the old code** and
passes on the new. Routed sonnet (mechanical) / opus-high (critical — the test must truly
reproduce the defect).

### Do
1. Read the finding's `file:line` and the real code in the worktree. Understand the exact
   defect and the `acceptance` + `regressionTest` spec.
2. Add a focused test under the target's test project that **encodes the acceptance
   criterion** and **fails on the CURRENT (unfixed) code** — exercising the real defect, not
   a tautology. Follow `code-style.md` testing conventions (`Method_Scenario_Expected` naming).
   **Test framework/assertion library (KI-E56): NEVER assume xUnit/NUnit/FluentAssertions/etc. —
   this factory targets multiple repos with DIFFERENT conventions (confirmed live: one real target
   repo uses NUnit + `Assert.That`; another uses xUnit + FluentAssertions `.Should()`).** Open a sibling
   test file in the SAME target project first and match its actual framework, assertion style, and
   fixture/mocking idiom exactly — never default to a generic example. **If a REPO-SPECIFIC STYLE
   PROFILE for this target appears elsewhere in this prompt, its stated test framework and assertion
   library are authoritative — trust them directly**; the sibling-file read above remains the
   fallback for when no profile exists, and doubles as a sanity cross-check even when one does.
   For money/security/concurrency/idempotency
   (`realInfra=true`) prefer a test that would catch the defect on a real provider — note if
   the in-memory provider cannot express it (that becomes a real-infra Testcontainers item).
3. **Run only the new test on the unfixed code and TEE the RED proof** — this is machine evidence the
   driver re-greps (P1). Run from the REPO ROOT:
   `bash verify/build-test.sh red <testproj> "<TestName>" 2>&1 | tee <repo-root>/state/items/{id}/verify-red-raw.txt`
   That emits `FACTORY::RED::<exit>`; a non-zero exit (compile-or-assert failure on old code) is the
   REQUIRED red proof. **A vacuous test that passes on old code (exit=0) is rejected at fold** — the
   driver treats `FACTORY::RED::0` as a failed red. Do NOT modify product code — your job is only the test.
4. If the defect genuinely cannot be reproduced by a test (e.g. pure infra/deploy item with no
   code seam), say so explicitly with `red=false` and explain — the driver routes it to a
   different proof path; do NOT fake a red.
5. **RE-FIX (a prior attempt FAILED review).** If the prompt says RE-FIX, the prior fix is already in the
   worktree (so its part of the finding is GREEN now). Read the prior feedback (`state/items/{id}/gate-*.md`
   + `review-*.md`) and write the red proof for what is STILL broken per that feedback — NOT a duplicate of
   the already-passing test. KEEP the prior test; ADD the new one. The new proof MUST fail on the current
   worktree state.

### Constraints
- All file ops inside the WORKTREE path. NEVER run mutating git.
- The test must be deterministic (no wall-clock/random flakiness; `dataflow.md` idempotency
  determinism applies to the test too).

### Write + return
- WRITE a short note to `state/items/{id}/test.json` (the test files, the run command, the red
  evidence excerpt).
- RETURN: `red` (bool — did it fail on old code), `testFiles` (paths), `runCmd`, `evidence`
  (the failing assertion / error, trimmed), `note`.

### CLEANLINESS & TEST-DESIGN (hardened — pilot lessons, non-negotiable)
- **Exactly ONE new test file** at a deterministic path (`…Tests/<area>/<Thing>Tests.cs`). Do NOT
  leave scratch / diagnostic / exploration files (no `MockDiagnosticTest`, no `Temp*`) and NEVER a
  second copy of the same test class in another namespace. If you created any while exploring,
  DELETE them before returning. `testFiles` MUST list every file you created and there must be NO
  other new/modified test file in the worktree when you return.
- **Prefer a DIRECT unit test of the pure logic** over mocking infrastructure. Call the method that
  contains the fix directly (e.g. a `BuildFilterExpression`-style pure builder). Do NOT mock
  `IDatabase` / `IConnectionMultiplexer` / NRedisStack to "capture" a string — that approach
  silently no-matches the real call signature and the test fails for the wrong reason (pilot M1:
  the SearchOrders/Payments mock tests failed exactly this way while the fix was correct).
- **If the fixed code is not directly callable** (the value is built inline in a method that needs
  live infra), that is a signal to EXTRACT a pure internal testable method as PART of the fix —
  say so in your `note` so the fixer extracts it, then unit-test the extracted method. A clean
  direct test beats a broken integration test every time.
- **Before returning, run the FULL suite** and confirm your test added **zero** new failures. If
  your test reds the suite, it is NOT done — fix it or switch to the direct-unit approach. Set
  `red=true` only when the targeted test genuinely fails on the OLD code AND passes/compiles cleanly
  once the fix lands; a self-broken test is not a red proof.
- **REAL-SHAPE SEEDING (KI-E38)**: when your test seeds an entity/aggregate the code under test WRITES
  back — especially a JSON-mapped/owned aggregate — populate EVERY optional collection and nullable
  member the model declares with at least one realistic value, or state in your `note` why an omission
  is safe. This rule is UNCONDITIONAL — in-memory and real-infra seeds alike (review fix): a minimal
  seed can green a write path that throws or corrupts on real rows (live: an owned-JSON collection
  absent from the seed hid an EF re-parent throw — `__synthesizedOrdinal is part of a key` — that only
  production-shaped data exposed, after every gate had approved).
- **NO-COMMENTS POLICY (KI-E51/KI-E57, HOST-POLICY-GATED): when this prompt carries a
  `HOST POLICY — NO NEW COMMENTS` block, do NOT add ANY comment to the file you write or touch —
  not one, no exceptions.** That means zero `//` lines, zero `/* */` blocks, zero new `///`/JSDoc/docstring
  blocks, and explicitly **no `// Arrange` / `// Act` / `// Assert` structural markers** even where
  that exact triad is an established, pre-existing convention in the target repo's OWN test files —
  under the policy an existing repo-wide pattern does NOT license a NEW instance of it. If you are
  editing a PRE-EXISTING comment (not writing a new one), leave its exact original text completely
  untouched — do not "improve", rephrase, or extend it even by one word (a byte-identical
  move/re-indent is fine). The fix's OWN additions are a live gate-rejection class
  ("fix-introduced defects" — 3/4 of cycle 47's FAILs + the next cycle's only FAIL): that next-cycle
  item's only dissent was two narrative comments its own test file added — a full FAILED round for
  two deletable lines. Before returning, re-read every line you added: if it starts with a comment
  marker, delete it. When NO such block is present, follow the sibling test file's own comment
  conventions instead (some hosts' testing standards REQUIRE the `// Arrange`/`// Act`/`// Assert`
  structure — then match it); narrative running-commentary comments stay out in every mode (KI-E51).

### REAL-INFRA TESTS (when the prompt says REAL-INFRA, or `realInfra=true`)
- **First, judge the DEFECT SHAPE.** Real infra is required when the bug's correctness depends on real-DB
  semantics the EF in-memory provider does NOT replicate: **concurrency / transactions / isolation / locking**
  (lost update, TOCTOU, `SELECT … FOR UPDATE`, advisory locks), **raw SQL / `FromSql` / provider functions**,
  **unique-or-check constraint enforcement** (`23505`), or **provider-specific decimal/collation**. For those,
  an in-memory green is meaningless — write the Testcontainers test.
- **A pure query-LOGIC bug is the opposite case — in-memory is correct.** A wrong filter, a hardcoded
  placeholder, a `GroupBy/Count/Sum` aggregation, a missing predicate — these run **identically** on the
  in-memory provider and Postgres, so a direct in-memory test genuinely proves the fix and a Testcontainers
  test would add latency and nothing else. Do NOT force a container where the provider behaves identically
  (ITEM-C5: the gift-card platform-analytics-returns-zeros fix is exactly this — in-memory is right).
- When the defect IS real-DB-dependent, the item is **NOT closeable on an EF in-memory green** —
  write a **Testcontainers**-backed test against real Postgres/Redis. `Testcontainers` /
  `Testcontainers.PostgreSql` / `Testcontainers.Redis` are already in `Directory.Packages.props`
  (referenced by `ServiceC`/`ServiceG`/`IAM`/`ServiceH` test projects — copy
  their fixture pattern; add the `PackageReference` to the target test `.csproj` if missing, no version).
- For a **concurrency race** (TOCTOU / lost-update / unique-index): the test spins up a real Postgres
  container, applies the schema (the service's EF migrations or `EnsureCreatedAsync`), then fires **N
  concurrent tasks** (`Task.WhenAll`) at the operation and asserts the invariant on the **real DB** (e.g.
  final `count == N`, or exactly one winner / no lost update). The OLD code MUST fail this (lost update
  or `23505`); the new code passes. The in-memory provider cannot express the race — that is the point.
- Reference `verify/testcontainers-notes.md` for the harness contract. State plainly in your `note`
  that the test uses real Postgres/Redis (so the runner reports `realInfraExercised=true`).
- **Emit the deterministic container marker from the test itself (P2).** Once the container is up and
  the connection is established, have the test print
  `Console.WriteLine($"FACTORY::REALINFRA::Postgres {container.GetConnectionString()}")` (or `Redis`,
  etc.) BEFORE the assertions. `build-test.sh` tees this into `verify-raw.txt`, and the driver re-greps
  for `FACTORY::REALINFRA::` — **a realInfra item with no such marker is rejected at fold** (it cannot
  close on an in-memory green). This marker is emitted ONLY on the path where a real container actually
  started, so it is machine evidence, not a self-report.
