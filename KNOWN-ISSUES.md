# Known Issues — engine registry

This is the factory's **append-only** registry of known issues, limitations, accepted
constraints, and by-design behaviours. Read it before changing the engine; add a `KI-*`
row in the SAME change that introduces or fixes an issue. A change that adds a limitation
without a row here is the silent-divergence failure mode this registry exists to prevent.

The lib self-test (`node _workflow/lib/_selftest.mjs`) is the regression net for the
correctness-class entries — keep it green.

> This shipped registry documents the **engine invariants** only. Your own operational
> findings (per-cycle issues, host-specific quirks) accumulate here as you run the factory.

## Engine invariants & operational constraints (by design — not bugs, but must be known)

| ID | Constraint |
|----|-----------|
| KI-E1 | **No mutating git, ever** — no `commit`/`add`/`checkout`/`restore`/`stash`/`reset`/`clean` by the factory or any subagent. Fixes land on `factory/<id>` worktree branches as UNSTAGED changes; **the human commits**. |
| KI-E2 | **The Workflow runtime cannot touch the filesystem or git, cannot `require()`, and `Date.now()`/`Math.random()`/argless `new Date()` throw.** Hence the two-half split: `driver.mjs` (Node — fs/git/ledger) + `factory.js` (Workflow — agents only). Pure helpers used inside `factory.js` are inlined byte-for-byte from `_workflow/lib/`; change both copies together. |
| KI-E3 | **The filesystem is the checkpoint** (`state/ledger.json` + worktree inspection) — resumable after a kill. The ledger has a **single writer** (the driver); hand-editing it risks corruption. The findings-graph is hand-editable. |
| KI-E4 | **Scope red-lines are hard stops** — an item whose only fix would cross a scope boundary you have declared MUST `scope-stop` (→ the human queue), never be "fixed" by adding the forbidden surface. |
| KI-E6 | **Graceful-stop drain guard** — a `state/STOP_REQUESTED.md` marker puts the factory in a graceful drain: `driver.mjs group` refuses while it exists (in-flight lanes finish, nothing new launches). `fold`/`reconstruct`/`escalations` stay unguarded so running work completes. Resuming is deliberate: delete the marker (or pass `group --stop-override`). |
| KI-E7 | **Telemetry is observational, never evidentiary.** Every factory action lands as an event on the append-only stream `telemetry/data/events.jsonl` (`FACTORY_TELEMETRY=0` disables). An emitted event never feeds a fold verdict; the factory runs fine with the telemetry stack down. `driver.mjs telemetry-report` renders the evaluation report from the JSONL directly. |
| KI-E17 | **Portable mounts** — the factory is mountable at any host path (submodule or plain clone). `_workflow/lib/rootfind.mjs` detects the host repo root (walk up from the mount's parent to the first `.git`; `FACTORY_REPO_ROOT` overrides) and rewrites the committed stock-prefixed config paths onto the real mount; an optional gitignored `config/factory.config.local.json` overlays per-host knobs. See `SETUP.md`. |
| KI-E18 | **AcceptanceScan** — a pre-band clause-coverage probe: the item's `acceptance` splits into checkable clauses (`lib/acceptance.mjs`, inlined byte-identically in factory.js — change both together, the selftest pins parity); a cheap probe answers per clause "does the diff carry concrete evidence?" BEFORE the gate band. Gaps feed ONE bounded fixer amend + one re-probe; still-uncovered clauses FAIL pre-band with clause-level gateDetails. Skipped for verificationOnly + single-clause acceptances; fail-open on a null/malformed probe. |
| KI-E19 | **Evidence manifest** — `build-test.sh` trails every subcommand with a keyed `FACTORY::SUMMARY::<sub> …` marker (the suite carries its own counts); `parseVerifyRaw` prefers the keyed markers over the ambient type-agnostic dotnet summary line, so transcript append order can never misattribute counts. The fold adds a FULL-band PAIR rule: a FULL code item must show a green build marker AND a green suite signal in at least one transcript (results without `band` skip the rule — backward-compatible). |
| KI-E20 | **`driver recover <id>`** — the direct-recovery scaffold for a FAILED/ESCALATED item: dissent digest from the checkpoint's structured gateDetails, one delta re-gate prompt per dissenting role (role brief inlined), the evidence contract (integrate-raw vs mutation-proof separation + red-marker rules), the `#<cycle>r` fold skeleton (attemptsDelta:0; machine-evidence flags carried so recovery is never a lighter evidentiary path), and a `recovery_prepared` telemetry event. Prepare-only: the operator applies, re-gates, folds. |
| KI-E21 | **Sweep routing in `suggest`** — a cluster where one signature keyword spans >= 6 members (`--sweep-min` overrides) is recommended to the SWEEP band (`cluster.mjs --emit-pattern` + `driver sweep`) instead of pair-group lines — design-once + cheap applies + one pattern gate is measured ~4-10x cheaper per finding than pair lanes. |
| KI-E22 | **Acceptance-surface lint** — `graphaudit.mjs acceptanceSurfaceGaps`: path-like tokens + PascalCase type names in `acceptance` that resolve to a tracked repo file absent from `files[]` → advisory WARN at `graph-audit` and at `group` time (the file-lock cannot serialize an unlisted surface, so the fixer can be lock-forbidden from meeting acceptance). `graph-audit --fix` also appends the standards-ledger path for flagged shared-file gaps (the KI-E16 mechanical triage). |
| KI-E23 | **Telemetry completeness** — editorial verdicts are recorded in the gates map + gateDetails (advisory stays non-blocking); results and `item_folded` events carry `band` (LIGHT/FULL cost + gate-value split); the factory returns `usage` from the runtime budget counter and the fold emits a `usage` event, so cost analyses stop extrapolating from call counts. |
| KI-E24 | **`driver decisions-digest`** — one ranked page (severity x age) for the parked owner queue, with a one-line reply format (`<ID>: <letter>`) and same-target rule-together bundles; hand the digest to the owner instead of the raw queue wall. |
| KI-E26 | **Host data must never enter the engine repo.** `SETUP.md` promises "everything under `state/`, `reports/`, and `queue/` is generated per host at runtime and is gitignored, so no project data ever enters this repo" — but `queue/decisions.md` was **tracked**, and `state/{ledger,findings-graph,PROGRESS}` + `reports/*` were merely untracked (so `git add -A` in the mount swept them in). Operating the factory in a host therefore dirtied a tracked file with that host's data: the decision queue quotes owner framings verbatim, which routinely name customers, internal issue ids and production detail. `queue/decisions.md` is now untracked (`queue/.gitkeep` ships instead, matching `state/`/`reports/`) and the per-host runtime artifacts are gitignored, making the shipped promise true. Nothing reads these as input — `setup/init.mjs` scaffolds the dirs and `driver init`/`escalations` regenerate the files on every host. |
| KI-E25 | **Telemetry stack identity is per-host, not just per-port.** The factory mounts in any number of host repos, but `telemetry/docker-compose.yml` pinned `container_name: factory-*` and the compose project `name:`, so a SECOND host on the same machine could not start its stack at all (duplicate container names — and `docker compose -p` does **not** override `container_name`), and the project name scopes the `prometheus-data`/`grafana-data` volumes, so a renamed-by-hand host would silently share host A's data. Both are now `${FACTORY_COMPOSE_PROJECT:-ai-factory-telemetry}` / `${FACTORY_CONTAINER_PREFIX:-factory}`, defaulting to the historical names (existing single-host stacks unaffected). Host B sets both in `.env` alongside the ports — see `telemetry/README.md`. Verified by running two stacks concurrently. Prometheus scrapes by **service** name (`exporter:9464`), never `container_name`, so inter-service DNS is unaffected. |

## Verified design properties (recorded so they are not re-investigated)

- The global agent limiter cannot deadlock — every `agent()` routes through one limiter; an
  item never holds a slot while awaiting another.
- Per-item results are isolated — a thrown item degrades to `FAILED`; siblings still
  complete and fold (the batch never rejects as a whole).
- A null/again-null gate result fails closed (`!== 'APPROVED'` → `FAILED`).
- `foldResults` is idempotent and self-heals a partial application (it re-walks from the
  current state rather than corrupting it).

## How to add an entry

Give it a stable `KI-<class><n>` id, one row stating the issue/constraint and its
mitigation or status, and — if it is a correctness fix — a matching assertion in
`_workflow/lib/_selftest.mjs`. Resolved entries stay (marked resolved), never deleted.
