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
7. **Reviewers are separate subagents.** Every pending role a `next` step hands you goes through
   an independent session (`Task` in v1, `subagent` in v2, or the server dispatcher)
   as its own subagent — never played inline in this conversation. Nesting the reviewer in the
   implementer's reasoning trail is the one thing that makes the whole gate band meaningless.

## Session start

1. Read any host resume/handoff notes if present (e.g. a `CONTINUE_PROMPT_*.md` kept in the host repo).
2. `DRV status` — counts, in-flight, escalations. `DRV resume` — stranded ACTIVE items
   (`--reset-stale` re-queues them; checked + honest).
3. `DRV preflight` — docker/dotnet readiness (decides realInfra closability).

## The cycle loop

OpenCode has no `Workflow` tool. Use the Node server dispatcher for the claimed batch:

```text
RT init <id> --launch <mount>/state/run-args-<label>.json
node <mount>/_workflow/opencode/dispatch.mjs --url <server-url> --ids <claimed-id[,claimed-id]>
```

Initialize each claimed item once. `--launch` can be omitted when the ledger's `runScript`
locates its claim-matched run-args file. Repeated init on the same claim is refused.
The dispatcher accepts `--version v1|v2` and `--config <file>`; otherwise it discovers the
server version and loads `<mount>/config/opencode-dispatch.local.json` when present.
These are dispatcher flags, not runtime-init or OpenCode-config fields. Neither CLI has a
general `--help` contract; use `_workflow/opencode/README.md` for the exact commands.

The dispatcher runs pending steps, finalizes terminal envelopes and returns batch outcomes.
It does **not** fold: the controller folds the generated absolute result paths with its lease.
For each completed item, the envelope is `<mount>/state/results-cycle-<N>-<id>.json`;
`RT finalize <id>` can revalidate it and print its absolute path before folding. The
dispatcher's stdout is a batch outcome array, not a fold envelope.
Resume the same complete batch/config after interruption. Durable message completion,
not prompt admission, SSE or idle status, determines whether an answer can be submitted.

Example host-local **dispatcher** config (separate from `opencode.json`):

```json
{
  "url": "http://127.0.0.1:4096",
  "version": "v2",
  "agentConcurrency": 4,
  "buildConcurrency": 1,
  "agentTimeoutMs": 1200000,
  "pollMs": 1000,
  "items": { "ITEM": { "target": "src/App.sln", "filter": "FullyQualifiedName~RegressionTests" } },
  "roles": {
    "gate-qa": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6", "agent": "factory-reviewer-mechanical" }
  }
}
```

`roles[descriptor.role]` overrides `models[descriptor.route.model]`. Each override can
specify `providerID`, `modelID`, `agent`, and v2 `variant` or `variants[effort]`.
Absent overrides, the adapter selects the installed profile and queries its effective
model in the item's worktree, preserving host model overrides. Missing profile/model
definitions fail closed. V1 sends model/agent but no invented effort field; v2 supports
model variants. Per-agent v2 `request` overlays are documented as not forwarded by its
runner, so configure active provider/model settings instead.

The independent `buildConcurrency` limit uses shared filesystem slots for mechanical
and worker-issued `build|red|filter|suite|efmigration` commands through
`build-lease.mjs`. Workers must use their prompt's wrapper; direct arbitrary shell commands
are not intercepted. Orphaned/timed-out slots require process-tree inspection.

## Manual Task/subagent fallback

```
DRV cycle --max 1        # or: DRV suggest / DRV group --ids <id> --conc 1
    → claims the item, creates its worktree, writes the ledger row
RT init <id> --launch <mount>/state/run-args-<label>.json
loop:
  RT next <id>
    → {"mechanical":"<step>"}   run: RT mech <id> <verify|leftover|integrate|checkpoint>
    → pending agent descriptors: read JSON promptRef and pass its prompt to the worker
        dispatch ONLY pending entries, one independent session per dispatch identity;
        parallelize independent readers, serialize overlapping writers
        RT submit <id> --role <key> --dispatch <dispatch-id> --json <file|->
        call RT next <id> after submission (submit does not auto-next)
  until `next` reports done (it keeps returning the checkpoint step until
  `RT mech <id> checkpoint` has written state/items/<id>/result.json)
RT finalize <id>         # wraps result.json into the envelope fold requires
DRV fold <absolute-path-printed-by-finalize> --controller <token>
DRV progress && DRV burndown && DRV escalations
DRV gc --yes             # prune worktrees of CLOSED items (optional)
```

A BARE per-item `result.json` folds as "ZERO results" — always `finalize` before `fold`.
EVERY terminal outcome (`FAILED`/`BLOCKED`/`ESCALATED` as much as `CLOSED`) must be
checkpointed, or the ledger row stays CLAIMED forever with nothing to fold.

The first code verify needs `RT mech <id> verify -- <solution> <filter>`; the `--` belongs
after `verify`, before positional target/filter. Later mechanics use saved verification
inputs. Mechanical commands may print the next descriptors; dispatch each identity only once.
Recurring role keys alone are not identities: retain attempt/claim ID, dispatch ID,
prompt/input hash and session ID exactly as emitted. Reject stale answers instead of
retagging them for a new phase. Identical dispatch replay is a no-op; conflicting replay fails.
`RT init <id> --launch <file> --legacy` explicitly enables historical full prompts/role-only
submission; alternatively `RT next <id> --legacy` and
`RT submit <id> --role <key> --json <file|-> --legacy` opt in per command. Put boolean
`--legacy` last so it cannot consume a positional argument. Add `--model <actual-model>`
only when known; manual dispatch otherwise records unknown, not the intended route.

Setup supplies `factory-{writer|reviewer|probe}-{mechanical|standard|strong|planning|cheap}`
worker profiles with provider-prefixed models. The adapter classifies `test-author`, `fixer`
and `review-editorial-*` as writers; other roles ending `-probe` as probes; remaining roles
(including planner, runner and integrator) as reviewers. Tier selection matches the intended
model against `opencode-assets/worker-profiles.json`; preserve Sonnet 4.6 for mechanical work.
Reviewers/probes deny product edits but retain live shell/network/build/infrastructure probe
ability under host permissions; the controller persists their JSON. Record the **actual**
model reported by the server, requested model and fallback separately. `small_model` is not
worker routing. Confirm model aliases exist for the host provider before claiming work.

Repeat until the target is drained or a stop condition fires. Between items report:
CLOSED / FAILED / ESCALATED / BLOCKED deltas, cost if asked (`DRV cost`).

## Recovery

- Inspect `DRV resume`, saved session/dispatch metadata and server durable state before
  relaunching. Never reset a claim or create a duplicate dispatch while its worker is live.
- `RT status <id>` prints the current phase / gates / pending keys — resume from there rather
  than re-running `init` (which refuses an existing same-claim attempt).
- Resume only pending dispatches in the existing attempt. Let the runtime validate content
  fingerprints and invalidate stale downstream evidence; never manually reuse a verdict after
  changing its reviewed input. Resume server work with the entire persisted batch and original
  config; never narrow `--ids` while old server sessions may still be active.
- For native Claude-origin claims, use original saved-session replay or `DRV resume --reuse`
  and `mark-launched` as documented in the Claude controller manual; OpenCode progress is a
  different protocol. `reset` is reserved for intentionally abandoned, confirmed-dead claims.
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
