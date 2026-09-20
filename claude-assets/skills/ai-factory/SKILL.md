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
3. `DRV preflight` — docker/dotnet readiness (decides realInfra closability) **and cost-telemetry
   readiness (KI-E33)**. If it reports `cost telemetry: NOT gathered`, the session was launched without
   the Claude Code OTLP env, so the run's token/cost telemetry (the two dashboard cost panels) will be
   lost — `factory_*` metrics still land. Fix before running: set `CLAUDE_CODE_ENABLE_TELEMETRY=1` +
   `OTEL_EXPORTER_OTLP_ENDPOINT` (see `telemetry/claude-code-telemetry.env.example`) and restart the
   session, or put them in the host's `.claude/settings.local.json` `env` so every session has them.

## The cycle loop

```
DRV cycle [--until critical|high|dry --max N]   # or: DRV suggest / DRV group --ids a,b --conc 3
    → emits a batch: per-item worktrees + an inlined launcher at state/run-script*.js
launch it: Workflow tool with {scriptPath: "<mount>/state/run-script*.js"} and NO args
DRV mark-launched --ids <claimed-ids> --taskId <actual-task-id> --runId <actual-run-id>
    → the Workflow runs plan → red test → fix → verify → RED-proof probe → root-cause touch probe
      → edge-scan → acceptance-scan → plan-commitment/plan-step scan → comment-scan → leftover-scan
      → ledger-anchor scan → editorial → 5 role gates + review flows → refute → re-audit
      → integrate → checkpoint
DRV fold <mount>/state/results-cycle-<N>.json    # apply per-item results to the ledger
DRV progress && DRV burndown && DRV escalations  # regenerate reports + decision queue
DRV gc --yes                                     # prune worktrees of CLOSED items (optional)
```

Repeat until the target is drained or a stop condition fires. Between cycles report:
CLOSED / FAILED / ESCALATED / BLOCKED deltas, cost if asked (`DRV cost`).

## Recovery

1. Run `DRV resume` and inspect recorded task/run IDs with the original session's task
   tools. An old mtime alone does not prove death. Never launch a second worker over live work.
2. If terminal checkpoints exist, `DRV reconstruct`, inspect the reported IDs/cycle,
   and fold the generated envelope. Fold finished work before deciding what to relaunch.
3. For interrupted work, reopening the **original saved Claude session** (`claude --resume
   <session-id>`) can retain Workflow replay. Use the installed Workflow authoring reference
   for its resume call and actual run ID. Completed calls replay in start order; changed or
   failed calls can invalidate the suffix. A new conversation does not inherit that replay.
4. If original-session replay is unavailable, `DRV resume --reuse` prepares a launcher
   using validated on-disk prior-attempt/progress artifacts. Inspect its main-drift, debris,
   stale-ID and reuse diagnostics; launch only the emitted, current unresolved membership.
   This is artifact reuse, not a promise of free model calls or universal gate reuse.
5. After every actual launch record `DRV mark-launched --ids <actual-launched-ids>
   --taskId <actual-task-id> --runId <actual-run-id>`; add `--continued` for same-claim
   continuation. Keep the Claude session ID in the handoff too. Never substitute a PID or
   session ID for a Workflow task/run ID. Partial folds do not justify resetting remaining
   valid claims; follow `resume` diagnostics before any re-group.
6. Use `DRV reset <id>` only after confirming no live worker and intentionally abandoning
   the claim/reuse path. Re-group is a new scheduling decision, not the default recovery.
- A FAILED/ESCALATED/BLOCKED item with a reviewer-converged remedy or owner ruling (KI-E34) → `DRV recover <id>` scaffolds the
  direct-recovery (dissent digest, delta re-gate prompts, evidence contract, `#Nr` fold
  skeleton) — the dominant close path, first-class (KI-E20). You apply the remedy in the
  worktree, run the re-gate prompts as separate agents, fill the skeleton, fold it.

Prompt-cache hits are separate from Workflow replay and artifact reuse. Record observed
usage (unknown stays unknown). Where the installed Claude Code supports it (2.1.242+),
the owner can evaluate `subagentPromptCacheTtl: "1h"`; do not assume Workflow `agent()`
accepts arbitrary SDK options or add paid warm-up calls.

## What goes to the human

- `DRV escalations` syncs `<mount>/queue/decisions.md` — BLOCKED (owner ruling) and
  ESCALATED (auth/money/crypto/cross-service sign-off) items. Surface them; never rule.
- `DRV decisions-digest` renders `reports/decisions-digest.md` — the parked queue ranked
  severity x age with a one-line reply format (`<ID>: <letter>`) + rule-together bundles
  (KI-E24). Hand the digest to the owner instead of the raw queue wall.
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
