# Architecture — the AI Implementation Factory

An in-project agentic **implement-and-auto-evaluate** engine. You feed it a spec'd work
item (an audit finding, a story, or a change request with acceptance criteria); it
implements the item in an isolated git worktree, proves it with a red→green regression
test plus an adversarial review stage plus a scoped re-audit, and hands the verified change
off **for a human to commit**. The factory never runs mutating git.

## The two halves

The engine is split because the Claude Code **Workflow** runtime cannot touch the
filesystem or git:

| Half | What | Where |
|---|---|---|
| **Control plane** (persistence + scheduling) | `driver.mjs` — owns `state/ledger.json` (single writer), selects READY items, emits the run batch, folds Workflow results back, regenerates reports. Run via `node` between Workflow invocations. | `_workflow/driver.mjs` + `_workflow/lib/*.mjs` |
| **Worker plane** (agents) | `factory.js` — a **Workflow script**. Receives a batch + agent briefs + model routing, drives each item through the lifecycle with model-routed, worktree-isolated, low-concurrency subagents, writes each artifact to disk, returns compact per-item results. | `_workflow/factory.js`, `agents/*.md` |

The control plane and worker plane communicate through the filesystem only: the driver emits
a launcher script (`state/run-script*.js`), the Workflow runs and writes per-item results,
the driver folds those results into the ledger.

## Work-item lifecycle (the resumable state machine)

```
READY → CLAIMED → RED → GREEN → BUILT → TESTED → GATED → REFUTE_OK → REAUDITED → INTEGRATED → CLOSED
off-ramps: BLOCKED (owner decision) · ESCALATED (auth/money/crypto/cross-service → human sign-off) · FAILED · CONFLICT (file-lock)
```

Every transition is persisted atomically in `state/ledger.json`. A killed run re-derives
state from disk + worktree inspection; nothing restarts from zero.

## The review stage

The review stage is **separate adversarial subagents** — never nested in the doing agent.

- **Band A — role gates**: Architect, Developer, QA, Security, PO (Product Owner). A subset
  are hard gates that block integration. Configure in `config/factory.config.json`
  (`gateSet` / `hardGates`).
- **Band B/C — review flows**: independent adversarial passes (a code review, an
  adversarial "cynical" review, an edge-case path-tracer, a test-quality review, and
  optional editorial passes for doc-touching items), each run as its own subagent, applied
  per item by what it touches (`reviewFlows` in the config).

A blocking review returning CHANGES_REQUIRED sends the item back to the fixer, exactly like
a failed role gate.

## Model routing

`config/model-routing.json` routes each stage to a model tier — the strongest models are
reserved for hard reasoning, the hard gates, and the refute pass; a mid tier for ordinary
work; a cheap tier for mechanical probes. A LIGHT review band (see `EFFECTIVENESS.md`) runs
the long tail far cheaper.

## Invariants (non-negotiable)

1. **The human authors every commit.** The factory runs **no** mutating git
   (`commit`/`add`/`checkout`/`restore`/`stash`/`reset`/`clean`). Fixes live on a
   `factory/<id>` branch in an isolated worktree; the worktree/branch is the handoff.
2. **The filesystem is the checkpoint.** Agents write artifacts + per-item result files; the
   driver folds them into the ledger (single writer = no race).
3. **Green build ≠ done.** A fix needs a red→green regression test; money/security/
   concurrency items additionally need real-infra (e.g. Testcontainers) verification.
4. **One Workflow at a time**; low concurrency under throttle; per-agent retry ≥ the
   configured attempts.
5. **One controller session** owns the factory at a time (an advisory lease in
   `state/controller.json`).
6. **Scope red-lines are hard stops.** Configure the boundaries your project must never
   cross; an item whose only fix crosses one is a `scope-stop` → the human queue, never
   "fixed" by adding the forbidden surface.

## Portability

The engine detects its host repo root and rewrites its config paths onto whatever mount you
use (see `_workflow/lib/rootfind.mjs` and `SETUP.md`), so it runs unchanged as a submodule
or plain clone at any path.
