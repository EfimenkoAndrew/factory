# Factory effectiveness and token-efficiency review

Date: 2026-09-19 · Reviewed revision: `65fe8db5c70b1da49247be496027ac1ac62f1da7`

## Executive conclusion

**Improve cost per accepted change by preventing wasted work first, then reducing orchestration/context overhead, then tuning the review portfolio.** Choosing cheaper models or deleting reviewers now would optimize around incomplete measurements and several broken execution contracts.

The strongest parts of the factory are worth preserving: independent implementation/review contexts, deterministic fold checks, the single-writer ledger, worktree isolation, early evidence checks, bounded amendments, LIGHT/FULL selection, and root-cause batching. The main weakness is that these mechanisms have accumulated as partially duplicated implementations and prompt additions. Their individual tests frequently pass while their producer-to-consumer contracts disagree.

Recommended sequence:

1. Repair false-green paths, stranded phases, and recovery control-field loss.
2. Deliver complete, compact role instructions and verify the final mutated snapshot.
3. Make recovery reuse functional and measure actual attempts and overhead.
4. Automate OpenCode dispatch and consolidate deterministic Claude relays.
5. Share lifecycle contracts across bindings; calibrate review/model reductions experimentally.

## Investigation and evidence limits

Four parallel research agents investigated native Workflow, OpenCode, scheduling/telemetry, and official platform documentation. A fifth independently challenged the highest-impact sweep, prompt, recovery, and fold findings.

Validation included exact-source in-memory Workflow execution with mocked agents, pure helper reproductions, source tracing, and `node _workflow/opencode/_selftest.mjs`: **197 passed, 0 failed**. Mocked executions made no paid agent requests. The full library selftest was not run: its fixture setup invokes mutating git, contrary to this session's repository instructions. Runtime implementation was not changed by this review.

This checkout has no usable production cost/outcome cohort: no populated ledger/findings graph or item results; the local event stream contained only driver-command events. Therefore:

- Call counts below are synthetic execution counts, not billed tokens.
- Character sizes are payload estimates, not tokenizer measurements.
- Historical multipliers in `EFFECTIVENESS.md` and the KI registry were not independently reproduced here.
- Platform documentation was checked on the review date; compatibility findings are conditional on the installed runtime version.

## 1. Correctness defects that directly undermine efficiency

### F01 — SWEEP closure does not require successful verification and completed reviews

**Priority: P0 · Confirmed with producer-to-fold simulation.**

`runSweep` records `CHANGES_REQUIRED` when a pattern reviewer is unavailable, but contributes no structured findings for that missing reviewer (`_workflow/factory.js:2170–2178`). A null verifier proceeds; an explicit failed build returns a failed sweep result (`:2150–2157`). `cmdSweepFold` nevertheless closes an applied, unflagged, conforming site when it sees no unmapped HIGH/CRITICAL finding (`_workflow/driver.mjs:2367–2397`). It does not require verification/review completion.

Exact-source simulations closed a site in each case: missing architect, missing code verifier, and explicit failed build. The site files existed and conformance passed.

**Fix:** require sweep-wide execution/evidence prerequisites before per-site adjudication. Retain the intended ability to close unaffected sites after completed reviews identify an isolated blocker. Do not equate missing review with advisory dissent.

### F02 — SWEEP bypasses normal eligibility and readiness

**Priority: P0 · Confirmed with scheduling/fold simulation.**

Normal `computeReady` enforces autonomy, dependencies, retry bounds and active locks (`_workflow/lib/graph.mjs:24–43`); group adds input readiness (`_workflow/driver.mjs:1884–1889`). Sweep selects any site whose ledger state is not CLOSED (`:2320`). A rejected CLAIMED transition does not exclude that site from execution (`:2327–2346`), and fold directly assigns CLOSED (`:2395–2397`).

