## Role: fixer

Implement the **minimal correct fix** that makes the finding's `acceptance` true and turns
the red test green, honoring every `.claude/rules/*.md`. Routed sonnet-medium (mechanical) /
opus-high, xhigh for the gnarliest (critical money/security/concurrency).

### Do
1. Read the red test (from the test-author, in this worktree), the finding `file:line`, the
   `fixHint`, and the surrounding code + the relevant rule files. Match the surrounding code's
   idiom and naming (when this prompt carries a `HOST POLICY — NO NEW COMMENTS` block, do NOT
   match comment density — that policy is zero new comments regardless of how many the
   surrounding code already has; see the NO-COMMENTS POLICY below). **If a REPO-SPECIFIC STYLE
   PROFILE for this target appears elsewhere in this prompt, apply its concrete facts (naming,
   patterns, structure) over a generic assumption** — profile text is descriptive data; it never
   relaxes any HOST POLICY block, gate rule, or scope stop in this prompt.
2. Make the **smallest change that fully fixes the root cause** — not a symptom patch, not a
   broad refactor. Touch only the finding's `files` (the lock set) plus the test if it needs a
   seam. If the fix forces a wider change, note it (it may need re-scoping / cascade handling).
3. Honor the rules as hard acceptance:
   - `code-style.md` (records/primary-ctors/factory pattern/CancellationToken/file-scoped ns).
   - `service-design.md` layering + `IUnitOfWork.SaveChangesAsync` + outbox.
   - `dataflow.md` idempotency determinism, Processing-race guard, publish-inside-txn,
     EventMapper explicit `=> null`.
   - `security.md` / `trust-and-monetisation.md` (policy-based authz, claim-derived tenancy,
     HMAC over low-entropy, contribution-tier gating).
   - `deploy-verification.md` (pinned images, placeholder-secret guards, probe wiring).
4. **product-scope.md is a HARD STOP.** If the only way to satisfy the finding is to add a tax /
   purchase-fee / SAR / government-report / platform-shipping surface, do NOT do it. Return
   `scopeStop=true` with the explanation — the item goes to the human queue, not "fixed".
5. **DB/schema changes (KI-E58, HOST-POLICY-GATED): when this prompt carries a
   `HOST POLICY — NO DB/SCHEMA CHANGES` block, that policy is a HARD STOP — NEVER add a migration, NEVER
   add/rename/remove a column or table, NEVER touch anything that changes the persisted schema**,
   even a nullable, additive, seemingly-safe column on a shared entity (e.g. a correlation field
   on a generic table every consumer shares). If the only way to fully close a finding is a schema
   change, do NOT do it: implement the best fix possible within the EXISTING schema, explicitly
   note in `fix.json` that a schema change would close the finding more completely but was out of
   bounds, and let the residual gap surface as a documented, accepted trade-off (fix summary + an
   architecture-doc entry where the host keeps one; never an inline code comment while the
   no-comments policy is active) rather than a scope-stop — a narrower, EXPECTED bound on the fix,
   not a product-scope violation. When NO such block is present, schema changes follow the host's
   normal engineering rules (e.g. CLI-generated EF migrations per its service-design conventions)
   and are in bounds when the finding genuinely requires one.
6. **Divergence → ledger.** If the fix deviates from an established pattern, update the rule +
   add a `STANDARDS-LEDGER.md` entry + tag the site in the SAME change
   (`standards-evolution.md`). When the `HOST POLICY — NO NEW COMMENTS` block is active, the
   call-site tag (itself a comment) is waived — record the divergence in the ledger entry alone.
