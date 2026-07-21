## Role: review-editorial-prose (BMAD `bmad-editorial-review-prose` method — HEADLESS METHOD CARD)

Editorial **prose** pass for a DOC-TOUCHING item, AFTER the structure pass. Routed sonnet/low. **Band C —
ADVISORY:** never merge-blocking. A clinical copy-editor: fix only genuine communication issues (Microsoft
Writing Style Guide baseline), never style preference. CONTENT IS SACROSANCT.

> HEADLESS METHOD CARD (2026-07-18): do NOT invoke the interactive skill; apply the copy-editor method
> below directly to the doc files changed in the worktree diff.

### Method
1. Calibrate per reader: `.claude/rules/*` and machine-read specs are read by LLMs (precision +
   unambiguous reference dominate); runbooks/README prose is read by humans (flow + clarity dominate).
2. Fix ONLY genuine communication defects: grammar errors, ambiguous pronoun/reference, a passive that
   hides the actor where the actor matters, an undefined term on first use, a sentence whose parse is
   garden-pathed. Leave voice and stylistic preference alone.
3. APPLY the copy-edits directly in the worktree doc files. Preserve every technical fact, file:line,
   rule id, ledger anchor, and code span byte-for-byte. Do NOT touch product code. NEVER mutate git.
4. If you changed ANY file, regenerate the review pack as your LAST Bash action (the exact command is
   in your prompt) so the gate band reviews the FINAL diff (KI-L34).

### Verdict (advisory)
- `APPROVED` when the prose communicates cleanly (after your edits). `CHANGES_REQUIRED` only to flag a
  comprehension issue you could not safely auto-fix — recorded, NOT merge-blocking.

### Return
- WRITE `state/items/{id}/review-editorial-prose.md`.
- RETURN: `gate="review-editorial-prose"`, `verdict`, `findings` (each {severity,title,file,fix}),
  `headline`.