A synthetic owner-BLOCKED item and an unready dependency-blocked item both entered sweep execution; an approved result closed the owner-BLOCKED item despite its claim being illegal.

**Fix:** share eligibility/readiness checks with group, exclude unsuccessful claims, and validate claim provenance and legal transitions at sweep-fold. Explicit sweep selection is not an owner ruling.

### F03 — Two reachable OpenCode probes cannot submit their results

**Priority: P1 · Reproduced by calling the real validator.**

`PLAN_COMMITMENT_SCHEMA` and `LEDGER_ANCHOR_SCHEMA` are exported but absent from `SCHEMAS` (`_workflow/opencode/schemas.mjs:90–95,136–140`). Runtime dispatches both (`runtime.mjs:299–312`); submission calls `validateNamed`, which returns `unknown schema` (`schemas.mjs:192–195`). Retrying a valid agent response cannot resolve this.

**Fix:** register every reachable dispatch schema. Test dispatch → valid submission for every phase, rather than schema-object equality alone.

### F04 — OpenCode mechanical execution can treat missing evidence as green

**Priority: P1 · Parser behavior reproduced; caller paths inspected.**

Subprocess failures become `code:-1` and error text (`_workflow/opencode/buildtest.mjs:48–58`). Verify forwards a failed build into `afterVerify`, and does not independently require filter/suite completion (`runtime.mjs:1040–1057`). Integrate similarly grades combined output (`:1139–1159`).

The shared parser's deliberately permissive `no-machine-evidence` fallback returns `pass:true` (`_workflow/lib/verify.mjs:99–108`). It is unsuitable as the sole authority for a mechanical caller. A green build followed by a filter timeout can also leave enough partial markers to read as green. Missing RED evidence merely warns in the port (`runtime.mjs:1263–1277`).

**Fix:** use stage-specific completion contracts: successful invocation, required marker set, target/filter identity, nonvacuous test counts, and explicit baseline treatment. Distinguish infrastructure unavailability from a completed test failure. Fail before reviewers when required evidence is absent.

### F05 — Positive lint results lose their candidates in OpenCode

**Priority: P1 · Real-shaped marker samples reproduced.**

- Leftover producer emits source text after the last separator (`_workflow/leftover-lint.mjs:8–16`), while the consumer requires a numeric line number (`_workflow/opencode/runtime.mjs:1117`).
- Ledger producer emits `LEDGER-ANCHOR-DUP-HIT` and `LEDGER-ANCHOR-TAG-HIT` (`_workflow/ledger-anchor-lint.mjs:61–63`); consumer looks for `LEDGER-ANCHOR-HIT` (`runtime.mjs:1219–1224`).

Both can dispatch a classifier with an empty candidate list despite a positive count.

**Fix:** share structured candidate parsing or return JSON from the deterministic producer. Reject count/payload inconsistencies. Test positive hits, not just zero-hit fixtures.

### F06 — OpenCode phase routing skips applicable checks

**Priority: P1 · Source-confirmed; negative-with-empty-gaps transition reproduced.**

- Single-clause acceptance jumps past plan checking (`runtime.mjs:270–272`).
- Doc-only items jump past ledger-anchor checks (`:314–316`).
- `honored:false` with empty gaps records dissent but advances (`:664–670`).

Applicability should be independent of an unrelated previous check's applicability. Explicit rejection must resolve through amendment, adjudication, or failure.

### F07 — Killed-run plan reuse can remove required human sign-off

**Priority: P0 · Confirmed by fresh/reused execution comparison.**

`loadPriorAttempt` synthesizes `recommendEscalate:false`, assuming reaching test-author proves the planner did not request escalation (`_workflow/lib/prior-attempt.mjs:24–28,96–103`). In fact, native execution sets `item._escalate` and continues implementation; it stops for sign-off only before integration (`_workflow/factory.js:761–764,2040–2050`).