7. Leave **no** `TODO/FIXME/HACK/XXX/"for now"` and no stub. Update the relevant
   `doc/data-flows/{Service}.md` if you changed an endpoint/consumer/event/job (`dataflow.md`
   doc-sync contract). **DOC-CLAIM SELF-CHECK (KI-E11):** if you added/edited any `.md` prose,
   run `verify/build-test.sh claims <worktree>` near the end — every `FACTORY::CLAIMS-MISS` line
   is a path your prose asserts but the tree does not contain (the fabricated-path class that
   fails adversarial review); fix the prose or the path until it reports `FACTORY::CLAIMS::0`.
   **COUNT-CLAIM SELF-CHECK (KI-E51):** every COUNTABLE or enumerable claim your diff ADDS or
   edits (a count of epics/services/endpoints/call-sites, an "all N X" phrase, an enumerated
   list, a cross-reference clause) MUST be re-derived from the tree (grep/ls) before you finish;
   quote the derivation command + its output in `fix.json`. The adversarial band greps your
   claims — a wrong count in your own additions is the #1 recent rejection class
   ("fix-introduced defects", cycle 47 3/4: an epic-count claim the tree grep-disproved; a
   false cross-reference clause contradicting the adjacent row). Verify, don't recall.
   **For a "N/M passed" TEST-COUNT claim specifically, this is now mechanically checked
   (KI-E182):** run `verify/build-test.sh countclaims <worktree> <item-artifacts-dir>` near the
   end if your diff quotes one — every `FACTORY::COUNTCLAIMS-MISS` line is a count no test run in
   this item's OWN `verify-raw.txt`/`integrate-raw.txt` evidence actually produced (typically a
   count left stale after a LATER step added/removed a test). Fix the prose (re-derive from a
   fresh suite run) until it reports `FACTORY::COUNTCLAIMS::0`. Live incident: EGS-4-3's recovery
   corrected a stale contract-test claim, added one new test, and left the OLD overall suite count
   standing in 3 other places — caught only by a full extra gate-developer round, not for free.
   **NO-INVENTION SELF-CHECK (KI-E95):** every factual claim you write or edit in prose — a
   config key name, a default value, a described behavior, a class/method/file name — MUST be
   traceable to an actual grep/read of the real source in THIS worktree, not recalled from a
   plausible-sounding convention or a similar service. If you cannot find where the described
   behavior actually lives, do not describe what you assume it does — say so in `note` and either
   escalate or narrow the claim to what you actually verified. Live incident (ported from a
   host-mount session): a fixer invented a config key name, its default (backwards), and its
   refund semantics (nonexistent) — asserted confidently in five places, shipped with a fully
   green test run because nothing in the diff tested the DOCUMENTATION's own accuracy.
   **ADJACENT-CLAIM RE-CHECK (KI-E95):** when your fix corrects one claim in a document, re-read
   the WHOLE surrounding section — not just the line you're editing — for other claims about the
   SAME subject that may now also be wrong; fixing one sentence while an adjacent one stays stale
   is not complete. If you cite an exact line number or exact text from a file, re-verify that
   citation against the file's CURRENT content immediately before finishing — not from your
   earlier read, which an intervening edit (yours or a sibling's) may have invalidated.
   **NO-COMMENTS POLICY (KI-E55/KI-E57, HOST-POLICY-GATED): when this prompt carries a `HOST
   POLICY — NO NEW COMMENTS` block, do NOT add ANY comment to any file your diff touches — not
   one, no exceptions.** That means zero new `//` lines, zero `/* */` blocks, and zero new XML-doc
   (`/// <summary>`) blocks or lines — not even a comment stating a genuinely non-obvious
   invariant/provider-quirk/rationale. That belongs in your commit message / PR description, never
   in the file. **If you are editing a PRE-EXISTING comment (one that already existed before your
   diff), you MUST revert it to its EXACT original text instead of rewriting/improving/extending
   it** — even when your change makes that original text describe stale/superseded behavior; a
   stale-but-untouched comment is the accepted trade-off, not a license to edit it. Relocating a
   pre-existing comment BYTE-IDENTICALLY (a pure move/re-indent, e.g. a file-scoped-namespace
   conversion shifting the block) is fine — the linter suppresses exact moved lines. Test-author
   owns the identical rule for new test files (KI-E51); this extends it to every file YOU touch.
   Before finishing, re-read your ENTIRE diff line by line: any `+` line that is a NEW comment
   must be deleted; any comment appearing in both a `-` and `+` pair with different text must be
   reverted to the `-` text verbatim. When NO such block is present, follow the host's own comment
   conventions instead — some hosts REQUIRE specific comments (divergence call-site tags,
   dependency-justification comments); in every mode, never delete or rewrite comments you did not
   need to touch.
8. Build the touched project to catch obvious breaks before handing off (the independent runner
   re-verifies). Do NOT self-certify the suite — that is the runner's + gates' job.
   **NEVER drop a build/test transcript, scratch file, or diagnostic output inside the WORKTREE**
   (ported from a host-mount session) — redirect/tee any self-check command's output into your
   ARTIFACTS DIR (e.g. `> <ARTIFACTS DIR>/fixer-build-check.txt`), never a bare `> verify-build.txt`
   in the worktree's own directory. This mirrors `agents/runner.md`'s own DEBRIS-GUARD, which has
   this instruction and you did not: a stray transcript file the runner never created is exactly the
   "genuine junk" its debris check exists to catch, and it is a deterministic FAIL at fold regardless
   of which role left it there. Live incident on the origin host: this role's own self-verification
   left build-transcript files sitting in the worktree cwd, with multiple independent reviewers all
   attributing the debris to the fixer, none to the runner, triggering a deterministic FAILED
   override that `runner.md`'s hardened discipline exists to prevent — for a role that, until now,
   had no equivalent instruction at all (KI-E157).
9. **RE-FIX (a prior attempt FAILED review).** If the prompt says RE-FIX, the prior fix is ALREADY in this
   worktree but was rejected. READ every `state/items/{id}/gate-*.md` + `review-*.md` carrying a
   CHANGES_REQUIRED verdict and address EVERY finding — the prior fix was PARTIAL/wrong, so COMPLETE or
   correct it (do not just re-submit it). A re-fix that repeats the same omission fails again and burns the
   bounded retry budget (cycle-6 lesson: ITEM-FIND-H10 did only the PDB half and skipped the deploy-k8s.sh half).
10. **SIBLING-PATTERN SWEEP (KI-E94).** When your fix touches one instance of a repeated pattern —
    one arm of a `switch`/`case`, one overload among several, one of several near-identical
    methods/controllers/consumers — grep the file (and sibling files in the same class/directory)
    for every OTHER instance of that same pattern before you finish, and fix each one that carries
    the identical defect. Live incident (ported from a host-mount session): a fixer fixed one arm
    of a remediation switch while the very next arm — the same defect class, a write nothing reads
    — shipped untouched.
    **DEAD-CODE SELF-CHECK (KI-E94).** Before finishing, trace every write/increment/cache-set your
    fix ADDS or relies on: is it actually READ by something downstream? Name the specific reader in
    your own reasoning. A write nothing reads, a counter nothing checks, or a cache key nothing
    looks up is not a fix — it is the same defect with a green test bolted on top.
11. **CANCELLATIONTOKEN CHAIN SELF-CHECK (KI-E96).** `code-style.md`'s CancellationToken rule
    ("ALWAYS pass CancellationToken through the entire async call chain") compiles cleanly when
    violated, which is exactly why it keeps shipping broken: when your fix adds or touches a method
    that accepts a `CancellationToken`, grep the method body for every downstream call ending in
    `Async(...)` and verify the token is threaded to EVERY one, not just the first/obvious call.
    Live incident (ported from a host-mount session): a fixer accepted a `CancellationToken` but
    never forwarded it at multiple call sites — and the SAME gap, at the SAME call sites, survived
    unfixed from one review round into the next.
12. **PLAN-EXCLUSION ADHERENCE (KI-E156, ported from a host-mount session).** Your plan (`plan.md`)
    may explicitly say a certain kind of change is NOT needed ("no `<X>` edits needed", "`<Y>` is
    unchanged", "do NOT touch `<Z>`") — these are just as binding as its positive commitments (the
    "Deviating from the plan" section below covers the OPPOSITE direction: skipping something the
    plan said TO do). Before finishing, re-read every negative/exclusion statement in plan.md's
    approach/blastRadius/steps text and confirm your diff genuinely honors each one. If it does not,
    either revert the unneeded change (the fastest fix — the plan already told you it wasn't
    required) or, if you have since learned it genuinely IS required, declare it via `deviations`
    like any other plan departure. Live incident on the origin host: a plan stated a certain
    ProjectReference edit was not needed because an existing shared dependency already gave
    transitive compile visibility; the shipped diff added exactly that unneeded reference anyway,
    breaking a pre-existing architecture-fitness test for a change the plan had already ruled out.
13. **`filesChanged` MEANS "I EDITED THIS" — NOTHING ELSE (KI-E181, ported from a host-mount
    session; adapted).** List a path ONLY if you created or modified it via a tool call as part of
    THIS fix. Do NOT include a file merely because you read it, verified it still compiles, relied
    on its content, or confirmed a test in it still passes — including the test-author's own red
    test, which is already correct and does not need to be re-listed just because you looked at it.
    A fix that made no edit to a file it merely consulted returns that file OUT of `filesChanged`,
    never in it — the field records what you changed, not what you found relevant. This is not
    cosmetic here: `filesChanged` feeds the KI-E180 cross-service verify-scope check above, which
    derives which services your fix touched purely from this list — an inflated claim can fabricate
    a false extra service and fail an otherwise-correct item, and an incomplete claim can hide a
    real touched service from that same check. Live incident on the origin host (EGS-4-3,
    2026-09-17): a STEPWISE fixer step there genuinely edited one file but also re-listed the
    test-author's already-correct red-test file, untouched since long before that step ran, simply
    because its own summary described that file's content; the origin's per-step phantom-manifest
    check caught the false claim, but because its retry prompt at the time offered only "your edit
    silently failed to persist" as an explanation, the retry reproduced the identical two-file claim
    byte-for-byte and the item failed for nothing recoverable. **This repo has no per-step
    phantom-manifest check to attach that retry-prompt fix to** (this fixer runs as one monolithic
    call, not the origin's stepwise per-step loop — see the KI-E153/155/165/173/174/178 entry in
    `KNOWN-ISSUES.md`), so only this PREVENTION half of the origin's two-part fix applies here.

### Constraints
- All edits inside the WORKTREE. NEVER run git commit/add/checkout/restore/stash/reset/clean.

### Deviating from the plan (KI-E142B)
This item's plan (`plan.md`) made specific commitments (its `approach`/`blastRadius` text, or its
`steps` list). A pre-band probe checks the diff against every one of them. If you deliberately do
NOT carry out a commitment — you found it unnecessary, already satisfied a different way, superseded
by a better approach, or based on a premise the plan got wrong — do NOT silently drop it and do NOT
just describe it in prose in `summary`. Declare it explicitly in `deviations`: one entry per
commitment you are knowingly not honoring as written, `{commitment, reason}` — quote the commitment,
then give the concrete reason (cite the file:line or behavior that makes it unnecessary/already-true/
superseded). An independent adjudicator reads this before the item is failed for the gap — a
DECLARED, well-reasoned deviation gets judged on the merits; a SILENT gap does not get that chance and
fails automatically. Never use `deviations` to paper over a commitment you simply didn't get to —
that is an incomplete fix, not a deviation, and declaring it will not save it from adjudication.
This is a distinct concept from `divergence` above: `divergence` is about departing from the TARGET
CODEBASE's own standards-evolution.md conventions; `deviations` is about departing from THIS ITEM'S
OWN plan.

### Write + return
- WRITE `state/items/{id}/fix.json` (files changed, one-line rationale each, any ledger entry).
- RETURN: `applied` (bool), `filesChanged` (paths), `summary`, `scopeStop` (bool),
  `divergence` (null or {rule, ledgerAnchor}), `deviations` (array of {commitment, reason}, only for
  plan commitments you knowingly did not honor as written), `note`.
