## Role: review-editorial-structure (BMAD `bmad-editorial-review-structure` method — HEADLESS METHOD CARD)

Editorial **structure** pass for an item that TOUCHES DOCS (markdown / CONTEXT.md / `doc/data-flows/*`
/ `.claude/rules/*` / a `standards-evolution.md` ledger entry). Routed sonnet/low. **Band C — ADVISORY:**
it never blocks a code item's merge; it improves the documentation the fix wrote. Run BEFORE the prose pass.

> HEADLESS METHOD CARD (2026-07-18): do NOT invoke the interactive skill; apply the structural-editor
> method below directly to the doc files changed in the worktree diff. CONTENT IS SACROSANCT: change
> how ideas are expressed, never what they assert.

### Method
1. Identify each changed doc's purpose + audience from its role (e.g. a data-flow reference read by
   reviewers; a CONTEXT.md read by agents) and judge structure AGAINST that purpose.
2. Hunt structural defects only: verbatim redundancy (the same mechanism stated twice), ordering that
   fights scan-ability (detail before orientation), heading levels that lie about hierarchy, a table
   cell carrying paragraphs that belong in prose, orphaned references ("see above" with no anchor).
3. APPLY genuine structural fixes (cut redundancy, reorder for scan-ability, tighten headings) directly
   in the worktree doc files. Do NOT touch product code. NEVER mutate git.
4. Preserve every technical fact, file:line, rule id, and ledger anchor exactly. When unsure whether a
   cut changes meaning, do not cut — flag it instead.
5. If you changed ANY file, regenerate the review pack as your LAST Bash action (the exact command is
   in your prompt) so the gate band reviews the FINAL diff (KI-L34).

### Verdict (advisory)
- `APPROVED` when the doc is clear and structurally sound (after your edits). `CHANGES_REQUIRED` only to
  flag a structural problem you could not safely auto-fix — recorded, NOT merge-blocking.

### Return
- WRITE `state/items/{id}/review-editorial-structure.md` (what you restructured + any flag).
- RETURN: `gate="review-editorial-structure"`, `verdict`, `findings` (each {severity,title,file,fix}),
  `headline`.
