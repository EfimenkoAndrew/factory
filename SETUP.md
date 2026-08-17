# Setting up the AI Implementation Factory in YOUR repo

The factory is a repo-agnostic, zero-npm-dependency engine that lives INSIDE a host git
repository and drives spec'd work items (audit findings / stories with acceptance criteria)
through: plan → red test → fix → verify (build+test) → adversarial review gates → refute →
scoped re-audit → integrate. Finished fixes wait on `factory/<id>` git-worktree branches —
**the human authors every commit**; the factory never runs mutating git.

This repo ships **engine-only** — no findings, ledger, or run history. You supply the work
items (a `findings-graph.json`); everything under `state/`, `reports/`, and `queue/` is
generated per host at runtime and is gitignored, so no project data ever enters this repo.

## 0. TL;DR — versioned team install (KI-E52)

One line, run from anywhere inside your host repo:

```bash
curl -fsSL https://raw.githubusercontent.com/EfimenkoAndrew/factory/main/setup/install.sh | bash -s -- install
```

That installs the **latest release** (a `vX.Y.Z` tag; falls back to `main` with a notice
until the first release is cut) into `_bmad-output/ai-factory`, runs `setup/init.mjs`
(scaffolding + the `/ai-factory` controller skill), **gates on the full selftest suite**
(the current assert count lives in `CLAUDE.md`), and
bootstraps YOUR telemetry infra: the Grafana/Prometheus/OTel compose stack (`docker compose
up -d`, per-host `telemetry/.env`) plus the session **cost-telemetry env** installed three
ways — per-host env file, host `.claude/settings.local.json` `env` block, and (recommended —
some runtimes do not forward `OTEL_*` from settings env, KI-E33) a sourced block in your
shell profile. Useful variants:

```bash
… | bash -s -- install --submodule --hooks     # submodule mount + the pre-push audit gate
… | bash -s -- install --version v1.2.0        # pin a version
… | bash -s -- install --no-telemetry          # skip the observability bootstrap
```

Day-2, from the installed mount:

```bash
_bmad-output/ai-factory/setup/install.sh status          # installed vs latest release
_bmad-output/ai-factory/setup/install.sh upgrade --yes   # fetch latest, SELFTEST-GATED —
                                                         # a red selftest auto-ROLLS-BACK;
                                                         # state/ reports/ queue/ telemetry
                                                         # data + .env are never touched
_bmad-output/ai-factory/setup/install.sh telemetry-up    # (re)start the per-dev stack
```

`upgrade --yes` is unattended-safe (cron it if you want auto-upgrades). Maintainers cut
releases with `setup/release.sh <patch|minor|major|X.Y.Z>` (the explicit `X.Y.Z` form is how
the FIRST release matching the seeded `VERSION` is cut) — it verifies local main is exactly
`origin/main`, enforces the SAME selftest gate, bumps `VERSION`, prepends `CHANGELOG.md`,
tags `vX.Y.Z`, pushes atomically, and publishes the GitHub Release the installers resolve.
On a PR-only main (direct pushes blocked by a ruleset) it automatically publishes via the
tag + a `release/vX.Y.Z` branch + a PR instead. `setup/_e2e.sh` is the hermetic end-to-end
harness for all of this (local fixture remote, no network) — run it before cutting.
The sections below are the manual path and the details.

### 0b. No bash? Use the Node installer (KI-O5)

`install.sh` needs bash. On a host without one (Windows with no Git Bash/WSL, locked-down CI
images) use `setup/install.mjs` — same contracts (strict `vX.Y.Z` resolution, selftest gate on
install AND upgrade, rollback on a red upgrade, transactional cleanup of a failed install),
zero bash. Clone the engine anywhere, then point it at your host repo:

```bash
git clone https://github.com/EfimenkoAndrew/factory.git /tmp/factory
node /tmp/factory/setup/install.mjs install --host /path/to/host-repo [--submodule] [--hooks]
```

