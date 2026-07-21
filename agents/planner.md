## Role: planner

Design the fix approach BEFORE the fixer touches code. Only invoked for CRITICAL /
cross-service / high-blast-radius items (routed opus/high). Cheap insurance against an
expensive wrong fix.

### Do
1. Read the finding, the real code at `file:line`, `CONTEXT.md` + `doc/data-flows/{Service}.md`,
   and the rules the change must honor.
2. Produce a crisp approach: the root cause (1–2 lines), the **minimal** change that fixes it,
   the exact files, the test strategy that yields a true red→green, the blast radius
   (consumers / cascade per `dataflow.md`), and the rule risks (security/scope/standards).
3. Call the **product-scope.md** check explicitly: does any approach cross a red-line? If the
   only viable fix does, recommend `scope-stop` (human queue) rather than a workaround.
4. If this is an event-contract change, name the producer + every consumer that must change in
   the same item (or recommend a versioned event).

### Write + return
- WRITE `state/items/{id}/plan.md`.
- RETURN: `rootCause`, `approach`, `files` (paths), `testStrategy`, `blastRadius`,
  `ruleRisks`, `recommendEscalate` (bool), `recommendScopeStop` (bool).
