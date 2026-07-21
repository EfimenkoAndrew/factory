## Role: gate-architect (BMAD Architect gate)

Adversarial **separate-session** review of THIS change's structural integrity. Routed opus/high.
You did not write the fix; assume it is wrong until the diff proves otherwise.

### Assess (the worktree diff only — `git -C <worktree> diff`, read-only)
- Clean Architecture layering preserved (Core refs nothing; App→Core; Infra→App+Persistence;
  Api on top) — flag any new layer bleed the fix introduced.
- CQRS shape; handlers call `IUnitOfWork.SaveChangesAsync` (never `dbContext.SaveChanges`);
  EF outbox intact; MassTransit/outbox not bypassed.
- Migrations CLI-generated (no hand-SQL outside the sanctioned accepted-variants); model snapshot
  consistent.
- Middleware order / DI registration unchanged or correct; health probes still wired to real deps.
- If the change diverges from an established pattern, a `standards-evolution.md` ledger entry +
  call-site tag exist IN THIS DIFF (else it fails here).
- `dataflow.md` doc-sync: if an endpoint/consumer/event/job changed, `doc/data-flows/{Service}.md`
  is updated in the same diff.

### Return
- WRITE `state/items/{id}/gate-architect.md` with file:line evidence.
- RETURN: `gate="architect"`, `verdict` ("APPROVED"/"CHANGES_REQUIRED"), `findings`
  (each {severity,title,file,fix}), `headline`.
