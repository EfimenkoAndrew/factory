---
name: ai-factory
description: Drive the AI Implementation Factory from OpenCode — status, item selection, the _workflow/opencode runtime loop, folding results, reports, escalations. Use when the user says "run the factory", "factory status", "continue the factory", "factory cycle", "fold the results", or asks about the implementation queue / factory work items.
---

# AI Implementation Factory — OpenCode controller manual

You are the factory **controller session**. The factory is an implement-and-auto-evaluate
engine: it takes spec'd work items (audit findings / stories with acceptance criteria),
implements each in an isolated git worktree, proves it with a red->green regression test,
adversarial review gates and a scoped re-audit, and leaves the verified change on a
`factory/<id>` branch **for the human to commit**.

The always-on rules in `.opencode/ai-factory.md` still apply — this skill is the operating
procedure on top of them.

## Locate the mount

The factory lives in the host repo as a submodule or cloned directory — the directory
containing `_workflow/driver.mjs` (default `_bmad-output/ai-factory`; check `.gitmodules`
if moved). Everything below uses:

```
DRV = node <mount>/_workflow/driver.mjs
RT  = node <mount>/_workflow/opencode/runtime.mjs
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
3. **The driver is the single ledger writer.** Never hand-edit `state/ledger.json`.
4. **Stop marker**: if `state/STOP_REQUESTED.md` exists, the factory is in graceful drain —
   `group` refuses; `fold`/`reconstruct` still complete running work. NEVER delete the
   marker from inference; only the owner's explicit acknowledgment lifts it.
5. **Product red-lines are hard stops** — an item whose only fix crosses a product-scope
   boundary is `scope-stop` -> BLOCKED for the human, never "fixed".
6. **Green build != done** — every fix needs its red->green test; money/security/concurrency
   items additionally need real-infra (Testcontainers) proof.
7. **Reviewers are separate subagents.** Every role a `next` step hands you goes through `Task`
   as its own subagent — never played inline in this conversation. Nesting the reviewer in the
   implementer's reasoning trail is the one thing that makes the whole gate band meaningless.

## Session start

1. Read any host resume/handoff notes if present (e.g. a `CONTINUE_PROMPT_*.md` kept in the host repo).
2. `DRV status` — counts, in-flight, escalations. `DRV resume` — stranded ACTIVE items
   (`--reset-stale` re-queues them; checked + honest).
3. `DRV preflight` — docker/dotnet readiness (decides realInfra closability).

## The cycle loop

OpenCode has no `Workflow` tool, so the worker plane runs through the `_workflow/opencode/`
binding: **one item at a time**, driven by you.

```
DRV cycle --max 1        # or: DRV suggest / DRV group --ids <id> --conc 1
    → claims the item, creates its worktree, writes the ledger row
RT init <id>
loop:
  RT next <id>
    → {"mechanical":"<step>"}   run: RT mech <id> <verify|leftover|integrate|checkpoint>
    → {"agents":[{role,key,phase,schema,prompt}, ...]}
        dispatch ALL of them via Task — one subagent per entry, single message when >1 —
        then feed each answer back: RT submit <id> --role <key> --json <file|->
  until `next` reports done (it keeps returning the checkpoint step until
  `RT mech <id> checkpoint` has written state/items/<id>/result.json)
RT finalize <id>         # wraps result.json into the envelope fold requires
DRV fold <mount>/state/results-cycle-<N>-<id>.json --controller <token>
DRV progress && DRV burndown && DRV escalations
DRV gc --yes             # prune worktrees of CLOSED items (optional)
```

A BARE per-item `result.json` folds as "ZERO results" — always `finalize` before `fold`.
EVERY terminal outcome (`FAILED`/`BLOCKED`/`ESCALATED` as much as `CLOSED`) must be
checkpointed, or the ledger row stays CLAIMED forever with nothing to fold.

Repeat until the target is drained or a stop condition fires. Between items report:
CLOSED / FAILED / ESCALATED / BLOCKED deltas, cost if asked (`DRV cost`).

## Recovery

- An item stuck CLAIMED/ACTIVE with no live run → `DRV reset <id>` re-queues it.
- `RT status <id>` prints the current phase / gates / pending keys — resume from there rather
  than re-running `init` (which would restart the item's state machine).
- `RT next` never resets already-submitted verdicts; a re-submit of a completed phase's role is
  rejected loudly with no state change. Re-running `next` after an interruption is always safe.
- A FAILED/ESCALATED/BLOCKED item with a reviewer-converged remedy or owner ruling →
  `DRV recover <id>` scaffolds the direct-recovery (dissent digest, delta re-gate prompts,
  evidence contract, `#Nr` fold skeleton) — the dominant close path. You apply the remedy in the
  worktree, run the re-gate prompts as separate `Task` subagents, fill the skeleton, fold it.

## What goes to the human

- `DRV escalations` syncs `<mount>/queue/decisions.md` — BLOCKED (owner ruling) and
  ESCALATED (auth/money/crypto/cross-service sign-off) items. Surface them; never rule.
- `DRV decisions-digest` renders `reports/decisions-digest.md` — the parked queue ranked
  severity x age with a one-line reply format (`<ID>: <letter>`) + rule-together bundles.
  Hand the digest to the owner instead of the raw queue wall.
- CLOSED items: hand off worktree branches (`git -C <worktree> diff` to preview — read-only git
  is fine). The human applies/commits; you may summarize per-item changes and the evidence.

## Reference map (all under the mount)

| File | What |
|---|---|
| `_workflow/opencode/README.md` | The runtime binding — full protocol + fidelity gaps (KI-O1) |
| `README.md` / `SETUP.md` | Architecture halves / host onboarding |
| `KNOWN-ISSUES.md` | Append-only KI registry — read before changing the factory |
| `EFFECTIVENESS.md` | Cost triage: clustering, LIGHT band, sweeps |
| `PLAN.md` | Architecture & design |
| `state/PROGRESS.md`, `reports/*` | Generated progress/burndown/cost/telemetry |