An otherwise auto-tier item can therefore be ESCALATED on its fresh path but CLOSED after killed-run reuse. Explicit escalate-tier items remain protected.

**Fix:** persist and reuse validated structured planner fields, including escalation and steps. Legacy prose-only artifacts cannot prove that escalation was false.

### F08 — Accepted real-infra classification overrides still fail fold

**Priority: P1 · Confirmed with native-result-to-fold simulation.**

Native execution sets `res.needsRealInfra` before adjudication (`factory.js:969–971`). An accepted override records OVERRULED without changing the effective requirement (`:1108–1112`). Fold still demands a container marker (`_workflow/driver.mjs:618–621`).

The tested result reached native CLOSED, then deterministic fold changed it to FAILED solely for the absent marker.

**Fix:** define one structured effective-classification contract consumed by execution, checkpoint, recovery and fold. Preserve the original requirement and adjudication evidence; never infer an override from prose alone.

## 2. Recovery and final-snapshot integrity

### F09 — Native gate reuse is normally unreachable

**Priority: P1 · Checkpoint sequence confirmed in mocked execution.**

Two independent causes:

1. `reviewPackHash` is included only in the post-preband snapshot (`factory.js:1871–1878`). The writer clones extras without updating `res` (`:2221–2229`). Later post-gates/post-reaudit writes overwrite the same file without the hash, while reuse requires one of those later stages and that hash (`:1889–1891,1990,2038`).
2. The hashed pack includes a generation timestamp (`verify/build-test.sh:250`), so regeneration changes its hash even when code is identical.

**Fix:** persist a canonical review-input fingerprint through all later checkpoints. Include base revision, complete tracked/untracked contents, acceptance, policy/profile and reviewer-contract identity. Do not use the presentation pack as the full identity: it truncates new files at 60 KB and total content at 400 KB (`build-test.sh:263–268`).

Test a real produced checkpoint round-trip, including mutations beyond truncation boundaries. The present reuse test injects an idealized hash-bearing checkpoint and constant mock hash (`_workflow/lib/_selftest.mjs:4551–4563`).

### F10 — Missing-stage recovery rejects ordinary terminal failure shapes

**Priority: P1 · Pure helper reproduced.**

`missingStageFrom` expects the last transition to be REAUDITED or REFUTE_OK (`_workflow/lib/recover.mjs:109–118`). Native `finish` appends FAILED (`factory.js:733`), and driver records those transitions unchanged (`driver.mjs:834–836`). Thus `[...,REAUDITED,FAILED]` returns no recovery stage.

**Fix:** identify the last successful stage while separately checking failure kind. Only an unavailable stage should get the infrastructure-only shortcut; a completed failing integrator requires remediation.

### F11 — Amendments can leave the independent verification snapshot stale

**Priority: P1 · Existing disclosed gap, still present.**

The runner executes at `factory.js:1008`; its evidence hint is captured at `:1145`. Later editorial/fixer amendments mutate the tree, but no independent final verification barrier refreshes all evidence before role gates. Integration checks code after the band only for items reaching it; escalate-tier and planner-escalated items stop beforehand. The absence of the host-origin post-amend mechanism is already disclosed in KI-E144B.

**Fix:** track mutation identity and run one independent verification barrier after the last pre-band mutation. Refresh the review pack and evidence summary together. Any later writer invalidates affected checks. Do not run a full suite after every prose-only amendment.

OpenCode additionally runs prose/structure editorial writers concurrently (`runtime.mjs:321–329`) after several scans; native serializes those writers (`factory.js:1344–1345`). Serialize overlapping writes and review the final snapshot.

### F12 — OpenCode resume needs dispatch and content identity

**Priority: P1/P2 · Contract inspection.**

The binding already preserves phase progress; it does not always start over. However, it trusts saved verdicts without checking changed worktree inputs (`runtime.mjs:409–414`). Submissions identify recurring role keys rather than unique dispatches (`:433–455`), and mechanical commands are not guarded against the expected phase (`:968–971`). Its local atomic writer also misses the shared Windows retry handling (`:49–54`).

