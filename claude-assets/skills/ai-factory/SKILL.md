---
name: ai-factory
description: Drive the AI Implementation Factory — status, batch grouping, Workflow launch, folding results, reports, escalations. Use when the user says "run the factory", "factory status", "continue the factory", "factory cycle", "fold the results", or asks about the implementation queue / factory work items.
---

# AI Implementation Factory — controller manual

You are the factory **controller session**. The factory is an implement-and-auto-evaluate
engine: it takes spec'd work items (audit findings / stories with acceptance criteria),
implements each in an isolated git worktree, proves it with a red→green regression test,
adversarial review gates and a scoped re-audit, and leaves the verified change on a
`factory/<id>` branch **for the human to commit**.

## Locate the mount

The factory lives in the host repo as a submodule or cloned directory — the directory
containing `_workflow/driver.mjs` (default `_bmad-output/ai-factory`; check `.gitmodules`
if moved). Everything below uses:

```
DRV = node <mount>/_workflow/driver.mjs
```

**Always run the driver from the HOST repo root** — never from inside an item worktree
(the driver refuses shadow copies), and never a worktree's copy of the driver.

## Hard rules (non-negotiable)

1. **NO mutating git, ever** — no `commit`/`add`/`checkout`/`restore`/`stash`/`reset`/`clean`
   by you or any subagent. Fixes stay on `factory/<id>` worktree branches; the human commits.
2. **ONE controller session.** Every mutating driver command needs the advisory lease:
   the first one auto-claims and prints a token — pass it as `--controller <token>` (or
   `FACTORY_CONTROLLER=<token>`) on every later mutating command. If a FRESH foreign lease
   exists, stand down and do read-only work.
3. **ONE Workflow at a time**; concurrency 2–3 under throttle.
4. **The driver is the single ledger writer.** Never hand-edit `state/ledger.json`.
5. **Stop marker**: if `state/STOP_REQUESTED.md` exists, the factory is in graceful drain —
   `group` refuses; `fold`/`reconstruct` still complete running work. NEVER delete the
   marker from inference; only the owner's explicit acknowledgment lifts it.
6. **Product red-lines are hard stops** — an item whose only fix crosses a product-scope
   boundary is `scope-stop` → BLOCKED for the human, never "fixed".
7. **Green build ≠ done** — every fix needs its red→green test; money/security/concurrency
   items additionally need real-infra (Testcontainers) proof.

## Session start

1. Read any host resume/handoff notes if present (e.g. a `CONTINUE_PROMPT_*.md` you keep in the host repo).
2. `DRV status` — counts, in-flight, escalations. `DRV resume` — stranded ACTIVE items
   (`--reset-stale` re-queues them; checked + honest).
3. `DRV preflight` — docker/dotnet readiness (decides realInfra closability).

## The cycle loop

```
DRV cycle [--until critical|high|dry --max N]   # or: DRV suggest / DRV group --ids a,b --conc 3
    → emits a batch: per-item worktrees + an inlined launcher at state/run-script*.js
launch it: Workflow tool with {scriptPath: "<mount>/state/run-script*.js"} and NO args
    → the Workflow runs plan → red test → fix → verify → edge-scan → leftover-scan
      → 5 role gates + review flows → refute → re-audit → integrate → checkpoint
DRV fold <mount>/state/results-cycle-<N>.json    # apply per-item results to the ledger
DRV progress && DRV burndown && DRV escalations  # regenerate reports + decision queue
DRV gc --yes                                     # prune worktrees of CLOSED items (optional)
```

Repeat until the target is drained or a stop condition fires. Between cycles report:
CLOSED / FAILED / ESCALATED / BLOCKED deltas, cost if asked (`DRV cost`).

## Recovery

- Workflow killed mid-band → `DRV reconstruct` rebuilds `results-cycle-<N>.json` from
  per-item checkpoints, then `fold` it.
- A cross-session Workflow "resume" is a COLD full re-band at full price (same-session only
  cache) — budget it as a fresh run; relaunching the same run-script verbatim is the
  sanctioned recovery, gates re-adjudicate the worktree.
- An item stuck CLAIMED/ACTIVE with no live run → `DRV reset <id>` re-queues it.
- After a PARTIAL fold, re-`group` — never Workflow-`resume`.

## What goes to the human

- `DRV escalations` syncs `<mount>/queue/decisions.md` — BLOCKED (owner ruling) and
  ESCALATED (auth/money/crypto/cross-service sign-off) items. Surface them; never rule.
- CLOSED items: hand off worktree branches (`git -C <worktree> diff` to preview). The
  human applies/commits; you may summarize per-item changes and the verification evidence.

## Reference map (all under the mount)

| File | What |
|---|---|
| `README.md` / `SETUP.md` | Architecture halves / host onboarding |
| `KNOWN-ISSUES.md` | Append-only KI registry — read before changing the factory |
| `EFFECTIVENESS.md` | Cost triage: clustering, LIGHT band, sweeps |
| `PLAN.md` | Architecture & design |
| `state/PROGRESS.md`, `reports/*` | Generated progress/burndown/cost/telemetry |
| `orchestrator/ORCHESTRATOR.md` | Mechanized loop (`orchestrate.mjs run`) |
