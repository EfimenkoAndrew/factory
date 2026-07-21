# AI Implementation Factory

An in-project, agentic **implement-and-auto-evaluate** engine. Feed it a spec'd work
item (audit finding / story / change request with acceptance criteria); it implements
the item, proves it with a red→green test + an adversarial review stage (5 role gates +
independent review flows) + a scoped re-audit, and hands the verified change off
**for the human to commit**. See `PLAN.md` for the architecture.

It runs on **Claude Code**: the worker plane is a Claude Code Workflow script; the
control plane is zero-dependency Node (>= 20.11). Nothing to `npm install`.

> **Every known issue, limitation, accepted constraint, and residual lives in
> [`KNOWN-ISSUES.md`](./KNOWN-ISSUES.md)** — the canonical, append-only registry. Read it
> before changing the factory; add a `KI-*` row when you find or fix one.
>
> **Cost too high / backlog too big?** [`EFFECTIVENESS.md`](./EFFECTIVENESS.md) is the operator guide:
> root-cause clustering (`cluster.mjs` → most findings are ~6 systemic patterns), cost-band triage, the
> LIGHT review band (~4× cheaper long tail), and the build-time audit gate (`audit-diff.mjs`) that stops new
> findings at PR time. Run `node _workflow/cluster.mjs` first — it reframes "N problems" as "a few sweeps."

## Use it in YOUR repo (clone & set up)

The factory is repo-agnostic and ships as its own repository —
<https://github.com/EfimenkoAndrew/factory>. Mount it in any host repo (submodule
recommended, any path), initialize, feed it a findings-graph:

```bash
git submodule add https://github.com/EfimenkoAndrew/factory.git _bmad-output/ai-factory
node _bmad-output/ai-factory/setup/init.mjs --fresh --yes --hooks   # new host (scaffolds state, installs the skill + pre-push gate)
node _bmad-output/ai-factory/setup/init.mjs                         # existing host / keep current state
```

[`SETUP.md`](./SETUP.md) is the full onboarding guide (prerequisites, mount shapes, host
adaptation seams, the operating loop). `setup/init.mjs` detects the host repo root + mount
path (any depth — KI-E17), scaffolds runtime state, and installs the `/ai-factory`
controller skill into the host's `.claude/skills/`. The agent briefs in `agents/` need no
host install — the driver inlines them into every batch.

## How it runs (two halves)

The factory is split because the Workflow runtime cannot touch the filesystem or git:

| Half | What | Where |
|---|---|---|
| **Control plane (persistence + scheduling)** | `driver.mjs` — owns `ledger.json` (single writer), selects READY items, emits `run-args.json`, folds Workflow results back, regenerates reports. Run via `node` between Workflow invocations. | `_workflow/driver.mjs` + `_workflow/lib/*.mjs` |
| **Worker plane (agents)** | `factory.js` — a **Workflow script**. Receives a batch + agent templates + model routing via `args`, drives each item through the lifecycle with model-routed, worktree-isolated, low-concurrency subagents, writes each artifact to disk, returns compact per-item results. | `_workflow/factory.js`, `agents/*.md` |

You supply `state/findings-graph.json` — hand-authored or generated from your backlog; see `SETUP.md` § 4 and `templates/findings-graph.example.json`.

## Work-item lifecycle (the resumable state machine)

```
READY → CLAIMED → RED → GREEN → BUILT → TESTED → GATED → REFUTE_OK → REAUDITED → INTEGRATED → CLOSED
off-ramps: BLOCKED (owner decision) · ESCALATED (auth/money/crypto/cross-service → human sign-off) · FAILED · CONFLICT (file-lock)
```

Every transition is persisted atomically in `ledger.json`. A killed run re-derives state
from disk + worktree inspection; nothing restarts from zero.

## Hard rules (non-negotiable)

- **The human authors every commit.** The factory runs **no** mutating git
  (`commit`/`add`/`checkout`/`restore`/`stash`/`reset`/`clean`). Fixes live on a
  `factory/<id>` branch in an isolated worktree; the worktree/branch is the handoff.
- **Filesystem is the checkpoint.** Agents write artifacts + per-item result files; the
  driver folds them into the ledger (single writer = no race).
- **Throttle discipline:** one Workflow at a time; concurrency 2–3 under throttle; per-agent
  retry ≥3; opus throttled harder than sonnet.
- **Green build ≠ done.** A fix needs a red→green regression test; money/security/concurrency
  items additionally need real-infra (Testcontainers) verification.
- **The review stage is separate adversarial subagents** — never nested in the doing agent. Band A:
  the 5 role gates (Architect/Developer/QA/Security/PO). Band B/C: independent review flows —
  a code review, an adversarial "cynical" review, an edge-case path-tracer, a test-quality
  review, and editorial structure/prose passes for doc-touching items — applied per item by
  what it touches. The methods ship embedded in `agents/*.md`; nothing external to install.
  See `PLAN.md` (the review stage) + `reviewFlows` in `config/factory.config.json`.