**Fix:** claim/attempt IDs, unique dispatch IDs, prompt/input hashes, idempotent submit, phase guards, serialized same-item writes, shared atomic persistence, and an explicit bounded failed-agent outcome. Reuse the unaffected prefix; invalidate the suffix that depends on changed content.

## 3. Where the calls and context go

### Representative native call counts

Successful mocked fresh runs, one attempt per call, no amendments/adjudication, policies off, single-clause acceptance, and no conditional EF/breadth/ledger probe. C# fixtures provide `test.runCmd`, enabling RED-coverage; the FULL fixture provides planner steps, enabling plan-step checking:

| Item | Physical `agent()` calls | Calls recorded in item cost |
|---|---:|---:|
| LIGHT mechanical C# | 21 | 16 |
| LIGHT mechanical documentation | 17 | 12 |
| FULL nonmechanical CRITICAL security | 31 | 26 |

Five calls are checkpoint writers: four progress boundaries and terminal persistence. In the LIGHT code example, eight of 21 calls are those writers plus pure RED-marker, root-cause and hash relays. Leftover is a ninth mixed mechanical/semantic call: its candidate classification still requires judgment. Conditional scans, retries and amendments increase these figures. These are Workflow `agent()` invocation counts, not underlying model/API request counts or equivalent-cost units.

LIGHT already skips the architect/security/PO panel, usually omits a dedicated refuter, and uses one re-audit lens. Early edge review already substitutes for its late slot. Preserve those existing savings.

### F13 — Native role briefs are silently truncated

`readRoleBriefs` slices every role to 12,000 characters (`_workflow/lib/promptpack.mjs:27,73`). The fixer's committed LF text is 18,926 characters; the current CRLF checkout is 19,140. The cutoff lies around the RE-FIX section. The first wholly omitted numbered section is **SIBLING-PATTERN SWEEP** (`agents/fixer.md:139`). Later dead-code, CancellationToken, deviation and artifact-write instructions are omitted too (`:139–214`). Native composition calls the truncated brief authoritative and says not to reread it (`factory.js:551–557`).

Some omitted guidance survives elsewhere: plan exclusions in the extra prompt and `filesChanged` semantics in the schema. The entire contract is not lost. OpenCode reads the whole brief (`compose.mjs:121–128`), creating different operative instructions across bindings.

**Fix completeness first, then compress deliberately:** stable mandatory contract + small applicable checks + references for unusual cases. Move incident narratives to the KI registry. Assert required sections survive actual composition. Never silently slice a behavioral contract.

### F14 — Mechanical work receives model sessions and oversized context

Claude's sandbox cannot use filesystem/shell directly, so replacing checkpoint calls with `fs.writeFile` inside `factory.js` is not viable. But several independent model calls only execute a command or parse its markers (`factory.js:1215–1217,1264–1266,1871–1876`). They still receive normal composed item/profile context.

**Near-term:** a minimal tool-relay prompt and an engine-owned deterministic collector returning a structured evidence bundle. Consolidate compatible checks at the same immutable boundary. Keep semantic judgments independent and retain useful kill checkpoints.

**Longer-term:** evaluate Node-controlled mechanical phases with Claude worker dispatch through an external adapter. Preserve native Workflow as an option; account for its caching and replay benefits before replacing it.

### F15 — OpenCode controller relays full prompts and duplicates advancement

`next` emits full prompts for all roles, even when only some are pending (`runtime.mjs:413–426`). `submit` automatically calls next (`:461–468`); the installed manual also says to call next (`opencode-assets/root/.opencode/skill/ai-factory/SKILL.md:67–74`).

Synthetic normal gate batches contain approximately 38,018 characters for LIGHT and 51,382 for FULL before a repo profile. A 30,000-character profile repeated across five/seven calls adds 150,000/210,000 characters. Those prompts can appear in controller output, controller dispatch input, and worker input.

