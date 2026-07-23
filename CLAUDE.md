# AI Implementation Factory — repo guide (for sessions opened IN this repo)

This repo is an in-project agentic **implement-and-auto-evaluate** engine: `_workflow/driver.mjs`
(Node control plane — ledger, scheduling, folds) + `_workflow/factory.js` (a Claude Code Workflow
script — the agent pipeline) + `agents/*.md` (role briefs). `README.md` explains the halves;
`SETUP.md` is host onboarding; `PLAN.md` is the architecture.

## Working on the factory itself

- **Read `KNOWN-ISSUES.md` first.** It is the append-only KI registry. Any change that adds a
  limitation, constraint, or fix MUST append/update a `KI-*` row in the SAME change.
- **Keep the selftest green**: `node _workflow/lib/_selftest.mjs` (currently 431 asserts) after
  every change to `_workflow/`, `verify/`, or `agents/` contracts it pins.
- **Zero npm dependencies** — Node built-ins only, everywhere (driver, orchestrator, setup, libs).
- **`factory.js` runs in the Workflow runtime**: no filesystem, no `require()`, no
  `Date.now()`/`Math.random()`/argless `new Date()`. Pure helpers used there are INLINED
  byte-for-byte from `_workflow/lib/` — change both copies together.
- **The state files are machine-owned.** `state/ledger.json` has a single writer (the driver);
  never hand-edit it. The findings-graph IS hand-editable — schema:
  `schema/work-item.schema.json`.

## Hard behavioural rules (apply to any session, host or standalone)

- **NO mutating git, ever** (`commit`/`add`/`checkout`/`restore`/`stash`/`reset`/`clean`) — by
  the factory, its subagents, or you while operating it. Fixes live on `factory/<id>` worktree
  branches; **the human authors every commit**.
- `state/STOP_REQUESTED.md` is an owner-controlled drain marker — never delete it from inference.
- Product-scope red-lines are hard stops (`scope-stop` → BLOCKED), never "fixed".

## Layout

`config/` knobs + model routing · `schema/` item/ledger schemas · `_workflow/` driver + Workflow +
libs · `agents/` role briefs · `verify/` build-test runner (host-stack seam) · `setup/init.mjs`
host initializer · `claude-assets/` host-installable `/ai-factory` skill · `templates/` example
findings-graph · `queue/` human decisions · `state/` + `reports/` runtime + generated ·
`telemetry/` observational event stream + compose stack · `orchestrator/` mechanized loop ·
`ci/` pre-push audit gate.
