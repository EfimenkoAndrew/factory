# Factory Orchestrator — the standalone-deliverable loop

`orchestrate.mjs` makes the factory operable **outside** an interactive Claude Code session.
It owns the loop the human/controller session used to drive by hand:

```
status → group → dispatch(backend) → validate checkpoints → atomic result envelope → fold → telemetry-report → repeat
```

Every ledger mutation still goes through `driver.mjs` as a child process — the orchestrator
adds **zero** new writers (single-writer invariant KI-E3 intact) and never runs mutating git
(KI-E1: the human authors every commit).

## Commands

```bash
node <mount>/orchestrator/orchestrate.mjs doctor    # environment readiness
node <mount>/orchestrator/orchestrate.mjs status    # ledger counts + lease + stop-marker
node <mount>/orchestrator/orchestrate.mjs run [--backend dry|interactive|claude-headless|opencode] [--ids A,B] [--max-lanes N]
node <mount>/orchestrator/orchestrate.mjs apply     # PLAN-ONLY apply commands for CLOSED worktrees
```

Policy lives in `config/orchestrator.config.json`.

## Backends (the worker-plane seam)

| Backend | What dispatch does | Status |
|---|---|---|
| `interactive` (default) | Prints the exact `Workflow({scriptPath})` launch line for the controlling Claude Code session, then watches `state/items/<id>/result.json` checkpoints — the file-first model means the orchestrator doesn't care WHO launched | production (this is today's operating mode, mechanized) |
| `claude-headless` | Spawns `claude -p`; uses documented `--output-format stream-json --verbose` when advertised by CLI help, captures session/usage metadata | fake-process tested; real Workflow availability in headless mode remains a host capability |
| `opencode` | Initializes enriched claims, runs the integrated server dispatcher, requires finalized terminal envelopes before folding | fake-process/config and HTTP-fake v1/v2 integration tested; local v1 no-model capability smoke passed; paid worker/provider validation remains host-specific |
| `dry` | Reads graph/ledger with shared readiness helpers, prints JSON scheduler suggestions; invokes no driver and claims no lease/items | filesystem/process fixture tested |

Dry suggestions are advisory: readiness, dependencies, retries, locks, real-infra opt-in,
and file-disjoint refill are applied; real `group` revalidates main-tree overlap and other
host checks. Unlike `driver group --dry`, this path does not auto-claim a controller lease
or generate launchers/reports. It can run while another controller owns the lease.

`modelConcurrency` is passed to `group --conc`. `maxItemsPerLane` bounds lane membership.
Every real backend passes requested `buildCapacity` to `group --build-capacity`; the driver
writes shared `state/build-capacity.json` and includes capacity in the launch envelope.
For `opencode`, `modelConcurrency` maps to dispatcher `agentConcurrency` and effective
build capacity maps to `buildConcurrency`. Native `interactive`/`claude-headless` prompts use the
implemented `build-lease.mjs` wrapper. Both bindings enforce build/RED/filter/suite/EF
capacity through the same filesystem slots, independently of agent concurrency.
Arbitrary shell commands bypassing the wrapper are not intercepted; uncertain or
orphaned build process trees retain their slots pending inspection.

For both native and OpenCode lanes, `launch.json` records the effective `buildCapacity`
at launch: the shared wrapper resolver takes the minimum of the launch-envelope capacity,
shared state, effective local/base factory configuration, and any legacy runtime limit.
Invalid capacity configuration is rejected. `buildCapacityEnforced:true` and
`buildCapacityScope:'mechanics-and-contract-compliant-worker-builds'` describe wrapper-mediated
mechanics and worker commands in both bindings, not arbitrary shell/OS process interception.
The OpenCode per-lane config snapshot uses this same effective capacity. Dry plans remain
advisory with `buildCapacityEnforced:false`; they do not launch or enforce capacity.

Configure `opencode.config` as a factory-root-relative path (default
`config/opencode-dispatch.local.json`). It is the **factory dispatch** config, not the host's
`opencode.json`. Keep URL/version, model/role mappings, headers and first target/filter there;
see `_workflow/opencode/README.md`. Optional `opencode.url` and `opencode.version` override the
file. The orchestrator supplies model concurrency and the effective shared build capacity. A private
per-lane config snapshot is retained for exact resume (POSIX mode 0600; Windows uses host ACLs).

## Launch identity, outputs and recovery

