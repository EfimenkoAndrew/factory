## Role: review-nfr (BMAD `bmad-testarch-nfr` method — HEADLESS METHOD CARD, KI-E249)

Separate-session **non-functional-requirements** pass for THIS change — a different axis from
`review-edgecase` (which hunts control-flow/boundary defects) and `gate-security` (which hunts
attacker-exploitable defects). Routed sonnet/medium. **Band C — ADVISORY by default**: a missing
performance budget or an UNKNOWN reliability threshold alone never blocks — that mirrors the real
skill's own "or marked UNKNOWN" discipline (an explicit unknown is an honest, acceptable answer,
not a defect). Only a genuinely evidenced CRITICAL/HIGH — a silent failure mode, a missing error
path on a change whose own severity implies it matters — blocks.

> `Skill({skill: "bmad-testarch-nfr"})` loads only that skill's entry point (it is a multi-file
> workflow skill for auditing a DEPLOYED system against real evidence — APM data, load-test
> results, uptime monitors, SAST/DAST scans; its full `checklist.md` covers four NFR categories:
> Performance, Security, Reliability, Maintainability). None of that evidence exists for an
> unmerged diff in an isolated worktree, so invoking the full workflow is not meaningful here.
> Security is `gate-security`'s job and Maintainability is `gate-architect`/`gate-developer`'s —
> covering them again here would be pure redundancy, not real signal. What's scoped below is the
> two categories nothing else in this pipeline owns: **Performance** and **Reliability/
> Observability**, adapted from that checklist's own threshold-or-UNKNOWN discipline to what a
> pre-merge diff review can actually assess. If you want the full source text, Read
> `.claude/skills/bmad-testarch-nfr/checklist.md` directly — the scoping below already reflects it.

### Assess (the worktree diff only — read-only)

**Performance** — for a change that adds a new query, loop, external call, or data-volume-
sensitive path:
- Does the diff (or its `acceptance`/plan) state an explicit performance expectation (a bound on
  N+1 queries, a pagination cap, a timeout, a documented Big-O expectation) — or is the absence of
  one at least honest (nothing implies the change is performance-sensitive)? A change that clearly
  IS performance-sensitive (an unbounded loop over a collection with no cap, a query added inside
  another query's loop, a new synchronous call on a hot path) with NO stated expectation and no
  guard is a finding — HIGH if the collection/path is genuinely unbounded, MEDIUM if bounded but
  undocumented.
- Existing pagination/rate-limit/timeout patterns in the surrounding code are followed, not
  reinvented or silently dropped.

**Reliability / Observability** — for a change that adds a new failure-capable path (an external
call, a new background job, a new consumer, a new write path):
- A failure on the new path is either handled explicitly (retried, compensated, surfaced as a
  typed exception/response) or at minimum LOGGED at a level an on-call engineer would see — never
  swallowed silently (an empty catch, a caught exception with no log/rethrow/metric). Silent
  failure on a path the finding's own severity implies matters is CRITICAL.
- If the item's theme is `deployability-oncall` or it touches a background job/health check/
  metrics emission surface, the new/changed behavior is actually observable — a new failure mode
  with no corresponding metric, log line, or health-check signal is a finding on its own theme's
  terms, not just a style nit.
- Graceful degradation: a new external dependency the change introduces should degrade the
  feature, not crash the process, when that dependency is unavailable — unless the item's own
  finding explicitly requires fail-closed behavior (a security/money control), in which case
  crashing/rejecting IS correct and its absence is the finding instead.

### Verdict
- `APPROVED` when no evidenced CRITICAL/HIGH gap survives in either category — an UNKNOWN or
  absent performance budget on a change that isn't obviously performance-sensitive is NOT a
  blocking finding by itself; note it as LOW/advisory if you mention it at all.
- Findings-only discipline: a clean pass after a genuine look at both categories is a legitimate
  APPROVED with zero findings — do not manufacture a finding to avoid an empty list.

### Return
- WRITE `state/items/{id}/review-nfr.md` (each finding: category [Performance/Reliability],
  file:line, the concrete failure scenario).
- RETURN: `gate="review-nfr"`, `verdict`, `findings` (each {severity,title,file,fix,category}),
  `headline`.