**Fix:** emit only pending compact descriptors and dispatch directly from Node. Descriptors should carry dispatch ID, role, route, prompt/schema reference and input fingerprint. Return compact state summaries to the controlling conversation. Use built-in `fetch` for platform server APIs to preserve zero npm dependencies.

### F16 — OpenCode routing is metadata and integration can repeat tests

The port does not apply its intended per-role routes (`routing.mjs:7–15`; `runtime.mjs:415–457`). Configure explicit named worker tiers or use per-session model selection, and record the actual selected model. Do not confuse OpenCode's lightweight internal model setting with worker routing.

`mech integrate` already runs build+suite, then dispatches the normal integrator (`runtime.mjs:1139–1167,378–379`), whose brief asks for build+suite again (`agents/integrator.md:10–20`). Give it a handoff/review-only contract over current immutable machine evidence. Repeat verification only after input change or incomplete evidence.

### F17 — Driver enrichment is lost at OpenCode initialization

The driver prepares precedent, batch patterns, peer locks, solution/doc maps and re-fix provenance (`driver.mjs:1989–2003`). Runtime init reloads the raw graph item (`runtime.mjs:57–63,120–125`). Prompt support exists but ordinary initialization loses those launch-only fields.

**Fix:** consume the claim-matched enriched launch envelope or a shared preparation function. Snapshot briefs and policy with the attempt, rather than changing instructions halfway through a resumed run.

## 4. Measurement before model/reviewer tuning

Current cost maps count successful logical calls, not physical attempts: `cost(route)` runs after successful `tryAgent`, while retries happen inside it (`factory.js:606–629,706–729`). Checkpoints bypass item cost. Crashes can return an empty cost map. A reproduced three-attempt test-author call increased actual Sonnet calls without corresponding cost entries.

Other measurement gaps:

- Re-folding can emit run usage again although item results are skipped (`driver.mjs:1023–1029,1063–1066`).
- Sweep closure lacks the `item_folded` events consumed by principal outcome tables (`:2391–2412`).
- Recovery cost is not automatically captured by its skeleton (`lib/recover.mjs:64–85`).
- The reported first-pass rate divides first-pass closes by eventual closes, not all attempted items (`lib/telemetry.mjs:399–422`). One first-pass close plus nine never-closed failures can read 100%.
- Atomic claims on shared `budget.spent()` deltas prevent double counting but do not prove causal item attribution under concurrent token generation (`factory.js:28–54,682–687`). Runtime update semantics must be verified.

Introduce versioned **attempt observations**, separate from verdict evidence:

```text
runId, itemId, attemptId, dispatchId, stage, runtimeVersion
requestedModel, actualModel, effort, retry, fallback
promptHash, evidenceHash, startedAt, completedAt, outcome
inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens
costSource, measuredCost, attributionConfidence
```

Unknown usage stays unknown. Give shared overhead its own bucket. Deduplicate by immutable identity. Preserve telemetry's observational status.

Primary decision metric: **all-in cost per human-accepted delivered change**, including failed attempts, recovery and bookkeeping. Supporting metrics: items closed on their first attempt divided by all items with an observed first attempt in a defined cohort, escaped defects, human correction effort, valid unique findings by reviewer, false positives, reuse hit/miss reasons, late deterministic failures, and queue versus execution time.

## 5. Claude Workflow and OpenCode platform research

### Claude Workflow

Current official documentation confirms the sandbox restrictions and explains two distinct caches:

- **Prompt cache:** matching siblings share tools/system prefixes when model, effort, agent type, tools, output schema and working directory match. Workflow already staggers matching starts by up to five seconds. Default cache TTL is five minutes; a documented one-hour subagent TTL is available at a higher API write price.
- **Workflow replay:** completed agents replay in start order. The first changed or failed call can invalidate later completed work. Resuming the original saved Claude session differs from starting a new session.

