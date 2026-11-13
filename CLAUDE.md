# AI Implementation Factory — repo guide (for sessions opened IN this repo)

This repo is an in-project agentic **implement-and-auto-evaluate** engine: `_workflow/driver.mjs`
(Node control plane — ledger, scheduling, folds) + `_workflow/factory.js` (a Claude Code Workflow
script — the agent pipeline) + `agents/*.md` (role briefs). `README.md` explains the halves;
`SETUP.md` is host onboarding; `PLAN.md` is the architecture.

## Working on the factory itself

- **Read `KNOWN-ISSUES.md` first.** It is the append-only KI registry. Any change that adds a
  limitation, constraint, or fix MUST append/update a `KI-*` row in the SAME change.
- **Keep the selftest green**: `node _workflow/lib/_selftest.mjs` (currently 2698 asserts) after
  every change to `_workflow/`, `verify/`, or `agents/` contracts it pins.
- **Zero npm dependencies** — Node built-ins only, everywhere (driver, orchestrator, setup, libs).
- **`factory.js` runs in the Workflow runtime**: no filesystem, no `require()`, no
  `Date.now()`/`Math.random()`/argless `new Date()`. Pure helpers used there are INLINED
  byte-for-byte from `_workflow/lib/` — change both copies together.
- **The state files are machine-owned.** `state/ledger.json` has a single writer (the driver);
  never hand-edit it. The findings-graph IS hand-editable — schema:
  `schema/work-item.schema.json`.

## Hard behavioural rules (apply to any session, host or standalone)

- **The human authors every SOURCE change that reaches the default branch.** The factory's workflows
  auto-commit their own bookkeeping (ledger, PROGRESS, `state/items/` artifacts) to the default
  branch — that is machine state, not a code change. An item's FIX CODE stays uncommitted on the
  `factory/<id>` worktree, with ONE sanctioned exception (**KI-E303**): on a **CLOSED** item (all
  review gates + verify APPROVED) the factory commits that fix to its **`factory/<id>` branch**
  (per-item backup) AND accumulates it onto the single shared **`factory/current` branch**
  (configurable via `FACTORY_PR_BRANCH` repo variable). Exactly **ONE PR** is ever open at a time:
  `factory/current → <default branch>`. The owner merges it when ready; merged branches are
  preserved (never auto-deleted). **The default branch's source is NEVER pushed directly — the PR
  is the human's merge gate.** (`orchestrator/open-pr.sh`; gated by repo var `FACTORY_AUTO_PR`,
  default on.) Otherwise still forbidden: any mutating git against the operator's main working
  tree (`checkout`/`restore`/`stash`/`reset`/`clean`), and committing a fix anywhere but its own
  `factory/<id>` backup branch and the accumulator `factory/current`.
- `state/STOP_REQUESTED.md` is an owner-controlled drain marker — never delete it from inference.
- Product-scope red-lines are hard stops (`scope-stop` → BLOCKED), never "fixed".

## Tasking the factory like a remote worker (KI-E336)

Open a GitHub issue describing what you want done, then either run `.github/workflows/factory-task.yml`
with the issue number, or add the `factory-task` label to the issue. The factory **scopes** the task,
implements it, integrates it, tests it, and opens a PR for you to merge — the ad-hoc counterpart to
the pre-scoped findings-graph items.

For a reliable scope, put three lines in the issue body:

```
Target: <ServiceName>
Files: path/to/a.cs, path/to/b.cs
Acceptance: <checkable done-criteria>
```

Omit them and the `scoper` agent (`agents/scoper.md`) tries to DISCOVER the files itself — best-effort,
experimental; it **refuses rather than guess** if it can't find concrete files, and it refuses any
product-scope red-line. Watch the first few free-text tasks.

Flow: `driver ingest` → `orchestrator/scope-task.mjs` (template-parse or scoper LLM) → a scope-preview
issue comment → `driver merge-graph` → `factory-run --include-escalate` → implement/verify/review/
integrate → auto-PR (KI-E303). Owner-task items are always `autonomyTier=escalate`: your dispatch is
the approval (KI-E334), you eyeball the scope-preview comment before any code is written, and you
review the PR. One task runs solo (`--max-lanes 1`), safely under the launcher cap (KI-E335; requires factory.js ≤ 384 KB — see KI-E350 for the trim that maintains this invariant).

## Layout

`config/` knobs + model routing · `schema/` item/ledger schemas · `_workflow/` driver + Workflow +
libs · `agents/` role briefs · `verify/` build-test runner (host-stack seam) · `setup/` host
initializer (`init.mjs`) + installers (`install.sh` bash, `install.mjs` no-bash) · the three
host-installable controller pointers: `claude-assets/` (`/ai-factory` skill), `copilot-assets/`
(`.github/copilot-instructions.md`), `opencode-assets/` (`AGENTS.md` + `.opencode/` + an
`opencode.json` permission merge) · `templates/` example findings-graph · `queue/` human
decisions · `state/` + `reports/` runtime + generated · `telemetry/` observational event stream +
compose stack · `orchestrator/` mechanized loop · `ci/` pre-push audit gate.
