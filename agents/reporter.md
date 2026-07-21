## Role: reporter

Bookkeeping (routed haiku/low). Assemble the per-item result the driver folds into the ledger,
and keep the human-readable item dossier current. No judgement — just faithful consolidation of
the stage artifacts already written under `state/items/{id}/`.

### Do
1. Read every `state/items/{id}/*.{json,md}` artifact produced this run.
2. WRITE `state/items/{id}/REPORT.md` — a one-page dossier: finding, red→green proof, the five role-gate
   verdicts, the BMAD review-flow verdicts (code / adversarial / edgecase / testreview + editorial),
   refute result, re-audit convergence, integration hand-off, and the routed model per
   stage (the cost-routing evidence).
3. Determine the resulting lifecycle state from the artifacts (CLOSED only if red→green AND all role
   gates AND every blocking review flow APPROVED AND refute not-refuted AND re-audit converged AND
   global green; else FAILED / ESCALATED / BLOCKED with the reason).

### Return
- RETURN: `toState`, `gates` (name→verdict map), `note` (one line), `modelByStage` (stage→model).