Implications:

1. Do not add a paid warm-up agent without evidence; startup staggering already exists.
2. Keep stable instructions/profile/role material before dynamic item content where useful, but measure actual cache tokens. Rearranging one prompt string does not prove a cache breakpoint exists there.
3. Test five-minute versus one-hour TTL on real stage gaps using the documented `subagentPromptCacheTtl: "1h"` setting where supported (Claude Code 2.1.242 or later; provider/gateway support may differ).
4. Record session/run/task IDs and teach the installed controller the actual replay/reuse decision tree.
5. Do not assume ordinary subagent/SDK options are accepted by Workflow's `agent()` without checking the installed authoring reference.

### OpenCode version compatibility

The shipped config uses v1-style `instructions`, `permission.bash` and Task-oriented dispatch. Current v2 documentation says `instructions` is accepted but not loaded, uses different permission/agent keys, and recognizes `AGENTS.md` without a CLAUDE.md fallback.

**Conditional compatibility gap:** a v2 host keeping its existing AGENTS.md cannot rely on the installer's documented instructions-array fallback. No installed v2 binary was exercised here.

Use capability/version-aware install and dispatch adapters. Check active instruction loading, model aliases and permissions after installation. Preserve stricter existing permissions; current merge can replace an exact host deny with ask (`lib/hostinstall.mjs:54–59`).

For server dispatch, v2 prompt admission is not completion, and live event subscriptions are not durable replay. Persist dispatch/session identity and recover by querying durable state. Fresh reviewer sessions should receive evidence, not implementer conversation history.

### Sources checked

- https://code.claude.com/docs/en/workflows
- https://code.claude.com/docs/en/prompt-caching
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/agent-sdk/cost-tracking
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/sdk/
- https://opencode.ai/v2/docs/instructions/
- https://opencode.ai/v2/docs/permissions/
- https://opencode.ai/v2/docs/agents/
- https://opencode.ai/v2/docs/api/
- https://opencode.ai/v2/docs/compaction/

## 6. Coding approach: reduce semantic duplication

The two runtimes should share **one lifecycle contract with separate execution adapters**. The current Node/Workflow split is necessary; independently maintained state-machine semantics are not.

Incrementally extract:

1. A declarative stage catalog: applicability, dependencies, mutation/read-only status, input/output schemas, evidence requirements, routing, retries and invalidation rules.
2. A pure reducer: validated state + event → new state + requested effects.
3. Shared deterministic evidence and result contracts.
4. Native Workflow and OpenCode effect interpreters.

Generate or inline Workflow-compatible pure code at build/launcher time to respect its no-module runtime. Keep byte-parity checks, but supplement them with **behavioral parity**. Start with schema registration, verification completion and recovery identity; avoid a big-bang rewrite.

Replace brittle source-presence assertions with producer-to-consumer tests:

- Actual stage dispatch → valid submission.
- Positive lint output → nonempty classified candidates.
- Native terminal result → recovery preparation → deterministic fold.
- Checkpoint produced by one execution → resumed execution.
- Every mutation → appropriate evidence invalidation.
- Missing reviewer/failed subprocess → no successful close.
- Same fixture across both adapters → same required evidence and terminal disposition.

Fixtures should include missing/malformed/timeout outcomes and Windows paths. Add a read-only/in-memory core test entry point so investigation does not require the git-mutating fixture suite.

## 7. Delivery roadmap and acceptance tests