Real launches read the driver's generated run-args JSON for membership/cycle/worktrees;
human-readable item lines are not authority. Checkpoints must parse, be terminal, match
item/result ID (`<id>#<cycle>`), worktree and branch, postdate dispatch, and still match the
claim-history snapshot. Explicit claim/attempt IDs are checked when the producer supplies
them. Legacy producers do not carry a cryptographic per-attempt identity; same-cycle
reclaims still need operator scrutiny. Only this lane's validated results enter its fold.

Each real lane writes `state/orchestrator/<label>/launch.json`, `results.json`, and
`fold.json` atomically. Headless stdout/stderr are append-only `.log` transcripts;
`launch.json` captures PID, actual CLI session ID, exit/error/signal, reported usage,
per-model usage and total cost when emitted. Usage remains null when unavailable and is
observational: the enclosing CLI session's token counts are **not** mislabeled as Workflow
output tokens or added to its fold usage. Session identity is saved as soon as reported.

The watcher wakes on child exit/error rather than waiting the lane timeout. Even when all
checkpoints exist it waits for headless child close to capture final metadata. Timeout or
lease loss requests termination with bounded escalation; unconfirmed termination prevents
folding. Child termination is not proof that detached Workflow/server work stopped: inspect
the original session before relaunching. Native partial terminal results can fold; an incomplete
or failed lane ends the run with a failure status rather than scheduling another batch.

`launch.json` includes machine-readable recovery suggestions. Start with `driver resume`,
inspect original session/task liveness, fold completed checkpoints, then choose original
saved-session Workflow replay or `resume --reuse` artifact recovery. Record actual Workflow
IDs through `mark-launched --ids ... --taskId ... --runId ...` (`--continued` for continuation).
A CLI session ID/PID is not a Workflow task/run ID. Interactive controllers must record those
IDs themselves. Reset is an explicit abandonment choice, not automatic recovery.

For OpenCode, the worker calls `runtime.mjs init ID --launch <run-args>`, then
`dispatch.mjs --config <lane-config> --ids <complete-batch>`. Direct controller use also
accepts `--url <server> --version v1|v2`. Version discovery probes documented v1 health/v2 info.
The wrapper treats an `unavailable` batch result as failure even if the dispatcher exits zero.
The orchestrator requires each finalized envelope to match its checkpoint, and refuses to
fold an unsettled OpenCode batch. Per-dispatch sessions/models/usage remain authoritative in
`state/items/<id>/dispatch/*-session.json`; terminal results also carry claim-matched
admission receipts and physical observations for portable folding. The wrapper has
no aggregate model session to count.

After interruption, use `launch.json.resumeCommand` to resume the **same complete batch/config**
directly, without reinitializing or re-grouping. Check worker and server session liveness first;
terminating the local wrapper does not establish that descendant CLI/build/server work stopped.
After the dispatcher finalizes, run `runtime.mjs finalize ID` to revalidate and print each
absolute envelope path, then fold those files with the current controller lease. Dispatcher
stdout is a batch outcome array, not the fold payload.
`doctor` refuses a new OpenCode lane while its prior dispatcher batch is incomplete. Orphaned
build slots require process-tree inspection, not age-based recycling.

## Focused verification

```text
node --test setup/controller-assets.test.mjs orchestrator/lifecycle.test.mjs orchestrator/opencode-worker.test.mjs
```

These tests use temporary filesystem fixtures and fake processes, with no installers on a
real host, paid agents, or mutating git. The integrated
`node _workflow/lib/_selftest.mjs` also uses nonmutating fixtures: all seven git fixture
groups use process injection plus real read-only checkout coverage, with no git-group
exclusions. Its three shell groups cover all 14 behavioral/syntax assertions using
`lib/bash.mjs:resolveBash`, which probes the explicit override, Windows Git Bash
locations and PATH Bash for actual execution; an unusable shell is a failure.
Windows-denied file-symlink creation uses injected link metadata/realpath with real
target bytes; actual hardlink/junction coverage is separate.

The recorded local smoke passed against **OpenCode 1.18.31** on 2026-09-19, including
empty-session lifecycle and cleanup, without sending a prompt or invoking a model.
Official portable v2.0.10 also passed effective-profile routing and durable no-model
admission/cancellation; see `_workflow/opencode/COMPATIBILITY.md` for evidence and startup.
See `_workflow/LIVE-CHECK.md` for the v1 smoke. These results establish neither paid worker behavior
nor native Workflow actual model/usage, billing or performance.

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
