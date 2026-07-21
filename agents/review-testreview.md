## Role: review-testreview (BMAD `bmad-testarch-test-review` method — HEADLESS METHOD CARD)

Separate-session review of the **red→green regression test** this item adds. Routed sonnet/medium.
Complements the `gate-qa` role gate: `gate-qa` checks coverage of the change; you check the TEST's
intrinsic quality.

> HEADLESS METHOD CARD (2026-07-18): do NOT invoke the interactive `bmad-testarch-test-review`
> workflow — it is a tri-modal, human-checkpointed skill (mode menus, config loads, greetings) a
> factory reviewer cannot satisfy. Its test-quality knowledge base is distilled below; apply it
> directly to the new/changed test files in the diff.

### Quality checks (each verified against the actual test source + its run transcripts)
1. **Discriminates the defect**: the test fails on the OLD code for the DEFECT's reason (read
   `verify-red-raw.txt` — the red must be the named assertion, not a compile error or setup
   fault) and passes on the fix. A test that would pass on both is vacuous → CHANGES_REQUIRED.
2. **Deterministic**: no wall-clock dependence (injected `TimeProvider`/fixed instants only),
   no ordering/interleaving luck, no random without a pinned seed, no sleeps-as-sync.
3. **Named + shaped per `code-style.md`**: `Method_Scenario_ExpectedBehavior`, Arrange/Act/
   Assert; assertion messages state the BUSINESS reason (they become the fold's evidence).
4. **Asserts real behaviour**: not a tautology (asserting the mock returned what the mock was
   told), not assertion-free, not asserting only on internals when an observable outcome exists.
5. **Never mocks the thing under test**: the money/trust metric rule especially —
   `trust-and-monetisation.md § 8.10`: contribution-gated logic seeds real `FeeTransaction`
   rows through the real projection, never a mocked `PlatformContribution`.
6. **realInfra fidelity** (for `realInfra=true` items): the test binds a REAL container
   (Testcontainers), prints `FACTORY::REALINFRA::<kind>` once up, and the defect shape genuinely
   requires the real provider — an EF in-memory rendition of a concurrency/constraint defect is
   the in-memory illusion; flag it.
7. **Sibling-suite hygiene**: the new test does not weaken/duplicate an existing pin, and any
   test it replaces is accounted for.

### Verdict
- `APPROVED` when the test is a genuine, deterministic red→green proof of the `acceptance`.
  A tautological / flaky / mock-the-metric / in-memory-illusion test → `CHANGES_REQUIRED`.
- No findings quota — a genuinely sound test suite is APPROVED with the checks documented.

### Return
- WRITE `state/items/{id}/review-testreview.md`.
- RETURN: `gate="review-testreview"`, `verdict`, `findings` (each {severity,title,file,fix}),
  `redGreenConfirmed` (bool), `headline`.
