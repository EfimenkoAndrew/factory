# Factory Orchestrator — the standalone-deliverable loop

`orchestrate.mjs` makes the factory operable **outside** an interactive Claude Code session.
It owns the loop the human/controller session used to drive by hand:

```
status → group → dispatch(backend) → watch checkpoints → reconstruct → fold → telemetry-report → repeat
```

Every ledger mutation still goes through `driver.mjs` as a child process — the orchestrator
adds **zero** new writers (single-writer invariant KI-E3 intact) and never runs mutating git
(KI-E1: the human authors every commit).

## Commands

```bash
node <mount>/orchestrator/orchestrate.mjs doctor    # environment readiness
node <mount>/orchestrator/orchestrate.mjs status    # ledger counts + lease + stop-marker
node <mount>/orchestrator/orchestrate.mjs run [--backend dry|interactive|claude-headless] [--ids A,B] [--max-lanes N]
node <mount>/orchestrator/orchestrate.mjs apply     # PLAN-ONLY apply commands for CLOSED worktrees
```

Policy lives in `config/orchestrator.config.json`.

## Backends (the worker-plane seam)

| Backend | What dispatch does | Status |
|---|---|---|
| `interactive` (default) | Prints the exact `Workflow({scriptPath})` launch line for the controlling Claude Code session, then watches `state/items/<id>/result.json` checkpoints — the file-first model means the orchestrator doesn't care WHO launched | production (this is today's operating mode, mechanized) |
| `claude-headless` | Spawns `claude -p` with a tight no-git prompt telling it to launch the emitted run-script | seam shipped + smoke-tested (`doctor` checks the CLI); burn-in pending — supervise first runs |
| `dry` | Groups nothing beyond the plan; launches nothing | smoke tests |

## Discipline the orchestrator enforces (inherited invariants)

- **Lease:** claims ONE controller token at `run` start, passes it on every driver call,
  **heartbeats every watch tick** (`controller heartbeat`) so a multi-hour lane never goes
  TTL-stale, releases on exit. A LIVE foreign lease → stands down.
- **Stop-marker (KI-E6):** checked before EVERY dispatch. The orchestrator never passes
  `--stop-override` — resuming a stopped factory is a human act (delete `state/STOP_REQUESTED.md`).
- **Apply is explicit:** `autoApply` is false by design; `apply` prints per-item
  diff-then-copy plans. Shared files need 3-way-merge judgment; the human commits.
- **Telemetry (KI-E7):** emits `source:'orchestrator'` events (`orchestrator_run`,
  `orchestrator_lane`) to the same stream; refreshes `reports/telemetry-latest.md` after folds.

## Moving hosts

The whole factory is this repository — control plane (`_workflow/`), worker briefs
(`agents/`), telemetry stack (`telemetry/`), and this orchestrator. To point it at a
(new) host repo:

1. Mount it in the host repo and run `setup/init.mjs` (`SETUP.md` § 2–3).
2. Feed it a findings-graph (hand-author, or `driver.mjs merge-graph`) and `driver.mjs init`.
3. `orchestrate.mjs doctor` → `run`.

No path in committed source is host- or repo-absolute; runtime-generated launch
artifacts (`state/run-script*.js`) legitimately carry machine paths and are regenerated
per `group`.
