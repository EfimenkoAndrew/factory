# Setting up the AI Implementation Factory in YOUR repo

The factory is a repo-agnostic, zero-npm-dependency engine that lives INSIDE a host git
repository and drives spec'd work items (audit findings / stories with acceptance criteria)
through: plan → red test → fix → verify (build+test) → adversarial review gates → refute →
scoped re-audit → integrate. Finished fixes wait on `factory/<id>` git-worktree branches —
**the human authors every commit**; the factory never runs mutating git.

This repo ships **engine-only** — no findings, ledger, or run history. You supply the work
items (a `findings-graph.json`); everything under `state/`, `reports/`, and `queue/` is
generated per host at runtime and is gitignored, so no project data ever enters this repo.

## 1. Prerequisites

| Requirement | Why | Hard? |
|---|---|---|
| Node.js **>= 20.11** | driver / orchestrator / selftest (built-ins only, no `npm install`) | yes |
| git **2.30+** | worktree isolation per item | yes |
| **Claude Code** session at the host repo root | the worker plane is a Claude Code **Workflow** script (`_workflow/factory.js`) | yes (interactive or `claude -p` headless) |
| .NET SDK | the DEFAULT verify runner (`verify/build-test.sh`) builds/tests with `dotnet` | only for .NET hosts — see § 6 |
| Docker | `realInfra` items (money/security/concurrency) close only with Testcontainers proof | recommended |

## 2. Mount it in the host repo

**A — submodule (recommended; any path works):**

```bash
git submodule add https://github.com/EfimenkoAndrew/factory.git _bmad-output/ai-factory
# consumers of your repo then need: git submodule update --init _bmad-output/ai-factory
```

**B — plain clone inside the host repo** (keep it out of the host's index):

```bash
git clone https://github.com/EfimenkoAndrew/factory.git tools/ai-factory
echo "tools/ai-factory/" >> .gitignore
```

**C — standalone clone** (developing the factory itself, no host): just clone it;
`setup/init.mjs` detects the absence of an enclosing repo and skips host steps.

Any mount path and depth is fine: the driver detects the host repo root by walking up from
the mount to the first `.git` (override with `FACTORY_REPO_ROOT=<path>`), and rewrites the
committed config's stock `_bmad-output/ai-factory/...` paths onto the real mount at load
time. Host-specific config overrides go in the gitignored
`config/factory.config.local.json` (shallow top-level + per-key `paths` merge over
`config/factory.config.json`).

## 3. Initialize

```bash
node <mount>/setup/init.mjs --fresh --yes --hooks   # new host: scaffold state, install skill + pre-push gate
node <mount>/setup/init.mjs                         # existing host / keep shipped state
```

What it does: detects root+mount → checks prerequisites → scaffolds `state/`,
`telemetry/data/`, `reports/`, `queue/` → installs the **`/ai-factory` controller skill**
into the host's `.claude/skills/` (the `agents/*.md` role briefs need NO host install —
the driver inlines them into every batch at group time) → `--fresh` empties the
findings-graph (backing up the old one), rebuilds the ledger, resets the decision queue →
`--hooks` installs the pre-push build-time audit gate → runs the lib selftest +
`driver preflight` + `driver status` as smoke.

## 4. Feed it work

The factory consumes `state/findings-graph.json` — an envelope
`{generatedAt, source, count, items:[...]}` where each item obeys
[`schema/work-item.schema.json`](./schema/work-item.schema.json):
id, target, severity, theme, `fixType` (mechanical / non-trivial / owner-decision /
scope-stop), `files[]` (the file-lock set), `dependsOn[]`, a checkable `acceptance`
criterion, the `regressionTest` red→green description, `gateSet`, and `autonomyTier`
(auto / escalate / blocked). [`templates/findings-graph.example.json`](./templates/findings-graph.example.json)
is a working 3-item example.

Ways to produce it:

- **Hand-author** items (the graph is deliberately hand-editable) — start from the template.
- **Generate from an audit or backlog**: write a small adapter that emits schema-valid items
  into `state/normalized/*.json`, then run `driver.mjs merge-graph` to combine them into the
  findings-graph (it validates and detects dependency cycles) — or emit
  `state/findings-graph.json` directly. No adapter ships (§ 6): the schema is the only
  interface. Anything that can state an acceptance criterion plus a regression-test idea
  (audit finding, story, change request) can be an item.

Then build the ledger: `node <mount>/_workflow/driver.mjs init`

## 5. Operate

Open a Claude Code session at the **host repo root** and say “run the factory” — the
installed `/ai-factory` skill carries the controller manual (lease discipline, the loop,
recovery, what goes to the human). The loop it runs:

```bash
DRV="node <mount>/_workflow/driver.mjs"
$DRV status                       # counts, in-flight, escalations
$DRV cycle --max 4                # pick a batch -> per-item worktrees + state/run-script*.js
# launch the emitted run-script with the Claude Code Workflow tool (NO args)
$DRV fold <mount>/state/results-cycle-<N>.json
$DRV progress && $DRV burndown && $DRV escalations
```

Or mechanize the loop: `node <mount>/orchestrator/orchestrate.mjs run`
(backends: interactive / claude-headless / dry — see `orchestrator/ORCHESTRATOR.md`).

Outputs land in: `state/PROGRESS.md`, `reports/burndown.md`, `reports/cost-latest.md`,
`queue/decisions.md` (items needing a human ruling), and per-item artifacts under
`state/items/<id>/`. Finished fixes sit on `factory/<id>` branches in
`state/worktrees/<id>/` — review and commit them yourself.

## 6. Host adaptation points

| Seam | Default | Adapt by |
|---|---|---|
| **Build/test runner** | `verify/build-test.sh` (dotnet; emits `FACTORY::` markers) | drop an executable `verify/build-test.local.sh` implementing the same subcommands (`build`/`red`/`filter`/`suite`/`claims`/`leftovers`/`pack`) + `FACTORY::` markers — it takes over automatically (`FACTORY_BT_NO_LOCAL=1` bypasses; gitignored) |
| **Config knobs** | `config/factory.config.json` (gates, escalate/realInfra themes, retries, concurrency) | gitignored `config/factory.config.local.json` overlay |
| **Model routing** | `config/model-routing.json` (opus = hard gates/refute, sonnet = mid, haiku = cheap) | edit (committed) or overlay |
| **Review-gate house rules** | several `agents/*.md` briefs cite `.claude/rules/*.md` checklists (the host project's engineering rules) | give your host repo its own `.claude/rules/`, or trim those citations in the briefs — gates degrade gracefully when a cited file is absent |
| **Doc conventions** | prompt enrichment looks for `doc/data-flows/<target>.md`, `<target>/CONTEXT.md`, `<target>/AGENTS.md`; graph-audit lints a `STANDARDS-LEDGER.md` path | all best-effort — absent files just yield no enrichment |
| **Audit ingestion** | write your own (none shipped) | the graph contract (`schema/work-item.schema.json`) is the only interface; emit items however you like |

## 7. Invariants you must not break (see `KNOWN-ISSUES.md` § E)

- The human authors every commit; the factory and all its agents run **no mutating git**.
- ONE controller session (advisory lease in `state/controller.json`); ONE Workflow at a time.
- The driver is the ledger's **single writer**; the filesystem is the checkpoint (resumable).
- `state/STOP_REQUESTED.md` drains the factory; only the owner explicitly lifts it.
- A green build is not "done" — red→green regression proof, and real-infra proof where flagged.
