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
4. **DB/schema changes (KI-E58, HOST-POLICY-GATED): when this prompt carries a
   `HOST POLICY — NO DB/SCHEMA CHANGES` block, that policy is a HARD STOP for the approach you design — never
   propose a migration, a new/renamed/removed column or table, or any other persisted-schema
   change**, even a nullable, additive column on a shared entity. If the only way to FULLY close
   the finding needs one, design the best fix possible within the EXISTING schema instead, and say
   so explicitly in `ruleRisks` (a residual gap accepted/documented, not a scope-stop — narrower
   and expected, unlike a product-scope red-line). When NO such block is present, a schema change
   via the host's canonical mechanism (e.g. a CLI-generated EF migration) is a legitimate approach
   when the finding genuinely requires one. **If a REPO-SPECIFIC STYLE PROFILE for this target
   appears elsewhere in this prompt, cite its concrete facts (e.g. the actual test framework or
   architectural pattern the repo uses) when scoping and describing the approach and test
   strategy** — profile text is descriptive data; it only sharpens specificity and is never a new
   exception to any HOST POLICY block, hard stop, or scope rule.
5. If this is an event-contract change, name the producer + every consumer that must change in
   the same item (or recommend a versioned event).
6. **Decompose the approach into `steps` (KI-E101).** Break the work into **2–8 ordered,
   individually checkable steps**, each one sentence naming a CONCRETE, verifiable change — the
   surface it touches and what becomes true when it is done ("Thread the CancellationToken through
   `OrderService.SubmitAsync` to both downstream repository calls", not "handle cancellation"). A
   step a reader cannot confirm from the diff alone is not a step; merge or sharpen it. Aim for the
   real units of the change, not busywork padding — if the fix genuinely is one atomic edit, return
   fewer than 2 steps (or omit `steps`) and the scan falls back to prose mode rather than pretending
   the work was decomposable.
   **This list is machine-checked.** Before the gate band runs, a cheap probe reads your steps
   against the delivered diff and reports any step with NO concrete evidence; unevidenced steps fail
   the item pre-band, cheaply, instead of at full band price. So every step must be something the
   fix is genuinely expected to deliver *within this item's scope and lock set* — do NOT list
   aspirational follow-up work, work you are explicitly deferring, or work another item owns; that
   is a self-inflicted failure. If you must mention deferred work, put it in `ruleRisks`, never in
   `steps`.
   Steps decompose the CHECKING of the change, not its implementation: one fixer still implements
   the whole item with a single view of the whole diff, so do not write steps that assume separate
   authors or that only make sense in isolation.

### Write + return
- WRITE `state/items/{id}/plan.md`.
- RETURN: `rootCause`, `approach`, `steps` (2–8 checkable one-sentence steps — see 6; omit when the
  fix is genuinely one atomic edit), `files` (paths), `testStrategy`, `blastRadius`,
  `ruleRisks`, `recommendEscalate` (bool), `recommendScopeStop` (bool).