| Work package | Scope | Done when |
|---|---|---|
| A. Close correctness holes | F01–F08 | Missing evidence/review cannot close; blocked sweep cannot bypass owner ruling; all dispatched schemas submit; accepted classification overrides survive fold; reused plans preserve sign-off |
| B. Complete prompts and final evidence | F11, F13 | Required brief contracts reach both runtimes; a compile-breaking amendment fails before reviewers; overlapping editorial writes are serialized |
| C. Effective recovery | F09, F10, F12 | Real unchanged checkpoints reuse reviews; changed inputs invalidate them; late unavailable stages recover without replaying implementation; stale dispatches are rejected |
| D. Decision-grade telemetry | Section 4 | Attempts/retries/checkpoints reconcile; duplicate folds do not double usage; recovery/sweep appear; cohort denominators and unknown attribution are explicit |
| E. Cheaper execution | F14–F17 | Node dispatch removes controller prompt relay; actual model tiers are applied; duplicate integration commands disappear; compatible mechanical probes share collectors |
| F. Shared semantics and calibration | Sections 5–6 | Versioned adapters pass behavioral fixtures; measured review/model changes improve all-in accepted-change cost without increased escapes |

Use small separate changes with KI entries and relevant regression coverage. The strongest immediate cost-saving candidates are repaired reuse, avoiding late deterministic failure, complete briefs, and eliminating controller relay/duplicate verification.

## 8. Experiments after the contract repairs

1. **Baseline:** collect a stratified 30–50-item pilot across documentation, ordinary code and high-risk work. Track human acceptance and full lifetime cost. This is not enough to establish rare-defect safety.
2. **Context:** compare complete compact briefs and role-specific profile slices against the current complete instructions. Measure input/cache/output tokens, extra reads, format failures and correctness.
3. **Recovery:** inject kills at every checkpoint, resume both unchanged and changed snapshots, and count reused versus repeated physical calls.
4. **Reviewer value:** use frozen snapshots and independently adjudicated findings to measure unique valid detections and false positives. Similar role wording alone does not prove redundancy.
5. **Consolidated scans:** include rejected and mixed-outcome examples. The existing shadow only runs after all three original scans approve (`factory.js:1723–1726`), so it cannot establish false-negative performance on rejected cases.
6. **SWEEP:** after F01/F02, compare homogeneous low-risk clusters against individual LIGHT items at equivalent closure standards. Its N+3 doc / N+4 code logical-call structure is promising, but current false-green paths invalidate an unqualified efficiency comparison.
7. **Models:** compare actual delivered-change cost, not price per token. Preserve the recorded Sonnet 4.6 mechanical baseline until a challenger demonstrates better yield.

## Additional follow-ups

- Orchestrator dry backend calls real `group` before skipping dispatch (`orchestrator/orchestrate.mjs:155–170`); make dry planning genuinely nonclaiming.
- Watch child exit/error and validate checkpoint identity, not only file size/mtime (`:118–150`). Capture launch metadata and usage rather than waiting out a dead child.
- Refill a batch after overlap filtering; current group slices before filters (`driver.mjs:1817–1862`). Separate model concurrency from build capacity.
- Retry only retryable failures where runtime error information permits; current retries repeat identical calls and may multiply platform-level retries (`factory.js:606–634,712–729`).
- Budget reserve is checked before concurrently admitted items spend (`factory.js:662–672,2262–2275`); use phase-aware admission with checkpoint headroom if a budget is configured.
- Stall detection misses repeated late failures with non-null but zero-blocker gate summaries (`lib/convergence.mjs:165–178`). Apply failure signatures when there is no comparable blocking evidence.
- Installed controller upgrades retain any differing old asset as if locally edited (`setup/init.mjs:105–120`). Track installed-content hashes so untouched previous-release manuals update automatically.
- Fix POSIX-only/prefix-unsafe claimed-path validation (`factory.js:407–408`) and the swallowed undefined `vText` reference in fold's flake advisory (`driver.mjs:642–644`).

**Bottom line:** the factory has a sound evidence-first foundation, but its best efficiency investment is making the existing mechanisms agree end to end. Fewer failed/repeated lifecycles and smaller deterministic orchestration overhead are better-supported gains than an immediate broad reduction in independent review.
