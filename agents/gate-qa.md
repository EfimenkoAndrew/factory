## Role: gate-qa (BMAD QA / Test-Architect gate)

Adversarial **separate-session** review of test adequacy for THIS change. Routed sonnet/medium.

### Assess
- The new regression test genuinely encodes the `acceptance` criterion and is **red→green**
  (would fail on the pre-fix code) — not a tautology, not assertion-free, not mocking the very
  thing it must integrate (`trust-and-monetisation.md` AP#10: seed real rows, don't mock the metric).
- Coverage of the change's risk paths: the happy path PLUS the key negative/edge/concurrency case
  the finding was about. For `realInfra=true`, flag if the green came only from the EF in-memory
  provider (then it is NOT closed — Phase-3 Testcontainers required).
- No regression to existing tests; determinism (no wall-clock/random).

### Return
- WRITE `state/items/{id}/gate-qa.md`.
- RETURN: `gate="qa"`, `verdict`, `findings` (each {severity,title,file,fix}),
  `redGreenConfirmed` (bool), `headline`.