- **Model routing** per `config/model-routing.json` — opus reserved for hard reasoning + the
  three hard gates + refute; sonnet for mid; haiku for cheap.
- **Declared product red-lines are hard stops** — an item whose only fix would add a surface
  your project forbids is `scope-stop` and goes to the human queue, never "fixed".

## Driver commands

```
node <mount>/_workflow/driver.mjs <cmd>       # <mount> = your factory path, e.g. _bmad-output/ai-factory
  init [--force]        build/refresh ledger from findings-graph (resume-safe)
  status               counts, waiting-on-deps, escalations, in-flight
  select [--max N --target T --themes a,b --include-escalate --posture P --worktree PATH:BRANCH]
  claim <id...>        READY/FAILED/CONFLICT → CLAIMED (track in-flight)
  reset <id...>        re-queue CLAIMED/active/FAILED → READY (un-claim / recover a stranded item)
  fold <results.json>  apply Workflow per-item results to the ledger
  reconstruct          rebuild a results file from per-item checkpoints (killed-run recovery), then fold it
  resume [--reset-stale]   report in-flight; --reset-stale re-queues ACTIVE → READY (checked + honest)
  suggest              read-only batch planner — clusters schedulable items into similar batches, prints `group --ids` lines
  group [--target T --layer L --ids a,b --max N --include-escalate --include-realinfra]
                       pick a parallel batch: per-item worktrees + compact run-args
  cycle [--until critical|high|dry --target T --max N ...]
                       closed-loop step: emit next batch + a RUN/STOP signal (drive from /loop or a routine)
  sweep <N|slug> [--max-sites K]   root-cause sweep — design once + apply across a cluster's sites
                       (run `cluster.mjs --emit N --pattern <kw>` first to write the spec)
  sweep-fold <results.json>   close the chunk's findings if the pattern gate APPROVED
  controller <status|claim|release|heartbeat>   advisory single-controller lease
  gc [--yes]           list (or --yes remove) worktrees for CLOSED items; prunes dead refs
  preflight            environment readiness (docker → realInfra closability; dotnet → build/test)
  graph-audit [--fix] | realinfra-lint   lint the findings-graph (stale files[], over-flagged realInfra)
  progress | burndown | cost | escalations | report-cycle | telemetry-report
  merge-graph          merge state/normalized/*.json → findings-graph.json (validates + detects dep cycles)
  worktree-add <id> | worktree-remove <path> | worktree-list
```

A ledger-mutating command (`init/claim/reset/fold/group/cycle/sweep/sweep-fold/merge-graph/gc/controller`, plus `resume --reset-stale`) takes an advisory
`ledger.json.lock` — a second concurrent driver fails fast rather than racing the ledger.

## Layout

```
config/{model-routing.json, factory.config.json, orchestrator.config.json}   schema/{work-item,ledger}.schema.json
_workflow/{factory.js, driver.mjs, cluster.mjs (triage), audit-diff.mjs (build-time gate), telemetry-emit.mjs, lib/*.mjs}
agents/*.md   verify/   state/{findings-graph.json, ledger.json, PROGRESS.md, normalized/, items/, worktrees/}
queue/decisions.md   reports/{burndown.md, cost-latest.md, cycle-NN.md, telemetry-latest.md}
telemetry/{docker-compose.yml, exporter/, grafana/, data/events.jsonl (git-ignored)}   orchestrator/{orchestrate.mjs, ORCHESTRATOR.md}
setup/init.mjs (host initializer)   claude-assets/skills/ai-factory/ (host /ai-factory skill)   templates/findings-graph.example.json   SETUP.md
```

## Telemetry & observability (KI-E7 — observational, never evidentiary)

Every factory action lands as a v1 event on the append-only stream `telemetry/data/events.jsonl`
(driver commands, claims, folds + deterministic mtime-derived stage timelines; agents best-effort
emit via `_workflow/telemetry-emit.mjs`). `driver.mjs telemetry-report` renders the evaluation
report; `telemetry/docker-compose.yml` runs the OTel-collector + Prometheus + Grafana stack
(pinned images, permanent named volumes — see `telemetry/README.md`). `FACTORY_TELEMETRY=0`
disables. The factory runs fine with the whole stack down.

## Standalone orchestration (the factory as its own deliverable)

`orchestrator/orchestrate.mjs` mechanizes the loop (group → dispatch → watch → reconstruct →
fold → report) with pluggable worker backends (interactive Claude Code session, `claude -p`
headless, dry) — every ledger mutation still goes through `driver.mjs` (single-writer intact),
the lease heartbeats on every watch tick, and apply/commit stays human. See
`orchestrator/ORCHESTRATOR.md` for operation + extraction.
