# Effectiveness & cost triage — operator guide

A large backlog is rarely a large number of *independent* problems. Before running the full
band on every item, triage.

## Cluster first

```bash
node _workflow/cluster.mjs
```

`cluster.mjs` groups the findings-graph by similarity — most backlogs collapse to a handful
of systemic patterns across many sites. It reframes "N problems" as "a few sweeps." Use
`--emit <N> --pattern <keyword>` to write a sweep spec for one homogeneous cluster.

## Cost bands

Route each item to the cheapest band that still proves the fix:

- **SWEEP** — a whole root-cause cluster: design the canonical fix once (strong model), apply
  it across every site (cheap model, sequential in a shared worktree), gate the pattern once.
  Drive with `driver.mjs sweep <N> --max-sites K` → `driver.mjs sweep-fold`.
- **LIGHT** — doc/mechanical, non-critical items: the role gates and review flows run on the
  mid/cheap tier, single-lens re-audit, no strong-model panel. Far cheaper for the long tail.
- **FULL** — critical security / money / concurrency / idempotency: the full adversarial band
  with strong-model hard gates, refute, and real-infra verification.
- **QUEUE** — owner decisions: framed for a human, never auto-run.

## Stop findings from coming back

`_workflow/audit-diff.mjs` is a standalone deterministic linter: it scans the ADDED lines of
a diff for the anti-patterns your project cares about and exits non-zero on a new
CRITICAL/HIGH. Wire it as a pre-push hook (`ci/install-hooks.sh`) or a CI step so new
findings are stopped at the source — the only lever that trends the backlog down permanently.

## Recommended program

1. Put `audit-diff.mjs` in CI so the backlog stops growing.
2. Run the sweeps for the big homogeneous clusters.
3. LIGHT-band the mechanical/doc tail.
4. Reserve FULL for the genuinely critical items.
5. QUEUE the owner decisions.