Day-2, from the installed mount:

```bash
node <mount>/setup/install.mjs status        # installed vs latest release + per-controller state
node <mount>/setup/install.mjs upgrade       # selftest-gated, rolls back on red
node <mount>/setup/install.mjs controllers   # re-install ONLY the host controller assets
```

It delegates every host-side install to `setup/init.mjs`, so the three controller seams have
exactly one implementation. It does **not** bootstrap telemetry — that stack is docker +
shell-profile work with no meaningful Windows story, and a second implementation of it would
only drift; run `bash <mount>/setup/install.sh telemetry-up` on a POSIX host.

## 1. Prerequisites

| Requirement | Why | Hard? |
|---|---|---|
| Node.js **>= 20.11** | driver / orchestrator / selftest (built-ins only, no `npm install`) | yes |
| git **2.30+** | worktree isolation per item | yes |
| A **controller session** at the host repo root | Claude Code (native `Workflow` worker plane), OpenCode or GitHub Copilot (both drive `_workflow/opencode/`) | yes |
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
node <mount>/setup/init.mjs --fresh --yes --hooks   # new host: scaffold state, install controllers + pre-push gate
node <mount>/setup/init.mjs                         # existing host / keep shipped state
```

What it does: detects root+mount → checks prerequisites → scaffolds `state/`,
`telemetry/data/`, `reports/`, `queue/` → installs the **host controller assets** (below) →
`--fresh` empties the findings-graph (backing up the old one), rebuilds the ledger, resets the
decision queue → `--hooks` installs the pre-push build-time audit gate → runs the lib selftest +
`driver preflight` + `driver status` as smoke.

The `agents/*.md` role briefs need NO host install — the driver inlines them into every batch at
group time. What DOES get installed is one pointer per controller (KI-O4, KI-O5):

| Controller | Host paths | Skip with |
|---|---|---|
| **Claude Code** | `.claude/skills/ai-factory/SKILL.md` | `--no-claude-assets` |
| **GitHub Copilot** | `.github/copilot-instructions.md` | `--no-copilot-assets` |
| **OpenCode** | `AGENTS.md`, `.opencode/ai-factory.md`, `.opencode/skill/ai-factory/SKILL.md`, + a merge into your `opencode.json` | `--no-opencode-assets` |

All of it is no-clobber and re-runnable: a byte-identical file is a silent no-op, an absent one
is created, and a **locally edited** one is never overwritten — the new version lands alongside
as `*.factory-new` with a warning. Only the OpenCode `opencode.json` is *merged* rather than
copied (it is your file, carrying your model/provider/MCP settings): the factory appends its
`instructions` entry and re-appends its `permission` rules at the END of each tool's rule object,
because opencode evaluates the **last** matching pattern. A host config that is not strict JSON,
or whose top-level `permission` is the bare-string form, is **refused** rather than rewritten —
the factory block is written as `opencode.json.factory-new` for you to merge.

Those permission rules are the one place a factory invariant becomes a machine gate rather than
a sentence in a brief: mutating git verbs (`commit`/`add`/`checkout`/`restore`/`stash`/`reset`/
`clean`/`push`) are **`ask`** — ordinary OpenCode-assisted development in your repo still works,
but "the human authors every commit" becomes a prompt you have to answer — while the same verbs
aimed at a **factory worktree**, deleting `state/STOP_REQUESTED.md`, and editing
`state/ledger.json` are hard **`deny`**. See `opencode-assets/README.md` for the full rationale.

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

- **`driver ingest` from a source (KI-E27)** — the built-in adapters pull issues into
  `state/normalized/<source>.json`, which `merge-graph` folds:

  ```bash
  DRV="node <mount>/_workflow/driver.mjs"
  $DRV ingest --github owner/repo --issues 101,102          # named issues (needs gh, authenticated)
  $DRV ingest --github owner/repo --label bug --state open  # a label query, up to --limit N (default 30)
  $DRV ingest --json  path/to/items.json                    # gh-issue array OR ready work-item array (passthrough)
  $DRV ingest --markdown path/to/backlog.md                 # "- [ ] task" checklist -> triage items
  $DRV merge-graph                                           # the guarded step: fold every normalized/*.json into the graph
  #   ingest options: --out NAME / --id-prefix P / --target T / --theme X / --severity S
  ```

  **The honest-acceptance rule:** an ingested item is **never auto-runnable**. A raw issue rarely
  states a *checkable* `acceptance` + `regressionTest` — the factory's contract — so ingestion lands
  each item as `blocked` triage (no parseable section) or at most `escalate` (an "Expected behaviour"
  section was lifted, but a human still confirms it). You (or `bmad-spec`) then author the acceptance,
  set `files[]`, and flip `autonomyTier` to `auto`. Ingestion seeds the queue; it never fabricates a
  green light. Add a source type by extending the pure mappers in `_workflow/lib/ingest.mjs`.

- **Hand-author** items (the graph is deliberately hand-editable) — start from the template. This is
  the shortest path to a fully-spec'd, immediately-schedulable item (as the shipped example is).
- **Generate from your own audit**: emit schema-valid items into `state/normalized/*.json` however you
  like, then `merge-graph`. The schema (`schema/work-item.schema.json`) is the only interface.

Then build the ledger: `node <mount>/_workflow/driver.mjs init`

## 5. Operate

Open a session at the **host repo root** and say "run the factory" — the installed controller
asset carries the manual (lease discipline, the loop, recovery, what goes to the human):

| Controller | What drives the worker plane |
|---|---|
| **Claude Code** | the `/ai-factory` skill → the native `Workflow` tool runs `_workflow/factory.js`, the full batch pipeline with real subagents |
| **OpenCode** | the `ai-factory` skill → `_workflow/opencode/runtime.mjs`, one item at a time, with `Task` supplying each role as an independent subagent |
| **GitHub Copilot** | `.github/copilot-instructions.md` → the same `runtime.mjs` protocol, but every role is played by the one session (a disclosed fidelity gap, KI-O4) |

The control plane is identical for all three. The Claude Code loop:

```bash
DRV="node <mount>/_workflow/driver.mjs"
$DRV status                       # counts, in-flight, escalations
$DRV cycle --max 4                # pick a batch -> per-item worktrees + state/run-script*.js
# launch the emitted run-script with the Claude Code Workflow tool (NO args)
$DRV fold <mount>/state/results-cycle-<N>.json
$DRV progress && $DRV burndown && $DRV escalations
```

The OpenCode/Copilot loop swaps the middle step for the runtime binding (`init` → loop
`next` / do the work / `submit` → `mech ... checkpoint` → `finalize`, then fold the finalized
envelope). See `_workflow/opencode/README.md` for the exact protocol.

Or mechanize the loop: `node <mount>/orchestrator/orchestrate.mjs run`
(backends: interactive / claude-headless / dry — see `orchestrator/ORCHESTRATOR.md`).

Outputs land in: `state/PROGRESS.md`, `reports/burndown.md`, `reports/cost-latest.md`,
`queue/decisions.md` (items needing a human ruling), and per-item artifacts under
`state/items/<id>/`. Finished fixes sit on `factory/<id>` branches in
`state/worktrees/<id>/` — review and commit them yourself.

## 6. Host adaptation points

| Seam | Default | Adapt by |
|---|---|---|
| **Build/test runner** | `verify/build-test.sh` (dotnet; emits `FACTORY::` markers) | drop an executable `verify/build-test.local.sh` implementing the same subcommands (`build`/`red`/`filter`/`suite`/`claims`/`pack`) + `FACTORY::` markers — it takes over automatically (`FACTORY_BT_NO_LOCAL=1` bypasses; gitignored). The diff lints (`leftovers`/`comments`) are ENGINE-OWNED and dispatched before the override seam — stack-agnostic, a local script never implements them |
| **Config knobs** | `config/factory.config.json` (gates, escalate/realInfra themes, retries, concurrency) | gitignored `config/factory.config.local.json` overlay |
| **Host policies** | `policies` in `config/factory.config.json` — `noNewComments` (KI-E57/KI-E59 zero-new-comments rule + its mechanical gate) and `noSchemaChanges` (KI-E58 no-migrations hard stop), BOTH OFF in the shipped engine | flip per host in the gitignored local overlay: `{ "policies": { "noNewComments": true, "noSchemaChanges": true } }` — the driver prints the effective state at every `group`/`sweep`, and the briefs' matching sections activate only when a policy's `HOST POLICY` block is injected |
| **Model routing** | `config/model-routing.json` (opus = hard gates/refute, sonnet = mid, haiku = cheap) | edit (committed) or overlay |
| **Review-gate house rules** | several `agents/*.md` briefs cite `.claude/rules/*.md` checklists (the host project's engineering rules) | give your host repo its own `.claude/rules/`, or trim those citations in the briefs — gates degrade gracefully when a cited file is absent |
| **Doc conventions** | prompt enrichment looks for `doc/data-flows/<target>.md`, `<target>/CONTEXT.md`, `<target>/AGENTS.md`; graph-audit lints a `STANDARDS-LEDGER.md` path | all best-effort — absent files just yield no enrichment |
| **Repo style profiles** | an optional `agents/repo-profiles/<target>.md` is layered onto (never in place of) the universal `agents/*.md` briefs for that target (KI-E60), on every prompt-composing lane (group/sweep/select/recover + the opencode runtime), capped at `PROFILE_CAP` (30k chars) in both runtimes | HOST-LOCAL data: the dir is gitignored except `README.md` + the fictional `_example.Contoso.Widgets.md` — write real profiles per host mount (see the README); a target with no profile file behaves exactly as if this convention did not exist |
| **Audit ingestion** | `driver ingest` ships github / json / markdown adapters (KI-E27) | extend the pure mappers in `_workflow/lib/ingest.mjs` for a new source; the graph contract (`schema/work-item.schema.json`) is the only interface, so you can also emit items however you like |
| **Cost telemetry** | dashboard cost panels need session OTLP (KI-E28) | source `telemetry/claude-code-telemetry.env.example` in the session shell; see `telemetry/README.md` |
| **Copilot conventions** | `init` installs `copilot-assets/copilot-instructions.md` to the host's `.github/copilot-instructions.md` (KI-O4) | skip with `--no-copilot-assets`; once installed it's a normal host file — edit in place (re-running `init` never clobbers a locally-edited copy, same `*.factory-new` no-clobber behavior as the `.claude/skills/` install) |
| **OpenCode conventions** | `init` copies `opencode-assets/root/**` onto the host root (`AGENTS.md`, `.opencode/ai-factory.md`, `.opencode/skill/ai-factory/`) and MERGES `opencode-assets/opencode.config.json` into the host's own `opencode.json` (KI-O5) | skip with `--no-opencode-assets`; loosen or drop individual `permission` rules by editing the host `opencode.json` — re-running `init` re-appends only the factory's own keys and never touches the rest of your config. `AGENTS.md` is the one likely collision, which is why it is only a pointer: the substance lives in `.opencode/ai-factory.md`, loaded via `instructions`, so keeping your own `AGENTS.md` costs you nothing |

## 7. Invariants you must not break (see `KNOWN-ISSUES.md` § E)

- The human authors every commit; the factory and all its agents run **no mutating git**.
- ONE controller session (advisory lease in `state/controller.json`); ONE Workflow at a time.
- The driver is the ledger's **single writer**; the filesystem is the checkpoint (resumable).
- `state/STOP_REQUESTED.md` drains the factory; only the owner explicitly lifts it.
- A green build is not "done" — red→green regression proof, and real-infra proof where flagged.
